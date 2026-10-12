CREATE TABLE "company_branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_branches_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "company_branches_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "company_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_role" text NOT NULL,
	"access" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_roles_name_uq" UNIQUE("company_id","name"),
	CONSTRAINT "company_roles_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "company_roles_base_ck" CHECK ("company_roles"."base_role" in ('accountant','sales','site_manager','viewer','operations_manager','operator'))
);
--> statement-breakpoint
CREATE TABLE "document_tax_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"version" text NOT NULL,
	"product_class" text NOT NULL,
	"transaction_type" text NOT NULL,
	"party_tax_status" text NOT NULL,
	"invoice_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_note" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_tax_rules_code_date_uq" UNIQUE("company_id","code","valid_from"),
	CONSTRAINT "document_tax_rules_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "document_tax_rules_country_ck" CHECK ("document_tax_rules"."jurisdiction" in ('TR','KKTC')),
	CONSTRAINT "document_tax_rules_range_ck" CHECK ("document_tax_rules"."valid_to" is null or "document_tax_rules"."valid_to">="document_tax_rules"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "export_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"report_key" text NOT NULL,
	"format" text NOT NULL,
	"row_count" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text NOT NULL,
	"ip" text,
	CONSTRAINT "export_events_count_ck" CHECK ("export_events"."row_count">=0)
);
--> statement-breakpoint
CREATE TABLE "member_branch_access" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	CONSTRAINT "member_branch_access_company_id_user_id_branch_id_pk" PRIMARY KEY("company_id","user_id","branch_id")
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_rule_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_calculation" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "product_class" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "transaction_type" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_treatment" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_totals_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "branch_scope_mode" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "branch_allow_unassigned" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "tax_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "company_branches" ADD CONSTRAINT "company_branches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_branches" ADD CONSTRAINT "company_branches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_roles" ADD CONSTRAINT "company_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_roles" ADD CONSTRAINT "company_roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tax_rules" ADD CONSTRAINT "document_tax_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_events" ADD CONSTRAINT "export_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_events" ADD CONSTRAINT "export_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_branch_access" ADD CONSTRAINT "member_branch_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_branch_access" ADD CONSTRAINT "member_branch_access_membership_fk" FOREIGN KEY ("company_id","user_id") REFERENCES "public"."memberships"("company_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_branch_access" ADD CONSTRAINT "member_branch_access_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_rule_fk" FOREIGN KEY ("tax_rule_id","company_id") REFERENCES "public"."document_tax_rules"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_custom_role_fk" FOREIGN KEY ("custom_role_id","company_id") REFERENCES "public"."company_roles"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branch_fk" FOREIGN KEY ("branch_id","company_id") REFERENCES "public"."company_branches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_branch_scope_ck" CHECK ("memberships"."branch_scope_mode" in ('all','restricted'));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_tax_status_ck" CHECK ("parties"."tax_status" in ('unknown','consumer','business','vat_registered','withholding_agent','nonresident'));
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_branches','member_branch_access','company_roles','document_tax_rules','export_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
  EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
 END LOOP;
 GRANT SELECT,INSERT,UPDATE ON company_branches,company_roles,document_tax_rules TO erp_app;
 GRANT SELECT,INSERT,DELETE ON member_branch_access TO erp_app;
 GRANT SELECT,INSERT ON export_events TO erp_app;
