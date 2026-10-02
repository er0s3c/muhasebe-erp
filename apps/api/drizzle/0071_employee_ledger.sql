CREATE TABLE "employee_advance_deductions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"advance_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_advance_deductions_uq" UNIQUE("run_id","advance_id"),
	CONSTRAINT "employee_advance_deductions_amount_ck" CHECK ("employee_advance_deductions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "employee_advance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"advance_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"settled_amount" numeric(19, 2) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_advance_settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"advance_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"settled_date" date NOT NULL,
	"payroll_run_id" uuid,
	"treasury_txn_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reverse_reason" text,
	CONSTRAINT "employee_advance_settlements_kind_ck" CHECK ("employee_advance_settlements"."kind" in ('payroll','repayment')),
	CONSTRAINT "employee_advance_settlements_amount_ck" CHECK ("employee_advance_settlements"."amount" > 0),
	CONSTRAINT "employee_advance_settlements_source_ck" CHECK (("employee_advance_settlements"."kind" = 'payroll' and "employee_advance_settlements"."payroll_run_id" is not null and "employee_advance_settlements"."treasury_txn_id" is null) or ("employee_advance_settlements"."kind" = 'repayment' and "employee_advance_settlements"."treasury_txn_id" is not null and "employee_advance_settlements"."payroll_run_id" is null)),
	CONSTRAINT "employee_advance_settlements_reverse_ck" CHECK (("employee_advance_settlements"."reversed_at" is null) = ("employee_advance_settlements"."reverse_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "employee_advances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"advance_date" date NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"purpose" text NOT NULL,
	"project_id" uuid,
	"treasury_account_id" uuid NOT NULL,
	"treasury_txn_id" uuid NOT NULL,
	"settled_amount" numeric(19, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_advances_number_uq" UNIQUE("company_id","number"),
	CONSTRAINT "employee_advances_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "employee_advances_txn_uq" UNIQUE("treasury_txn_id"),
	CONSTRAINT "employee_advances_status_ck" CHECK ("employee_advances"."status" in ('open','partial','settled','cancelled')),
	CONSTRAINT "employee_advances_amount_ck" CHECK ("employee_advances"."amount" > 0),
	CONSTRAINT "employee_advances_settled_ck" CHECK ("employee_advances"."settled_amount" >= 0 and "employee_advances"."settled_amount" <= "employee_advances"."amount"),
	CONSTRAINT "employee_advances_cancel_ck" CHECK (("employee_advances"."status" = 'cancelled') = ("employee_advances"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "employee_ledger_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"deduction_cap_pct" numeric(7, 4),
	"source_note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_ledger_settings_company_uq" UNIQUE("company_id"),
	CONSTRAINT "employee_ledger_settings_cap_ck" CHECK ("employee_ledger_settings"."deduction_cap_pct" is null or ("employee_ledger_settings"."deduction_cap_pct" > 0 and "employee_ledger_settings"."deduction_cap_pct" <= 100))
);
--> statement-breakpoint
CREATE TABLE "employee_salary_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"payroll_run_id" uuid,
	"treasury_txn_id" uuid NOT NULL,
	"pay_date" date NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_salary_payments_txn_uq" UNIQUE("treasury_txn_id"),
	CONSTRAINT "employee_salary_payments_amount_ck" CHECK ("employee_salary_payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "parties" DROP CONSTRAINT "parties_kind_ck";--> statement-breakpoint
ALTER TABLE "personal_data_access_log" DROP CONSTRAINT "personal_data_access_log_field_ck";--> statement-breakpoint
ALTER TABLE "employee_advance_deductions" ADD CONSTRAINT "employee_advance_deductions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_deductions" ADD CONSTRAINT "employee_advance_deductions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_deductions" ADD CONSTRAINT "employee_advance_deductions_run_fk" FOREIGN KEY ("run_id","company_id") REFERENCES "public"."payroll_runs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_deductions" ADD CONSTRAINT "employee_advance_deductions_advance_fk" FOREIGN KEY ("advance_id","company_id") REFERENCES "public"."employee_advances"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_deductions" ADD CONSTRAINT "employee_advance_deductions_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_events" ADD CONSTRAINT "employee_advance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_events" ADD CONSTRAINT "employee_advance_events_advance_fk" FOREIGN KEY ("advance_id","company_id") REFERENCES "public"."employee_advances"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_advance_fk" FOREIGN KEY ("advance_id","company_id") REFERENCES "public"."employee_advances"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_run_fk" FOREIGN KEY ("payroll_run_id","company_id") REFERENCES "public"."payroll_runs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advance_settlements" ADD CONSTRAINT "employee_advance_settlements_txn_fk" FOREIGN KEY ("treasury_txn_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_treasury_account_fk" FOREIGN KEY ("treasury_account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_txn_fk" FOREIGN KEY ("treasury_txn_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_ledger_settings" ADD CONSTRAINT "employee_ledger_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_ledger_settings" ADD CONSTRAINT "employee_ledger_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_payments" ADD CONSTRAINT "employee_salary_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_payments" ADD CONSTRAINT "employee_salary_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_payments" ADD CONSTRAINT "employee_salary_payments_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_payments" ADD CONSTRAINT "employee_salary_payments_run_fk" FOREIGN KEY ("payroll_run_id","company_id") REFERENCES "public"."payroll_runs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_payments" ADD CONSTRAINT "employee_salary_payments_txn_fk" FOREIGN KEY ("treasury_txn_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_advance_events_advance_idx" ON "employee_advance_events" USING btree ("advance_id","created_at");--> statement-breakpoint
CREATE INDEX "employee_advance_settlements_advance_idx" ON "employee_advance_settlements" USING btree ("advance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_advance_settlements_run_uq" ON "employee_advance_settlements" USING btree ("advance_id","payroll_run_id") WHERE "employee_advance_settlements"."payroll_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_advance_settlements_txn_uq" ON "employee_advance_settlements" USING btree ("treasury_txn_id") WHERE "employee_advance_settlements"."treasury_txn_id" is not null;--> statement-breakpoint
CREATE INDEX "employee_advances_employee_idx" ON "employee_advances" USING btree ("company_id","employee_id","advance_date");--> statement-breakpoint
CREATE INDEX "employee_salary_payments_employee_idx" ON "employee_salary_payments" USING btree ("company_id","employee_id","pay_date");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_party_uq" ON "employees" USING btree ("company_id","party_id") WHERE "employees"."party_id" is not null;--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable','payroll_labor_cost','payroll_employer_cost','payroll_payable','payroll_social_payable','payroll_tax_payable','payroll_other_payable','cheque_portfolio','note_portfolio','docs_in_collection','cheque_issued','note_payable','import_cost_clearing','employee_advance'));--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_kind_ck" CHECK ("parties"."kind" in ('customer','supplier','both','employee'));--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_field_ck" CHECK ("personal_data_access_log"."field" in ('id_number','birth_date','iban','export','payroll','social_security_no','social_security','foreign_doc_no','foreign_docs','employee_ledger'));