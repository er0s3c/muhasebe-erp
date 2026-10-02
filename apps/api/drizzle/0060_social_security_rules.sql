-- =========================================================================
-- Sosyal güvenlik çıktıları (Faz D4): RLS, yetki, denetim izi, iş kuralları (ERRCODE ERP13 → HR_RULE_VIOLATION).
-- Destek kuralı değeri/tarihi sonradan değişmez; kullanılmış kural silinmez. Bildirim yalnızca onaylı/ödenmiş bordrodan üretilir;
-- kesinleşmiş bildirim değişmez ve o ay için bordro iptalini ve puantaj ayı açılmasını engeller. Oran/koşul/format DOĞRULANMAMIŞTIR.
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_social_profiles', 'social_support_rules', 'employee_support_eligibility', 'social_declarations', 'social_declaration_lines'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON social_support_rules, social_declarations TO erp_app;
    -- Profil ve uygunluk değiştirilmez: düzeltme = sil + yeniden ekle (denetim izinde); bildirim satırı yalnızca taslakta yazılır/silinir
    GRANT SELECT, INSERT, DELETE ON employee_social_profiles, employee_support_eligibility, social_declaration_lines TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Destek kuralı: kod, tarih, hedef, kip ve değer sonradan değişmez (yeni tarihli satır eklenir); bildirimde kullanılmış kural silinmez
CREATE FUNCTION social_support_rules_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM social_declarations d WHERE d.company_id = OLD.company_id AND d.status = 'finalized'
               AND d.support_snapshot @> jsonb_build_array(jsonb_build_object('ruleId', OLD.id::text))) THEN
      RAISE EXCEPTION 'Kesinleşmiş bildirimde kullanılan destek kuralı silinemez' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.code <> OLD.code OR NEW.effective_from <> OLD.effective_from OR NEW.target <> OLD.target OR NEW.mode <> OLD.mode
     OR NEW.value <> OLD.value OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Destek kuralının kodu, tarihi, hedefi, kipi ve değeri değiştirilemez; yeni tarihli satır ekleyin' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER social_support_rules_guard
  BEFORE UPDATE OR DELETE ON social_support_rules
  FOR EACH ROW EXECUTE FUNCTION social_support_rules_guard();
--> statement-breakpoint

-- Sosyal güvenlik profili: ekleme/silme yalnızca; işe giriş tarihinden önceki sigorta başlangıcı kabul edilmez
CREATE FUNCTION employee_social_profiles_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  e employees%ROWTYPE;
BEGIN
  SELECT * INTO e FROM employees WHERE id = NEW.employee_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personel bulunamadı' USING ERRCODE = 'ERP13';
  END IF;
  IF NEW.ssn_enc IS NOT NULL AND NEW.ssn_last4 IS NULL THEN
    RAISE EXCEPTION 'Şifreli numaranın maskeli son haneleri de yazılmalı' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_social_profiles_guard
  BEFORE INSERT ON employee_social_profiles
  FOR EACH ROW EXECUTE FUNCTION employee_social_profiles_guard();
--> statement-breakpoint

