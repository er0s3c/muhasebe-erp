CREATE TABLE "company_api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_four" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"branch_id" uuid,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_api_keys_hash_uq" UNIQUE("key_hash"),
	CONSTRAINT "company_api_keys_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "company_api_keys_hash_ck" CHECK ("company_api_keys"."key_hash"~'^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "integration_write_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_write_requests_key_request_uq" UNIQUE("api_key_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"branch_id" uuid,
	"payload" jsonb NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_http_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_source_uq" UNIQUE("subscription_id","event_type","invoice_id"),
	CONSTRAINT "webhook_events_status_ck" CHECK ("webhook_events"."status" in ('pending','sending','delivered','dead_letter','cancelled')),
	CONSTRAINT "webhook_events_attempts_ck" CHECK ("webhook_events"."attempts">=0)
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"branch_id" uuid,
	"event_types" jsonb NOT NULL,
	"secret_encrypted" text NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_subscriptions_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "company_api_keys" ADD CONSTRAINT "company_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_api_keys" ADD CONSTRAINT "company_api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_api_keys" ADD CONSTRAINT "company_api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_api_keys" ADD CONSTRAINT "company_api_keys_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_write_requests" ADD CONSTRAINT "integration_write_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_write_requests" ADD CONSTRAINT "integration_write_requests_key_fk" FOREIGN KEY ("api_key_id","company_id") REFERENCES "public"."company_api_keys"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_subscription_fk" FOREIGN KEY ("subscription_id","company_id") REFERENCES "public"."webhook_subscriptions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_invoice_fk" FOREIGN KEY ("invoice_id","company_id") REFERENCES "public"."invoices"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_events_due_idx" ON "webhook_events" USING btree ("company_id","status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION platform_admin_allowed() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM memberships m JOIN companies c ON c.id=m.company_id WHERE m.company_id=app_company_id() AND c.organization_id=app_org_id() AND m.user_id=app_user_id() AND m.role IN ('owner','admin') AND m.branch_scope_mode='all') AND coalesce(current_setting('app.branch_selection',true),'all')='all'
$$;
CREATE FUNCTION platform_worker_allowed() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app_user_id() IS NULL AND current_setting('app.worker',true)='platform-webhook' AND EXISTS(SELECT 1 FROM companies WHERE id=app_company_id() AND organization_id=app_org_id())
$$;
ALTER TABLE company_api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY key_read ON company_api_keys FOR SELECT USING(company_id=app_company_id() AND (platform_admin_allowed() OR key_hash=nullif(current_setting('app.api_key_hash',true),'')));
CREATE POLICY key_insert ON company_api_keys FOR INSERT WITH CHECK(company_id=app_company_id() AND platform_admin_allowed() AND created_by=app_user_id());
CREATE POLICY key_update ON company_api_keys FOR UPDATE USING(company_id=app_company_id() AND (platform_admin_allowed() OR key_hash=nullif(current_setting('app.api_key_hash',true),''))) WITH CHECK(company_id=app_company_id() AND (platform_admin_allowed() OR key_hash=nullif(current_setting('app.api_key_hash',true),'')));
GRANT SELECT,INSERT,UPDATE ON company_api_keys TO erp_app;
ALTER TABLE integration_write_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_write_requests USING(company_id=app_company_id() AND EXISTS(SELECT 1 FROM company_api_keys k WHERE k.id=api_key_id AND k.company_id=integration_write_requests.company_id AND k.key_hash=nullif(current_setting('app.api_key_hash',true),''))) WITH CHECK(company_id=app_company_id() AND EXISTS(SELECT 1 FROM company_api_keys k WHERE k.id=api_key_id AND k.company_id=integration_write_requests.company_id AND k.key_hash=nullif(current_setting('app.api_key_hash',true),'') AND k.created_by=app_user_id() AND k.revoked_at IS NULL AND k.expires_at>now()));
GRANT SELECT,INSERT ON integration_write_requests TO erp_app;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_read ON webhook_subscriptions FOR SELECT USING(company_id=app_company_id() AND (platform_admin_allowed() OR platform_worker_allowed()));
CREATE POLICY subscription_insert ON webhook_subscriptions FOR INSERT WITH CHECK(company_id=app_company_id() AND platform_admin_allowed() AND created_by=app_user_id());
CREATE POLICY subscription_update ON webhook_subscriptions FOR UPDATE USING(company_id=app_company_id() AND platform_admin_allowed()) WITH CHECK(company_id=app_company_id() AND platform_admin_allowed());
GRANT SELECT,INSERT,UPDATE ON webhook_subscriptions TO erp_app;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_read ON webhook_events FOR SELECT USING(company_id=app_company_id() AND (platform_admin_allowed() OR platform_worker_allowed()));
CREATE POLICY event_update ON webhook_events FOR UPDATE USING(company_id=app_company_id() AND (platform_admin_allowed() OR platform_worker_allowed())) WITH CHECK(company_id=app_company_id() AND (platform_admin_allowed() OR platform_worker_allowed()));
GRANT SELECT,UPDATE ON webhook_events TO erp_app;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['company_api_keys','integration_write_requests','webhook_subscriptions','webhook_events'] LOOP EXECUTE format('CREATE TRIGGER audit_%1$I AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t); END LOOP; END $$;
--> statement-breakpoint
CREATE FUNCTION company_api_keys_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'API anahtarı silinmez, iptal edilir' USING ERRCODE='ERP10'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT platform_admin_allowed() OR NEW.created_by IS DISTINCT FROM app_user_id() OR NOT EXISTS(SELECT 1 FROM companies WHERE id=NEW.company_id AND organization_id=NEW.organization_id AND organization_id=app_org_id()) THEN RAISE EXCEPTION 'API anahtarı şirket yöneticisi tarafından oluşturulmalı' USING ERRCODE='ERP26'; END IF;
  IF NEW.expires_at<=now() OR NEW.expires_at>now()+interval '365 days' OR NEW.revoked_at IS NOT NULL OR NEW.last_used_at IS NOT NULL THEN RAISE EXCEPTION 'API anahtarı süresi veya ilk durumu geçersiz' USING ERRCODE='ERP10'; END IF;
  IF jsonb_typeof(NEW.scopes)<>'array' OR jsonb_array_length(NEW.scopes) NOT BETWEEN 1 AND 4 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.scopes) s(value) WHERE s.value NOT IN ('inventory.read','parties.read','invoices.read','invoices.create_draft')) OR (SELECT count(DISTINCT s.value) FROM jsonb_array_elements_text(NEW.scopes) s(value))<>jsonb_array_length(NEW.scopes) THEN RAISE EXCEPTION 'API anahtar kapsamı geçersiz' USING ERRCODE='ERP10'; END IF;
  IF NEW.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_branches WHERE id=NEW.branch_id AND company_id=NEW.company_id AND is_active) THEN RAISE EXCEPTION 'API anahtar şubesi geçersiz' USING ERRCODE='ERP26'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['revoked_at','last_used_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','last_used_at']) THEN RAISE EXCEPTION 'API anahtarının kimliği, erişimi ve süresi değiştirilemez' USING ERRCODE='ERP10'; END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND (NOT platform_admin_allowed() OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL) THEN RAISE EXCEPTION 'API anahtarı iptali geri alınamaz' USING ERRCODE='ERP10'; END IF;
  IF NOT platform_admin_allowed() AND OLD.key_hash IS DISTINCT FROM nullif(current_setting('app.api_key_hash',true),'') THEN RAISE EXCEPTION 'API anahtarı doğrulama kanıtı eksik' USING ERRCODE='ERP26'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER company_api_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON company_api_keys FOR EACH ROW EXECUTE FUNCTION company_api_keys_guard();
