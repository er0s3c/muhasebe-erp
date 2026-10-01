CREATE TABLE "employee_social_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"payroll_type_code" text,
	"insurance_start" date,
	"insurance_end" date,
	"ssn_enc" text,
	"ssn_last4" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_social_profiles_uq" UNIQUE("employee_id","effective_from"),
	CONSTRAINT "employee_social_profiles_dates_ck" CHECK ("employee_social_profiles"."insurance_end" is null or "employee_social_profiles"."insurance_start" is null or "employee_social_profiles"."insurance_end" >= "employee_social_profiles"."insurance_start")
);
--> statement-breakpoint
CREATE TABLE "employee_support_eligibility" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"rule_code" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_support_eligibility_uq" UNIQUE("employee_id","rule_code","valid_from"),
	CONSTRAINT "employee_support_eligibility_dates_ck" CHECK ("employee_support_eligibility"."valid_to" is null or "employee_support_eligibility"."valid_to" >= "employee_support_eligibility"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "social_declaration_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"declaration_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"payroll_line_id" uuid NOT NULL,
	"payroll_type_code" text,
	"insurance_start" date,
	"insurance_end" date,
	"ssn_last4" text,
	"days_worked" integer DEFAULT 0 NOT NULL,
	"annual_leave_days" integer DEFAULT 0 NOT NULL,
	"sick_leave_days" integer DEFAULT 0 NOT NULL,
	"unpaid_leave_days" integer DEFAULT 0 NOT NULL,
	"absent_days" integer DEFAULT 0 NOT NULL,
	"premium_base" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employee_premium" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_premium" numeric(19, 4) DEFAULT '0' NOT NULL,
	"support_employee" numeric(19, 4) DEFAULT '0' NOT NULL,
	"support_employer" numeric(19, 4) DEFAULT '0' NOT NULL,
	"support_codes" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_declaration_lines_uq" UNIQUE("declaration_id","employee_id"),
	CONSTRAINT "social_declaration_lines_amounts_ck" CHECK ("social_declaration_lines"."premium_base" >= 0 and "social_declaration_lines"."employee_premium" >= 0 and "social_declaration_lines"."employer_premium" >= 0 and "social_declaration_lines"."support_employee" >= 0 and "social_declaration_lines"."support_employer" >= 0 and "social_declaration_lines"."support_employee" <= "social_declaration_lines"."employee_premium" and "social_declaration_lines"."support_employer" <= "social_declaration_lines"."employer_premium")
);
--> statement-breakpoint
CREATE TABLE "social_declarations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"month" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"payroll_run_number" text NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"premium_base_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employee_premium_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_premium_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"support_employee_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"support_employer_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"support_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_unverified_params" boolean DEFAULT false NOT NULL,
	"built_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"finalized_by" uuid,
	"finalize_note" text,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopen_reason" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_declarations_number_uq" UNIQUE("company_id","number"),
	CONSTRAINT "social_declarations_month_uq" UNIQUE("company_id","month"),
	CONSTRAINT "social_declarations_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "social_declarations_status_ck" CHECK ("social_declarations"."status" in ('draft','finalized')),
	CONSTRAINT "social_declarations_month_ck" CHECK ("social_declarations"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "social_declarations_totals_ck" CHECK ("social_declarations"."premium_base_total" >= 0 and "social_declarations"."employee_premium_total" >= 0 and "social_declarations"."employer_premium_total" >= 0 and "social_declarations"."support_employee_total" >= 0 and "social_declarations"."support_employer_total" >= 0 and "social_declarations"."support_employee_total" <= "social_declarations"."employee_premium_total" and "social_declarations"."support_employer_total" <= "social_declarations"."employer_premium_total"),
	CONSTRAINT "social_declarations_final_ck" CHECK (("social_declarations"."status" = 'finalized') = ("social_declarations"."finalized_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "social_support_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"target" text NOT NULL,
	"mode" text NOT NULL,
	"value" numeric(19, 6) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"source_note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_support_rules_uq" UNIQUE("company_id","code","effective_from"),
	CONSTRAINT "social_support_rules_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "social_support_rules_target_ck" CHECK ("social_support_rules"."target" in ('employer','employee')),
	CONSTRAINT "social_support_rules_mode_ck" CHECK ("social_support_rules"."mode" in ('percent_of_premium','fixed_amount')),
	CONSTRAINT "social_support_rules_value_ck" CHECK ("social_support_rules"."value" >= 0 and ("social_support_rules"."mode" <> 'percent_of_premium' or "social_support_rules"."value" <= 100)),
	CONSTRAINT "social_support_rules_dates_ck" CHECK ("social_support_rules"."effective_to" is null or "social_support_rules"."effective_to" >= "social_support_rules"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "personal_data_access_log" DROP CONSTRAINT "personal_data_access_log_field_ck";--> statement-breakpoint
ALTER TABLE "employee_social_profiles" ADD CONSTRAINT "employee_social_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_social_profiles" ADD CONSTRAINT "employee_social_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_social_profiles" ADD CONSTRAINT "employee_social_profiles_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_support_eligibility" ADD CONSTRAINT "employee_support_eligibility_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_support_eligibility" ADD CONSTRAINT "employee_support_eligibility_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_support_eligibility" ADD CONSTRAINT "employee_support_eligibility_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declaration_lines" ADD CONSTRAINT "social_declaration_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declaration_lines" ADD CONSTRAINT "social_declaration_lines_declaration_fk" FOREIGN KEY ("declaration_id","company_id") REFERENCES "public"."social_declarations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declaration_lines" ADD CONSTRAINT "social_declaration_lines_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declaration_lines" ADD CONSTRAINT "social_declaration_lines_payroll_line_fk" FOREIGN KEY ("payroll_line_id","company_id") REFERENCES "public"."payroll_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD CONSTRAINT "social_declarations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD CONSTRAINT "social_declarations_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD CONSTRAINT "social_declarations_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD CONSTRAINT "social_declarations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_declarations" ADD CONSTRAINT "social_declarations_run_fk" FOREIGN KEY ("payroll_run_id","company_id") REFERENCES "public"."payroll_runs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_support_rules" ADD CONSTRAINT "social_support_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_support_rules" ADD CONSTRAINT "social_support_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_declaration_lines_decl_idx" ON "social_declaration_lines" USING btree ("declaration_id");--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_field_ck" CHECK ("personal_data_access_log"."field" in ('id_number','birth_date','iban','export','payroll','social_security_no','social_security'));