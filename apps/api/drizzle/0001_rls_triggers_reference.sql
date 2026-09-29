-- =========================================================================
-- 1) Referans veri: para birimleri (tüm şirketler için ortak)
-- =========================================================================
INSERT INTO currencies (code, name, symbol, minor_units) VALUES
  ('TRY', 'Türk Lirası', '₺', 2),
  ('GBP', 'İngiliz Sterlini', '£', 2),
  ('EUR', 'Euro', '€', 2),
  ('USD', 'ABD Doları', '$', 2);
--> statement-breakpoint

-- =========================================================================
-- 2) Oturum bağlamı: uygulama her işlemin başında set_config(..., true) çağırır
-- =========================================================================
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_company_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;
--> statement-breakpoint

-- =========================================================================
-- 3) Satır Düzeyi Güvenlik (RLS): bağlam yoksa hiçbir satır görünmez
-- =========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_modules', 'exchange_rates', 'tax_rates', 'custom_codes', 'document_sequences',
    'fiscal_periods', 'accounts', 'journal_entries', 'journal_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON companies
  USING (organization_id = app_org_id())
  WITH CHECK (organization_id = app_org_id());
--> statement-breakpoint

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY membership_access ON memberships
  USING (user_id = app_user_id() OR company_id = app_company_id())
  WITH CHECK (
    company_id = app_company_id()
    OR (user_id = app_user_id() AND EXISTS (SELECT 1 FROM companies c WHERE c.id = company_id))
  );
--> statement-breakpoint

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_read ON audit_log FOR SELECT USING (company_id = app_company_id());
--> statement-breakpoint

-- =========================================================================
-- 4) Yetkiler: çalışma zamanı rolü (erp_app) şema sahibi değildir
-- =========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT USAGE ON SCHEMA public TO erp_app;
    GRANT SELECT ON currencies, audit_log TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON organizations, users TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      companies, company_modules, memberships, exchange_rates, tax_rates, custom_codes,
      document_sequences, fiscal_periods, accounts, journal_entries, journal_lines
      TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- =========================================================================
-- 5) Değiştirilemez defter kuralları (ERRCODE ERP01 => API'de 422)
-- =========================================================================
CREATE FUNCTION journal_entries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  p fiscal_periods%ROWTYPE;
  line_count int;
  sum_d numeric;
  sum_c numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Yevmiye önce taslak olarak oluşturulmalı' USING ERRCODE = 'ERP01';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Kaydedilmiş yevmiye silinemez; ters kayıt oluşturun' USING ERRCODE = 'ERP01';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'posted' THEN
    -- Kaydedilmiş yevmiyede yalnızca reversed_by_id (boş -> dolu) değişebilir.
    IF NEW.status <> 'posted'
       OR OLD.reversed_by_id IS NOT NULL
       OR (to_jsonb(NEW) - 'reversed_by_id' - 'updated_at')
          IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_id' - 'updated_at') THEN
      RAISE EXCEPTION 'Kaydedilmiş yevmiye değiştirilemez; ters kayıt oluşturun' USING ERRCODE = 'ERP01';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT * INTO p FROM fiscal_periods WHERE id = NEW.period_id AND company_id = NEW.company_id;
    IF NOT FOUND OR NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
      RAISE EXCEPTION 'Yevmiye tarihi dönemiyle uyuşmuyor' USING ERRCODE = 'ERP01';
    END IF;
    IF p.status <> 'open' THEN
      RAISE EXCEPTION 'Dönem kapalı: %-%', p.year, lpad(p.month::text, 2, '0') USING ERRCODE = 'ERP01';
    END IF;

    SELECT count(*), coalesce(sum(debit_base), 0), coalesce(sum(credit_base), 0)
      INTO line_count, sum_d, sum_c
      FROM journal_lines WHERE entry_id = NEW.id;
    IF line_count < 2 THEN
      RAISE EXCEPTION 'Yevmiye en az iki satır içermeli' USING ERRCODE = 'ERP01';
    END IF;
    IF sum_d <> sum_c THEN
      RAISE EXCEPTION 'Yevmiye dengesiz: borç % <> alacak %', sum_d, sum_c USING ERRCODE = 'ERP01';
    END IF;
    IF sum_d = 0 THEN
      RAISE EXCEPTION 'Yevmiye tutarı sıfır olamaz' USING ERRCODE = 'ERP01';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();
--> statement-breakpoint

CREATE FUNCTION journal_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  s text;
  a accounts%ROWTYPE;
BEGIN
  SELECT status INTO s FROM journal_entries
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
  -- Üst kayıt yoksa (taslak silinirken cascade) izin ver; posted ise engelle.
  IF FOUND AND s <> 'draft' THEN
    -- Tek istisna: kur sonradan girildiğinde BOŞ raporlama tutarları doldurulabilir.
    -- Defter (base) tutarlarına ve dolu raporlama tutarlarına dokunulamaz.
    IF TG_OP = 'UPDATE'
       AND OLD.debit_reporting IS NULL AND OLD.credit_reporting IS NULL
       AND (to_jsonb(NEW) - 'debit_reporting' - 'credit_reporting')
           = (to_jsonb(OLD) - 'debit_reporting' - 'credit_reporting') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Kaydedilmiş yevmiyenin satırları değiştirilemez' USING ERRCODE = 'ERP01';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.entry_id <> OLD.entry_id THEN
    RAISE EXCEPTION 'Satır başka yevmiyeye taşınamaz' USING ERRCODE = 'ERP01';
  END IF;

  SELECT * INTO a FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF NOT a.is_postable THEN
    RAISE EXCEPTION 'Hesaba kayıt atılamaz (alt hesapları var): %', a.code USING ERRCODE = 'ERP01';
  END IF;
  IF NOT a.is_active THEN
    RAISE EXCEPTION 'Pasif hesaba kayıt atılamaz: %', a.code USING ERRCODE = 'ERP01';
  END IF;
  IF a.currency_code IS NOT NULL AND a.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'Hesap % yalnızca % cinsinden hareket görür', a.code, a.currency_code
      USING ERRCODE = 'ERP01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard();
--> statement-breakpoint

-- =========================================================================
-- 6) Denetim izi: yalnızca ekleme; erp_app'in audit_log'a doğrudan yazma yetkisi yok
-- =========================================================================
CREATE FUNCTION audit_row_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  rec jsonb;
  old_rec jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := to_jsonb(OLD);
    old_rec := rec;
  ELSIF TG_OP = 'UPDATE' THEN
    rec := to_jsonb(NEW);
    old_rec := to_jsonb(OLD);
    IF rec = old_rec THEN
      RETURN NULL;
    END IF;
  ELSE
    rec := to_jsonb(NEW);
    old_rec := NULL;
  END IF;

  INSERT INTO audit_log (company_id, user_id, ip, table_name, row_id, action, old_data, new_data)
  VALUES (
    CASE WHEN TG_TABLE_NAME = 'companies' THEN (rec ->> 'id')::uuid
         ELSE nullif(rec ->> 'company_id', '')::uuid END,
    app_user_id(),
    nullif(current_setting('app.ip', true), ''),
    TG_TABLE_NAME,
    rec ->> 'id',
    TG_OP,
    old_rec,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE rec END
  );
  RETURN NULL;
END
$$;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'companies', 'memberships', 'company_modules', 'exchange_rates', 'tax_rates', 'custom_codes',
    'fiscal_periods', 'accounts', 'journal_entries', 'journal_lines'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