CREATE FUNCTION integration_write_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Entegrasyon tekrar makbuzu değiştirilemez' USING ERRCODE='ERP10'; END IF;
 IF NEW.request_hash!~'^[0-9a-f]{64}$' OR jsonb_typeof(NEW.response)<>'object' THEN RAISE EXCEPTION 'Entegrasyon tekrar makbuzu geçersiz' USING ERRCODE='ERP10'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER integration_write_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON integration_write_requests FOR EACH ROW EXECUTE FUNCTION integration_write_requests_guard();
--> statement-breakpoint
CREATE FUNCTION webhook_subscriptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bildirim bağlantısı silinmez, iptal edilir' USING ERRCODE='ERP10'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM app_user_id() OR NOT platform_admin_allowed() OR NEW.revoked_at IS NOT NULL OR NEW.secret_version<>1 THEN RAISE EXCEPTION 'Bildirim bağlantısı ilk durumu geçersiz' USING ERRCODE='ERP26'; END IF;
  IF NEW.url!~'^https://' OR jsonb_typeof(NEW.event_types)<>'array' OR jsonb_array_length(NEW.event_types) NOT BETWEEN 1 AND 2 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.event_types) s(value) WHERE s.value NOT IN ('invoice.draft.created','invoice.posted')) OR (SELECT count(DISTINCT s.value) FROM jsonb_array_elements_text(NEW.event_types) s(value))<>jsonb_array_length(NEW.event_types) THEN RAISE EXCEPTION 'Bildirim adresi veya olay türü geçersiz' USING ERRCODE='ERP10'; END IF;
  IF NEW.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_branches WHERE id=NEW.branch_id AND company_id=NEW.company_id AND is_active) THEN RAISE EXCEPTION 'Bildirim şubesi geçersiz' USING ERRCODE='ERP26'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['enabled','revoked_at','secret_encrypted','secret_version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['enabled','revoked_at','secret_encrypted','secret_version','updated_at']) THEN RAISE EXCEPTION 'Bildirim bağlantısının adresi, olayları ve şubesi değiştirilemez' USING ERRCODE='ERP10'; END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'İptal edilen bildirim bağlantısı değiştirilemez' USING ERRCODE='ERP10'; END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND (NEW.revoked_at IS NULL OR NEW.enabled) THEN RAISE EXCEPTION 'Bildirim iptali geri alınamaz' USING ERRCODE='ERP10'; END IF;
  IF NEW.secret_encrypted IS DISTINCT FROM OLD.secret_encrypted THEN IF NEW.secret_version<>OLD.secret_version+1 THEN RAISE EXCEPTION 'Bildirim sırrı sürümü sıralı artmalı' USING ERRCODE='ERP10'; END IF;
  ELSIF NEW.secret_version<>OLD.secret_version THEN RAISE EXCEPTION 'Sır değiştirilmeden sürüm artırılamaz' USING ERRCODE='ERP10'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER webhook_subscriptions_guard BEFORE INSERT OR UPDATE OR DELETE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION webhook_subscriptions_guard();
CREATE FUNCTION webhook_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bildirim olayı silinemez' USING ERRCODE='ERP10'; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['status','attempts','next_attempt_at','lease_token','lease_until','delivered_at','last_http_status','last_error']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','attempts','next_attempt_at','lease_token','lease_until','delivered_at','last_http_status','last_error']) THEN RAISE EXCEPTION 'Bildirim olay kimliği ve içeriği değiştirilemez' USING ERRCODE='ERP10'; END IF;
 IF NEW.body::jsonb IS DISTINCT FROM NEW.payload OR NEW.payload->>'id' IS DISTINCT FROM NEW.id::text OR NEW.payload->>'companyId' IS DISTINCT FROM NEW.company_id::text OR NEW.payload->>'type' IS DISTINCT FROM NEW.event_type OR NEW.payload->'data'->>'invoiceId' IS DISTINCT FROM NEW.invoice_id::text OR NEW.payload->>'branchId' IS DISTINCT FROM NEW.branch_id::text THEN RAISE EXCEPTION 'Bildirim olay görüntüsü geçersiz' USING ERRCODE='ERP10'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_events_guard BEFORE INSERT OR UPDATE OR DELETE ON webhook_events FOR EACH ROW EXECUTE FUNCTION webhook_events_guard();
