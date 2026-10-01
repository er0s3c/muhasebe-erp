CREATE TABLE "data_subject_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid,
	"requester_name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"description" text,
	"resolution_note" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by" uuid,
	"resolved_by" uuid,
	CONSTRAINT "data_subject_requests_kind_ck" CHECK ("data_subject_requests"."kind" in ('access','export','correction','erasure')),
	CONSTRAINT "data_subject_requests_status_ck" CHECK ("data_subject_requests"."status" in ('open','completed','rejected')),
	CONSTRAINT "data_subject_requests_resolved_ck" CHECK (("data_subject_requests"."status" = 'open') = ("data_subject_requests"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"full_name" text NOT NULL,
	"nationality" text,
	"id_kind" text,
	"id_enc" text,
	"id_hash" text,
	"id_last4" text,
	"birth_date_enc" text,
	"iban_enc" text,
	"iban_last4" text,
	"phone" text,
	"email" text,
	"address" text,
	"hire_date" date,
	"leave_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"department" text,
	"job_title" text,
	"project_id" uuid,
	"party_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "employees_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "employees_id_hash_uq" UNIQUE("company_id","id_hash"),
	CONSTRAINT "employees_status_ck" CHECK ("employees"."status" in ('active','left')),
	CONSTRAINT "employees_id_kind_ck" CHECK ("employees"."id_kind" is null or "employees"."id_kind" in ('national_id','passport')),
	CONSTRAINT "employees_dates_ck" CHECK ("employees"."leave_date" is null or "employees"."hire_date" is null or "employees"."leave_date" >= "employees"."hire_date"),
	CONSTRAINT "employees_id_complete_ck" CHECK (("employees"."id_enc" is null) = ("employees"."id_kind" is null) and ("employees"."id_enc" is null) = ("employees"."id_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "personal_data_access_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"field" text NOT NULL,
	"reason" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_data_access_log_field_ck" CHECK ("personal_data_access_log"."field" in ('id_number','birth_date','iban','export')),
	CONSTRAINT "personal_data_access_log_reason_ck" CHECK (length(btrim("personal_data_access_log"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "personal_data_inventory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"table_name" text NOT NULL,
	"field_name" text NOT NULL,
	"category" text NOT NULL,
	"purpose" text NOT NULL,
	"legal_basis" text NOT NULL,
	"retention" text,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"transfer_abroad" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_data_inventory_key_uq" UNIQUE("company_id","key"),
	CONSTRAINT "personal_data_inventory_category_ck" CHECK ("personal_data_inventory"."category" in ('identity','contact','financial','employment','other'))
);
--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_data_inventory" ADD CONSTRAINT "personal_data_inventory_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_subject_requests_status_idx" ON "data_subject_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "personal_data_access_log_emp_idx" ON "personal_data_access_log" USING btree ("company_id","employee_id","created_at");