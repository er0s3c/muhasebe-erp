-- =========================================================================
-- Değişiklik emri (DE): RLS, yetki, denetim izi ve iş kuralları (ERRCODE ERP10). Yürürlükteki sözleşmenin yeni revizyonu
-- yalnızca DE uygulanırken onaylanır; uygulanmış DE değişmez.
-- =========================================================================

ALTER TABLE variation_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON variation_orders
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE TRIGGER audit_variation_orders AFTER INSERT OR UPDATE OR DELETE ON variation_orders
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON variation_orders TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

CREATE FUNCTION variation_orders_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  r subcontract_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Değişiklik emri silinemez; iptal edilir' USING ERRCODE = 'ERP10';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id;
    IF NOT FOUND OR sc.status <> 'active' THEN
      RAISE EXCEPTION 'Değişiklik emri yalnızca yürürlükteki sözleşmeye açılır' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.direction <> sc.direction OR NEW.project_id <> sc.project_id THEN
      RAISE EXCEPTION 'Değişiklik emrinin yönü ve projesi sözleşmeyle aynı olmalı' USING ERRCODE = 'ERP10';
    END IF;
    SELECT * INTO r FROM subcontract_revisions WHERE id = NEW.revision_id;
    IF NOT FOUND OR r.subcontract_id <> NEW.subcontract_id OR r.status <> 'draft' THEN
      RAISE EXCEPTION 'Değişiklik emri sözleşmenin taslak revizyonuna bağlanır' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Değişiklik emri taslak olarak açılır' USING ERRCODE = 'ERP10';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.subcontract_id <> OLD.subcontract_id OR NEW.project_id <> OLD.project_id
     OR NEW.direction <> OLD.direction OR NEW.base_revision_id <> OLD.base_revision_id OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'Değişiklik emrinin sözleşmesi, kodu ve dayanak revizyonu değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.revision_id IS DISTINCT FROM OLD.revision_id AND NOT (NEW.revision_id IS NULL AND NEW.status IN ('cancelled', 'rejected')) THEN
    RAISE EXCEPTION 'Değişiklik emrinin revizyonu değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF OLD.status IN ('applied', 'cancelled') AND (to_jsonb(NEW) - 'revision_id' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revision_id' - 'updated_at') THEN
    RAISE EXCEPTION 'Uygulanmış ya da iptal edilmiş değişiklik emri değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
      OR (OLD.status = 'submitted' AND NEW.status IN ('awaiting_client', 'applied', 'rejected', 'cancelled'))
      OR (OLD.status = 'awaiting_client' AND NEW.status IN ('applied', 'rejected', 'cancelled'))
      OR (OLD.status = 'rejected' AND NEW.status IN ('submitted', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Geçersiz değişiklik emri durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status = 'awaiting_client' AND NEW.direction <> 'receivable' THEN
      RAISE EXCEPTION 'İşveren kabulü yalnızca işveren sözleşmesinin değişiklik emrinde beklenir' USING ERRCODE = 'ERP10';
    END IF;
    IF NEW.status = 'applied' THEN
      IF NEW.direction = 'receivable' AND (OLD.status <> 'awaiting_client' OR NEW.client_accepted_at IS NULL) THEN
        RAISE EXCEPTION 'İşveren kabul etmeden işveren değişiklik emri uygulanamaz' USING ERRCODE = 'ERP10';
      END IF;
      SELECT * INTO r FROM subcontract_revisions WHERE id = NEW.revision_id;
      IF NOT FOUND OR r.status <> 'approved' THEN
        RAISE EXCEPTION 'Değişiklik emrinin revizyonu yürürlüğe girmeden emir uygulanmış sayılamaz' USING ERRCODE = 'ERP10';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER variation_orders_guard
  BEFORE INSERT OR UPDATE OR DELETE ON variation_orders
  FOR EACH ROW EXECUTE FUNCTION variation_orders_guard();
--> statement-breakpoint

-- Yürürlükteki sözleşmede yeni revizyon yalnızca değişiklik emri uygulanırken onaylanır (ilk revizyon serbest):
-- taşeronda iç onayı verilmiş, işverende ayrıca işveren kabulü girilmiş DE.
CREATE FUNCTION subcontract_revisions_vo_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'approved'
     AND EXISTS (SELECT 1 FROM subcontract_revisions p WHERE p.subcontract_id = NEW.subcontract_id AND p.status = 'approved')
     AND NOT EXISTS (SELECT 1 FROM variation_orders v WHERE v.revision_id = NEW.id
                       AND ((v.status = 'submitted' AND v.direction = 'payable' AND v.approved_at IS NOT NULL)
                         OR (v.status = 'awaiting_client' AND v.client_accepted_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'Yürürlükteki sözleşmenin değişikliği yalnızca onaylanan değişiklik emriyle yürürlüğe girer' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcontract_revisions_vo_guard
  BEFORE UPDATE ON subcontract_revisions
  FOR EACH ROW EXECUTE FUNCTION subcontract_revisions_vo_guard();