END $$;
--> statement-breakpoint
CREATE FUNCTION app_branch_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.branch_id',true),'')::uuid $$;
CREATE FUNCTION app_branch_has_access(p_company uuid,p_branch uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p_company=app_company_id() AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=p_company AND m.user_id=app_user_id() AND (m.role='owner' OR m.branch_scope_mode='all' OR (p_branch IS NULL AND m.branch_allow_unassigned) OR EXISTS(SELECT 1 FROM member_branch_access a WHERE a.company_id=p_company AND a.user_id=m.user_id AND a.branch_id=p_branch)))
$$;
CREATE FUNCTION app_branch_row_allowed(p_company uuid,p_branch uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT app_branch_has_access(p_company,p_branch) AND CASE coalesce(nullif(current_setting('app.branch_selection',true),''),'all') WHEN 'branch' THEN p_branch=app_branch_id() WHEN 'unassigned' THEN p_branch IS NULL ELSE true END
$$;
REVOKE ALL ON FUNCTION app_branch_has_access(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_branch_has_access(uuid,uuid) TO erp_app;
--> statement-breakpoint
CREATE POLICY branch_read_scope ON company_branches AS RESTRICTIVE FOR SELECT USING(app_branch_has_access(company_id,id));
CREATE POLICY branch_access_read_scope ON member_branch_access AS RESTRICTIVE FOR SELECT USING(user_id=app_user_id() OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=member_branch_access.company_id AND m.user_id=app_user_id() AND m.role IN ('owner','admin')));
CREATE POLICY export_read_scope ON export_events AS RESTRICTIVE FOR SELECT USING(user_id=app_user_id() OR EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=export_events.company_id AND m.user_id=app_user_id() AND m.role IN ('owner','admin')));
CREATE POLICY export_insert_actor ON export_events AS RESTRICTIVE FOR INSERT WITH CHECK(user_id=app_user_id());
--> statement-breakpoint
CREATE FUNCTION branch_admin_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE caller memberships%ROWTYPE; BEGIN
 SELECT * INTO caller FROM memberships WHERE company_id=coalesce(NEW.company_id,OLD.company_id) AND user_id=app_user_id();
 IF app_user_id() IS NOT NULL AND (NOT FOUND OR caller.role NOT IN ('owner','admin')) THEN RAISE EXCEPTION 'Şube ve rol yönetimi yönetici yetkisi ister' USING ERRCODE='ERP26'; END IF;
 IF TG_TABLE_NAME='company_branches' AND app_user_id() IS NOT NULL AND caller.branch_scope_mode<>'all' THEN RAISE EXCEPTION 'Şube yönetimi tüm şubelere erişim ister' USING ERRCODE='ERP26'; END IF;
 IF TG_TABLE_NAME='member_branch_access' THEN
  IF TG_OP='INSERT' AND app_user_id() IS NOT NULL AND NOT app_branch_has_access(NEW.company_id,NEW.branch_id) THEN RAISE EXCEPTION 'Kendi şube kapsamınızdan fazlasını veremezsiniz' USING ERRCODE='ERP26'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER branch_admin_guard BEFORE INSERT OR UPDATE OR DELETE ON company_branches FOR EACH ROW EXECUTE FUNCTION branch_admin_guard();
CREATE TRIGGER branch_admin_guard BEFORE INSERT OR DELETE ON member_branch_access FOR EACH ROW EXECUTE FUNCTION branch_admin_guard();
CREATE TRIGGER branch_admin_guard BEFORE INSERT OR UPDATE OR DELETE ON company_roles FOR EACH ROW EXECUTE FUNCTION branch_admin_guard();
--> statement-breakpoint
CREATE FUNCTION membership_scope_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r company_roles%ROWTYPE; caller memberships%ROWTYPE; BEGIN
 IF NEW.role='owner' AND (NEW.branch_scope_mode<>'all' OR NOT NEW.branch_allow_unassigned) THEN RAISE EXCEPTION 'Şirket sahibinin şube erişimi kısıtlanamaz' USING ERRCODE='ERP26'; END IF;
 IF NEW.custom_role_id IS NOT NULL THEN
  SELECT * INTO r FROM company_roles WHERE id=NEW.custom_role_id AND company_id=NEW.company_id;
  IF NOT FOUND OR NOT r.is_active OR r.base_role<>NEW.role OR NEW.role IN ('owner','admin') THEN RAISE EXCEPTION 'Üyelik özel rolü geçersiz veya pasif' USING ERRCODE='ERP26'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.branch_scope_mode,NEW.branch_allow_unassigned) IS DISTINCT FROM (OLD.branch_scope_mode,OLD.branch_allow_unassigned) THEN
  SELECT * INTO caller FROM memberships WHERE company_id=NEW.company_id AND user_id=app_user_id();
  IF app_user_id() IS NOT NULL AND (NOT FOUND OR caller.role NOT IN ('owner','admin') OR (caller.branch_scope_mode='restricted' AND (NEW.branch_scope_mode='all' OR (NEW.branch_allow_unassigned AND NOT caller.branch_allow_unassigned)))) THEN RAISE EXCEPTION 'Kendi şube kapsamınızdan fazlasını veremezsiniz' USING ERRCODE='ERP26'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_scope_role_guard BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION membership_scope_role_guard();
