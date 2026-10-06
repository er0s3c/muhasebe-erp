CREATE TABLE "administration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "company_operations_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_time_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "work_time_bounds" CHECK ("work_time_sessions"."stopped_at" is null or ("work_time_sessions"."stopped_at" >= "work_time_sessions"."started_at" and "work_time_sessions"."stopped_at" <= "work_time_sessions"."started_at" + interval '24 hours'))
);
--> statement-breakpoint
ALTER TABLE "record_documents" DROP CONSTRAINT "record_documents_size_ck";--> statement-breakpoint
ALTER TABLE "administration_runs" ADD CONSTRAINT "administration_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administration_runs" ADD CONSTRAINT "administration_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_operations_settings" ADD CONSTRAINT "company_operations_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_operations_settings" ADD CONSTRAINT "company_operations_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_time_sessions" ADD CONSTRAINT "work_time_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_time_sessions" ADD CONSTRAINT "work_time_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_id_company" UNIQUE("id","company_id");--> statement-breakpoint
ALTER TABLE "work_time_sessions" ADD CONSTRAINT "work_time_task_fk" FOREIGN KEY ("task_id","company_id") REFERENCES "public"."work_items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "administration_runs_company" ON "administration_runs" USING btree ("company_id","kind","started_at");--> statement-breakpoint
CREATE INDEX "work_time_company_user" ON "work_time_sessions" USING btree ("company_id","user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_time_one_active" ON "work_time_sessions" USING btree ("company_id","user_id") WHERE "work_time_sessions"."stopped_at" is null;--> statement-breakpoint

ALTER TABLE "record_documents" ADD CONSTRAINT "record_documents_size_ck" CHECK ("record_documents"."size" between 1 and 104857600);--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['company_operations_settings','work_time_sessions','administration_runs'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON company_operations_settings,work_time_sessions,administration_runs TO erp_app;
CREATE OR REPLACE FUNCTION user_company_mfa_required() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT exists(select 1 from memberships m join company_operations_settings s on s.company_id=m.company_id where m.user_id=app_user_id() and (s.settings->>'requireMfa')::boolean);
$$;
REVOKE ALL ON FUNCTION user_company_mfa_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_company_mfa_required() TO erp_app;
CREATE FUNCTION work_time_session_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF OLD.stopped_at IS NOT NULL OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.task_id IS DISTINCT FROM OLD.task_id THEN
RAISE EXCEPTION 'Kapanan süre kaydı ve sayaç kimliği değiştirilemez' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER work_time_session_seal BEFORE UPDATE ON work_time_sessions FOR EACH ROW EXECUTE FUNCTION work_time_session_seal();
