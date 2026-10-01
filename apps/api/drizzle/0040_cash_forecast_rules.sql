-- =========================================================================
-- Nakit projeksiyonu ek kalemleri: RLS, yetki, denetim izi.
-- =========================================================================

ALTER TABLE cash_forecast_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cash_forecast_items
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE TRIGGER audit_cash_forecast_items AFTER INSERT OR UPDATE OR DELETE ON cash_forecast_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON cash_forecast_items TO erp_app;
  END IF;
END
$$;