--> statement-breakpoint
CREATE FUNCTION document_tax_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.verified_at IS NOT NULL OR NEW.verified_by IS NOT NULL THEN RAISE EXCEPTION 'Vergi kuralı doğrulanmadan oluşturulmalı' USING ERRCODE='ERP24'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['enabled','verified_at','verified_by','valid_to']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['enabled','verified_at','verified_by','valid_to']) THEN RAISE EXCEPTION 'Vergi kuralı değişmez; yeni tarihli sürüm oluşturun' USING ERRCODE='ERP24'; END IF;
  IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
   IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.valid_to<NEW.valid_from THEN RAISE EXCEPTION 'Vergi kuralının bitişi yalnız bir kez kapatılabilir' USING ERRCODE='ERP24'; END IF;
   IF document_tax_rule_last_used_date(OLD.company_id,OLD.id)>NEW.valid_to THEN RAISE EXCEPTION 'Vergi kuralı bitişi kullanıldığı kesinleşmiş belge tarihinden önce olamaz' USING ERRCODE='ERP24'; END IF;
  END IF;
  IF (NEW.verified_at,NEW.verified_by) IS DISTINCT FROM (OLD.verified_at,OLD.verified_by) AND (OLD.verified_at IS NOT NULL OR OLD.verified_by IS NOT NULL OR NEW.verified_at IS NULL OR NEW.verified_by IS NULL OR length(btrim(NEW.verified_by))<1) THEN RAISE EXCEPTION 'Vergi kuralı yalnız bir kez doğrulanabilir' USING ERRCODE='ERP24'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_tax_rule_guard BEFORE INSERT OR UPDATE ON document_tax_rules FOR EACH ROW EXECUTE FUNCTION document_tax_rule_guard();
