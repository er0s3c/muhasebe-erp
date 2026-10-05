-- Product expansion: tenant isolation, personal tasks, immutable document versions and external portal access.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['work_items','record_documents','record_document_content','operation_entries','cash_scenarios','portal_links','portal_access_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['work_items','record_documents','operation_entries','cash_scenarios'] LOOP
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY work_item_visibility ON work_items AS RESTRICTIVE USING (
 owner_id=app_user_id() OR created_by=app_user_id() OR EXISTS(
 SELECT 1 FROM memberships m WHERE m.company_id=app_company_id() AND m.user_id=app_user_id() AND m.role IN ('owner','admin'))
);
ALTER TABLE work_alert_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_alert_states USING(company_id=app_company_id() AND user_id=app_user_id()) WITH CHECK(company_id=app_company_id() AND user_id=app_user_id());
--> statement-breakpoint
-- The random invitation hash locates only an invitation. The API additionally verifies the password,
-- expiry, revocation and issuer privileges before reading scoped company data.
CREATE POLICY portal_secret_lookup ON portal_links FOR SELECT USING(token_hash=nullif(current_setting('app.portal_hash',true),''));
GRANT SELECT,INSERT,UPDATE ON work_items,work_alert_states,operation_entries,portal_links TO erp_app;
GRANT SELECT,INSERT ON record_documents,record_document_content,cash_scenarios,portal_access_events TO erp_app;
--> statement-breakpoint
ALTER TABLE work_items ADD CONSTRAINT work_items_record_kind_ck CHECK(record_kind IS NULL OR record_kind IN ('party','invoice','project','subcontract','sales_contract','employee','transaction','site_report','defect'));
ALTER TABLE record_documents ADD CONSTRAINT record_documents_kind_ck CHECK(record_kind IN ('party','invoice','project','subcontract','sales_contract','employee','transaction','site_report','defect'));
