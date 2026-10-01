-- =========================================================================
-- İnşaat parametreleri ve onay motoru (Faz B2a): RLS, yetki, denetim izi, iş kuralları.
-- Kurallar ERRCODE ERP10 ile yükselir (API'de 422 SUBCONTRACT_RULE_VIOLATION).
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['construction_params', 'approval_rules', 'approval_rule_steps', 'approval_requests', 'approval_steps'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON construction_params, approval_rules, approval_rule_steps TO erp_app;
    -- Talep ve adımlar silinmez; yalnızca karar verilir
    GRANT SELECT, INSERT, UPDATE ON approval_requests, approval_steps TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Karar verilmiş adım değişmez; bekleyen adım yalnızca onay/ret ile kapanır.
CREATE FUNCTION approval_steps_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Onay adımı silinemez' USING ERRCODE = 'ERP10';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Karar verilmiş onay adımı değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Bekleyen adım yalnızca onaylanır veya reddedilir' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.decided_by IS NULL OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'Karar veren ve zamanı yazılmalı' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.step_no <> OLD.step_no
     OR NEW.approver_role IS DISTINCT FROM OLD.approver_role
     OR NEW.approver_user_id IS DISTINCT FROM OLD.approver_user_id THEN
    RAISE EXCEPTION 'Onay adımının kimliği ve onaylayanı değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_steps_guard
  BEFORE UPDATE OR DELETE ON approval_steps
  FOR EACH ROW EXECUTE FUNCTION approval_steps_guard();
--> statement-breakpoint

-- Talep: yalnızca bekleyen → onaylandı/reddedildi/iptal; kimlik alanları değişmez; silinemez.
CREATE FUNCTION approval_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Onay talebi silinemez' USING ERRCODE = 'ERP10';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Sonuçlanmış onay talebi değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Bekleyen talep yalnızca onaylanır, reddedilir veya iptal edilir' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.doc_type <> OLD.doc_type OR NEW.doc_id <> OLD.doc_id OR NEW.amount <> OLD.amount
     OR NEW.requested_by <> OLD.requested_by OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'Onay talebinin belgesi ve tutarı değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  IF NEW.status = 'approved' AND EXISTS (
       SELECT 1 FROM approval_steps WHERE request_id = NEW.id AND company_id = NEW.company_id AND status <> 'approved') THEN
    RAISE EXCEPTION 'Tüm adımlar onaylanmadan talep onaylanamaz' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approval_requests_guard
  BEFORE UPDATE OR DELETE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION approval_requests_guard();
