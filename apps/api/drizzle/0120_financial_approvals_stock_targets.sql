CREATE TABLE "financial_approval_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"branch_id" uuid,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"document_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_doc_id" uuid,
	"posted_at" timestamp with time zone,
	CONSTRAINT "financial_approval_drafts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "financial_approval_drafts_type_ck" CHECK ("financial_approval_drafts"."doc_type" in ('payment','expense')),
	CONSTRAINT "financial_approval_drafts_status_ck" CHECK ("financial_approval_drafts"."status" in ('draft','submitted','rejected','posted','cancelled')),
	CONSTRAINT "financial_approval_drafts_amount_ck" CHECK ("financial_approval_drafts"."amount">0),
	CONSTRAINT "financial_approval_drafts_hash_ck" CHECK ("financial_approval_drafts"."payload_hash"~'^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "approval_rules" DROP CONSTRAINT "approval_rules_doc_type_ck";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "document_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "target_level" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "financial_approval_drafts" ADD CONSTRAINT "financial_approval_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_approval_drafts" ADD CONSTRAINT "financial_approval_drafts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_approval_drafts" ADD CONSTRAINT "financial_approval_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_approval_drafts" ADD CONSTRAINT "financial_approval_drafts_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_doc_type_ck" CHECK ("approval_rules"."doc_type" in ('progress_payment','employer_claim','purchase_request','variation_order','invoice','sales_quote','payment','expense'));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_target_level_ck" CHECK ("items"."target_level" is null or ("items"."target_level">=0 and ("items"."min_level" is null or "items"."target_level">="items"."min_level")));
--> statement-breakpoint
ALTER TABLE financial_approval_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_approval_drafts USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id());
CREATE POLICY branch_scope ON financial_approval_drafts AS RESTRICTIVE USING(app_branch_row_allowed(company_id,branch_id)) WITH CHECK(app_branch_row_allowed(company_id,branch_id));
CREATE POLICY branch_scope ON approval_requests AS RESTRICTIVE USING(app_branch_row_allowed(company_id,branch_id)) WITH CHECK(app_branch_row_allowed(company_id,branch_id));
CREATE POLICY branch_scope ON approval_steps AS RESTRICTIVE USING(EXISTS(SELECT 1 FROM approval_requests r WHERE r.id=request_id AND r.company_id=approval_steps.company_id)) WITH CHECK(EXISTS(SELECT 1 FROM approval_requests r WHERE r.id=request_id AND r.company_id=approval_steps.company_id));
GRANT SELECT,INSERT,UPDATE ON financial_approval_drafts TO erp_app;
CREATE TRIGGER audit_financial_approval_drafts AFTER INSERT OR UPDATE OR DELETE ON financial_approval_drafts FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER branch_assignment_guard BEFORE INSERT OR UPDATE ON financial_approval_drafts FOR EACH ROW EXECUTE FUNCTION branch_assignment_guard();
--> statement-breakpoint
CREATE FUNCTION approval_request_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.branch_id IS NULL THEN NEW.branch_id:=app_branch_id(); END IF;
 IF NEW.doc_type IN ('invoice','sales_quote','payment','expense') AND (NEW.payload_hash IS NULL OR NEW.payload_hash!~'^[0-9a-f]{64}$' OR NEW.document_snapshot IS NULL OR NOT NEW.separate_requester) THEN RAISE EXCEPTION 'Mali belge onayı değişmez belge görüntüsü ve ayrı onaylayıcı ister' USING ERRCODE='ERP10'; END IF;
 IF TG_OP='UPDATE' AND (NEW.payload_hash,NEW.document_snapshot,NEW.branch_id,NEW.separate_requester) IS DISTINCT FROM (OLD.payload_hash,OLD.document_snapshot,OLD.branch_id,OLD.separate_requester) THEN RAISE EXCEPTION 'Onay talebinin görüntüsü, şubesi ve ayrı onaylayıcı kuralı değiştirilemez' USING ERRCODE='ERP10'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approval_request_snapshot_guard BEFORE INSERT OR UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION approval_request_snapshot_guard();
