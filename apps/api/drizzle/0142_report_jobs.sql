CREATE TABLE "db_stat_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by" uuid,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"report_key" text NOT NULL,
	"format" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"row_count" integer,
	"file_name" text,
	"content" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "report_jobs_status_ck" CHECK ("report_jobs"."status" in ('queued','running','completed','failed','cancelled')),
	CONSTRAINT "report_jobs_format_ck" CHECK ("report_jobs"."format" in ('xlsx','csv')),
	CONSTRAINT "report_jobs_progress_ck" CHECK ("report_jobs"."progress" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "db_stat_snapshots" ADD CONSTRAINT "db_stat_snapshots_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_jobs_user_idx" ON "report_jobs" USING btree ("company_id","user_id","created_at");--> statement-breakpoint
ALTER TABLE report_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON report_jobs USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON report_jobs TO erp_app;
    GRANT SELECT, INSERT ON db_stat_snapshots TO erp_app;
  END IF;
END
$$;
