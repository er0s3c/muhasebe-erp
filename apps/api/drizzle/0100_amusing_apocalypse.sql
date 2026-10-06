ALTER TABLE "employee_advance_settlements" DROP CONSTRAINT "employee_advance_settlements_kind_ck";--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" DROP CONSTRAINT "employee_advance_settlements_source_ck";--> statement-breakpoint
ALTER TABLE "expense_entries" DROP CONSTRAINT "expense_entries_payment_ck";--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD COLUMN "expense_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD COLUMN "employee_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD COLUMN "advance_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD COLUMN "advance_applied_amount" numeric(19, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_id_company" UNIQUE("id","company_id");--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_expense_fk" FOREIGN KEY ("expense_entry_id","company_id") REFERENCES "public"."expense_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_advance_fk" FOREIGN KEY ("advance_id","company_id") REFERENCES "public"."employee_advances"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_advance_settlements_expense_uq" ON "employee_advance_settlements" USING btree ("expense_entry_id") WHERE "employee_advance_settlements"."expense_entry_id" is not null;--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_kind_ck" CHECK ("employee_advance_settlements"."kind" in ('payroll','repayment','expense'));--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_source_ck" CHECK (("employee_advance_settlements"."kind" = 'payroll' and "employee_advance_settlements"."payroll_run_id" is not null and "employee_advance_settlements"."treasury_txn_id" is null and "employee_advance_settlements"."expense_entry_id" is null) or ("employee_advance_settlements"."kind" = 'repayment' and "employee_advance_settlements"."treasury_txn_id" is not null and "employee_advance_settlements"."payroll_run_id" is null and "employee_advance_settlements"."expense_entry_id" is null) or ("employee_advance_settlements"."kind"='expense' and "employee_advance_settlements"."expense_entry_id" is not null and "employee_advance_settlements"."payroll_run_id" is null and "employee_advance_settlements"."treasury_txn_id" is null));--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_advance_ck" CHECK ("expense_entries"."advance_applied_amount">=0 and "expense_entries"."advance_applied_amount"<="expense_entries"."payable" and ("expense_entries"."advance_applied_amount"=0 or "expense_entries"."advance_id" is not null) and ("expense_entries"."payment_kind"='employee' or ("expense_entries"."employee_id" is null and "expense_entries"."advance_id" is null and "expense_entries"."advance_applied_amount"=0)));--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_payment_ck" CHECK (("expense_entries"."payment_kind" = 'treasury' and "expense_entries"."treasury_account_id" is not null) or ("expense_entries"."payment_kind" = 'party' and "expense_entries"."party_id" is not null and "expense_entries"."treasury_account_id" is null) or ("expense_entries"."payment_kind"='employee' and "expense_entries"."employee_id" is not null and ("expense_entries"."advance_applied_amount"="expense_entries"."payable" or "expense_entries"."treasury_account_id" is not null)));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION employee_advance_settlements_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  adv employee_advances%ROWTYPE;
  s numeric;
  t record;
  r record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Avans kapama taksiti silinemez; geri alınır' USING ERRCODE = 'ERP20';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Taksit geri alınmamış olarak eklenir' USING ERRCODE = 'ERP20';
    END IF;
    SELECT * INTO adv FROM employee_advances WHERE id = NEW.advance_id AND company_id = NEW.company_id FOR UPDATE;
    IF NOT FOUND OR adv.status = 'cancelled' THEN
      RAISE EXCEPTION 'İptal edilmiş avansa taksit eklenemez' USING ERRCODE = 'ERP20';
    END IF;
    IF NEW.settled_date < adv.advance_date THEN
      RAISE EXCEPTION 'Kapama tarihi avans tarihinden önce olamaz' USING ERRCODE = 'ERP20';
    END IF;
    IF NEW.kind = 'payroll' THEN
      SELECT status INTO r FROM payroll_runs WHERE id = NEW.payroll_run_id AND company_id = NEW.company_id;
      IF NOT FOUND OR r.status NOT IN ('draft', 'approved') THEN
        RAISE EXCEPTION 'Avans kesintisi onaylanan bordroya bağlı olmalı' USING ERRCODE = 'ERP20';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM payroll_lines l WHERE l.run_id = NEW.payroll_run_id AND l.employee_id = adv.employee_id) THEN
        RAISE EXCEPTION 'Avansın personeli bu bordroda yok' USING ERRCODE = 'ERP20';
      END IF;
    ELSIF NEW.kind = 'expense' THEN
      SELECT * INTO r FROM expense_entries WHERE id=NEW.expense_entry_id AND company_id=NEW.company_id;
      IF NOT FOUND OR r.status <> 'posted' OR r.payment_kind <> 'employee' OR r.employee_id <> adv.employee_id
         OR r.advance_id IS DISTINCT FROM adv.id OR r.advance_applied_amount <> NEW.amount OR r.entry_date <> NEW.settled_date THEN
        RAISE EXCEPTION 'Masraf mahsubu aynı personel, avans, tutar ve tarihli kayıtlı gider fişine bağlı olmalı' USING ERRCODE='ERP20';
      END IF;
    ELSE
      SELECT type, status, amount, txn_date INTO t FROM treasury_transactions WHERE id = NEW.treasury_txn_id AND company_id = NEW.company_id;
      IF NOT FOUND OR t.type <> 'other_receipt' OR t.status <> 'posted' OR t.amount <> NEW.amount OR t.txn_date <> NEW.settled_date THEN
        RAISE EXCEPTION 'Geri ödeme, aynı tutar/tarihle kaydedilmiş bir kasa/banka tahsilatına bağlı olmalı' USING ERRCODE = 'ERP20';
      END IF;
    END IF;
    SELECT coalesce(sum(amount), 0) INTO s FROM employee_advance_settlements WHERE advance_id = NEW.advance_id AND reversed_at IS NULL;
    IF s + NEW.amount > adv.amount THEN
      RAISE EXCEPTION 'Kapanan tutar avans tutarını aşamaz (avans %, kapanan %, yeni %)', adv.amount, s, NEW.amount USING ERRCODE = 'ERP20';
    END IF;
    RETURN NEW;
  END IF;

  -- GÜNCELLEME: yalnız bir kez geri alma (reversed_* NULL → dolu); kaynak (bordro/hareket) iptal edilmiş olmalı
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Geri alınmış taksit değiştirilemez' USING ERRCODE = 'ERP20';
  END IF;
  IF NEW.reversed_at IS NULL OR NEW.reverse_reason IS NULL OR length(btrim(NEW.reverse_reason)) < 3
     OR (to_jsonb(NEW) - 'reversed_at' - 'reversed_by' - 'reverse_reason') <> (to_jsonb(OLD) - 'reversed_at' - 'reversed_by' - 'reverse_reason') THEN
    RAISE EXCEPTION 'Avans kapama taksiti yalnızca gerekçeyle geri alınabilir; başka alanı değiştirilemez' USING ERRCODE = 'ERP20';
  END IF;
  IF OLD.kind = 'payroll' THEN
    SELECT status INTO r FROM payroll_runs WHERE id = OLD.payroll_run_id;
    IF r.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'Bordro kesintisi yalnızca bordro iptal edilince geri alınır' USING ERRCODE = 'ERP20';
    END IF;
  ELSIF OLD.kind = 'expense' THEN
    SELECT status INTO r FROM expense_entries WHERE id=OLD.expense_entry_id AND company_id=OLD.company_id;
    IF r.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'Masraf mahsubu yalnızca gider fişi iptal edilince geri alınır' USING ERRCODE='ERP20';
    END IF;
  ELSE
    SELECT status INTO t FROM treasury_transactions WHERE id = OLD.treasury_txn_id;
    IF t.status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'Geri ödeme yalnızca kasa/banka hareketi iptal edilince geri alınır' USING ERRCODE = 'ERP20';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION expense_entries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Gider fişi silinemez; iptal edin' USING ERRCODE = 'ERP19';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'posted' THEN
      RAISE EXCEPTION 'Gider fişi kayıtlı olarak oluşturulur' USING ERRCODE = 'ERP19';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM journal_entries j
       WHERE j.id = NEW.journal_entry_id AND j.company_id = NEW.company_id AND j.status = 'posted'
         AND j.source_type = 'expense_entry' AND j.source_id = NEW.id AND j.reversal_of_id IS NULL
    ) THEN
      RAISE EXCEPTION 'Gider fişinin kaynaklı, kaydedilmiş yevmiyesi olmalı' USING ERRCODE = 'ERP19';
    END IF;
    IF NEW.payment_kind='employee' AND NEW.advance_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM employee_advances a WHERE a.id=NEW.advance_id AND a.company_id=NEW.company_id AND a.employee_id=NEW.employee_id
        AND a.status IN ('open','partial') AND a.advance_date<=NEW.entry_date
        AND NEW.advance_applied_amount<=a.amount-a.settled_amount
    ) THEN
      RAISE EXCEPTION 'Masraf mahsubu personele ait açık avansın kalanını aşamaz' USING ERRCODE='ERP19';
    END IF;
    IF NEW.advance_applied_amount>0 AND NOT EXISTS(
      SELECT 1 FROM journal_lines l JOIN account_mappings m ON m.company_id=NEW.company_id AND m.key='employee_advance' AND m.account_id=l.account_id
       WHERE l.entry_id=NEW.journal_entry_id AND l.credit_base=NEW.advance_applied_amount AND l.debit_base=0
    ) THEN
      RAISE EXCEPTION 'Avans mahsubunun yevmiye karşılığı olmalı' USING ERRCODE='ERP19';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş gider fişi değiştirilemez' USING ERRCODE = 'ERP19';
  END IF;
  IF NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Kaydedilmiş gider fişi değiştirilemez; iptal edip yeniden girin' USING ERRCODE = 'ERP19';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.entry_no <> OLD.entry_no OR NEW.entry_date <> OLD.entry_date OR NEW.card_id <> OLD.card_id
     OR NEW.description <> OLD.description OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.payment_kind <> OLD.payment_kind
     OR NEW.treasury_account_id IS DISTINCT FROM OLD.treasury_account_id OR NEW.net <> OLD.net OR NEW.vat <> OLD.vat
     OR NEW.withholding <> OLD.withholding OR NEW.gross <> OLD.gross OR NEW.payable <> OLD.payable
     OR NEW.document_ref IS DISTINCT FROM OLD.document_ref OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.wbs_id IS DISTINCT FROM OLD.wbs_id OR NEW.cost_code_id IS DISTINCT FROM OLD.cost_code_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.advance_id IS DISTINCT FROM OLD.advance_id
     OR NEW.advance_applied_amount <> OLD.advance_applied_amount OR NEW.journal_entry_id <> OLD.journal_entry_id THEN
    RAISE EXCEPTION 'İptalde yalnızca iptal alanları yazılır' USING ERRCODE = 'ERP19';
  END IF;
  IF coalesce(btrim(NEW.cancel_reason), '') = '' OR NOT EXISTS (
    SELECT 1 FROM journal_entries j WHERE j.id = NEW.cancel_journal_entry_id AND j.reversal_of_id = NEW.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'İptal için neden ve ters yevmiye gerekir' USING ERRCODE = 'ERP19';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION expense_entries_reverse_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE employee_advance_settlements SET reversed_at=now(),reversed_by=nullif(current_setting('app.user_id',true),'')::uuid,
      reverse_reason='Gider fişi iptali '||NEW.entry_no
      WHERE expense_entry_id=NEW.id AND company_id=NEW.company_id AND reversed_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER expense_entries_reverse_advance AFTER UPDATE OF status ON expense_entries FOR EACH ROW EXECUTE FUNCTION expense_entries_reverse_advance();