CREATE FUNCTION document_tax_rule_last_used_date(p_company uuid,p_rule uuid) RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT max(i.invoice_date) FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id AND i.company_id=l.company_id WHERE l.company_id=p_company AND l.tax_rule_id=p_rule AND i.status<>'draft' $$;
--> statement-breakpoint
CREATE FUNCTION immutable_export_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Dışa aktarma denetim kaydı değiştirilemez' USING ERRCODE='ERP07'; END $$;
CREATE TRIGGER immutable_export_event_guard BEFORE UPDATE OR DELETE ON export_events FOR EACH ROW EXECUTE FUNCTION immutable_export_event_guard();
--> statement-breakpoint
CREATE FUNCTION branch_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE derived uuid; BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.branch_id IS NULL THEN NEW.branch_id:=app_branch_id(); END IF;
  IF TG_TABLE_NAME='invoices' THEN
   IF NEW.return_of_id IS NOT NULL THEN SELECT branch_id INTO NEW.branch_id FROM invoices WHERE id=NEW.return_of_id AND company_id=NEW.company_id; END IF;
  END IF;
  IF TG_TABLE_NAME='journal_entries' THEN
   IF NEW.reversal_of_id IS NOT NULL THEN SELECT branch_id INTO NEW.branch_id FROM journal_entries WHERE id=NEW.reversal_of_id AND company_id=NEW.company_id;
   ELSIF NEW.source_type='invoice' THEN SELECT branch_id INTO NEW.branch_id FROM invoices WHERE id=NEW.source_id AND company_id=NEW.company_id; END IF;
  END IF;
  IF TG_TABLE_NAME='stock_documents' THEN SELECT branch_id INTO NEW.branch_id FROM warehouses WHERE id=NEW.warehouse_id AND company_id=NEW.company_id; END IF;
  IF TG_TABLE_NAME='treasury_transactions' THEN SELECT branch_id INTO NEW.branch_id FROM journal_entries WHERE id=NEW.journal_entry_id AND company_id=NEW.company_id; END IF;
 ELSE
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id AND TG_TABLE_NAME='warehouses' AND EXISTS(SELECT 1 FROM stock_movements WHERE company_id=OLD.company_id AND warehouse_id=OLD.id) THEN RAISE EXCEPTION 'Hareket görmüş depo şubesi değiştirilemez; yeni depo ve stok transferi kullanın' USING ERRCODE='ERP24'; END IF;
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id AND TG_TABLE_NAME='employees' AND EXISTS(SELECT 1 FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE l.company_id=OLD.company_id AND l.employee_id=OLD.id AND r.status<>'draft') THEN RAISE EXCEPTION 'Kesinleşmiş bordrolu personelin şubesi doğrudan değiştirilemez' USING ERRCODE='ERP24'; END IF;
 END IF;
 IF app_user_id() IS NOT NULL AND NOT app_branch_has_access(NEW.company_id,NEW.branch_id) THEN RAISE EXCEPTION 'Kayıt şubesi erişim kapsamınız dışında' USING ERRCODE='ERP26'; END IF;
 IF NEW.branch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company_branches WHERE id=NEW.branch_id AND company_id=NEW.company_id AND is_active) AND (TG_OP='INSERT' OR NEW.branch_id IS DISTINCT FROM OLD.branch_id) THEN RAISE EXCEPTION 'Etkin ve aynı şirkete ait şube seçin' USING ERRCODE='ERP24'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['warehouses','employees','invoices','journal_entries','treasury_transactions','stock_documents'] LOOP
  EXECUTE format('CREATE TRIGGER branch_assignment_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION branch_assignment_guard()',t);
  EXECUTE format('CREATE POLICY branch_scope ON %I AS RESTRICTIVE USING(app_branch_row_allowed(company_id,branch_id)) WITH CHECK(app_branch_row_allowed(company_id,branch_id))',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY branch_scope ON journal_lines AS RESTRICTIVE USING(EXISTS(SELECT 1 FROM journal_entries e WHERE e.id=entry_id AND e.company_id=journal_lines.company_id)) WITH CHECK(EXISTS(SELECT 1 FROM journal_entries e WHERE e.id=entry_id AND e.company_id=journal_lines.company_id));
CREATE POLICY branch_scope ON invoice_lines AS RESTRICTIVE USING(EXISTS(SELECT 1 FROM invoices e WHERE e.id=invoice_id AND e.company_id=invoice_lines.company_id)) WITH CHECK(EXISTS(SELECT 1 FROM invoices e WHERE e.id=invoice_id AND e.company_id=invoice_lines.company_id));
CREATE POLICY branch_scope ON stock_movements AS RESTRICTIVE USING(EXISTS(SELECT 1 FROM warehouses w WHERE w.id=warehouse_id AND w.company_id=stock_movements.company_id)) WITH CHECK(EXISTS(SELECT 1 FROM warehouses w WHERE w.id=warehouse_id AND w.company_id=stock_movements.company_id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['delivery_notes','stock_counts','pos_tills'] LOOP
  EXECUTE format('CREATE POLICY branch_scope ON %1$I AS RESTRICTIVE USING(EXISTS(SELECT 1 FROM warehouses w WHERE w.id=%1$I.warehouse_id AND w.company_id=%1$I.company_id)) WITH CHECK(EXISTS(SELECT 1 FROM warehouses w WHERE w.id=%1$I.warehouse_id AND w.company_id=%1$I.company_id))',t);
 END LOOP;
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='employee_id' AND table_name NOT IN ('employees') LOOP
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='company_id') THEN
   EXECUTE format('CREATE POLICY branch_employee_scope ON %1$I AS RESTRICTIVE USING(employee_id IS NULL OR EXISTS(SELECT 1 FROM employees e WHERE e.id=%1$I.employee_id AND e.company_id=%1$I.company_id)) WITH CHECK(employee_id IS NULL OR EXISTS(SELECT 1 FROM employees e WHERE e.id=%1$I.employee_id AND e.company_id=%1$I.company_id))',t);
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
-- Şirket ülke geçişi tüm şubelerdeki geçmişi kontrol eder; aktif şube filtresi bunu daraltamaz.
ALTER FUNCTION company_has_finalized_records(uuid) SECURITY DEFINER;
ALTER FUNCTION company_has_finalized_records(uuid) SET search_path=public,pg_temp;
ALTER TABLE member_module_access ADD CONSTRAINT member_module_access_operation_level_ck CHECK(module_key NOT LIKE 'operation.%' OR (module_key~'^operation\.[a-z][a-z0-9_.]+\.(create|update|delete|export)$' AND level IN ('none','write')));
