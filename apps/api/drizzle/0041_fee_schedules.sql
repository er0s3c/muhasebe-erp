CREATE TABLE "fee_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"side" text NOT NULL,
	"basis" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"source_note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_schedules_uq" UNIQUE("company_id","code","valid_from"),
	CONSTRAINT "fee_schedules_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "fee_schedules_side_ck" CHECK ("fee_schedules"."side" in ('buyer','project')),
	CONSTRAINT "fee_schedules_basis_ck" CHECK ("fee_schedules"."basis" in ('per_unit','per_m2','pct_of_price','fixed')),
	CONSTRAINT "fee_schedules_amount_ck" CHECK ("fee_schedules"."amount" >= 0 and ("fee_schedules"."basis" <> 'pct_of_price' or "fee_schedules"."amount" <= 100)),
	CONSTRAINT "fee_schedules_currency_ck" CHECK (("fee_schedules"."basis" = 'pct_of_price') or "fee_schedules"."currency_code" is not null),
	CONSTRAINT "fee_schedules_range_ck" CHECK ("fee_schedules"."valid_to" is null or "fee_schedules"."valid_to" >= "fee_schedules"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "cost_codes" DROP CONSTRAINT "cost_codes_kind_ck";--> statement-breakpoint
ALTER TABLE "sales_installments" DROP CONSTRAINT "sales_installments_kind_ck";--> statement-breakpoint
ALTER TABLE "sales_installments" ADD COLUMN "fee_schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_installments" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_fee_fk" FOREIGN KEY ("fee_schedule_id","company_id") REFERENCES "public"."fee_schedules"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable'));--> statement-breakpoint
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_kind_ck" CHECK ("cost_codes"."kind" in ('material','labor','subcontract','equipment','transport','overhead','fee','other'));--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_fee_ck" CHECK (("sales_installments"."kind" = 'fee') or ("sales_installments"."fee_schedule_id" is null and "sales_installments"."label" is null));--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_kind_ck" CHECK ("sales_installments"."kind" in ('down_payment','installment','balloon','fee'));