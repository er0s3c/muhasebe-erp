CREATE TABLE "party_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"control" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"charge_line_id" uuid NOT NULL,
	"settle_line_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_base" numeric(19, 4) NOT NULL,
	"settle_amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_allocations_settle_uq" UNIQUE("settle_line_id"),
	CONSTRAINT "party_allocations_control_ck" CHECK ("party_allocations"."control" in ('receivable','payable')),
	CONSTRAINT "party_allocations_amount_ck" CHECK ("party_allocations"."amount" > 0 and "party_allocations"."amount_base" > 0 and "party_allocations"."settle_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "treasury_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"currency_code" text NOT NULL,
	"account_id" uuid NOT NULL,
	"bank_name" text,
	"branch" text,
	"iban" text,
	"account_no" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_accounts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "treasury_accounts_gl_uq" UNIQUE("company_id","account_id"),
	CONSTRAINT "treasury_accounts_name_uq" UNIQUE("company_id","name"),
	CONSTRAINT "treasury_accounts_kind_ck" CHECK ("treasury_accounts"."kind" in ('cash','bank'))
);
--> statement-breakpoint
CREATE TABLE "treasury_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"txn_no" text NOT NULL,
	"txn_date" date NOT NULL,
	"account_id" uuid NOT NULL,
	"to_account_id" uuid,
	"party_id" uuid,
	"gl_account_id" uuid,
	"currency_code" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"counter_amount" numeric(19, 4),
	"fx_rate" numeric(19, 8),
	"description" text,
	"journal_entry_id" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"cancel_journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_transactions_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "treasury_transactions_no_uq" UNIQUE("company_id","txn_no"),
	CONSTRAINT "treasury_transactions_type_ck" CHECK ("treasury_transactions"."type" in ('receipt','payment','transfer','exchange','other_receipt','other_payment')),
	CONSTRAINT "treasury_transactions_status_ck" CHECK ("treasury_transactions"."status" in ('posted','cancelled')),
	CONSTRAINT "treasury_transactions_amount_ck" CHECK ("treasury_transactions"."amount" > 0 and ("treasury_transactions"."counter_amount" is null or "treasury_transactions"."counter_amount" > 0)),
	CONSTRAINT "treasury_transactions_cancelled_ck" CHECK ("treasury_transactions"."status" <> 'cancelled' or ("treasury_transactions"."cancelled_at" is not null and "treasury_transactions"."cancel_reason" is not null and "treasury_transactions"."cancel_journal_entry_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_id_company_uq" UNIQUE("id","company_id");--> statement-breakpoint
ALTER TABLE "party_allocations" ADD CONSTRAINT "party_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_allocations" ADD CONSTRAINT "party_allocations_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_allocations" ADD CONSTRAINT "party_allocations_transaction_fk" FOREIGN KEY ("transaction_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_allocations" ADD CONSTRAINT "party_allocations_charge_fk" FOREIGN KEY ("charge_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_allocations" ADD CONSTRAINT "party_allocations_settle_fk" FOREIGN KEY ("settle_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_gl_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_account_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_to_account_fk" FOREIGN KEY ("to_account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_gl_fk" FOREIGN KEY ("gl_account_id","company_id") REFERENCES "public"."accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_journal_fk" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_cancel_journal_fk" FOREIGN KEY ("cancel_journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_allocations_charge_idx" ON "party_allocations" USING btree ("charge_line_id");--> statement-breakpoint
CREATE INDEX "party_allocations_party_idx" ON "party_allocations" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE INDEX "treasury_transactions_date_idx" ON "treasury_transactions" USING btree ("company_id","txn_date");--> statement-breakpoint
CREATE INDEX "treasury_transactions_account_idx" ON "treasury_transactions" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE INDEX "treasury_transactions_party_idx" ON "treasury_transactions" USING btree ("company_id","party_id");--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss'));