CREATE TABLE "progress_payment_deductions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "progress_payment_deductions_amount_ck" CHECK ("progress_payment_deductions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "progress_payment_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"line_key" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_no" text,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"prev_qty" numeric(19, 4) NOT NULL,
	"cum_qty" numeric(19, 4) NOT NULL,
	"this_qty" numeric(19, 4) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"wbs_id" uuid NOT NULL,
	"cost_code_id" uuid,
	CONSTRAINT "progress_payment_lines_key_uq" UNIQUE("payment_id","line_key"),
	CONSTRAINT "progress_payment_lines_qty_ck" CHECK ("progress_payment_lines"."prev_qty" >= 0 and "progress_payment_lines"."cum_qty" >= "progress_payment_lines"."prev_qty" and "progress_payment_lines"."this_qty" = "progress_payment_lines"."cum_qty" - "progress_payment_lines"."prev_qty")
);
--> statement-breakpoint
CREATE TABLE "progress_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"payment_no" integer NOT NULL,
	"number" text,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency_code" text NOT NULL,
	"fx_rate" numeric(19, 8),
	"vat_code" text,
	"vat_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"retention_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"advance_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"withholding_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"gross" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"retention" numeric(19, 4) DEFAULT '0' NOT NULL,
	"advance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"withholding" numeric(19, 4) DEFAULT '0' NOT NULL,
	"other_deductions" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"rejection_note" text,
	"entry_id" uuid,
	"submitted_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "progress_payments_no_uq" UNIQUE("subcontract_id","payment_no"),
	CONSTRAINT "progress_payments_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "progress_payments_status_ck" CHECK ("progress_payments"."status" in ('draft','submitted','posted','cancelled')),
	CONSTRAINT "progress_payments_amounts_ck" CHECK ("progress_payments"."gross" >= 0 and "progress_payments"."vat" >= 0 and "progress_payments"."retention" >= 0 and "progress_payments"."advance" >= 0 and "progress_payments"."withholding" >= 0 and "progress_payments"."other_deductions" >= 0 and "progress_payments"."net" >= 0),
	CONSTRAINT "progress_payments_net_ck" CHECK ("progress_payments"."net" = "progress_payments"."gross" + "progress_payments"."vat" - "progress_payments"."retention" - "progress_payments"."advance" - "progress_payments"."withholding" - "progress_payments"."other_deductions"),
	CONSTRAINT "progress_payments_posted_ck" CHECK (("progress_payments"."status" in ('posted','cancelled')) = ("progress_payments"."number" is not null and "progress_payments"."entry_id" is not null and "progress_payments"."fx_rate" is not null and "progress_payments"."posted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "retention_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"release_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"entry_id" uuid NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_releases_entry_uq" UNIQUE("entry_id"),
	CONSTRAINT "retention_releases_amount_ck" CHECK ("retention_releases"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "subcontract_advances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"advance_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"transaction_id" uuid NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subcontract_advances_txn_uq" UNIQUE("transaction_id"),
	CONSTRAINT "subcontract_advances_amount_ck" CHECK ("subcontract_advances"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "progress_payment_deductions" ADD CONSTRAINT "progress_payment_deductions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payment_deductions" ADD CONSTRAINT "progress_payment_deductions_payment_fk" FOREIGN KEY ("payment_id","company_id") REFERENCES "public"."progress_payments"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payment_lines" ADD CONSTRAINT "progress_payment_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payment_lines" ADD CONSTRAINT "progress_payment_lines_payment_fk" FOREIGN KEY ("payment_id","company_id") REFERENCES "public"."progress_payments"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payment_lines" ADD CONSTRAINT "progress_payment_lines_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payment_lines" ADD CONSTRAINT "progress_payment_lines_cost_code_fk" FOREIGN KEY ("cost_code_id","company_id") REFERENCES "public"."cost_codes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_subcontract_fk" FOREIGN KEY ("subcontract_id","project_id") REFERENCES "public"."subcontracts"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_releases" ADD CONSTRAINT "retention_releases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_releases" ADD CONSTRAINT "retention_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_releases" ADD CONSTRAINT "retention_releases_subcontract_fk" FOREIGN KEY ("subcontract_id","company_id") REFERENCES "public"."subcontracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_releases" ADD CONSTRAINT "retention_releases_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_advances" ADD CONSTRAINT "subcontract_advances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_advances" ADD CONSTRAINT "subcontract_advances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_advances" ADD CONSTRAINT "subcontract_advances_subcontract_fk" FOREIGN KEY ("subcontract_id","company_id") REFERENCES "public"."subcontracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_advances" ADD CONSTRAINT "subcontract_advances_txn_fk" FOREIGN KEY ("transaction_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "progress_payment_lines_sub_idx" ON "progress_payment_lines" USING btree ("subcontract_id","line_key");--> statement-breakpoint
CREATE INDEX "progress_payment_lines_wbs_idx" ON "progress_payment_lines" USING btree ("wbs_id");--> statement-breakpoint
CREATE UNIQUE INDEX "progress_payments_number_uq" ON "progress_payments" USING btree ("company_id","number") WHERE "progress_payments"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "progress_payments_open_uq" ON "progress_payments" USING btree ("subcontract_id") WHERE "progress_payments"."status" in ('draft','submitted');--> statement-breakpoint
CREATE INDEX "progress_payments_project_idx" ON "progress_payments" USING btree ("company_id","project_id","status");--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance'));