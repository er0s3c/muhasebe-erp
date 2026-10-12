CREATE TABLE "attendance_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"day_type" text NOT NULL,
	"normal_hours" numeric(5, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(5, 2) DEFAULT '0' NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_corrections_status_ck" CHECK ("attendance_corrections"."status" in ('pending','approved','rejected')),
	CONSTRAINT "attendance_corrections_decided_ck" CHECK (("attendance_corrections"."status" = 'pending') = ("attendance_corrections"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "employee_checklist_templates" (
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_checklist_templates_company_id_kind_pk" PRIMARY KEY("company_id","kind"),
	CONSTRAINT "employee_checklist_templates_kind_ck" CHECK ("employee_checklist_templates"."kind" in ('onboarding','offboarding'))
);
--> statement-breakpoint
CREATE TABLE "employee_checklists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "employee_checklists_kind_ck" CHECK ("employee_checklists"."kind" in ('onboarding','offboarding')),
	CONSTRAINT "employee_checklists_status_ck" CHECK (("employee_checklists"."status" = 'completed') = ("employee_checklists"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_checklist_templates" ADD CONSTRAINT "employee_checklist_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_checklist_templates" ADD CONSTRAINT "employee_checklist_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_checklists" ADD CONSTRAINT "employee_checklists_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_checklists" ADD CONSTRAINT "employee_checklists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_checklists" ADD CONSTRAINT "employee_checklists_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_corrections_status_idx" ON "attendance_corrections" USING btree ("company_id","status","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_checklists_open_uq" ON "employee_checklists" USING btree ("company_id","employee_id","kind") WHERE "employee_checklists"."status" = 'open';--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_user_uq" ON "employees" USING btree ("company_id","user_id") WHERE "employees"."user_id" is not null;--> statement-breakpoint
ALTER TABLE attendance_corrections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON attendance_corrections USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE employee_checklist_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON employee_checklist_templates USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
ALTER TABLE employee_checklists ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON employee_checklists USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON attendance_corrections TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON employee_checklist_templates TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON employee_checklists TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Karar verilmiş düzeltme talebi değişmez; talep silinmez.
CREATE FUNCTION attendance_corrections_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Puantaj düzeltme talebi silinemez' USING ERRCODE = 'ERP25';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Karar verilmiş puantaj düzeltme talebi değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_note') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_note') THEN
    RAISE EXCEPTION 'Talebin içeriği değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER attendance_corrections_guard BEFORE UPDATE OR DELETE ON attendance_corrections FOR EACH ROW EXECUTE FUNCTION attendance_corrections_guard();
--> statement-breakpoint
-- Tamamlanmış kontrol listesi değişmez.
CREATE FUNCTION employee_checklists_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'completed' THEN
    RAISE EXCEPTION 'Tamamlanmış ya da başlatılmış kontrol listesi silinemez/değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  IF NEW.employee_id <> OLD.employee_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'Kontrol listesinin personeli ve türü değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER employee_checklists_guard BEFORE UPDATE OR DELETE ON employee_checklists FOR EACH ROW EXECUTE FUNCTION employee_checklists_guard();