--> statement-breakpoint
CREATE FUNCTION financial_approval_drafts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.posted_doc_id IS NOT NULL OR NEW.posted_at IS NOT NULL THEN RAISE EXCEPTION 'Mali onay belgesi taslak oluşturulmalı' USING ERRCODE='ERP10'; END IF;
  IF app_user_id() IS NOT NULL AND NEW.created_by IS DISTINCT FROM app_user_id() THEN RAISE EXCEPTION 'Mali onay talebinin oluşturanı oturumdaki kullanıcı olmalı' USING ERRCODE='ERP10'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.doc_type<>OLD.doc_type OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Mali onay belgesinin kimliği değiştirilemez' USING ERRCODE='ERP10'; END IF;
 IF OLD.status IN ('posted','cancelled') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Sonuçlanmış mali onay belgesi değiştirilemez' USING ERRCODE='ERP10'; END IF;
 IF OLD.status='submitted' AND (NEW.payload,NEW.payload_hash,NEW.branch_id,NEW.amount,NEW.currency,NEW.document_date) IS DISTINCT FROM (OLD.payload,OLD.payload_hash,OLD.branch_id,OLD.amount,OLD.currency,OLD.document_date) THEN RAISE EXCEPTION 'Onaydaki mali belgenin içeriği değiştirilemez' USING ERRCODE='ERP10'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status IN ('draft','rejected') AND NEW.status IN ('draft','submitted','cancelled')) OR (OLD.status='submitted' AND NEW.status IN ('rejected','posted','cancelled'))) THEN RAISE EXCEPTION 'Geçersiz mali onay belgesi durum geçişi' USING ERRCODE='ERP10'; END IF;
 IF NEW.status='posted' AND (NEW.posted_doc_id IS NULL OR NEW.posted_at IS NULL) THEN RAISE EXCEPTION 'Mali onay belgesinin kesinleşmiş kaydı eksik' USING ERRCODE='ERP10'; END IF;
 IF NEW.status<>'posted' AND (NEW.posted_doc_id IS NOT NULL OR NEW.posted_at IS NOT NULL) THEN RAISE EXCEPTION 'Kesinleşmemiş mali onay belgesine sonuç kaydı bağlanamaz' USING ERRCODE='ERP10'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_approval_drafts_guard BEFORE INSERT OR UPDATE ON financial_approval_drafts FOR EACH ROW EXECUTE FUNCTION financial_approval_drafts_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION branch_admin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE caller memberships%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='member_branch_access' THEN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM memberships WHERE company_id=OLD.company_id AND user_id=OLD.user_id) THEN RETURN OLD; END IF;
 END IF;
 SELECT * INTO caller FROM memberships WHERE company_id=coalesce(NEW.company_id,OLD.company_id) AND user_id=app_user_id();
 IF app_user_id() IS NOT NULL AND (NOT FOUND OR caller.role NOT IN ('owner','admin')) THEN RAISE EXCEPTION 'Şube ve rol yönetimi yönetici yetkisi ister' USING ERRCODE='ERP26'; END IF;
 IF TG_TABLE_NAME IN ('company_branches','company_roles') AND app_user_id() IS NOT NULL AND caller.branch_scope_mode<>'all' THEN RAISE EXCEPTION 'Şirket şube ve rol yönetimi tüm şubelere erişim ister' USING ERRCODE='ERP26'; END IF;
 IF TG_TABLE_NAME='member_branch_access' THEN
  IF TG_OP='INSERT' AND app_user_id() IS NOT NULL AND NOT app_branch_has_access(NEW.company_id,NEW.branch_id) THEN RAISE EXCEPTION 'Kendi şube kapsamınızdan fazlasını veremezsiniz' USING ERRCODE='ERP26'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