-- Bildirim satırları yalnızca TASLAK bildirimde yazılır/silinir
CREATE FUNCTION social_assert_declaration_draft(p_decl uuid) RETURNS void LANGUAGE plpgsql AS
$$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM social_declarations WHERE id = p_decl;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Kesinleşmiş bildirimin satırları değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION social_declaration_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM social_assert_declaration_draft(OLD.declaration_id);
    RETURN OLD;
  END IF;
  PERFORM social_assert_declaration_draft(NEW.declaration_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER social_declaration_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON social_declaration_lines
  FOR EACH ROW EXECUTE FUNCTION social_declaration_lines_guard();
--> statement-breakpoint

-- Bildirim
-- Durum geçişleri: taslak → kesinleşmiş (kaynak bordro onaylı/ödenmiş ve aynı ayda; toplamlar satırlarla tutarlı; kullanıcı oturumdan),
-- kesinleşmiş → taslak (gerekçe + sayaç). Kesinleşmiş içerik değişmez; yalnız taslak silinir. Onay anında bordro satırı paylaşım
-- kilidiyle tutulur: "bordroyu iptal et" ile "bildirimi kesinleştir" yarışamaz.
CREATE FUNCTION social_declarations_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  who text := nullif(current_setting('app.user_id', true), '');
  r payroll_runs%ROWTYPE;
  s record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Yalnızca taslak bildirim silinir; kesinleşmiş bildirim önce yeniden açılır' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Bildirim taslak olarak açılır' USING ERRCODE = 'ERP13';
    END IF;
    SELECT * INTO r FROM payroll_runs WHERE id = NEW.payroll_run_id AND company_id = NEW.company_id;
    IF NOT FOUND OR r.month <> NEW.month OR r.status NOT IN ('approved', 'paid') THEN
      RAISE EXCEPTION 'Bildirim yalnızca aynı ayın onaylı ya da ödenmiş bordrosundan üretilir' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.number <> OLD.number OR NEW.month <> OLD.month OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Bildirimin numarası, ayı ve şirketi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;

  IF OLD.status = 'finalized' AND NEW.status = 'finalized'
     AND (NEW.payroll_run_id <> OLD.payroll_run_id OR NEW.employee_count <> OLD.employee_count OR NEW.premium_base_total <> OLD.premium_base_total
          OR NEW.employee_premium_total <> OLD.employee_premium_total OR NEW.employer_premium_total <> OLD.employer_premium_total
          OR NEW.support_employee_total <> OLD.support_employee_total OR NEW.support_employer_total <> OLD.support_employer_total
          OR NEW.support_snapshot <> OLD.support_snapshot OR NEW.has_unverified_params <> OLD.has_unverified_params) THEN
    RAISE EXCEPTION 'Kesinleşmiş bildirimin içeriği değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    RETURN NEW;
  ELSIF OLD.status = 'draft' AND NEW.status = 'finalized' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hr-attendance-month|' || NEW.company_id::text || '|' || NEW.month, 0));
    SELECT * INTO r FROM payroll_runs WHERE id = NEW.payroll_run_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR r.month <> NEW.month OR r.status NOT IN ('approved', 'paid') THEN
      RAISE EXCEPTION 'Kaynak bordro onaylı ya da ödenmiş değil; bildirim kesinleştirilemez' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.finalized_by IS NULL OR NEW.finalized_at IS NULL THEN
      RAISE EXCEPTION 'Kesinleştirmede kullanıcı gerekir' USING ERRCODE = 'ERP13';
    END IF;
    IF who IS NOT NULL AND NEW.finalized_by::text <> who THEN
      RAISE EXCEPTION 'Kesinleştirme yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
    END IF;
    SELECT count(*) AS n, coalesce(sum(premium_base), 0) AS base, coalesce(sum(employee_premium), 0) AS emp, coalesce(sum(employer_premium), 0) AS er,
           coalesce(sum(support_employee), 0) AS se, coalesce(sum(support_employer), 0) AS sr
      INTO s FROM social_declaration_lines WHERE declaration_id = NEW.id;
    IF s.n = 0 THEN
      RAISE EXCEPTION 'Satırı olmayan bildirim kesinleştirilemez' USING ERRCODE = 'ERP13';
    END IF;
    IF s.n <> NEW.employee_count OR s.base <> NEW.premium_base_total OR s.emp <> NEW.employee_premium_total OR s.er <> NEW.employer_premium_total
       OR s.se <> NEW.support_employee_total OR s.sr <> NEW.support_employer_total THEN
      RAISE EXCEPTION 'Bildirim toplamları satırlarla tutarsız; yeniden oluşturun' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'finalized' AND NEW.status = 'draft' THEN
    IF NEW.reopen_reason IS NULL OR length(btrim(NEW.reopen_reason)) < 3 OR NEW.reopened_by IS NULL OR NEW.reopened_at IS NULL THEN
      RAISE EXCEPTION 'Kesinleşmiş bildirim gerekçe ve kullanıcı olmadan açılamaz' USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.reopen_count <> OLD.reopen_count + 1 THEN
      RAISE EXCEPTION 'Yeniden açma sayacı bir artmalı' USING ERRCODE = 'ERP13';
    END IF;
    IF who IS NOT NULL AND NEW.reopened_by::text <> who THEN
      RAISE EXCEPTION 'Yeniden açma yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Bildirim durumu % → % geçişi geçersiz', OLD.status, NEW.status USING ERRCODE = 'ERP13';
END
$$;
--> statement-breakpoint
CREATE TRIGGER social_declarations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON social_declarations
  FOR EACH ROW EXECUTE FUNCTION social_declarations_guard();
--> statement-breakpoint

-- Bordro çalıştırması (D3 işlevinin genişletilmiş hâli): iptalde kesinleşmiş bildirim engeli, taslak bildirim temizliği
CREATE OR REPLACE FUNCTION payroll_runs_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  who text := nullif(current_setting('app.user_id', true), '');
  s record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Yalnızca taslak bordro silinir; onaylı bordro iptal edilir' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Bordro taslak olarak açılır' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.number <> OLD.number OR NEW.month <> OLD.month OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Bordronun numarası, ayı ve şirketi değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;

  IF OLD.status <> 'draft' AND NEW.status = OLD.status
     AND (NEW.employee_count <> OLD.employee_count OR NEW.gross_total <> OLD.gross_total OR NEW.deductions_total <> OLD.deductions_total
          OR NEW.net_total <> OLD.net_total OR NEW.employer_total <> OLD.employer_total OR NEW.params_snapshot <> OLD.params_snapshot
          OR NEW.has_unverified_params <> OLD.has_unverified_params OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
          OR NEW.description IS DISTINCT FROM OLD.description) THEN
    RAISE EXCEPTION 'Onaylanmış bordronun içeriği değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    RETURN NEW;
  ELSIF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hr-attendance-month|' || NEW.company_id::text || '|' || NEW.month, 0));
    IF NOT EXISTS (SELECT 1 FROM attendance_months m WHERE m.company_id = NEW.company_id AND m.month = NEW.month AND m.status = 'closed') THEN
      RAISE EXCEPTION 'Puantaj ayı (%) kapalı değil; bordro onaylanamaz. Önce puantajı kapatın', NEW.month USING ERRCODE = 'ERP13';
    END IF;
    IF NEW.entry_id IS NULL OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'Onaylanan bordronun yevmiyesi ve onaylayanı olmalı' USING ERRCODE = 'ERP13';
    END IF;
    IF who IS NOT NULL AND NEW.approved_by::text <> who THEN
      RAISE EXCEPTION 'Onay yalnızca oturumdaki kullanıcı adına yazılır' USING ERRCODE = 'ERP13';
    END IF;
    SELECT count(*) AS n, coalesce(sum(gross), 0) AS gross, coalesce(sum(deductions_total), 0) AS ded, coalesce(sum(employer_total), 0) AS emp,
           count(*) FILTER (WHERE net < 0) AS neg
      INTO s FROM payroll_lines WHERE run_id = NEW.id;
    IF s.n = 0 THEN
      RAISE EXCEPTION 'Satırı olmayan bordro onaylanamaz' USING ERRCODE = 'ERP13';
    END IF;
    IF s.neg > 0 THEN
      RAISE EXCEPTION 'Net ücreti negatif satır olan bordro onaylanamaz' USING ERRCODE = 'ERP13';
    END IF;
    IF s.n <> NEW.employee_count OR s.gross <> NEW.gross_total OR s.ded <> NEW.deductions_total OR s.emp <> NEW.employer_total THEN
      RAISE EXCEPTION 'Bordro toplamları satırlarla tutarsız; yeniden hesaplayın' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'approved' AND NEW.status = 'paid' THEN
    IF NEW.paid_at IS NULL OR NEW.paid_marked_by IS NULL THEN
      RAISE EXCEPTION 'Ödendi işaretinde ödeme tarihi ve kullanıcı gerekir' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  ELSIF OLD.status = 'paid' AND NEW.status = 'approved' THEN
    RETURN NEW;
  ELSIF OLD.status = 'approved' AND NEW.status = 'cancelled' THEN
    IF NEW.cancel_reason IS NULL OR length(btrim(NEW.cancel_reason)) < 3 OR NEW.cancelled_by IS NULL OR NEW.cancelled_at IS NULL OR NEW.reversal_entry_id IS NULL THEN
      RAISE EXCEPTION 'Bordro iptali gerekçe, kullanıcı ve ters yevmiye ister' USING ERRCODE = 'ERP13';
    END IF;
    -- Faz D4: kesinleşmiş sosyal güvenlik bildirimi varsa bordro iptal edilemez; taslak bildirim bayatlayacağından silinir.
    IF EXISTS (SELECT 1 FROM social_declarations d WHERE d.company_id = NEW.company_id AND d.month = NEW.month AND d.status = 'finalized') THEN
      RAISE EXCEPTION '% ayı için kesinleşmiş sosyal güvenlik bildirimi var; bordro iptal edilemez. Önce bildirimi yeniden açın', NEW.month USING ERRCODE = 'ERP13';
    END IF;
    DELETE FROM social_declaration_lines WHERE company_id = NEW.company_id AND declaration_id IN (SELECT id FROM social_declarations WHERE company_id = NEW.company_id AND month = NEW.month AND status = 'draft');
    DELETE FROM social_declarations WHERE company_id = NEW.company_id AND month = NEW.month AND status = 'draft';
    RETURN NEW;
  ELSIF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Bordro durumu % → % geçişi geçersiz', OLD.status, NEW.status USING ERRCODE = 'ERP13';
END
$$;
--> statement-breakpoint

-- Puantaj ayı kapanışı (genişletilmiş): kesinleşmiş bildirim varken ay açılamaz
CREATE OR REPLACE FUNCTION attendance_months_guard() RETURNS trigger LANGUAGE plpgsql AS
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
    IF EXISTS (SELECT 1 FROM social_declarations d WHERE d.company_id = NEW.company_id AND d.month = NEW.month AND d.status = 'finalized') THEN
      RAISE EXCEPTION '% ayı için kesinleşmiş sosyal güvenlik bildirimi var; puantaj ayı açılamaz. Önce bildirimi yeniden açın', NEW.month USING ERRCODE = 'ERP13';
    END IF;
    IF EXISTS (SELECT 1 FROM payroll_runs r WHERE r.company_id = NEW.company_id AND r.month = NEW.month AND r.status IN ('approved', 'paid')) THEN
      RAISE EXCEPTION '% ayı için onaylanmış bordro var; puantaj ayı açılamaz. Önce bordroyu iptal edin', NEW.month USING ERRCODE = 'ERP13';
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
