CREATE TABLE "bank_guarantees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"letter_no" text NOT NULL,
	"bank_name" text NOT NULL,
	"branch" text,
	"party_id" uuid,
	"counterparty_name" text NOT NULL,
	"project_id" uuid,
	"subcontract_id" uuid,
	"purpose" text,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"issue_date" date NOT NULL,
	"expiry_date" date,
	"commission_rate" numeric(7, 4),
	"commission_amount" numeric(19, 4),
	"commission_note" text,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"resolved_date" date,
	"resolution_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_guarantees_no_uq" UNIQUE("company_id","direction","bank_name","letter_no"),
	CONSTRAINT "bank_guarantees_direction_ck" CHECK ("bank_guarantees"."direction" in ('given','received')),
	CONSTRAINT "bank_guarantees_status_ck" CHECK ("bank_guarantees"."status" in ('active','returned','liquidated','expired')),
	CONSTRAINT "bank_guarantees_amount_ck" CHECK ("bank_guarantees"."amount" > 0 and "bank_guarantees"."currency_code" ~ '^[A-Z]{3}$' and ("bank_guarantees"."expiry_date" is null or "bank_guarantees"."expiry_date" >= "bank_guarantees"."issue_date")),
	CONSTRAINT "bank_guarantees_commission_ck" CHECK (("bank_guarantees"."commission_rate" is null or "bank_guarantees"."commission_rate" between 0 and 100) and ("bank_guarantees"."commission_amount" is null or "bank_guarantees"."commission_amount" >= 0)),
	CONSTRAINT "bank_guarantees_resolved_ck" CHECK (("bank_guarantees"."status" = 'active') = ("bank_guarantees"."resolved_date" is null) and ("bank_guarantees"."resolved_date" is null or "bank_guarantees"."resolved_date" >= "bank_guarantees"."issue_date") and ("bank_guarantees"."status" <> 'expired' or "bank_guarantees"."expiry_date" is not null))
);
--> statement-breakpoint
CREATE TABLE "cheque_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"cheque_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"control" text NOT NULL,
	"charge_line_id" uuid NOT NULL,
	"settle_line_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_base" numeric(19, 4) NOT NULL,
	"settle_amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cheque_allocations_settle_uq" UNIQUE("settle_line_id"),
	CONSTRAINT "cheque_allocations_control_ck" CHECK ("cheque_allocations"."control" in ('receivable','payable')),
	CONSTRAINT "cheque_allocations_amount_ck" CHECK ("cheque_allocations"."amount" > 0 and "cheque_allocations"."amount_base" > 0 and "cheque_allocations"."settle_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "cheque_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_no" text NOT NULL,
	"action" text NOT NULL,
	"event_date" date NOT NULL,
	"bank_account_id" uuid,
	"party_id" uuid,
	"total" numeric(19, 4) NOT NULL,
	"doc_count" integer NOT NULL,
	"entry_id" uuid NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cheque_batches_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "cheque_batches_no_uq" UNIQUE("company_id","batch_no"),
	CONSTRAINT "cheque_batches_action_ck" CHECK ("cheque_batches"."action" in ('deposit','collect','bounce','return','endorse','unendorse','pay','cancel')),
	CONSTRAINT "cheque_batches_amount_ck" CHECK ("cheque_batches"."total" > 0 and "cheque_batches"."doc_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "cheque_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"cheque_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"event_date" date NOT NULL,
	"batch_id" uuid,
	"entry_id" uuid NOT NULL,
	"party_id" uuid,
	"bank_account_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cheque_events_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "cheques" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"doc_type" text NOT NULL,
	"doc_no" text NOT NULL,
	"bank_name" text DEFAULT '' NOT NULL,
	"branch" text,
	"party_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"status" text NOT NULL,
	"holder_party_id" uuid,
	"bank_account_id" uuid,
	"entry_id" uuid NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cheques_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "cheques_number_uq" UNIQUE("company_id","direction","doc_type","bank_name","doc_no"),
	CONSTRAINT "cheques_direction_ck" CHECK ("cheques"."direction" in ('received','issued')),
	CONSTRAINT "cheques_doc_type_ck" CHECK ("cheques"."doc_type" in ('cheque','note')),
	CONSTRAINT "cheques_status_ck" CHECK (("cheques"."direction" = 'received' and "cheques"."status" in ('portfolio','in_collection','collected','bounced','endorsed','returned')) or ("cheques"."direction" = 'issued' and "cheques"."status" in ('issued','paid','bounced','cancelled'))),
	CONSTRAINT "cheques_amount_ck" CHECK ("cheques"."amount" > 0 and "cheques"."currency_code" ~ '^[A-Z]{3}$' and "cheques"."due_date" >= "cheques"."issue_date"),
	CONSTRAINT "cheques_holder_ck" CHECK (("cheques"."status" = 'endorsed') = ("cheques"."holder_party_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "portfolio_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"guarantee_warning_days" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_settings_ck" CHECK ("portfolio_settings"."guarantee_warning_days" is null or "portfolio_settings"."guarantee_warning_days" between 0 and 3650)
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "bank_guarantees" ADD CONSTRAINT "bank_guarantees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_guarantees" ADD CONSTRAINT "bank_guarantees_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_guarantees" ADD CONSTRAINT "bank_guarantees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_guarantees" ADD CONSTRAINT "bank_guarantees_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_guarantees" ADD CONSTRAINT "bank_guarantees_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_guarantees" ADD CONSTRAINT "bank_guarantees_subcontract_fk" FOREIGN KEY ("subcontract_id","company_id") REFERENCES "public"."subcontracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_allocations" ADD CONSTRAINT "cheque_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_allocations" ADD CONSTRAINT "cheque_allocations_cheque_fk" FOREIGN KEY ("cheque_id","company_id") REFERENCES "public"."cheques"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_allocations" ADD CONSTRAINT "cheque_allocations_event_fk" FOREIGN KEY ("event_id","company_id") REFERENCES "public"."cheque_events"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_allocations" ADD CONSTRAINT "cheque_allocations_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_allocations" ADD CONSTRAINT "cheque_allocations_charge_fk" FOREIGN KEY ("charge_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_allocations" ADD CONSTRAINT "cheque_allocations_settle_fk" FOREIGN KEY ("settle_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_batches" ADD CONSTRAINT "cheque_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_batches" ADD CONSTRAINT "cheque_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_batches" ADD CONSTRAINT "cheque_batches_bank_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_batches" ADD CONSTRAINT "cheque_batches_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_batches" ADD CONSTRAINT "cheque_batches_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_events" ADD CONSTRAINT "cheque_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_events" ADD CONSTRAINT "cheque_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_events" ADD CONSTRAINT "cheque_events_cheque_fk" FOREIGN KEY ("cheque_id","company_id") REFERENCES "public"."cheques"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_events" ADD CONSTRAINT "cheque_events_batch_fk" FOREIGN KEY ("batch_id","company_id") REFERENCES "public"."cheque_batches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_events" ADD CONSTRAINT "cheque_events_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_events" ADD CONSTRAINT "cheque_events_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheque_events" ADD CONSTRAINT "cheque_events_bank_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_holder_fk" FOREIGN KEY ("holder_party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_bank_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheques" ADD CONSTRAINT "cheques_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_settings" ADD CONSTRAINT "portfolio_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_settings" ADD CONSTRAINT "portfolio_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_guarantees_expiry_idx" ON "bank_guarantees" USING btree ("company_id","expiry_date");--> statement-breakpoint
CREATE INDEX "cheque_allocations_charge_idx" ON "cheque_allocations" USING btree ("charge_line_id");--> statement-breakpoint
CREATE INDEX "cheque_allocations_party_idx" ON "cheque_allocations" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE INDEX "cheque_events_cheque_idx" ON "cheque_events" USING btree ("cheque_id");--> statement-breakpoint
CREATE INDEX "cheques_party_idx" ON "cheques" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE INDEX "cheques_due_idx" ON "cheques" USING btree ("company_id","due_date");--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable','payroll_labor_cost','payroll_employer_cost','payroll_payable','payroll_social_payable','payroll_tax_payable','payroll_other_payable','cheque_portfolio','note_portfolio','docs_in_collection','cheque_issued','note_payable'));