CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'customer' NOT NULL,
	"tax_number" text,
	"tax_office" text,
	"phone" text,
	"email" text,
	"address" text,
	"currency_code" text DEFAULT 'TRY' NOT NULL,
	"credit_limit" numeric(19, 4),
	"payment_term_days" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parties_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "parties_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "parties_kind_ck" CHECK ("parties"."kind" in ('customer','supplier','both')),
	CONSTRAINT "parties_term_ck" CHECK ("parties"."payment_term_days" between 0 and 365)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "party_control" text;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parties_name_idx" ON "parties" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_lines_party_idx" ON "journal_lines" USING btree ("company_id","party_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_party_control_ck" CHECK ("accounts"."party_control" in ('receivable','payable'));