--> statement-breakpoint
-- Belgeyi oluşturan kişi bildirim sırrını okuyamaz; yalnız kimlik alanları kuyruğa girer.
CREATE FUNCTION enqueue_invoice_webhooks(p_invoice uuid,p_type text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i invoices%ROWTYPE;s webhook_subscriptions%ROWTYPE;event_id uuid;event_payload jsonb;
BEGIN
 IF app_user_id() IS NULL OR p_type NOT IN ('invoice.draft.created','invoice.posted') THEN RAISE EXCEPTION 'Bildirim olay bağlamı geçersiz' USING ERRCODE='ERP26'; END IF;
 SELECT * INTO i FROM invoices WHERE id=p_invoice AND company_id=app_company_id();
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM memberships WHERE company_id=i.company_id AND user_id=app_user_id()) OR NOT app_branch_row_allowed(i.company_id,i.branch_id) THEN RAISE EXCEPTION 'Bildirim belgesi erişim kapsamında değil' USING ERRCODE='ERP26'; END IF;
 IF (p_type='invoice.draft.created' AND i.status<>'draft') OR (p_type='invoice.posted' AND i.status<>'posted') THEN RAISE EXCEPTION 'Bildirim olay türü belge durumuyla uyuşmuyor' USING ERRCODE='ERP10'; END IF;
 FOR s IN SELECT * FROM webhook_subscriptions WHERE company_id=i.company_id AND enabled AND revoked_at IS NULL AND branch_id IS NOT DISTINCT FROM i.branch_id AND event_types @> jsonb_build_array(p_type) LOOP
  event_id:=gen_random_uuid();event_payload:=jsonb_build_object('id',event_id,'type',p_type,'occurredAt',clock_timestamp(),'companyId',i.company_id,'branchId',i.branch_id,'data',jsonb_build_object('invoiceId',i.id,'invoiceNo',i.invoice_no,'status',i.status));
  INSERT INTO webhook_events(id,company_id,subscription_id,invoice_id,event_type,branch_id,payload,body) VALUES(event_id,i.company_id,s.id,i.id,p_type,i.branch_id,event_payload,event_payload::text) ON CONFLICT(subscription_id,event_type,invoice_id) DO NOTHING;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION enqueue_invoice_webhooks(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_invoice_webhooks(uuid,text) TO erp_app;
--> statement-breakpoint
CREATE FUNCTION sales_source_branch_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.quote_id IS NOT NULL THEN SELECT branch_id INTO NEW.branch_id FROM sales_orders WHERE id=NEW.quote_id AND company_id=NEW.company_id;
  ELSIF NEW.warehouse_id IS NOT NULL THEN SELECT branch_id INTO NEW.branch_id FROM warehouses WHERE id=NEW.warehouse_id AND company_id=NEW.company_id;
  END IF;
 ELSIF NEW.branch_id IS DISTINCT FROM OLD.branch_id AND OLD.status<>'draft' THEN RAISE EXCEPTION 'Taslak dışındaki satış belgesinin şubesi değiştirilemez' USING ERRCODE='ERP24'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION sales_warehouse_branch_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.warehouse_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id) AND NOT EXISTS(SELECT 1 FROM warehouses WHERE id=NEW.warehouse_id AND company_id=NEW.company_id AND branch_id IS NOT DISTINCT FROM NEW.branch_id) THEN RAISE EXCEPTION 'Satış belgesi deposu aynı şubeden seçilmeli' USING ERRCODE='ERP24'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_sales_source_branch_guard BEFORE INSERT OR UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION sales_source_branch_guard();
