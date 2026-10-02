CREATE TABLE "employee_pay_terms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"pay_basis" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_pay_terms_uq" UNIQUE("employee_id","effective_from"),
	CONSTRAINT "employee_pay_terms_basis_ck" CHECK ("employee_pay_terms"."pay_basis" in ('monthly','daily','hourly')),
	CONSTRAINT "employee_pay_terms_amount_ck" CHECK ("employee_pay_terms"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payroll_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_adjustments_uq" UNIQUE("run_id","employee_id","item_id"),
	CONSTRAINT "payroll_adjustments_amount_ck" CHECK ("payroll_adjustments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payroll_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"affects_social_base" boolean DEFAULT false NOT NULL,
	"affects_tax_base" boolean DEFAULT false NOT NULL,
	"liability" text DEFAULT 'other' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_items_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "payroll_items_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "payroll_items_kind_ck" CHECK ("payroll_items"."kind" in ('earning','deduction')),
	CONSTRAINT "payroll_items_liability_ck" CHECK ("payroll_items"."liability" in ('tax','social','other'))
);
--> statement-breakpoint
CREATE TABLE "payroll_line_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"project_id" uuid,
	"wbs_id" uuid,
	"cost_code_id" uuid,
	"hours" numeric(9, 2) DEFAULT '0' NOT NULL,
	"gross_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "payroll_allocations_tag_ck" CHECK (("payroll_line_allocations"."wbs_id" is null or "payroll_line_allocations"."project_id" is not null) and ("payroll_line_allocations"."cost_code_id" is null or "payroll_line_allocations"."project_id" is not null)),
	CONSTRAINT "payroll_allocations_amount_ck" CHECK ("payroll_line_allocations"."hours" >= 0 and "payroll_line_allocations"."gross_amount" >= 0 and "payroll_line_allocations"."employer_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payroll_line_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"liability" text,
	"item_id" uuid,
	"param_key" text,
	"rate" numeric(19, 6),
	CONSTRAINT "payroll_line_items_kind_ck" CHECK ("payroll_line_items"."kind" in ('earning','deduction','employer')),
	CONSTRAINT "payroll_line_items_source_ck" CHECK ("payroll_line_items"."source" in ('manual','param')),
	CONSTRAINT "payroll_line_items_liability_ck" CHECK ("payroll_line_items"."liability" is null or "payroll_line_items"."liability" in ('tax','social','other')),
	CONSTRAINT "payroll_line_items_amount_ck" CHECK ("payroll_line_items"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"pay_basis" text NOT NULL,
	"rate" numeric(19, 4) NOT NULL,
	"normal_hours" numeric(9, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(9, 2) DEFAULT '0' NOT NULL,
	"hour_days" integer DEFAULT 0 NOT NULL,
	"annual_leave_days" integer DEFAULT 0 NOT NULL,
	"sick_leave_days" integer DEFAULT 0 NOT NULL,
	"unpaid_leave_days" integer DEFAULT 0 NOT NULL,
	"absent_days" integer DEFAULT 0 NOT NULL,
	"scheduled_pay" numeric(19, 4) DEFAULT '0' NOT NULL,
	"absence_deduction" numeric(19, 4) DEFAULT '0' NOT NULL,
	"base_pay" numeric(19, 4) DEFAULT '0' NOT NULL,
	"overtime_pay" numeric(19, 4) DEFAULT '0' NOT NULL,
	"earnings_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"gross" numeric(19, 4) DEFAULT '0' NOT NULL,
	"social_base" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_base" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employee_social" numeric(19, 4) DEFAULT '0' NOT NULL,
	"income_tax" numeric(19, 4) DEFAULT '0' NOT NULL,
	"other_deductions" numeric(19, 4) DEFAULT '0' NOT NULL,
	"deductions_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_social" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_other" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_lines_run_emp_uq" UNIQUE("run_id","employee_id"),
	CONSTRAINT "payroll_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "payroll_lines_basis_ck" CHECK ("payroll_lines"."pay_basis" in ('monthly','daily','hourly')),
	CONSTRAINT "payroll_lines_amounts_ck" CHECK ("payroll_lines"."scheduled_pay" >= 0 and "payroll_lines"."absence_deduction" >= 0 and "payroll_lines"."base_pay" >= 0 and "payroll_lines"."overtime_pay" >= 0 and "payroll_lines"."earnings_total" >= 0 and "payroll_lines"."employee_social" >= 0 and "payroll_lines"."income_tax" >= 0 and "payroll_lines"."other_deductions" >= 0 and "payroll_lines"."employer_social" >= 0 and "payroll_lines"."employer_other" >= 0),
	CONSTRAINT "payroll_lines_math_ck" CHECK ("payroll_lines"."base_pay" = "payroll_lines"."scheduled_pay" - "payroll_lines"."absence_deduction" and "payroll_lines"."gross" = "payroll_lines"."base_pay" + "payroll_lines"."overtime_pay" + "payroll_lines"."earnings_total" and "payroll_lines"."deductions_total" = "payroll_lines"."employee_social" + "payroll_lines"."income_tax" + "payroll_lines"."other_deductions" and "payroll_lines"."net" = "payroll_lines"."gross" - "payroll_lines"."deductions_total" and "payroll_lines"."employer_total" = "payroll_lines"."employer_social" + "payroll_lines"."employer_other")
);
--> statement-breakpoint
CREATE TABLE "payroll_params" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" numeric(19, 6) NOT NULL,
	"effective_from" date NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"source_note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"supersedes_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_params_uq" UNIQUE("company_id","key","effective_from"),
	CONSTRAINT "payroll_params_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "payroll_params_key_ck" CHECK ("payroll_params"."key" in ('days_per_month','hours_per_day','overtime_multiplier','sick_leave_pay_pct','annual_leave_pay_pct','employee_social_pct','income_tax_pct','tax_base_deducts_social','social_base_cap','employer_social_pct','employer_other_pct','minimum_wage_monthly')),
	CONSTRAINT "payroll_params_value_ck" CHECK ("payroll_params"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"month" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"gross_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"deductions_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"params_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_unverified_params" boolean DEFAULT false NOT NULL,
	"calculated_at" timestamp with time zone,
	"entry_id" uuid,
	"reversal_entry_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"paid_at" date,
	"paid_note" text,
	"paid_marked_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_number_uq" UNIQUE("company_id","number"),
	CONSTRAINT "payroll_runs_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "payroll_runs_status_ck" CHECK ("payroll_runs"."status" in ('draft','approved','paid','cancelled')),
	CONSTRAINT "payroll_runs_month_ck" CHECK ("payroll_runs"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "payroll_runs_totals_ck" CHECK ("payroll_runs"."gross_total" >= 0 and "payroll_runs"."deductions_total" >= 0 and "payroll_runs"."employer_total" >= 0 and "payroll_runs"."net_total" = "payroll_runs"."gross_total" - "payroll_runs"."deductions_total"),
	CONSTRAINT "payroll_runs_posted_ck" CHECK (("payroll_runs"."status" = 'draft') = ("payroll_runs"."approved_at" is null) and ("payroll_runs"."status" <> 'draft') = ("payroll_runs"."entry_id" is not null) and ("payroll_runs"."status" = 'cancelled') = ("payroll_runs"."reversal_entry_id" is not null)),
	CONSTRAINT "payroll_runs_paid_ck" CHECK (("payroll_runs"."status" = 'paid') = ("payroll_runs"."paid_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "personal_data_access_log" DROP CONSTRAINT "personal_data_access_log_field_ck";--> statement-breakpoint
ALTER TABLE "employee_pay_terms" ADD CONSTRAINT "employee_pay_terms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_pay_terms" ADD CONSTRAINT "employee_pay_terms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_pay_terms" ADD CONSTRAINT "employee_pay_terms_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_run_fk" FOREIGN KEY ("run_id","company_id") REFERENCES "public"."payroll_runs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."payroll_items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_allocations" ADD CONSTRAINT "payroll_line_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_allocations" ADD CONSTRAINT "payroll_allocations_line_fk" FOREIGN KEY ("line_id","company_id") REFERENCES "public"."payroll_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_allocations" ADD CONSTRAINT "payroll_allocations_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_allocations" ADD CONSTRAINT "payroll_allocations_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_allocations" ADD CONSTRAINT "payroll_allocations_cost_code_fk" FOREIGN KEY ("cost_code_id","company_id") REFERENCES "public"."cost_codes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_line_fk" FOREIGN KEY ("line_id","company_id") REFERENCES "public"."payroll_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."payroll_items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_fk" FOREIGN KEY ("run_id","company_id") REFERENCES "public"."payroll_runs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_params" ADD CONSTRAINT "payroll_params_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_params" ADD CONSTRAINT "payroll_params_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_params" ADD CONSTRAINT "payroll_params_supersedes_fk" FOREIGN KEY ("supersedes_id","company_id") REFERENCES "public"."payroll_params"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_paid_marked_by_users_id_fk" FOREIGN KEY ("paid_marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_reversal_fk" FOREIGN KEY ("reversal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_allocations_line_idx" ON "payroll_line_allocations" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "payroll_allocations_project_idx" ON "payroll_line_allocations" USING btree ("company_id","project_id") WHERE "payroll_line_allocations"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "payroll_line_items_line_idx" ON "payroll_line_items" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_emp_idx" ON "payroll_lines" USING btree ("company_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_month_uq" ON "payroll_runs" USING btree ("company_id","month") WHERE "payroll_runs"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable','payroll_labor_cost','payroll_employer_cost','payroll_payable','payroll_social_payable','payroll_tax_payable','payroll_other_payable'));--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_field_ck" CHECK ("personal_data_access_log"."field" in ('id_number','birth_date','iban','export','payroll'));