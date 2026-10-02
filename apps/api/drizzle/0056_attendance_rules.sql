-- =========================================================================
-- Puantaj (Faz D2): RLS, yetki, denetim izi, iş kuralları (ERRCODE ERP13; proje etiketi kuralları ERP09).
-- Kapalı ayda puantaj eklenemez/değiştirilemez/silinemez (sahip rolü dahil); kapalı ay yalnızca gerekçeyle açılır.
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_entries', 'attendance_months'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_entries TO erp_app;
    -- Kapanış kaydı silinmez: kapalı ay "açılır", geçmişi satırda ve denetim izinde kalır
    GRANT SELECT, INSERT, UPDATE ON attendance_months TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Yardımcı: kapalı ay denetimi. Ayın paylaşımlı danışma kilidini alır; kapatan işlem aynı anahtarın özel kilidini alır
-- (attendance_months_guard), böylece "ayı kapat" ile uçuştaki bir puantaj yazımı yarışamaz (yazım ya kapanıştan önce biter
-- ya da kapanışı görür).
CREATE FUNCTION attendance_month_assert_open(p_company uuid, p_date date) RETURNS void LANGUAGE plpgsql AS
$$
DECLARE
  m text := to_char(p_date, 'YYYY-MM');
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('hr-attendance-month|' || p_company::text || '|' || m, 0));
  IF EXISTS (SELECT 1 FROM attendance_months WHERE company_id = p_company AND month = m AND status = 'closed') THEN
    RAISE EXCEPTION 'Puantaj ayı kapalı (%); kayıt eklenemez, değiştirilemez veya silinemez', m USING ERRCODE = 'ERP13';
  END IF;
END
$$;
--> statement-breakpoint

-- Puantaj kaydı: kapalı ay yazılmaz; personel + tarih değişmez; tarih personelin işe giriş..çıkış aralığında olmalı;
-- proje etiketi (açık proje, projeye ait yaprak iş kalemi) yalnızca etiket eklenirken/değişirken denetlenir.
CREATE FUNCTION attendance_entries_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  e employees%ROWTYPE;
  pr projects%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM attendance_month_assert_open(OLD.company_id, OLD.work_date);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.employee_id <> OLD.employee_id OR NEW.work_date <> OLD.work_date) THEN
    RAISE EXCEPTION 'Puantaj kaydının personeli ve tarihi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  PERFORM attendance_month_assert_open(NEW.company_id, NEW.work_date);

  SELECT * INTO e FROM employees WHERE id = NEW.employee_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personel bulunamadı' USING ERRCODE = 'ERP13';
  END IF;
  IF e.hire_date IS NULL THEN
    RAISE EXCEPTION '% personelinin işe giriş tarihi girilmemiş; puantaj yazılamaz', e.code USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.work_date < e.hire_date OR (e.leave_date IS NOT NULL AND NEW.work_date > e.leave_date) THEN
    RAISE EXCEPTION '% personeli % tarihinde çalışma aralığında değil (işe giriş %, çıkış %)',
      e.code, NEW.work_date, e.hire_date, coalesce(e.leave_date::text, '—') USING ERRCODE = 'ERP13';
  END IF;

  IF NEW.project_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.wbs_id IS DISTINCT FROM OLD.wbs_id) THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Proje bulunamadı' USING ERRCODE = 'ERP09';
    END IF;
    IF pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye (%) puantaj etiketi yazılamaz', pr.code USING ERRCODE = 'ERP09';
    END IF;
    IF NEW.wbs_id IS NOT NULL THEN
      PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, true);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER attendance_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON attendance_entries
  FOR EACH ROW EXECUTE FUNCTION attendance_entries_guard();
--> statement-breakpoint