CREATE TRIGGER branch_assignment_guard BEFORE INSERT OR UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION branch_assignment_guard();
CREATE TRIGGER z_sales_warehouse_branch_guard BEFORE INSERT OR UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION sales_warehouse_branch_guard();
CREATE POLICY branch_scope ON sales_orders AS RESTRICTIVE USING(app_branch_row_allowed(company_id,branch_id)) WITH CHECK(app_branch_row_allowed(company_id,branch_id));
CREATE POLICY branch_scope ON sales_order_lines AS RESTRICTIVE USING(EXISTS(SELECT 1 FROM sales_orders o WHERE o.id=order_id AND o.company_id=sales_order_lines.company_id)) WITH CHECK(EXISTS(SELECT 1 FROM sales_orders o WHERE o.id=order_id AND o.company_id=sales_order_lines.company_id));
CREATE POLICY branch_scope ON sales_order_events AS RESTRICTIVE USING(EXISTS(SELECT 1 FROM sales_orders o WHERE o.id=order_id AND o.company_id=sales_order_events.company_id)) WITH CHECK(EXISTS(SELECT 1 FROM sales_orders o WHERE o.id=order_id AND o.company_id=sales_order_events.company_id));

--> statement-breakpoint
-- Yüksek tutarlarda bölüm hassasiyeti ve KDV dahil satır uyumu.
CREATE OR REPLACE FUNCTION invoice_tax_expected_payable(p invoices) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE
 l invoice_lines%ROWTYPE; src invoice_lines%ROWTYPE; r document_tax_rules%ROWTYPE;
 c jsonb; cfg jsonb; k text; amount_value numeric; vat_hold numeric; income_hold numeric; stamp_amount numeric;
 group_net numeric; group_gross numeric; group_stamp numeric; stamp_base numeric; allocated numeric; last_no int;
 previous_qty numeric; previous_vat numeric; previous_income numeric; previous_stamp numeric;
 has_tax boolean:=false; total_vat numeric:=0; total_income numeric:=0; total_stamp numeric:=0;
 base_vat numeric:=0; base_income numeric:=0; base_stamp numeric:=0; fx numeric:=coalesce(p.fx_rate,1);
 expected_doc numeric; expected_base numeric; party_status text; group_key jsonb;
