CREATE TABLE "company_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "company_budget_revision" UNIQUE("company_id","series_id","revision"),
	CONSTRAINT "company_budget_status" CHECK ("company_budgets"."status" in ('draft','approved','superseded')),
	CONSTRAINT "company_budget_revision_positive" CHECK ("company_budgets"."revision">0 and "company_budgets"."version">0),
	CONSTRAINT "company_budget_approval" CHECK (("company_budgets"."status"='draft' and "company_budgets"."approved_by" is null and "company_budgets"."approved_at" is null) or ("company_budgets"."status"<>'draft' and "company_budgets"."approved_by" is not null and "company_budgets"."approved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "company_budgets" ADD CONSTRAINT "company_budgets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_budgets" ADD CONSTRAINT "company_budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_budgets" ADD CONSTRAINT "company_budgets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_budget_draft" ON "company_budgets" USING btree ("company_id","series_id") WHERE "company_budgets"."status"='draft';--> statement-breakpoint
CREATE UNIQUE INDEX "company_budget_approved" ON "company_budgets" USING btree ("company_id","series_id") WHERE "company_budgets"."status"='approved';
--> statement-breakpoint
ALTER TABLE company_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_budgets USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id());
GRANT SELECT,INSERT,UPDATE ON company_budgets TO erp_app;
CREATE TRIGGER audit_company_budgets AFTER INSERT OR UPDATE OR DELETE ON company_budgets FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE FUNCTION company_budgets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous company_budgets%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bütçe geçmişi silinemez' USING ERRCODE='ERP19'; END IF;
 IF jsonb_typeof(NEW.config->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.config->'lines') NOT BETWEEN 1 AND 150
    OR NEW.config->>'scope' NOT IN ('company','department') OR (NEW.config->>'year')::integer NOT BETWEEN 1900 AND 2100 THEN
   RAISE EXCEPTION 'Bütçe kapsamı geçersiz' USING ERRCODE='ERP19';
 END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
     RAISE EXCEPTION 'Bütçe taslak olarak başlamalı' USING ERRCODE='ERP19';
   END IF;
   SELECT * INTO previous FROM company_budgets WHERE company_id=NEW.company_id AND series_id=NEW.series_id ORDER BY revision DESC LIMIT 1;
   IF FOUND THEN
     IF previous.status<>'approved' OR NEW.revision<>previous.revision+1 OR NEW.config->'year'<>previous.config->'year' OR NEW.config->'scope'<>previous.config->'scope' OR NEW.config->'department'<>previous.config->'department' THEN
       RAISE EXCEPTION 'Revizyon güncel onaylı bütçenin aynı kapsamından açılmalı' USING ERRCODE='ERP19';
     END IF;
   ELSIF NEW.series_id<>NEW.id OR NEW.revision<>1 THEN
     RAISE EXCEPTION 'İlk bütçe revizyonu geçersiz' USING ERRCODE='ERP19';
   END IF;
 ELSE
   IF (to_jsonb(NEW)-'config'-'version'-'status'-'updated_at'-'approved_by'-'approved_at')<>(to_jsonb(OLD)-'config'-'version'-'status'-'updated_at'-'approved_by'-'approved_at') OR NEW.version<>OLD.version+1 THEN
     RAISE EXCEPTION 'Bütçe kimliği ve revizyonu değiştirilemez' USING ERRCODE='ERP19';
   END IF;
   IF NEW.config->'year'<>OLD.config->'year' OR NEW.config->'scope'<>OLD.config->'scope' OR NEW.config->'department'<>OLD.config->'department' THEN
     RAISE EXCEPTION 'Bütçe seri kapsamı değiştirilemez' USING ERRCODE='ERP19';
   END IF;
   IF OLD.status='draft' THEN
     IF NEW.status NOT IN ('draft','approved') OR (NEW.status='approved' AND (NEW.config<>OLD.config OR NEW.approved_by IS DISTINCT FROM app_user_id() OR NEW.approved_at IS NULL)) THEN
       RAISE EXCEPTION 'Taslak yalnızca güncel içeriğiyle onaylanır' USING ERRCODE='ERP19';
     END IF;
   ELSIF OLD.status='approved' AND NEW.status='superseded' THEN
     IF NEW.config<>OLD.config OR NEW.approved_by<>OLD.approved_by OR NEW.approved_at<>OLD.approved_at OR NOT EXISTS(SELECT 1 FROM company_budgets WHERE company_id=NEW.company_id AND series_id=NEW.series_id AND status='draft' AND revision>NEW.revision) THEN
       RAISE EXCEPTION 'Onaylı bütçe yalnızca yeni revizyon onayıyla geçersiz olur' USING ERRCODE='ERP19';
     END IF;
   ELSE
     RAISE EXCEPTION 'Onaylı bütçe geçmişi değiştirilemez' USING ERRCODE='ERP19';
   END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER company_budgets_guard BEFORE INSERT OR UPDATE OR DELETE ON company_budgets FOR EACH ROW EXECUTE FUNCTION company_budgets_guard();
--> statement-breakpoint
CREATE FUNCTION company_budgets_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM company_budgets WHERE company_id=NEW.company_id AND series_id=NEW.series_id AND status='superseded') AND NOT EXISTS(SELECT 1 FROM company_budgets WHERE company_id=NEW.company_id AND series_id=NEW.series_id AND status='approved') THEN
   RAISE EXCEPTION 'Eski bütçe yerine onaylı yeni revizyon gerekir' USING ERRCODE='ERP19';
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER company_budgets_approval_guard AFTER UPDATE ON company_budgets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION company_budgets_approval_guard();