-- Personel: çıkış tarihinden sonra puantaj kaydı kalamaz (çıkış tarihi puantaj aralığını daraltamaz).
-- İşe giriş tarihine bakılmaz: yeniden işe almada tek işe giriş/çıkış tarihi tutulduğundan önceki dönemin kayıtları geçerlidir.
CREATE FUNCTION employees_attendance_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.leave_date IS NOT NULL AND NEW.leave_date IS DISTINCT FROM OLD.leave_date
     AND EXISTS (SELECT 1 FROM attendance_entries a WHERE a.employee_id = NEW.id AND a.work_date > NEW.leave_date) THEN
    RAISE EXCEPTION '% personelinin çıkış tarihinden (%) sonra puantaj kaydı var; önce o kayıtlar silinmeli', NEW.code, NEW.leave_date USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employees_attendance_guard
  BEFORE UPDATE OF leave_date ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_attendance_guard();
--> statement-breakpoint

-- Aylık kapanış: silinmez; ay/şirket değişmez; yalnız kapalı → açık (gerekçe + kullanıcı zorunlu) ve açık → kapalı geçişi;
-- kayıttaki kullanıcı oturumdaki kullanıcıdır (başkası adına kapatılamaz/açılamaz). Özel danışma kilidi: bkz. attendance_month_assert_open.
CREATE FUNCTION attendance_months_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  who text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Puantaj kapanış kaydı silinemez; ayı yeniden açın' USING ERRCODE = 'ERP13';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hr-attendance-month|' || NEW.company_id::text || '|' || NEW.month, 0));

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'closed' OR NEW.reopen_count <> 0 OR NEW.reopened_at IS NOT NULL THEN
      RAISE EXCEPTION 'Puantaj ayı kapalı olarak kaydedilir' USING ERRCODE = 'ERP13';
    END IF;
    IF who IS NOT NULL AND NEW.closed_by::text IS DISTINCT FROM who THEN
      RAISE EXCEPTION 'Kapanış yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.month <> OLD.month OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Kapanış kaydının ayı ve şirketi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    IF NEW.reopen_reason IS NULL OR length(btrim(NEW.reopen_reason)) < 3 OR NEW.reopened_by IS NULL OR NEW.reopened_at IS NULL THEN
      RAISE EXCEPTION 'Kapalı puantaj ayı gerekçe ve kullanıcı olmadan açılamaz' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.reopen_count <> OLD.reopen_count + 1 THEN
      RAISE EXCEPTION 'Yeniden açma sayacı bir artmalı' USING ERRCODE = 'ERP13';
    END IF;
    IF who IS NOT NULL AND NEW.reopened_by::text <> who THEN
      RAISE EXCEPTION 'Yeniden açma yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
    END IF;
  ELSIF OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF NEW.closed_by IS NULL OR NEW.reopen_count <> OLD.reopen_count THEN
      RAISE EXCEPTION 'Puantaj ayı kapatılırken kullanıcı gerekir' USING ERRCODE = 'ERP13';
    END IF;
    IF who IS NOT NULL AND NEW.closed_by::text <> who THEN
      RAISE EXCEPTION 'Kapanış yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
    END IF;
  ELSE
    RAISE EXCEPTION 'Kapanış kaydı durum değiştirmeden güncellenemez' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER attendance_months_guard
  BEFORE INSERT OR UPDATE OR DELETE ON attendance_months
  FOR EACH ROW EXECUTE FUNCTION attendance_months_guard();
--> statement-breakpoint

-- İş kalemi/proje "kaydı var mı" yardımcıları puantaj etiketini de sayar (etiketli iş kalemine alt iş eklenemez,
-- işçilik etiketi olan proje silinemez/iptal edilemez).
CREATE OR REPLACE FUNCTION project_wbs_has_postings(p_wbs uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$
  SELECT EXISTS (SELECT 1 FROM journal_lines WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM invoice_lines WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM stock_movements WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM project_budget_lines WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM project_progress WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM attendance_entries WHERE wbs_id = p_wbs)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_has_postings(p_project uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$
  SELECT EXISTS (SELECT 1 FROM journal_lines WHERE project_id = p_project)
      OR EXISTS (SELECT 1 FROM invoice_lines WHERE project_id = p_project)
      OR EXISTS (SELECT 1 FROM stock_movements WHERE project_id = p_project)
      OR EXISTS (SELECT 1 FROM attendance_entries WHERE project_id = p_project)
$$;
