-- =========================================================================
-- Yıl sonu kapanışı ve devir (Faz Y1): RLS, yetki, denetim izi ve iş kuralları (ERRCODE ERP23).
-- Hesap eşlemeleri ve yöntem doğrulanmamıştır (docs/LEGAL-NOTES.md §23).
-- =========================================================================

ALTER TABLE fiscal_years ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON fiscal_years
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE fiscal_year_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON fiscal_year_events
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fiscal_years', 'fiscal_year_events'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal_years TO erp_app;
    GRANT SELECT, INSERT ON fiscal_year_events TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Mevcut şirketler için yıl sonu hesap eşlemeleri (varsayılanlar doğrulanmamıştır):
-- 590 dönem net kârı, 591 dönem net zararı, 570 geçmiş yıllar kârları, 580 geçmiş yıllar zararları
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES ('year_end_profit', '590'), ('year_end_loss', '591'), ('year_end_retained_profit', '570'), ('year_end_retained_loss', '580')) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- ---- Mali yıl ----------------------------------------------------------------------------------------------------------
-- Ekleme: açık, tam aylara oturan (ayın 1'i - ayın son günü), en çok 12 ay, çakışmayan aralık.
-- Güncelleme: tarihler değişmez. açık -> kapalı: yılın tüm ayları tanımlı ve kapalı, önceki mali yıllar kapalı (katı sıra), taslak yevmiye yok.
-- kapalı -> açık: gerekçe zorunlu ve sonraki bir mali yıl kapalı olamaz (katı sıra). Kapalı yıl başka türlü değiştirilemez.
CREATE FUNCTION fiscal_years_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  n_months int;
  n_found int;
  n_not_closed int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'open' OR EXISTS (SELECT 1 FROM fiscal_year_events e WHERE e.fiscal_year_id = OLD.id) THEN
      RAISE EXCEPTION 'Kapatılmış ya da kapanış geçmişi olan mali yıl silinemez' USING ERRCODE = 'ERP23';
    END IF;
    RETURN OLD;
  END IF;

  n_months := (extract(year FROM NEW.end_date)::int * 12 + extract(month FROM NEW.end_date)::int)
            - (extract(year FROM NEW.start_date)::int * 12 + extract(month FROM NEW.start_date)::int) + 1;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'Mali yıl açık olarak oluşturulur' USING ERRCODE = 'ERP23';
    END IF;
    IF NEW.start_date <> date_trunc('month', NEW.start_date)::date
       OR NEW.end_date <> (date_trunc('month', NEW.end_date) + interval '1 month' - interval '1 day')::date THEN
      RAISE EXCEPTION 'Mali yıl tam aylara oturmalı: başlangıç ayın 1''i, bitiş ayın son günü olmalı' USING ERRCODE = 'ERP23';
    END IF;
    IF n_months > 12 THEN
      RAISE EXCEPTION 'Mali yıl en çok 12 ay olabilir' USING ERRCODE = 'ERP23';
    END IF;
    IF EXISTS (
      SELECT 1 FROM fiscal_years f
       WHERE f.company_id = NEW.company_id AND f.start_date <= NEW.end_date AND f.end_date >= NEW.start_date
    ) THEN
      RAISE EXCEPTION 'Mali yıl başka bir mali yılla çakışıyor' USING ERRCODE = 'ERP23';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date THEN
    RAISE EXCEPTION 'Mali yılın tarihleri değiştirilemez' USING ERRCODE = 'ERP23';
  END IF;

  IF OLD.status = 'closed' AND NEW.status = 'closed' THEN
    RAISE EXCEPTION 'Kapalı mali yıl değiştirilemez; önce yeniden açın' USING ERRCODE = 'ERP23';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'open' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    SELECT count(*), count(*) FILTER (WHERE p.status <> 'closed') INTO n_found, n_not_closed
      FROM fiscal_periods p
     WHERE p.company_id = NEW.company_id AND p.start_date >= NEW.start_date AND p.end_date <= NEW.end_date;
    IF n_found <> n_months OR n_not_closed > 0 THEN
      RAISE EXCEPTION 'Mali yılın tüm dönemleri tanımlı ve kapalı olmalı' USING ERRCODE = 'ERP23';
    END IF;
    IF EXISTS (
      SELECT 1 FROM fiscal_years f
       WHERE f.company_id = NEW.company_id AND f.end_date < NEW.start_date AND f.status <> 'closed'
    ) THEN
      RAISE EXCEPTION 'Önce önceki mali yıl kapatılmalı (kapanış sırası zorunlu)' USING ERRCODE = 'ERP23';
    END IF;
    IF EXISTS (
      SELECT 1 FROM journal_entries e
       WHERE e.company_id = NEW.company_id AND e.status = 'draft' AND e.entry_date BETWEEN NEW.start_date AND NEW.end_date
    ) THEN
      RAISE EXCEPTION 'Yılda taslak yevmiye var; kaydedin veya silin' USING ERRCODE = 'ERP23';
    END IF;
    RETURN NEW;
  END IF;

  -- kapalı -> açık
  IF NEW.reopen_reason IS NULL OR length(btrim(NEW.reopen_reason)) < 5 THEN
    RAISE EXCEPTION 'Mali yılı yeniden açmak için gerekçe zorunlu (en az 5 karakter)' USING ERRCODE = 'ERP23';
  END IF;
  IF EXISTS (
    SELECT 1 FROM fiscal_years f
     WHERE f.company_id = NEW.company_id AND f.start_date > OLD.end_date AND f.status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Sonraki mali yıl kapalı; önce onu yeniden açın (sıra zorunlu)' USING ERRCODE = 'ERP23';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER fiscal_years_guard
  BEFORE INSERT OR UPDATE OR DELETE ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION fiscal_years_guard();
--> statement-breakpoint

-- Olay geçmişi salt eklenir.
CREATE FUNCTION fiscal_year_events_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'Mali yıl olay geçmişi değiştirilemez ve silinemez' USING ERRCODE = 'ERP23';
END
$$;
--> statement-breakpoint
CREATE TRIGGER fiscal_year_events_guard
  BEFORE UPDATE OR DELETE ON fiscal_year_events
  FOR EACH ROW EXECUTE FUNCTION fiscal_year_events_guard();
--> statement-breakpoint

-- Kapalı mali yıla tarihli yevmiye kaydedilemez (ham SQL ve tablo sahibi dahil: tetikleyici sahibe de uygulanır).
CREATE FUNCTION journal_entries_year_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status <> 'posted') THEN
    IF EXISTS (
      SELECT 1 FROM fiscal_years f
       WHERE f.company_id = NEW.company_id AND f.status = 'closed' AND NEW.entry_date BETWEEN f.start_date AND f.end_date
    ) THEN
      RAISE EXCEPTION 'Mali yıl kapalı (%): bu tarihe kayıt yapılamaz', NEW.entry_date USING ERRCODE = 'ERP23';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_year_guard
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_year_guard();
--> statement-breakpoint

-- Kapalı mali yılın dönemi yeniden açılamaz ve silinemez (yeniden açma yalnızca mali yılı yeniden açarak).
CREATE FUNCTION fiscal_periods_year_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.status = 'closed' AND NEW.status <> 'closed')) THEN
    IF EXISTS (
      SELECT 1 FROM fiscal_years f
       WHERE f.company_id = OLD.company_id AND f.status = 'closed' AND OLD.start_date >= f.start_date AND OLD.end_date <= f.end_date
    ) THEN
      RAISE EXCEPTION 'Dönem kapalı bir mali yıla ait: önce mali yılı yeniden açın' USING ERRCODE = 'ERP23';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER fiscal_periods_year_guard
  BEFORE UPDATE OR DELETE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION fiscal_periods_year_guard();
