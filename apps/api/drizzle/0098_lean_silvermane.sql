CREATE TABLE "saved_insights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_insights" ADD CONSTRAINT "saved_insights_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_insights" ADD CONSTRAINT "saved_insights_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_insights_company_owner" ON "saved_insights" USING btree ("company_id","created_by");
--> statement-breakpoint
ALTER TABLE saved_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_insights USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id());
CREATE TRIGGER audit_saved_insights AFTER INSERT OR UPDATE OR DELETE ON saved_insights FOR EACH ROW EXECUTE FUNCTION audit_row_change();
GRANT SELECT,INSERT,UPDATE ON saved_insights TO erp_app;
