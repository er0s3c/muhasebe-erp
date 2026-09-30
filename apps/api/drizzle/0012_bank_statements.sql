CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"txn_date" date NOT NULL,
	"value_date" date,
	"description" text DEFAULT '' NOT NULL,
	"reference" text,
	"amount" numeric(19, 4) NOT NULL,
	"balance" numeric(19, 4),
	"currency_code" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"journal_line_id" uuid,
	"transaction_id" uuid,
	"matched_at" timestamp with time zone,
	"matched_by" uuid,
	"ignore_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "bank_statement_lines_dedupe_uq" UNIQUE("company_id","account_id","dedupe_key"),
	CONSTRAINT "bank_statement_lines_gl_uq" UNIQUE("company_id","journal_line_id"),
	CONSTRAINT "bank_statement_lines_status_ck" CHECK ("bank_statement_lines"."status" in ('open','matched','ignored')),
	CONSTRAINT "bank_statement_lines_amount_ck" CHECK ("bank_statement_lines"."amount" <> 0),
	CONSTRAINT "bank_statement_lines_match_ck" CHECK (("bank_statement_lines"."status" = 'matched') = ("bank_statement_lines"."journal_line_id" is not null and "bank_statement_lines"."matched_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"opening_balance" numeric(19, 4),
	"closing_balance" numeric(19, 4),
	"line_count" integer NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statements_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "bank_statements_hash_uq" UNIQUE("company_id","account_id","file_hash"),
	CONSTRAINT "bank_statements_range_ck" CHECK ("bank_statements"."from_date" <= "bank_statements"."to_date")
);
--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_fk" FOREIGN KEY ("statement_id","company_id") REFERENCES "public"."bank_statements"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_account_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_journal_line_fk" FOREIGN KEY ("journal_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_transaction_fk" FOREIGN KEY ("transaction_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_account_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_statement_lines_statement_idx" ON "bank_statement_lines" USING btree ("company_id","statement_id","line_no");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_account_idx" ON "bank_statement_lines" USING btree ("company_id","account_id","txn_date");--> statement-breakpoint
CREATE INDEX "bank_statements_account_idx" ON "bank_statements" USING btree ("company_id","account_id","to_date");