--> statement-breakpoint

-- Proje etiketi koruması (0024): kapanış/devir fişleri (kaynak year_end_*) önceki yıl satırlarının proje/iş kalemi boyutunu
-- AYNEN taşır ve tamamlanmış projeyi de nötrlemelidir; ters kayıt gibi muaftır. Diğer kurallar aynıdır.
CREATE OR REPLACE FUNCTION journal_lines_project_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  acc_type text;
  pr projects%ROWTYPE;
  rev uuid;
  src text;
  neutralizing boolean;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NEW.wbs_id IS NOT DISTINCT FROM OLD.wbs_id THEN
    RETURN NEW;
  END IF;

  SELECT type INTO acc_type FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF acc_type IS NULL OR acc_type NOT IN ('income', 'expense', 'cost') THEN
    RAISE EXCEPTION 'Proje yalnızca gelir, gider ve maliyet hesaplarına etiketlenebilir' USING ERRCODE = 'ERP09';
  END IF;

  SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proje bulunamadı' USING ERRCODE = 'ERP09';
  END IF;

  SELECT reversal_of_id, source_type INTO rev, src FROM journal_entries WHERE id = NEW.entry_id AND company_id = NEW.company_id;
  neutralizing := rev IS NOT NULL OR coalesce(src IN ('year_end_close', 'year_end_carry'), false);
  IF pr.status IN ('completed', 'cancelled') AND NOT neutralizing THEN
    RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye (%) yeni satır yazılamaz', pr.code USING ERRCODE = 'ERP09';
  END IF;

  IF NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, NOT neutralizing);
  END IF;
  RETURN NEW;
END
$$;
