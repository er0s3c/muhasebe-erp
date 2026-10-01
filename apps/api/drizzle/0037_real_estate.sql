CREATE TABLE "real_estate_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"block" text DEFAULT '' NOT NULL,
	"floor" integer,
	"unit_no" text NOT NULL,
	"unit_type" text DEFAULT 'apartment' NOT NULL,
	"gross_m_2" numeric(12, 2),
	"net_m_2" numeric(12, 2),
	"rooms" text,
	"list_price" numeric(19, 4),
	"list_currency" text,
	"status" text DEFAULT 'available' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "real_estate_units_no_uq" UNIQUE("company_id","project_id","block","unit_no"),
	CONSTRAINT "real_estate_units_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "real_estate_units_id_project_uq" UNIQUE("id","project_id"),
	CONSTRAINT "real_estate_units_type_ck" CHECK ("real_estate_units"."unit_type" in ('apartment','villa','shop','office','land','parking','storage','other')),
	CONSTRAINT "real_estate_units_status_ck" CHECK ("real_estate_units"."status" in ('available','reserved','sold','handed_over')),
	CONSTRAINT "real_estate_units_price_ck" CHECK (("real_estate_units"."list_price" is null or ("real_estate_units"."list_price" >= 0 and "real_estate_units"."list_currency" is not null))),
	CONSTRAINT "real_estate_units_area_ck" CHECK (("real_estate_units"."gross_m_2" is null or "real_estate_units"."gross_m_2" > 0) and ("real_estate_units"."net_m_2" is null or "real_estate_units"."net_m_2" > 0))
);
--> statement-breakpoint
CREATE TABLE "sales_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"contract_date" date NOT NULL,
	"planned_handover" date,
	"currency_code" text NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"down_payment" numeric(19, 4) DEFAULT '0' NOT NULL,
	"recognition" text DEFAULT 'on_handover' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"activated_on" date,
	"activation_fx" numeric(19, 8),
	"activation_entry_id" uuid,
	"handed_over_on" date,
	"handover_entry_id" uuid,
	"terminated_on" date,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"penalty_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_contracts_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "sales_contracts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "sales_contracts_status_ck" CHECK ("sales_contracts"."status" in ('draft','active','handed_over','terminated','cancelled')),
	CONSTRAINT "sales_contracts_recognition_ck" CHECK ("sales_contracts"."recognition" in ('on_handover')),
	CONSTRAINT "sales_contracts_amount_ck" CHECK ("sales_contracts"."price" > 0 and "sales_contracts"."down_payment" >= 0 and "sales_contracts"."down_payment" <= "sales_contracts"."price"),
	CONSTRAINT "sales_contracts_active_ck" CHECK ("sales_contracts"."status" in ('draft','cancelled') or ("sales_contracts"."activated_on" is not null and "sales_contracts"."activation_entry_id" is not null and "sales_contracts"."activation_fx" is not null)),
	CONSTRAINT "sales_contracts_handover_ck" CHECK (("sales_contracts"."status" = 'handed_over') = ("sales_contracts"."handover_entry_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "sales_installments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text DEFAULT 'installment' NOT NULL,
	"due_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"journal_line_id" uuid,
	CONSTRAINT "sales_installments_seq_uq" UNIQUE("contract_id","seq"),
	CONSTRAINT "sales_installments_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "sales_installments_kind_ck" CHECK ("sales_installments"."kind" in ('down_payment','installment','balloon')),
	CONSTRAINT "sales_installments_amount_ck" CHECK ("sales_installments"."amount" > 0 and "sales_installments"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sales_terminations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"termination_date" date NOT NULL,
	"reason" text NOT NULL,
	"collected" numeric(19, 4) NOT NULL,
	"retained" numeric(19, 4) NOT NULL,
	"refund" numeric(19, 4) NOT NULL,
	"entry_id" uuid NOT NULL,
	"refund_account_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_terminations_contract_uq" UNIQUE("contract_id"),
	CONSTRAINT "sales_terminations_amount_ck" CHECK ("sales_terminations"."collected" >= 0 and "sales_terminations"."retained" >= 0 and "sales_terminations"."refund" >= 0 and "sales_terminations"."retained" + "sales_terminations"."refund" = "sales_terminations"."collected"),
	CONSTRAINT "sales_terminations_refund_ck" CHECK ("sales_terminations"."refund" = 0 or "sales_terminations"."refund_account_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "sales_writeoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"charge_line_id" uuid NOT NULL,
	"settle_line_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_base" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_writeoffs_settle_uq" UNIQUE("settle_line_id"),
	CONSTRAINT "sales_writeoffs_amount_ck" CHECK ("sales_writeoffs"."amount" > 0 and "sales_writeoffs"."amount_base" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "real_estate_units" ADD CONSTRAINT "real_estate_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_estate_units" ADD CONSTRAINT "real_estate_units_list_currency_currencies_code_fk" FOREIGN KEY ("list_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_estate_units" ADD CONSTRAINT "real_estate_units_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "real_estate_units" ADD CONSTRAINT "real_estate_units_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_unit_fk" FOREIGN KEY ("unit_id","project_id") REFERENCES "public"."real_estate_units"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_activation_fk" FOREIGN KEY ("activation_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contracts" ADD CONSTRAINT "sales_contracts_handover_fk" FOREIGN KEY ("handover_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_contract_fk" FOREIGN KEY ("contract_id","company_id") REFERENCES "public"."sales_contracts"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_line_fk" FOREIGN KEY ("journal_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_terminations" ADD CONSTRAINT "sales_terminations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_terminations" ADD CONSTRAINT "sales_terminations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_terminations" ADD CONSTRAINT "sales_terminations_contract_fk" FOREIGN KEY ("contract_id","company_id") REFERENCES "public"."sales_contracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_terminations" ADD CONSTRAINT "sales_terminations_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_terminations" ADD CONSTRAINT "sales_terminations_account_fk" FOREIGN KEY ("refund_account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_contract_fk" FOREIGN KEY ("contract_id","company_id") REFERENCES "public"."sales_contracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_charge_fk" FOREIGN KEY ("charge_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_settle_fk" FOREIGN KEY ("settle_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "real_estate_units_project_idx" ON "real_estate_units" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_contracts_unit_live_uq" ON "sales_contracts" USING btree ("unit_id") WHERE "sales_contracts"."status" in ('draft','active','handed_over');--> statement-breakpoint
CREATE INDEX "sales_contracts_project_idx" ON "sales_contracts" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "sales_contracts_party_idx" ON "sales_contracts" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE INDEX "sales_installments_due_idx" ON "sales_installments" USING btree ("company_id","due_date");--> statement-breakpoint
CREATE INDEX "sales_writeoffs_charge_idx" ON "sales_writeoffs" USING btree ("charge_line_id");--> statement-breakpoint
CREATE INDEX "sales_writeoffs_party_idx" ON "sales_writeoffs" USING btree ("company_id","party_id");--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income'));