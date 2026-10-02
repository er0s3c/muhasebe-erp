-- =========================================================================
-- Bordro (Faz D3): RLS, yetki, denetim izi, hesap eşlemesi geri doldurma, iş kuralları (ERRCODE ERP13 → HR_RULE_VIOLATION).
-- Taslak dışında bordro satırı değişmez; onay için puantaj ayı kapalı olmalıdır; onaylı bordro varken puantaj ayı açılamaz;
-- parametre değeri/tarihi sonradan değişmez; kullanılmış parametre silinmez. Hesap eşlemesi varsayılanları DOĞRULANMAMIŞTIR.
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_params', 'employee_pay_terms', 'payroll_items', 'payroll_runs', 'payroll_lines', 'payroll_line_items', 'payroll_adjustments', 'payroll_line_allocations'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_params, payroll_runs, payroll_lines, payroll_adjustments TO erp_app;
    -- Ücret şartı değiştirilmez: düzeltme = sil + yeniden ekle (denetim izinde)
    GRANT SELECT, INSERT, DELETE ON employee_pay_terms, payroll_line_items, payroll_line_allocations TO erp_app;
    -- Kalem kataloğu silinmez (pasife alınır)
    GRANT SELECT, INSERT, UPDATE ON payroll_items TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Mevcut şirketler için bordro hesap eşlemeleri (genel Tekdüzen yapıya dayanır, doğrulanmamıştır)
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES
  ('payroll_labor_cost', '720'),
  ('payroll_employer_cost', '720'),
  ('payroll_payable', '335'),
  ('payroll_social_payable', '361'),
  ('payroll_tax_payable', '360'),
  ('payroll_other_payable', '336')
) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- Parametre: anahtar, değer, tarih ve şirket sonradan değişmez (yeni tarihli satır eklenir); yerine geçtiği satır aynı anahtardır;
-- bordro çalıştırmasında kullanılmış parametre silinemez (kayıtta kopyası vardır ama kaynak satır kanıt olarak kalır).
CREATE FUNCTION payroll_params_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM payroll_runs r WHERE r.company_id = OLD.company_id AND r.status <> 'draft' AND r.params_snapshot @> jsonb_build_array(jsonb_build_object('paramId', OLD.id::text))) THEN
      RAISE EXCEPTION 'Onaylanmış bordroda kullanılan parametre silinemez; yerine yeni tarihli satır ekleyin' USING ERRCODE = 'ERP13';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.key <> OLD.key OR NEW.value <> OLD.value OR NEW.effective_from <> OLD.effective_from OR NEW.company_id <> OLD.company_id
       OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
      RAISE EXCEPTION 'Parametrenin anahtarı, değeri ve tarihi değiştirilemez; yeni tarihli satır ekleyin' USING ERRCODE = 'ERP13';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.supersedes_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM payroll_params p WHERE p.id = NEW.supersedes_id AND p.company_id = NEW.company_id AND p.key = NEW.key AND p.effective_from < NEW.effective_from) THEN
    RAISE EXCEPTION 'Yerine geçilen parametre aynı anahtarın daha eski bir satırı olmalı' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_params_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_params
  FOR EACH ROW EXECUTE FUNCTION payroll_params_guard();
--> statement-breakpoint

-- Ücret şartı: personelin işe giriş tarihi vardır ve şart bundan önce başlayamaz
CREATE FUNCTION employee_pay_terms_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  e employees%ROWTYPE;
BEGIN
  SELECT * INTO e FROM employees WHERE id = NEW.employee_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personel bulunamadı' USING ERRCODE = 'ERP13';
  END IF;
  IF e.hire_date IS NOT NULL AND NEW.effective_from < e.hire_date THEN
    RAISE EXCEPTION '% personelinin ücret şartı işe giriş tarihinden (%) önce başlayamaz', e.code, e.hire_date USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_pay_terms_guard
  BEFORE INSERT ON employee_pay_terms
  FOR EACH ROW EXECUTE FUNCTION employee_pay_terms_guard();
--> statement-breakpoint

-- Kalem kataloğu: kod ve tür sonradan değişmez (kayıtlı satırlar bunlara dayanır)
CREATE FUNCTION payroll_items_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.code <> OLD.code OR NEW.kind <> OLD.kind OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Bordro kaleminin kodu ve türü değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_items_guard
  BEFORE UPDATE ON payroll_items
  FOR EACH ROW EXECUTE FUNCTION payroll_items_guard();
--> statement-breakpoint

-- Bordro çalıştırması
-- Durum geçişleri: taslak → onaylı (puantaj ayı kapalı, yevmiye var, toplamlar satırlarla tutarlı, net ≥ 0), onaylı ↔ ödendi,
-- onaylı → iptal (gerekçe + ters kayıt). Taslak dışında içerik (toplam, parametre kopyası, açıklama) değişmez; yalnız taslak silinir.
-- Ayın kapanış kilidiyle aynı danışma kilidi: "ayı yeniden aç" ile "bordroyu onayla" yarışamaz (bkz. attendance_months_guard).
CREATE FUNCTION payroll_runs_guard() RETURNS trigger LANGUAGE plpgsql AS
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
    RETURN NEW;
  ELSIF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Bordro durumu % → % geçişi geçersiz', OLD.status, NEW.status USING ERRCODE = 'ERP13';
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_runs_guard();
--> statement-breakpoint

-- Satır, kalem, elle girilen kalem ve etiket dağılımı yalnızca TASLAK bordroda yazılır/silinir.
CREATE FUNCTION payroll_assert_run_draft(p_run uuid) RETURNS void LANGUAGE plpgsql AS
$$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM payroll_runs WHERE id = p_run;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Onaylanmış bordronun satırları değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION payroll_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM payroll_assert_run_draft(OLD.run_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.run_id <> OLD.run_id OR NEW.employee_id <> OLD.employee_id) THEN
    RAISE EXCEPTION 'Bordro satırının çalıştırması ve personeli değiştirilemez' USING ERRCODE = 'ERP13';
  END IF;
  PERFORM payroll_assert_run_draft(NEW.run_id);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_lines_guard();
--> statement-breakpoint
CREATE FUNCTION payroll_adjustments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  it payroll_items%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM payroll_assert_run_draft(OLD.run_id);
    RETURN OLD;
  END IF;
  PERFORM payroll_assert_run_draft(NEW.run_id);
  SELECT * INTO it FROM payroll_items WHERE id = NEW.item_id AND company_id = NEW.company_id;
  IF NOT FOUND OR NOT it.is_active THEN
    RAISE EXCEPTION 'Bordro kalemi bulunamadı ya da pasif' USING ERRCODE = 'ERP13';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_adjustments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION payroll_adjustments_guard();
--> statement-breakpoint
CREATE FUNCTION payroll_line_children_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  l uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.line_id ELSE NEW.line_id END;
  r uuid;
BEGIN
  SELECT run_id INTO r FROM payroll_lines WHERE id = l;
  IF r IS NOT NULL THEN
    PERFORM payroll_assert_run_draft(r);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payroll_line_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_line_items
  FOR EACH ROW EXECUTE FUNCTION payroll_line_children_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_line_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_line_allocations
  FOR EACH ROW EXECUTE FUNCTION payroll_line_children_guard();
--> statement-breakpoint

-- Puantaj ayı kapanışı (D2 işlevinin genişletilmiş hâli): ek olarak, o ay için onaylı/ödenmiş bordro varken ay yeniden açılamaz.
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
