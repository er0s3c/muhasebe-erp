-- =========================================================================
-- Banka ekstresi ve mutabakat: RLS, yetki, denetim izi ve iş kuralları.
-- Kurallar ERRCODE ERP06 ile yükselir (API'de 422 BANK_RULE_VIOLATION);
-- ERP01 defter, ERP02 stok, ERP03 fatura, ERP04 irsaliye, ERP05 kasa/banka kuralları içindir.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statements', 'bank_statement_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2) Yetkiler (erp_app şema sahibi değildir). Ekstre başlığı değiştirilemez; satırlar yalnızca durum/eşleşme alanlarıyla güncellenir.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, DELETE ON bank_statements TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON bank_statement_lines TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Denetim izi
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statements', 'bank_statement_lines'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 4) Ekstre başlığı: yalnızca banka hesabına eklenir; değiştirilemez; eşleşmiş satırı olan ekstre silinemez.
CREATE FUNCTION bank_statements_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  ta treasury_accounts%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Banka ekstresi değiştirilemez' USING ERRCODE = 'ERP06';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM bank_statement_lines l
       WHERE l.statement_id = OLD.id AND l.company_id = OLD.company_id AND l.status = 'matched'
    ) THEN
      RAISE EXCEPTION 'Eşleşmiş satırı olan ekstre silinemez; önce eşleşmeleri kaldırın' USING ERRCODE = 'ERP06';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO ta FROM treasury_accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF NOT FOUND OR ta.kind <> 'bank' THEN
    RAISE EXCEPTION 'Ekstre yalnızca banka hesabına aktarılabilir' USING ERRCODE = 'ERP06';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bank_statements_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_statements
  FOR EACH ROW EXECUTE FUNCTION bank_statements_guard();
--> statement-breakpoint

-- 5) Ekstre satırı: içeriği değişmez; yalnızca durum (open/matched/ignored) ve eşleşme alanları değişir.
--    Eşleşme: defter satırı bu hesabın muhasebe hesabında, kaydedilmiş ve ters çevrilmemiş fişte, tutar ve işaret
--    ekstre tutarına eşit olmalı; aynı defter satırı tek ekstre satırıyla eşleşir (tekil dizin; satır kilitlenir).
--    Eşleşmiş satır silinemez.
CREATE FUNCTION bank_statement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st bank_statements%ROWTYPE;
  ta treasury_accounts%ROWTYPE;
  jl journal_lines%ROWTYPE;
  je journal_entries%ROWTYPE;
  tr treasury_transactions%ROWTYPE;
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
    RETURN NEW;
  END IF;

  -- open → matched: aynı defter satırına paralel eşleştirmeler sıraya girer
  SELECT * INTO jl FROM journal_lines WHERE id = NEW.journal_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Defter satırı bulunamadı' USING ERRCODE = 'ERP06';
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
--> statement-breakpoint
CREATE TRIGGER bank_statement_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION bank_statement_lines_guard();
--> statement-breakpoint

-- 6) Eşleşmiş banka satırı olan fiş ters çevrilemez (ikinci savunma; uygulama da `ENTRY_RECONCILED` verir).
CREATE FUNCTION journal_entries_reconciled_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.reversed_by_id IS NOT NULL AND OLD.reversed_by_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM bank_statement_lines b
        JOIN journal_lines l ON l.id = b.journal_line_id AND l.company_id = b.company_id
       WHERE b.status = 'matched' AND l.entry_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Fişin banka satırı ekstreyle eşleşmiş; ters çevirmeden önce eşleşmeyi kaldırın' USING ERRCODE = 'ERP06';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_reconciled_guard
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_reconciled_guard();
