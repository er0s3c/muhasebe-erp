CREATE TABLE "offline_draft_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_id" uuid NOT NULL,
	"result_path" text NOT NULL,
	"branch_selection" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_draft_receipts_client_uq" UNIQUE("company_id","user_id","client_id"),
	CONSTRAINT "offline_draft_receipts_kind_ck" CHECK ("offline_draft_receipts"."kind" in ('stock_count','field_task')),
	CONSTRAINT "offline_draft_receipts_hash_ck" CHECK ("offline_draft_receipts"."request_hash"~'^[0-9a-f]{64}$'),
	CONSTRAINT "offline_draft_receipts_branch_ck" CHECK ("offline_draft_receipts"."branch_selection" in ('all','unassigned') or "offline_draft_receipts"."branch_selection"~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "offline_draft_receipts" ADD CONSTRAINT "offline_draft_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_draft_receipts" ADD CONSTRAINT "offline_draft_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE offline_draft_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offline_draft_receipts USING(company_id=app_company_id() AND user_id=app_user_id()) WITH CHECK(company_id=app_company_id() AND user_id=app_user_id());
GRANT SELECT,INSERT ON offline_draft_receipts TO erp_app;
CREATE TRIGGER audit_offline_draft_receipts AFTER INSERT ON offline_draft_receipts FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE FUNCTION offline_draft_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Taslak eşitleme makbuzu değiştirilemez' USING ERRCODE='ERP10'; END IF;
 IF NEW.company_id IS DISTINCT FROM app_company_id() OR NEW.user_id IS DISTINCT FROM app_user_id() THEN RAISE EXCEPTION 'Taslak eşitleme makbuzu oturumdaki kullanıcıya ait olmalı' USING ERRCODE='ERP26'; END IF;
 IF NEW.result_path!~'^/(inventory/counts/[0-9a-f-]{36}|workspace\?task=[0-9a-f-]{36})$' THEN RAISE EXCEPTION 'Taslak sonuç yolu geçersiz' USING ERRCODE='ERP10'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER offline_draft_receipts_guard BEFORE INSERT OR UPDATE OR DELETE ON offline_draft_receipts FOR EACH ROW EXECUTE FUNCTION offline_draft_receipts_guard();
