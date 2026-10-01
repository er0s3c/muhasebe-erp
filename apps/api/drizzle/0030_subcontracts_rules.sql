-- =========================================================================
-- Taşeron sözleşmesi, revizyon ve BOQ (Faz B2b): RLS, yetki, denetim izi, iş kuralları (ERRCODE ERP10).
-- Onaylı revizyon ve satırları değişmez (proje bütçesi revizyonuyla aynı düzen).
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subcontracts', 'subcontract_revisions', 'subcontract_boq_lines'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON subcontracts, subcontract_revisions, subcontract_boq_lines TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 1) Sözleşme başlığı
CREATE FUNCTION subcontracts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  pk text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR EXISTS (
         SELECT 1 FROM subcontract_revisions WHERE subcontract_id = OLD.id AND status <> 'draft') THEN
      RAISE EXCEPTION 'Yürürlüğe girmiş sözleşme silinemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye sözleşme eklenemez' USING ERRCODE = 'ERP10';
    END IF;
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk = 'customer' THEN
      RAISE EXCEPTION 'Taşeron cari tedarikçi türünde olmalı' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Sözleşme taslak olarak açılır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id <> OLD.project_id OR NEW.party_id <> OLD.party_id OR NEW.currency_code <> OLD.currency_code THEN
    RAISE EXCEPTION 'Sözleşmenin kodu, projesi, taşeronu ve para birimi değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.retention_pct <> OLD.retention_pct OR NEW.advance_recoup_pct <> OLD.advance_recoup_pct OR NEW.withholding_pct <> OLD.withholding_pct) THEN
    RAISE EXCEPTION 'Yürürlükteki sözleşmenin kesinti yüzdeleri değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status = 'active' THEN
      IF NOT EXISTS (SELECT 1 FROM subcontract_revisions WHERE subcontract_id = NEW.id AND status = 'approved') THEN
        RAISE EXCEPTION 'Onaylı revizyonu olmayan sözleşme yürürlüğe giremez' USING ERRCODE = 'ERP10';
      END IF;
    ELSIF NOT (OLD.status = 'active' AND NEW.status IN ('completed', 'terminated')) THEN
      RAISE EXCEPTION 'Geçersiz sözleşme durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP10';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcontracts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON subcontracts
  FOR EACH ROW EXECUTE FUNCTION subcontracts_guard();
--> statement-breakpoint

-- 2) Revizyon
CREATE FUNCTION subcontract_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  next_no int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Onaylanmış sözleşme revizyonu silinemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR UPDATE;
    IF NOT FOUND OR sc.status IN ('completed', 'terminated') THEN
      RAISE EXCEPTION 'Tamamlanmış veya feshedilmiş sözleşmeye revizyon eklenemez' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Revizyon taslak olarak açılır' USING ERRCODE = 'ERP10';
    END IF;
    SELECT coalesce(max(revision_no), 0) + 1 INTO next_no FROM subcontract_revisions WHERE subcontract_id = NEW.subcontract_id;
    IF NEW.revision_no <> next_no THEN
      RAISE EXCEPTION 'Revizyon numarası % olmalı', next_no USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF (to_jsonb(NEW) - 'title') IS DISTINCT FROM (to_jsonb(OLD) - 'title') THEN
      RAISE EXCEPTION 'Taslak revizyonda yalnızca başlık değiştirilebilir' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'status' - 'approved_at' - 'approved_by') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'approved_at' - 'approved_by') THEN
    RAISE EXCEPTION 'Onaylanmış sözleşme revizyonu değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR UPDATE;
    IF sc.status IN ('completed', 'terminated') THEN
      RAISE EXCEPTION 'Tamamlanmış veya feshedilmiş sözleşmenin revizyonu onaylanamaz' USING ERRCODE = 'ERP10';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM subcontract_boq_lines WHERE revision_id = NEW.id) THEN
      RAISE EXCEPTION 'Boş revizyon onaylanamaz' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
    IF NOT EXISTS (
      SELECT 1 FROM subcontract_revisions r
       WHERE r.subcontract_id = NEW.subcontract_id AND r.status = 'approved' AND r.revision_no > NEW.revision_no
    ) THEN
      RAISE EXCEPTION 'Revizyon yalnızca daha yeni bir onaylı revizyon varken devre dışı kalır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Geçersiz revizyon durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP10';
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcontract_revisions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON subcontract_revisions
  FOR EACH ROW EXECUTE FUNCTION subcontract_revisions_guard();
--> statement-breakpoint

-- 3) BOQ satırı: yalnızca taslak revizyonda (revizyon FOR SHARE kilitli), yalnızca yaprak iş kaleminde.
CREATE FUNCTION subcontract_boq_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  r subcontract_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO r FROM subcontract_revisions WHERE id = OLD.revision_id;
    IF FOUND AND r.status <> 'draft' THEN
      RAISE EXCEPTION 'Onaylanmış revizyonun BOQ satırları silinemez' USING ERRCODE = 'ERP10';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO r FROM subcontract_revisions WHERE id = NEW.revision_id FOR SHARE;
  IF NOT FOUND OR r.status <> 'draft' THEN
    RAISE EXCEPTION 'Yalnızca taslak revizyonun BOQ satırları eklenir veya değiştirilir' USING ERRCODE = 'ERP10';
  END IF;
  IF r.subcontract_id <> NEW.subcontract_id THEN
    RAISE EXCEPTION 'BOQ satırı revizyonun sözleşmesine ait olmalı' USING ERRCODE = 'ERP10';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.revision_id <> OLD.revision_id OR NEW.line_key <> OLD.line_key OR NEW.project_id <> OLD.project_id) THEN
    RAISE EXCEPTION 'BOQ satırının kimliği değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcontract_boq_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON subcontract_boq_lines
  FOR EACH ROW EXECUTE FUNCTION subcontract_boq_lines_guard();
