CREATE TABLE "bank_statement_line_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"statement_line_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_line_matches_gl_uq" UNIQUE("company_id","journal_line_id")
);
--> statement-breakpoint
ALTER TABLE "bank_statement_line_matches" ADD CONSTRAINT "bank_statement_line_matches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_line_matches" ADD CONSTRAINT "bank_statement_line_matches_line_fk" FOREIGN KEY ("statement_line_id","company_id") REFERENCES "public"."bank_statement_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_line_matches" ADD CONSTRAINT "bank_statement_line_matches_gl_fk" FOREIGN KEY ("journal_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_statement_line_matches_line_idx" ON "bank_statement_line_matches" USING btree ("company_id","statement_line_id");--> statement-breakpoint
ALTER TABLE bank_statement_line_matches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON bank_statement_line_matches USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, DELETE ON bank_statement_line_matches TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Grup eşleştirmesi yalnız açık ekstre satırına eklenir ya da ondan silinir (satır eşleşmiş durumdayken grup değişmez).
-- Defter satırı ekstre hesabının muhasebe hesabında, kaydedilmiş ve ters çevrilmemiş fişte, aynı para biriminde olmalı ve
-- birebir eşleşmede kullanılmamış olmalıdır (defter satırı kilitlenir: paralel eşleştirmeler sıraya girer).
CREATE FUNCTION bank_statement_line_matches_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  b bank_statement_lines%ROWTYPE;
  ta treasury_accounts%ROWTYPE;
  jl journal_lines%ROWTYPE;
  je journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Grup eşleştirmesi değiştirilemez' USING ERRCODE = 'ERP06';
  END IF;
  SELECT * INTO b FROM bank_statement_lines WHERE id = COALESCE(NEW.statement_line_id, OLD.statement_line_id) AND company_id = COALESCE(NEW.company_id, OLD.company_id) FOR UPDATE;
  IF NOT FOUND OR b.status <> 'open' THEN
    RAISE EXCEPTION 'Grup eşleştirmesi yalnız açık ekstre satırında değişir' USING ERRCODE = 'ERP06';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT * INTO jl FROM journal_lines WHERE id = NEW.journal_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Defter satırı bulunamadı' USING ERRCODE = 'ERP06';
  END IF;
  SELECT * INTO ta FROM treasury_accounts WHERE id = b.account_id AND company_id = NEW.company_id;
  IF NOT FOUND OR jl.account_id <> ta.account_id OR jl.currency_code <> b.currency_code THEN
    RAISE EXCEPTION 'Defter satırı bu hesabın muhasebe hesabına ve para birimine ait değil' USING ERRCODE = 'ERP06';
  END IF;
  SELECT * INTO je FROM journal_entries WHERE id = jl.entry_id AND company_id = NEW.company_id;
  IF NOT FOUND OR je.status <> 'posted' OR je.reversed_by_id IS NOT NULL OR je.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Defter satırı kaydedilmiş ve ters çevrilmemiş bir fişte olmalı' USING ERRCODE = 'ERP06';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_statement_lines x WHERE x.company_id = NEW.company_id AND x.journal_line_id = NEW.journal_line_id) THEN
    RAISE EXCEPTION 'Defter satırı başka bir ekstre satırıyla eşleşmiş' USING ERRCODE = 'ERP06';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bank_statement_line_matches_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_line_matches
  FOR EACH ROW EXECUTE FUNCTION bank_statement_line_matches_guard();
--> statement-breakpoint
-- Ekstre satırı koruması: birebir eşleşmeye ek olarak grup eşleşmesi (journal_line_id boş, grup toplamı = tutar).
CREATE OR REPLACE FUNCTION bank_statement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st bank_statements%ROWTYPE;
  ta treasury_accounts%ROWTYPE;
  jl journal_lines%ROWTYPE;
  je journal_entries%ROWTYPE;
  tr treasury_transactions%ROWTYPE;
  group_count integer;
  group_total numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'matched' THEN
      RAISE EXCEPTION 'Eşleşmiş ekstre satırı silinemez; önce eşleşmeyi kaldırın' USING ERRCODE = 'ERP06';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO st FROM bank_statements WHERE id = NEW.statement_id AND company_id = NEW.company_id;
    IF NOT FOUND OR st.account_id <> NEW.account_id THEN
      RAISE EXCEPTION 'Ekstre satırı, ekstrenin hesabına ait olmalı' USING ERRCODE = 'ERP06';
    END IF;
    IF NEW.txn_date < st.from_date OR NEW.txn_date > st.to_date THEN
      RAISE EXCEPTION 'Satır tarihi ekstre aralığının dışında' USING ERRCODE = 'ERP06';
    END IF;
    SELECT * INTO ta FROM treasury_accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
    IF NOT FOUND OR ta.currency_code <> NEW.currency_code THEN
      RAISE EXCEPTION 'Satır para birimi hesabın para birimiyle uyuşmuyor' USING ERRCODE = 'ERP06';
    END IF;
    IF NEW.status <> 'open' OR NEW.journal_line_id IS NOT NULL OR NEW.transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'Ekstre satırı açık olarak oluşturulmalı' USING ERRCODE = 'ERP06';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (to_jsonb(NEW) - 'status' - 'journal_line_id' - 'transaction_id' - 'matched_at' - 'matched_by' - 'ignore_reason')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'journal_line_id' - 'transaction_id' - 'matched_at' - 'matched_by' - 'ignore_reason') THEN
    RAISE EXCEPTION 'Ekstre satırının içeriği değiştirilemez' USING ERRCODE = 'ERP06';
  END IF;

  IF OLD.status = NEW.status THEN
    IF NEW.journal_line_id IS DISTINCT FROM OLD.journal_line_id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
      RAISE EXCEPTION 'Eşleşmiş satırın eşleşmesi değiştirilemez; önce kaldırın' USING ERRCODE = 'ERP06';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'open' AND NEW.status IN ('matched', 'ignored')) OR (OLD.status IN ('matched', 'ignored') AND NEW.status = 'open')) THEN
    RAISE EXCEPTION 'Geçersiz durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP06';
  END IF;

  IF NEW.status <> 'matched' THEN
    IF NEW.journal_line_id IS NOT NULL OR NEW.transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'Eşleşmemiş satırda defter satırı ya da hareket bağı olamaz' USING ERRCODE = 'ERP06';
    END IF;
    IF NEW.status = 'ignored' AND EXISTS (SELECT 1 FROM bank_statement_line_matches m WHERE m.statement_line_id = NEW.id AND m.company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'Grup eşleştirmesi olan satır yok sayılamaz' USING ERRCODE = 'ERP06';
    END IF;
    RETURN NEW;
  END IF;

  -- open → matched (grup): defter satırları grup kayıtlarındadır, toplamları tutara eşit olmalı
  IF NEW.journal_line_id IS NULL THEN
    IF NEW.transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'Grup eşleşmesinde tek hareket bağı olmaz' USING ERRCODE = 'ERP06';
    END IF;
    SELECT count(*), coalesce(sum(l.debit - l.credit), 0) INTO group_count, group_total
      FROM bank_statement_line_matches m JOIN journal_lines l ON l.id = m.journal_line_id AND l.company_id = m.company_id
     WHERE m.statement_line_id = NEW.id AND m.company_id = NEW.company_id;
    IF group_count < 2 THEN
      RAISE EXCEPTION 'Grup eşleşmesi en az iki defter satırı gerektirir' USING ERRCODE = 'ERP06';
    END IF;
    IF group_total <> NEW.amount THEN
      RAISE EXCEPTION 'Ekstre tutarı (%) seçilen defter satırlarının toplamıyla (%) uyuşmuyor', NEW.amount, group_total USING ERRCODE = 'ERP06';
    END IF;
    RETURN NEW;
  END IF;

  -- open → matched (birebir): aynı defter satırına paralel eşleştirmeler sıraya girer
  IF EXISTS (SELECT 1 FROM bank_statement_line_matches m WHERE m.statement_line_id = NEW.id AND m.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Grup eşleştirmesi olan satır birebir eşleştirilemez' USING ERRCODE = 'ERP06';
  END IF;
  SELECT * INTO jl FROM journal_lines WHERE id = NEW.journal_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Defter satırı bulunamadı' USING ERRCODE = 'ERP06';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_statement_line_matches m WHERE m.journal_line_id = NEW.journal_line_id AND m.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Defter satırı bir grup eşleşmesinde kullanılıyor' USING ERRCODE = 'ERP06';
  END IF;
  SELECT * INTO ta FROM treasury_accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF NOT FOUND OR jl.account_id <> ta.account_id THEN
    RAISE EXCEPTION 'Defter satırı bu hesabın muhasebe hesabına ait değil' USING ERRCODE = 'ERP06';
  END IF;
  SELECT * INTO je FROM journal_entries WHERE id = jl.entry_id AND company_id = NEW.company_id;
  IF NOT FOUND OR je.status <> 'posted' OR je.reversed_by_id IS NOT NULL OR je.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Defter satırı kaydedilmiş ve ters çevrilmemiş bir fişte olmalı' USING ERRCODE = 'ERP06';
  END IF;
  IF jl.currency_code <> NEW.currency_code OR (jl.debit - jl.credit) <> NEW.amount THEN
    RAISE EXCEPTION 'Ekstre tutarı (%) defter satırıyla (%) uyuşmuyor', NEW.amount, jl.debit - jl.credit USING ERRCODE = 'ERP06';
  END IF;
  IF NEW.transaction_id IS NOT NULL THEN
    SELECT * INTO tr FROM treasury_transactions WHERE id = NEW.transaction_id AND company_id = NEW.company_id;
    IF NOT FOUND OR tr.journal_entry_id <> jl.entry_id OR tr.status <> 'posted' THEN
      RAISE EXCEPTION 'Hareket, defter satırının fişine ait olmalı' USING ERRCODE = 'ERP06';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
