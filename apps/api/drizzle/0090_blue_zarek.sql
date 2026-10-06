CREATE TABLE "construction_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "ca_id_company" UNIQUE("id","company_id"),
	CONSTRAINT "ca_size" CHECK ("construction_assets"."size" between 1 and 26214400)
);
--> statement-breakpoint
CREATE TABLE "construction_drawings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asset_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"discipline" text NOT NULL,
	"revision" text NOT NULL,
	"previous_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"decision_note" text,
	CONSTRAINT "cd_id_company" UNIQUE("id","company_id"),
	CONSTRAINT "cd_code_revision" UNIQUE("company_id","project_id","code","revision"),
	CONSTRAINT "cd_previous" UNIQUE("previous_id"),
	CONSTRAINT "cd_status" CHECK ("construction_drawings"."status" in ('draft','approved','obsolete'))
);
--> statement-breakpoint
CREATE TABLE "construction_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "cl_id_company" UNIQUE("id","company_id"),
	CONSTRAINT "cl_kind" CHECK ("construction_locations"."kind" in ('building','level','zone'))
);
--> statement-breakpoint
CREATE TABLE "construction_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"date" date NOT NULL,
	"caption" text NOT NULL,
	"panorama" boolean DEFAULT false NOT NULL,
	"operation_id" uuid
);
--> statement-breakpoint
CREATE TABLE "construction_pins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drawing_id" uuid NOT NULL,
	"location_id" uuid,
	"page" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"label" text NOT NULL,
	"record_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	CONSTRAINT "cp_client" UNIQUE("company_id","client_id"),
	CONSTRAINT "cp_xy" CHECK ("construction_pins"."x" between 0 and 1 and "construction_pins"."y" between 0 and 1 and "construction_pins"."page">0)
);
--> statement-breakpoint
CREATE TABLE "construction_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "cs_project_day" UNIQUE("company_id","project_id","date")
);
--> statement-breakpoint
ALTER TABLE "construction_assets" ADD CONSTRAINT "construction_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_assets" ADD CONSTRAINT "construction_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_assets" ADD CONSTRAINT "construction_assets_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_drawings" ADD CONSTRAINT "construction_drawings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_drawings" ADD CONSTRAINT "construction_drawings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_drawings" ADD CONSTRAINT "construction_drawings_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_drawings" ADD CONSTRAINT "construction_drawings_asset_id_company_id_construction_assets_id_company_id_fk" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."construction_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_locations" ADD CONSTRAINT "construction_locations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_locations" ADD CONSTRAINT "construction_locations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_locations" ADD CONSTRAINT "construction_locations_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_location_id_company_id_construction_locations_id_company_id_fk" FOREIGN KEY ("location_id","company_id") REFERENCES "public"."construction_locations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "construction_photos_asset_id_company_id_construction_assets_id_company_id_fk" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."construction_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_drawing_id_company_id_construction_drawings_id_company_id_fk" FOREIGN KEY ("drawing_id","company_id") REFERENCES "public"."construction_drawings"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_pins" ADD CONSTRAINT "construction_pins_location_id_company_id_construction_locations_id_company_id_fk" FOREIGN KEY ("location_id","company_id") REFERENCES "public"."construction_locations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_snapshots" ADD CONSTRAINT "construction_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_snapshots" ADD CONSTRAINT "construction_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_snapshots" ADD CONSTRAINT "construction_snapshots_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ca_project" ON "construction_assets" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "cd_project" ON "construction_drawings" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "cl_project" ON "construction_locations" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "cph_location" ON "construction_photos" USING btree ("company_id","location_id","date");--> statement-breakpoint
CREATE INDEX "cp_drawing" ON "construction_pins" USING btree ("company_id","drawing_id");
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['construction_locations','construction_assets','construction_drawings','construction_pins','construction_photos','construction_snapshots'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_app',t);
END LOOP; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX construction_drawing_current ON construction_drawings(company_id,project_id,code) WHERE status='approved';
