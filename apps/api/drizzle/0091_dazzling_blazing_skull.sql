CREATE TABLE "construction_production_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"production_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"quantity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "construction_workflow_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"by" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "construction_workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"location_id" uuid,
	"wbs_id" uuid,
	"owner_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payload" jsonb NOT NULL,
	"computed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"linked_kind" text,
	"linked_id" uuid,
	CONSTRAINT "cw_id_company" UNIQUE("id","company_id")
);
--> statement-breakpoint
ALTER TABLE "construction_production_allocations" ADD CONSTRAINT "construction_production_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_production_allocations" ADD CONSTRAINT "construction_production_allocations_production_id_company_id_construction_workflows_id_company_id_fk" FOREIGN KEY ("production_id","company_id") REFERENCES "public"."construction_workflows"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflow_events" ADD CONSTRAINT "construction_workflow_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflow_events" ADD CONSTRAINT "construction_workflow_events_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflow_events" ADD CONSTRAINT "construction_workflow_events_workflow_id_company_id_construction_workflows_id_company_id_fk" FOREIGN KEY ("workflow_id","company_id") REFERENCES "public"."construction_workflows"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_location_id_company_id_construction_locations_id_company_id_fk" FOREIGN KEY ("location_id","company_id") REFERENCES "public"."construction_locations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_workflows" ADD CONSTRAINT "construction_workflows_wbs_id_company_id_project_wbs_id_company_id_fk" FOREIGN KEY ("wbs_id","company_id") REFERENCES "public"."project_wbs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cpa_production" ON "construction_production_allocations" USING btree ("company_id","production_id");--> statement-breakpoint
CREATE INDEX "cwe_workflow" ON "construction_workflow_events" USING btree ("company_id","workflow_id","at");--> statement-breakpoint
CREATE INDEX "cw_project" ON "construction_workflows" USING btree ("company_id","project_id","kind","status");
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['construction_workflows','construction_workflow_events','construction_production_allocations'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON construction_workflows TO erp_app;
GRANT SELECT,INSERT ON construction_workflow_events,construction_production_allocations TO erp_app;
--> statement-breakpoint
ALTER TABLE construction_production_allocations ADD CONSTRAINT cpa_payment_fk FOREIGN KEY(payment_id,company_id) REFERENCES progress_payments(id,company_id);
CREATE UNIQUE INDEX cpa_payment_unique ON construction_production_allocations(production_id,payment_id);
CREATE OR REPLACE FUNCTION construction_workflow_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF OLD.status IN ('approved','closed','reserved','contracted') AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.computed IS DISTINCT FROM OLD.computed OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.wbs_id IS DISTINCT FROM OLD.wbs_id) THEN
RAISE EXCEPTION 'Onaylı kayıt değişmez; yeni revizyon oluşturun' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER construction_workflow_seal BEFORE UPDATE ON construction_workflows FOR EACH ROW EXECUTE FUNCTION construction_workflow_seal();