BEGIN
 FOR l IN SELECT * FROM invoice_lines WHERE invoice_id=p.id AND company_id=p.company_id ORDER BY line_no LOOP
  IF l.tax_calculation IS NULL AND l.tax_rule_snapshot IS NULL AND l.tax_rule_id IS NULL THEN CONTINUE; END IF;
  has_tax:=true;
  IF l.tax_calculation IS NULL OR l.tax_rule_snapshot IS NULL OR l.tax_rule_id IS NULL THEN RAISE EXCEPTION 'Vergi kuralı, kaynak görüntüsü ve hesap birlikte bulunmalı' USING ERRCODE='ERP03'; END IF;
  c:=l.tax_calculation;cfg:=l.tax_rule_snapshot->'config';
  IF c->>'engineVersion' IS DISTINCT FROM 'document-tax-v1' OR c->>'direction' IS DISTINCT FROM 'normal' THEN RAISE EXCEPTION 'Belge vergi hesap sürümü geçersiz' USING ERRCODE='ERP03'; END IF;
  FOREACH k IN ARRAY ARRAY['netAmount','vat','grossAmount','vatWithheld','vatPayableToSeller','incomeWithheld','stamp','payableToSeller'] LOOP
   IF coalesce(c->>k,'')!~'^\d{1,15}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'Vergi hesap tutarı geçersiz: %',k USING ERRCODE='ERP03'; END IF;
  END LOOP;
  IF (c->>'netAmount')::numeric IS DISTINCT FROM l.net OR (c->>'vat')::numeric IS DISTINCT FROM l.vat OR (c->>'grossAmount')::numeric IS DISTINCT FROM l.gross OR l.gross<>l.net+l.vat THEN RAISE EXCEPTION 'Vergi hesap tutarları fatura satırıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
  IF c->'input'->>'netAmount' IS DISTINCT FROM to_char(l.net,'FM999999999999999990.00')
   OR (c->'input'->>'vatRatePct')::numeric IS DISTINCT FROM l.vat_rate
   OR (c->'input'->>'vatAmount' IS NOT NULL AND (coalesce(c->'input'->>'vatAmount','')!~'^\d{1,15}(\.\d{1,2})?$' OR (c->'input'->>'vatAmount')::numeric IS DISTINCT FROM l.vat))
   OR c->'input'->>'jurisdiction' IS DISTINCT FROM l.tax_rule_snapshot->>'jurisdiction'
   OR c->'input'->>'rulePackVersion' IS DISTINCT FROM l.tax_rule_snapshot->>'version'
   OR c->'input'->'sourceRefs' IS DISTINCT FROM l.tax_rule_snapshot->'sourceRefs'
   OR c->'input'->'vatWithholding' IS DISTINCT FROM cfg->'vatWithholding'
   OR c->'input'->'incomeWithholding' IS DISTINCT FROM cfg->'incomeWithholding'
   OR c->'input'->'stamp' IS DISTINCT FROM cfg->'stamp' THEN RAISE EXCEPTION 'Vergi hesabının girdisi doğrulanmış kaynakla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
  IF l.source_line_id IS NOT NULL THEN
   SELECT * INTO src FROM invoice_lines WHERE id=l.source_line_id AND invoice_id=p.return_of_id AND company_id=p.company_id;
   IF NOT FOUND OR src.tax_calculation IS NULL OR src.tax_rule_id IS DISTINCT FROM l.tax_rule_id OR src.tax_rule_snapshot IS DISTINCT FROM l.tax_rule_snapshot OR l.vat_rate IS DISTINCT FROM src.vat_rate OR l.vat_code IS DISTINCT FROM src.vat_code THEN RAISE EXCEPTION 'İade vergi kaynağı özgün satırla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   SELECT coalesce(sum(x.quantity),0),coalesce(sum((x.tax_calculation->>'vatWithheld')::numeric),0),coalesce(sum((x.tax_calculation->>'incomeWithheld')::numeric),0),coalesce(sum((x.tax_calculation->>'stamp')::numeric),0)
    INTO previous_qty,previous_vat,previous_income,previous_stamp FROM invoice_lines x JOIN invoices h ON h.id=x.invoice_id AND h.company_id=x.company_id
    WHERE x.source_line_id=src.id AND x.company_id=p.company_id AND ((h.status='posted' AND h.id<>p.id) OR (h.id=p.id AND x.line_no<l.line_no));
   IF l.quantity>src.quantity-previous_qty THEN RAISE EXCEPTION 'Vergi iadeleri özgün satır miktarını aşıyor' USING ERRCODE='ERP03'; END IF;
   IF l.quantity=src.quantity-previous_qty THEN
    vat_hold:=(src.tax_calculation->>'vatWithheld')::numeric-previous_vat;income_hold:=(src.tax_calculation->>'incomeWithheld')::numeric-previous_income;stamp_amount:=(src.tax_calculation->>'stamp')::numeric-previous_stamp;
   ELSE
    vat_hold:=round(((src.tax_calculation->>'vatWithheld')::numeric*l.quantity)::numeric(80,40)/src.quantity,2);income_hold:=round(((src.tax_calculation->>'incomeWithheld')::numeric*l.quantity)::numeric(80,40)/src.quantity,2);stamp_amount:=round(((src.tax_calculation->>'stamp')::numeric*l.quantity)::numeric(80,40)/src.quantity,2);
   END IF;
  ELSE
   SELECT * INTO r FROM document_tax_rules WHERE id=l.tax_rule_id AND company_id=p.company_id;
   SELECT tax_status INTO party_status FROM parties WHERE id=p.party_id AND company_id=p.company_id;
   IF NOT FOUND OR NOT r.enabled OR r.verified_at IS NULL OR r.verified_by IS NULL OR p.invoice_date<r.valid_from OR (r.valid_to IS NOT NULL AND p.invoice_date>r.valid_to)
    OR r.jurisdiction IS DISTINCT FROM p.legal_profile_snapshot->>'jurisdiction' OR r.invoice_type IS DISTINCT FROM p.type OR r.party_tax_status IS DISTINCT FROM party_status
    OR r.product_class IS DISTINCT FROM l.product_class OR r.transaction_type IS DISTINCT FROM l.transaction_type
    OR l.tax_rule_snapshot->>'id' IS DISTINCT FROM r.id::text OR cfg IS DISTINCT FROM r.config OR l.tax_rule_snapshot->>'version' IS DISTINCT FROM r.version
    OR l.tax_rule_snapshot->>'jurisdiction' IS DISTINCT FROM r.jurisdiction OR l.tax_rule_snapshot->'sourceRefs' IS DISTINCT FROM r.source_refs
    OR l.tax_rule_snapshot->>'productClass' IS DISTINCT FROM r.product_class OR l.tax_rule_snapshot->>'transactionType' IS DISTINCT FROM r.transaction_type
    OR l.tax_rule_snapshot->>'partyTaxStatus' IS DISTINCT FROM r.party_tax_status OR l.tax_rule_snapshot->>'invoiceType' IS DISTINCT FROM r.invoice_type
    OR l.tax_rule_snapshot->>'verifiedBy' IS DISTINCT FROM r.verified_by OR (l.tax_rule_snapshot->>'verifiedAt')::timestamptz IS DISTINCT FROM r.verified_at THEN RAISE EXCEPTION 'Belge vergisi tarihli doğrulanmış kuralla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   IF l.tax_treatment IS DISTINCT FROM cfg->>'taxTreatment' OR l.vat_code IS DISTINCT FROM cfg->>'vatCode' THEN RAISE EXCEPTION 'KDV işlemi vergi kuralıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   IF cfg->>'taxTreatment'='exempt' THEN
    IF l.vat<>0 OR l.vat_rate<>0 THEN RAISE EXCEPTION 'İstisna satırında KDV olamaz' USING ERRCODE='ERP03'; END IF;
   ELSE
    IF NOT EXISTS(SELECT 1 FROM tax_rates t WHERE t.company_id=p.company_id AND t.code=l.vat_code AND t.jurisdiction=r.jurisdiction AND t.valid_from<=p.invoice_date AND (t.valid_to IS NULL OR t.valid_to>=p.invoice_date) AND t.rate=l.vat_rate) THEN RAISE EXCEPTION 'KDV oranı tarihli şirket kaynağına ait değil' USING ERRCODE='ERP03'; END IF;
   END IF;
   IF p.vat_included THEN
    IF l.net<>round(l.gross::numeric(80,40)/(1+l.vat_rate*0.01),2) OR l.vat<>l.gross-l.net THEN RAISE EXCEPTION 'KDV dahil satır aritmetiği uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   ELSIF l.vat<>round(l.net*l.vat_rate*0.01,2) THEN RAISE EXCEPTION 'KDV hariç satır aritmetiği uyuşmuyor' USING ERRCODE='ERP03'; END IF;
   vat_hold:=CASE WHEN cfg->'vatWithholding' IS NULL OR cfg->'vatWithholding'='null'::jsonb THEN 0 ELSE round((l.vat*(cfg->'vatWithholding'->>'numerator')::numeric)::numeric(80,40)/(cfg->'vatWithholding'->>'denominator')::numeric,2) END;
   income_hold:=CASE WHEN cfg->'incomeWithholding' IS NULL OR cfg->'incomeWithholding'='null'::jsonb THEN 0 ELSE round((CASE WHEN cfg->'incomeWithholding'->>'basis'='gross' THEN l.gross ELSE l.net END)*(cfg->'incomeWithholding'->>'ratePct')::numeric*0.01,2) END;
   stamp_amount:=0;
   IF cfg->'stamp' IS NOT NULL AND cfg->'stamp'<>'null'::jsonb THEN
    group_net:=l.net;group_gross:=l.gross;
    IF coalesce(cfg->>'stampScope','document')='document' THEN
     group_key:=jsonb_build_array(r.jurisdiction,r.version,r.source_refs,cfg->'stamp',cfg->'stampLiability');
     SELECT coalesce(sum(x.net),0),coalesce(sum(x.gross),0),max(x.line_no) INTO group_net,group_gross,last_no FROM invoice_lines x
      WHERE x.invoice_id=p.id AND x.company_id=p.company_id AND x.source_line_id IS NULL AND x.tax_rule_snapshot IS NOT NULL
       AND coalesce(x.tax_rule_snapshot->'config'->>'stampScope','document')='document'
       AND jsonb_build_array(x.tax_rule_snapshot->>'jurisdiction',x.tax_rule_snapshot->>'version',x.tax_rule_snapshot->'sourceRefs',x.tax_rule_snapshot->'config'->'stamp',x.tax_rule_snapshot->'config'->'stampLiability')=group_key;
    END IF;
    IF cfg->'stamp'->>'kind'='fixed' THEN group_stamp:=round((cfg->'stamp'->>'amount')::numeric,2);
    ELSE
     stamp_base:=greatest(0,(CASE WHEN cfg->'stamp'->>'basis'='gross' THEN group_gross ELSE group_net END)-(cfg->'stamp'->>'exemptAmount')::numeric);
     group_stamp:=round(stamp_base*(cfg->'stamp'->>'ratePct')::numeric*0.01,2);
     IF cfg->'stamp'->>'capAmount' IS NOT NULL THEN group_stamp:=least(group_stamp,(cfg->'stamp'->>'capAmount')::numeric); END IF;
    END IF;
    stamp_amount:=group_stamp;
    IF coalesce(cfg->>'stampScope','document')='document' THEN
     IF c->'stampAllocation'->>'basis' IS DISTINCT FROM 'document' OR (c->'stampAllocation'->>'documentNet')::numeric IS DISTINCT FROM group_net OR (c->'stampAllocation'->>'documentGross')::numeric IS DISTINCT FROM group_gross OR (c->'stampAllocation'->>'documentStamp')::numeric IS DISTINCT FROM group_stamp THEN RAISE EXCEPTION 'Belge damga matrahı ve tavanı uyuşmuyor' USING ERRCODE='ERP03'; END IF;
     IF l.line_no=last_no THEN
      SELECT coalesce(sum(CASE WHEN group_net=0 THEN 0 ELSE round((group_stamp*x.net)::numeric(80,40)/group_net,2) END),0) INTO allocated FROM invoice_lines x
       WHERE x.invoice_id=p.id AND x.company_id=p.company_id AND x.source_line_id IS NULL AND x.line_no<last_no AND x.tax_rule_snapshot IS NOT NULL
        AND coalesce(x.tax_rule_snapshot->'config'->>'stampScope','document')='document'
        AND jsonb_build_array(x.tax_rule_snapshot->>'jurisdiction',x.tax_rule_snapshot->>'version',x.tax_rule_snapshot->'sourceRefs',x.tax_rule_snapshot->'config'->'stamp',x.tax_rule_snapshot->'config'->'stampLiability')=group_key;
      stamp_amount:=group_stamp-allocated;
     ELSE stamp_amount:=CASE WHEN group_net=0 THEN 0 ELSE round((group_stamp*l.net)::numeric(80,40)/group_net,2) END; END IF;
    END IF;
   END IF;
  END IF;
  IF (c->>'vatWithheld')::numeric IS DISTINCT FROM vat_hold OR (c->>'incomeWithheld')::numeric IS DISTINCT FROM income_hold OR (c->>'stamp')::numeric IS DISTINCT FROM stamp_amount
   OR (c->>'vatPayableToSeller')::numeric IS DISTINCT FROM l.vat-vat_hold OR (c->>'payableToSeller')::numeric IS DISTINCT FROM l.gross-vat_hold-income_hold OR l.gross-vat_hold-income_hold<0 THEN RAISE EXCEPTION 'Vergi kesintisi veya ödenecek tutar aritmetiği uyuşmuyor' USING ERRCODE='ERP03'; END IF;
  total_vat:=total_vat+vat_hold;total_income:=total_income+income_hold;total_stamp:=total_stamp+stamp_amount;
  base_vat:=base_vat+round(vat_hold*fx,2);base_income:=base_income+round(income_hold*fx,2);base_stamp:=base_stamp+round(stamp_amount*fx,2);
 END LOOP;
 IF NOT has_tax THEN
  IF p.tax_totals_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Kaynak vergi satırı olmadan toplam vergi görüntüsü yazılamaz' USING ERRCODE='ERP03'; END IF;
  RETURN p.gross_total_base;
 END IF;
 expected_doc:=p.gross_total-total_vat-total_income;expected_base:=p.gross_total_base-base_vat-base_income;
 IF p.tax_totals_snapshot IS NULL OR p.tax_totals_snapshot->>'engineVersion' IS DISTINCT FROM 'document-tax-v1' THEN RAISE EXCEPTION 'Belge vergi toplam görüntüsü gerekli' USING ERRCODE='ERP03'; END IF;
 FOREACH k IN ARRAY ARRAY['vatWithheld','incomeWithheld','stamp','payableToSeller','vatWithheldBase','incomeWithheldBase','stampBase','payableToSellerBase'] LOOP
  IF coalesce(p.tax_totals_snapshot->>k,'')!~'^\d{1,15}(\.\d{1,2})?$' THEN RAISE EXCEPTION 'Belge vergi toplamı geçersiz: %',k USING ERRCODE='ERP03'; END IF;
 END LOOP;
 IF (p.tax_totals_snapshot->>'vatWithheld')::numeric IS DISTINCT FROM total_vat OR (p.tax_totals_snapshot->>'incomeWithheld')::numeric IS DISTINCT FROM total_income OR (p.tax_totals_snapshot->>'stamp')::numeric IS DISTINCT FROM total_stamp
  OR (p.tax_totals_snapshot->>'payableToSeller')::numeric IS DISTINCT FROM expected_doc OR (p.tax_totals_snapshot->>'vatWithheldBase')::numeric IS DISTINCT FROM base_vat OR (p.tax_totals_snapshot->>'incomeWithheldBase')::numeric IS DISTINCT FROM base_income OR (p.tax_totals_snapshot->>'stampBase')::numeric IS DISTINCT FROM base_stamp OR (p.tax_totals_snapshot->>'payableToSellerBase')::numeric IS DISTINCT FROM expected_base THEN RAISE EXCEPTION 'Belge vergi toplamları satır ve kur hesaplarıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
 SELECT coalesce(sum(round(net*fx,2)+round(vat*fx,2)),0) INTO amount_value FROM invoice_lines WHERE invoice_id=p.id AND company_id=p.company_id;
 IF amount_value IS DISTINCT FROM p.gross_total_base THEN RAISE EXCEPTION 'Vergili fatura defter tutarı satır kur toplamıyla uyuşmuyor' USING ERRCODE='ERP03'; END IF;
 RETURN expected_base;
END $$;

