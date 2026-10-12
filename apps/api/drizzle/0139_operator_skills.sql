CREATE TABLE "manufacturing_policies" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"freeze_hours" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manufacturing_policies_freeze_ck" CHECK ("manufacturing_policies"."freeze_hours" between 0 and 720)
);
--> statement-breakpoint
CREATE TABLE "operator_skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"valid_until" date,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_skills_uq" UNIQUE("company_id","user_id","skill"),
	CONSTRAINT "operator_skills_level_ck" CHECK ("operator_skills"."level" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "manufacturing_policies" ADD CONSTRAINT "manufacturing_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manufacturing_policies" ADD CONSTRAINT "manufacturing_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_skills" ADD CONSTRAINT "operator_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_skills" ADD CONSTRAINT "operator_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_skills" ADD CONSTRAINT "operator_skills_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE operator_skills ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operator_skills USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE manufacturing_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON manufacturing_policies USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON operator_skills TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON manufacturing_policies TO erp_app;
  END IF;
END
$$;
