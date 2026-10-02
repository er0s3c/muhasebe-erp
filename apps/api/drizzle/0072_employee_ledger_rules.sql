-- =========================================================================
-- Personel cari ve avans takibi (Faz X5): RLS, yetki, denetim izi, hesap eşlemesi geri doldurma ve iş kuralları.
-- Kurallar ERRCODE ERP20 ile yükselir (API'de 422 EMPLOYEE_LEDGER_RULE_VIOLATION).
-- Avans kapama taksitleri yalnız eklenir (iptal = reversed_* alanları bir kez dolar); kapanan tutar ve durum taksitlerden türetilir,
-- her durum geçişi aynı işlemde olay kaydı yazar. Hesap eşlemesi varsayılanı (196) DOĞRULANMAMIŞTIR.
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_ledger_settings', 'employee_advances', 'employee_advance_settlements', 'employee_advance_deductions', 'employee_advance_events', 'employee_salary_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON employee_ledger_settings, employee_advances, employee_advance_settlements TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON employee_advance_deductions TO erp_app;
    GRANT SELECT, INSERT ON employee_advance_events, employee_salary_payments TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Mevcut şirketler için personel avansları hesabı (varsayılan 196; doğrulanmamıştır)
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, 'employee_advance', a.id
FROM companies c
JOIN accounts a ON a.company_id = c.id AND a.code = '196'
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- ---- Personel kartı ve cari bağlantısı -------------------------------------------------------------------------------
CREATE FUNCTION employees_party_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  k text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.party_id IS NOT NULL THEN
      RAISE EXCEPTION 'Personel carisi kart açıldıktan sonra "cari aç" ile bağlanır' USING ERRCODE = 'ERP20';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.party_id IS DISTINCT FROM OLD.party_id THEN
    IF OLD.party_id IS NOT NULL THEN
      RAISE EXCEPTION 'Personel carisi bağlandıktan sonra değiştirilemez' USING ERRCODE = 'ERP20';
    END IF;
    SELECT kind INTO k FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF k IS DISTINCT FROM 'employee' THEN
      RAISE EXCEPTION 'Personele yalnızca "personel" türünde cari bağlanır' USING ERRCODE = 'ERP20';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employees_party_guard
  BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_party_guard();
--> statement-breakpoint

-- Personel türündeki cari: türü değişmez, silinmez; başka türdeki cari personel türüne çevrilemez
CREATE FUNCTION parties_employee_kind_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'employee' THEN
      RAISE EXCEPTION 'Personel carisi silinemez' USING ERRCODE = 'ERP20';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (OLD.kind = 'employee' OR NEW.kind = 'employee') THEN
    RAISE EXCEPTION 'Personel carisinin türü değiştirilemez; personel türü yalnızca personel kartından açılır' USING ERRCODE = 'ERP20';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER parties_employee_kind_guard
  BEFORE UPDATE OR DELETE ON parties
  FOR EACH ROW EXECUTE FUNCTION parties_employee_kind_guard();
--> statement-breakpoint

-- Personel türündeki cari ticari yevmiye satırında (müşteri/tedarikçi cari hesabı) kullanılamaz
CREATE FUNCTION journal_lines_employee_party_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.party_id IS NOT NULL AND EXISTS (SELECT 1 FROM parties p WHERE p.id = NEW.party_id AND p.kind = 'employee') THEN
    RAISE EXCEPTION 'Personel carisi müşteri/tedarikçi cari hesabında kullanılamaz; personel hareketleri Personel cari ekranından girilir' USING ERRCODE = 'ERP20';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_employee_party_guard
  BEFORE INSERT ON journal_lines
  FOR EACH ROW WHEN (NEW.party_id IS NOT NULL) EXECUTE FUNCTION journal_lines_employee_party_guard();
--> statement-breakpoint

-- ---- Avans ----------------------------------------------------------------------------------------------------------
CREATE FUNCTION employee_advances_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  t record;
  s numeric;
  expected text;
  who text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Personel avansı silinemez; iptal edin' USING ERRCODE = 'ERP20';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.settled_amount <> 0 THEN
      RAISE EXCEPTION 'Avans açık ve kapanmamış olarak oluşturulur' USING ERRCODE = 'ERP20';
    END IF;
    SELECT type, status, amount, account_id, txn_date INTO t FROM treasury_transactions WHERE id = NEW.treasury_txn_id AND company_id = NEW.company_id;
    IF NOT FOUND OR t.type <> 'other_payment' OR t.status <> 'posted' OR t.amount <> NEW.amount
       OR t.account_id <> NEW.treasury_account_id OR t.txn_date <> NEW.advance_date THEN
      RAISE EXCEPTION 'Avans, aynı tutar/tarih/hesapla kaydedilmiş bir kasa/banka ödemesine bağlı olmalı' USING ERRCODE = 'ERP20';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.number <> OLD.number OR NEW.employee_id <> OLD.employee_id
     OR NEW.advance_date <> OLD.advance_date OR NEW.amount <> OLD.amount OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.treasury_account_id <> OLD.treasury_account_id OR NEW.treasury_txn_id <> OLD.treasury_txn_id
     OR NEW.purpose <> OLD.purpose OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Avansın personeli, tutarı, tarihi, amacı, projesi ve ödeme hareketi değiştirilemez' USING ERRCODE = 'ERP20';
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş avans değiştirilemez' USING ERRCODE = 'ERP20';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO s FROM employee_advance_settlements WHERE advance_id = NEW.id AND reversed_at IS NULL;
  IF NEW.settled_amount <> s THEN
    RAISE EXCEPTION 'Kapanan tutar taksit satırlarının toplamıyla tutarlı olmalı' USING ERRCODE = 'ERP20';
  END IF;
  IF NEW.settled_amount > NEW.amount THEN
    RAISE EXCEPTION 'Kapanan tutar avans tutarını aşamaz' USING ERRCODE = 'ERP20';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF NEW.settled_amount <> 0 THEN
      RAISE EXCEPTION 'Kapanmış tutarı olan avans iptal edilemez; önce kesinti/geri ödemeyi geri alın' USING ERRCODE = 'ERP20';
    END IF;
    IF NEW.cancel_reason IS NULL OR length(btrim(NEW.cancel_reason)) < 3 OR NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL THEN
      RAISE EXCEPTION 'Avans iptali gerekçe ve kullanıcı ister' USING ERRCODE = 'ERP20';
    END IF;
    IF who IS NOT NULL AND NEW.cancelled_by::text <> who THEN
      RAISE EXCEPTION 'İptal yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP20';
    END IF;
    RETURN NEW;
  END IF;

  expected := CASE WHEN NEW.settled_amount = 0 THEN 'open' WHEN NEW.settled_amount < NEW.amount THEN 'partial' ELSE 'settled' END;
  IF NEW.status <> expected THEN
    RAISE EXCEPTION 'Avans durumu kapanan tutarla uyumsuz (beklenen %)', expected USING ERRCODE = 'ERP20';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_advances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON employee_advances
  FOR EACH ROW EXECUTE FUNCTION employee_advances_guard();
--> statement-breakpoint

-- Durum geçmişi: avans açılışı ve her durum geçişi aynı işlemde olay yazar
CREATE FUNCTION employee_advances_events_write() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO employee_advance_events (id, company_id, advance_id, from_status, to_status, settled_amount, created_by)
    VALUES (gen_random_uuid(), NEW.company_id, NEW.id, NULL, NEW.status, NEW.settled_amount, nullif(current_setting('app.user_id', true), '')::uuid);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO employee_advance_events (id, company_id, advance_id, from_status, to_status, settled_amount, created_by)
    VALUES (gen_random_uuid(), NEW.company_id, NEW.id, OLD.status, NEW.status, NEW.settled_amount, nullif(current_setting('app.user_id', true), '')::uuid);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_advances_events_write
  AFTER INSERT OR UPDATE ON employee_advances
  FOR EACH ROW EXECUTE FUNCTION employee_advances_events_write();
--> statement-breakpoint

CREATE FUNCTION employee_advance_events_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Avans geçmişi değiştirilemez' USING ERRCODE = 'ERP20';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_advance_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON employee_advance_events
  FOR EACH ROW EXECUTE FUNCTION employee_advance_events_guard();
--> statement-breakpoint

-- ---- Avans kapama taksitleri (yalnız eklenir) ---------------------------------------------------------------------
CREATE FUNCTION employee_advance_settlements_guard() RETURNS trigger LANGUAGE plpgsql AS
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
CREATE TRIGGER employee_advance_settlements_guard
  BEFORE INSERT OR UPDATE OR DELETE ON employee_advance_settlements
  FOR EACH ROW EXECUTE FUNCTION employee_advance_settlements_guard();
--> statement-breakpoint

-- Taksit eklenince/geri alınınca avansın kapanan tutarı ve durumu türetilir (durum geçmişi avans tetikleyicisinde yazılır)
CREATE FUNCTION employee_advance_settlements_apply() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  s numeric;
  a numeric;
BEGIN
  SELECT coalesce(sum(amount), 0) INTO s FROM employee_advance_settlements WHERE advance_id = NEW.advance_id AND reversed_at IS NULL;
  SELECT amount INTO a FROM employee_advances WHERE id = NEW.advance_id;
  UPDATE employee_advances
     SET settled_amount = s,
         status = CASE WHEN s = 0 THEN 'open' WHEN s < a THEN 'partial' ELSE 'settled' END,
         updated_at = now()
   WHERE id = NEW.advance_id AND status <> 'cancelled';
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_advance_settlements_apply
  AFTER INSERT OR UPDATE ON employee_advance_settlements
  FOR EACH ROW EXECUTE FUNCTION employee_advance_settlements_apply();
--> statement-breakpoint

-- Bordro iptal edilince o bordrodaki avans kesintisi taksitleri aynı işlemde geri alınır
CREATE FUNCTION payroll_runs_reverse_advance_deductions() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE employee_advance_settlements
       SET reversed_at = now(), reversed_by = nullif(current_setting('app.user_id', true), '')::uuid, reverse_reason = 'Bordro iptali ' || NEW.number
     WHERE payroll_run_id = NEW.id AND reversed_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_reverse_advance_deductions
  AFTER UPDATE OF status ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_runs_reverse_advance_deductions();
--> statement-breakpoint

-- Avansı ödeyen kasa/banka hareketi doğrudan iptal edilemez (avans önce Personel cari ekranından iptal edilir);
-- geri ödeme tahsilatı iptal edilince bağlı taksit aynı işlemde geri alınır.
CREATE FUNCTION treasury_transactions_employee_block() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
     AND EXISTS (SELECT 1 FROM employee_advances a WHERE a.treasury_txn_id = NEW.id AND a.status <> 'cancelled') THEN
    RAISE EXCEPTION 'Bu hareket bir personel avansına bağlı; avansı Personel cari ekranından iptal edin' USING ERRCODE = 'ERP20';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER treasury_transactions_employee_block
  BEFORE UPDATE OF status ON treasury_transactions
  FOR EACH ROW EXECUTE FUNCTION treasury_transactions_employee_block();
--> statement-breakpoint
CREATE FUNCTION treasury_transactions_reverse_repayments() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE employee_advance_settlements
       SET reversed_at = now(), reversed_by = nullif(current_setting('app.user_id', true), '')::uuid, reverse_reason = 'Geri ödeme hareketi iptali ' || NEW.txn_no
     WHERE treasury_txn_id = NEW.id AND reversed_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER treasury_transactions_reverse_repayments
  AFTER UPDATE OF status ON treasury_transactions
  FOR EACH ROW EXECUTE FUNCTION treasury_transactions_reverse_repayments();
--> statement-breakpoint

-- ---- Taslak bordro avans kesintisi planı --------------------------------------------------------------------------
CREATE FUNCTION employee_advance_deductions_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st text;
  adv employee_advances%ROWTYPE;
  rid uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
BEGIN
  SELECT status INTO st FROM payroll_runs WHERE id = rid;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Onaylanmış bordronun avans kesintileri değiştirilemez' USING ERRCODE = 'ERP20';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.run_id <> OLD.run_id OR NEW.advance_id <> OLD.advance_id OR NEW.employee_id <> OLD.employee_id) THEN
    RAISE EXCEPTION 'Avans kesintisinin bordrosu, avansı ve personeli değiştirilemez' USING ERRCODE = 'ERP20';
  END IF;
  SELECT * INTO adv FROM employee_advances WHERE id = NEW.advance_id AND company_id = NEW.company_id;
  IF NOT FOUND OR adv.employee_id <> NEW.employee_id THEN
    RAISE EXCEPTION 'Avans bu personele ait değil' USING ERRCODE = 'ERP20';
  END IF;
  IF adv.status NOT IN ('open', 'partial') THEN
    RAISE EXCEPTION 'Yalnızca açık ya da kısmen kapanmış avanstan kesinti yapılır' USING ERRCODE = 'ERP20';
  END IF;
  IF NEW.amount > adv.amount - adv.settled_amount THEN
    RAISE EXCEPTION 'Kesinti, avansın kalan tutarını aşamaz' USING ERRCODE = 'ERP20';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_advance_deductions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON employee_advance_deductions
  FOR EACH ROW EXECUTE FUNCTION employee_advance_deductions_guard();
--> statement-breakpoint

-- ---- Net maaş ödemesi bağlantısı (yalnız eklenir) ---------------------------------------------------------------------
CREATE FUNCTION employee_salary_payments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  t record;
  r record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Maaş ödemesi kaydı değiştirilemez ya da silinemez; kasa/banka hareketi iptal edilir' USING ERRCODE = 'ERP20';
  END IF;
  SELECT type, status, amount, txn_date INTO t FROM treasury_transactions WHERE id = NEW.treasury_txn_id AND company_id = NEW.company_id;
  IF NOT FOUND OR t.type <> 'other_payment' OR t.status <> 'posted' OR t.amount <> NEW.amount OR t.txn_date <> NEW.pay_date THEN
    RAISE EXCEPTION 'Maaş ödemesi, aynı tutar/tarihle kaydedilmiş bir kasa/banka ödemesine bağlı olmalı' USING ERRCODE = 'ERP20';
  END IF;
  IF NEW.payroll_run_id IS NOT NULL THEN
    SELECT status INTO r FROM payroll_runs WHERE id = NEW.payroll_run_id AND company_id = NEW.company_id;
    IF NOT FOUND OR r.status NOT IN ('approved', 'paid') THEN
      RAISE EXCEPTION 'Maaş ödemesi onaylı bordroya bağlanır' USING ERRCODE = 'ERP20';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM payroll_lines l WHERE l.run_id = NEW.payroll_run_id AND l.employee_id = NEW.employee_id) THEN
      RAISE EXCEPTION 'Personel bu bordroda yok' USING ERRCODE = 'ERP20';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_salary_payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON employee_salary_payments
  FOR EACH ROW EXECUTE FUNCTION employee_salary_payments_guard();
