CREATE TABLE "period_close_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"done_by" uuid NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "period_close_tasks_uq" UNIQUE("company_id","period_id","task_key"),
	CONSTRAINT "period_close_tasks_key_ck" CHECK ("period_close_tasks"."task_key" ~ '^[a-z][a-z0-9_]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "period_close_tasks" ADD CONSTRAINT "period_close_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_close_tasks" ADD CONSTRAINT "period_close_tasks_done_by_users_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_close_tasks" ADD CONSTRAINT "period_close_tasks_period_fk" FOREIGN KEY ("period_id","company_id") REFERENCES "public"."fiscal_periods"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE period_close_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON period_close_tasks USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, DELETE ON period_close_tasks TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Kapalı dönemin kapanış görevleri eklenemez ve geri alınamaz (dönem yeniden açılırsa değişebilir).
CREATE FUNCTION period_close_tasks_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM fiscal_periods WHERE id = COALESCE(NEW.period_id, OLD.period_id) AND company_id = COALESCE(NEW.company_id, OLD.company_id);
  IF st IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Kapalı dönemin kapanış görevleri değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Kapanış görevi değiştirilemez; geri alıp yeniden işaretleyin' USING ERRCODE = 'ERP25';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
CREATE TRIGGER period_close_tasks_guard BEFORE INSERT OR UPDATE OR DELETE ON period_close_tasks FOR EACH ROW EXECUTE FUNCTION period_close_tasks_guard();
