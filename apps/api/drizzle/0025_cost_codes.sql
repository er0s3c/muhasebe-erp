CREATE TABLE "cost_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_codes_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "cost_codes_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "cost_codes_kind_ck" CHECK ("cost_codes"."kind" in ('material','labor','subcontract','equipment','transport','overhead','other'))
);
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "cost_code_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cost_code_fk" FOREIGN KEY ("cost_code_id","company_id") REFERENCES "public"."cost_codes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cost_code_ck" CHECK ("journal_lines"."cost_code_id" is null or "journal_lines"."project_id" is not null);