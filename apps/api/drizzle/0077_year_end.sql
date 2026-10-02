CREATE TABLE "fiscal_year_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"result_base" numeric(19, 4),
	"close_entry_id" uuid,
	"carry_entry_id" uuid,
	"snapshot" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by" uuid NOT NULL,
	CONSTRAINT "fiscal_year_events_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "fiscal_year_events_action_ck" CHECK ("fiscal_year_events"."action" in ('close','reopen')),
	CONSTRAINT "fiscal_year_events_reason_ck" CHECK ("fiscal_year_events"."action" <> 'reopen' or length(btrim(coalesce("fiscal_year_events"."reason", ''))) >= 5)
);
--> statement-breakpoint
CREATE TABLE "fiscal_years" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"reopen_reason" text,
	"reopened_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_years_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "fiscal_years_start_uq" UNIQUE("company_id","start_date"),
	CONSTRAINT "fiscal_years_status_ck" CHECK ("fiscal_years"."status" in ('open','closed')),
	CONSTRAINT "fiscal_years_range_ck" CHECK ("fiscal_years"."end_date" > "fiscal_years"."start_date"),
	CONSTRAINT "fiscal_years_closed_ck" CHECK ("fiscal_years"."status" = 'open' or ("fiscal_years"."closed_at" is not null and "fiscal_years"."closed_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "fiscal_year_events" ADD CONSTRAINT "fiscal_year_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_events" ADD CONSTRAINT "fiscal_year_events_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_events" ADD CONSTRAINT "fiscal_year_events_year_fk" FOREIGN KEY ("fiscal_year_id","company_id") REFERENCES "public"."fiscal_years"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_events" ADD CONSTRAINT "fiscal_year_events_close_entry_fk" FOREIGN KEY ("close_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_events" ADD CONSTRAINT "fiscal_year_events_carry_entry_fk" FOREIGN KEY ("carry_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fiscal_year_events_year_idx" ON "fiscal_year_events" USING btree ("fiscal_year_id","at");--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable','payroll_labor_cost','payroll_employer_cost','payroll_payable','payroll_social_payable','payroll_tax_payable','payroll_other_payable','cheque_portfolio','note_portfolio','docs_in_collection','cheque_issued','note_payable','import_cost_clearing','employee_advance','year_end_profit','year_end_loss','year_end_retained_profit','year_end_retained_loss'));