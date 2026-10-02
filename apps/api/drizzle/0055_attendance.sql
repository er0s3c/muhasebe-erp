CREATE TABLE "attendance_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"day_type" text NOT NULL,
	"normal_hours" numeric(5, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(5, 2) DEFAULT '0' NOT NULL,
	"project_id" uuid,
	"wbs_id" uuid,
	"cost_code_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_entries_emp_date_uq" UNIQUE("employee_id","work_date"),
	CONSTRAINT "attendance_entries_type_ck" CHECK ("attendance_entries"."day_type" in ('worked','absent','annual_leave','sick_leave','unpaid_leave','public_holiday','weekly_rest')),
	CONSTRAINT "attendance_entries_hours_ck" CHECK ("attendance_entries"."normal_hours" >= 0 and "attendance_entries"."overtime_hours" >= 0 and "attendance_entries"."normal_hours" + "attendance_entries"."overtime_hours" <= 24),
	CONSTRAINT "attendance_entries_hours_type_ck" CHECK (("attendance_entries"."day_type" in ('worked','public_holiday','weekly_rest') or ("attendance_entries"."normal_hours" = 0 and "attendance_entries"."overtime_hours" = 0)) and ("attendance_entries"."day_type" <> 'worked' or "attendance_entries"."normal_hours" + "attendance_entries"."overtime_hours" > 0)),
	CONSTRAINT "attendance_entries_tag_ck" CHECK ("attendance_entries"."project_id" is null or "attendance_entries"."normal_hours" + "attendance_entries"."overtime_hours" > 0),
	CONSTRAINT "attendance_entries_wbs_ck" CHECK ("attendance_entries"."wbs_id" is null or "attendance_entries"."project_id" is not null),
	CONSTRAINT "attendance_entries_cost_code_ck" CHECK ("attendance_entries"."cost_code_id" is null or "attendance_entries"."project_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "attendance_months" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"month" text NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"close_note" text,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopen_reason" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "attendance_months_company_month_uq" UNIQUE("company_id","month"),
	CONSTRAINT "attendance_months_status_ck" CHECK ("attendance_months"."status" in ('closed','open')),
	CONSTRAINT "attendance_months_month_ck" CHECK ("attendance_months"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_cost_code_fk" FOREIGN KEY ("cost_code_id","company_id") REFERENCES "public"."cost_codes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_months" ADD CONSTRAINT "attendance_months_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_months" ADD CONSTRAINT "attendance_months_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_months" ADD CONSTRAINT "attendance_months_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_entries_date_idx" ON "attendance_entries" USING btree ("company_id","work_date");--> statement-breakpoint
CREATE INDEX "attendance_entries_project_idx" ON "attendance_entries" USING btree ("company_id","project_id","work_date") WHERE "attendance_entries"."project_id" is not null;