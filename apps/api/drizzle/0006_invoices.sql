CREATE TABLE "account_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"account_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_mappings_uq" UNIQUE("company_id","key"),
	CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset'))
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit" text,
	"unit_price" numeric(19, 6) NOT NULL,
	"discount_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"vat_code" text,
	"vat_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"gross" numeric(19, 4) NOT NULL,
	"account_id" uuid,
	"source_line_id" uuid,
	"net_base" numeric(19, 4),
	"vat_base" numeric(19, 4),
	"cost_value" numeric(19, 4),
	CONSTRAINT "invoice_lines_uq" UNIQUE("invoice_id","line_no"),
	CONSTRAINT "invoice_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "invoice_lines_amounts_ck" CHECK ("invoice_lines"."quantity" > 0 and "invoice_lines"."unit_price" >= 0 and "invoice_lines"."discount_pct" between 0 and 100 and "invoice_lines"."vat_rate" between 0 and 100 and "invoice_lines"."net" >= 0 and "invoice_lines"."vat" >= 0 and "invoice_lines"."gross" = "invoice_lines"."net" + "invoice_lines"."vat")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"invoice_no" text,
	"external_no" text,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"party_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"fx_rate" numeric(19, 8),
	"vat_included" boolean DEFAULT false NOT NULL,
	"warehouse_id" uuid,
	"return_of_id" uuid,
	"description" text,
	"net_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"gross_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net_total_base" numeric(19, 4),
	"vat_total_base" numeric(19, 4),
	"gross_total_base" numeric(19, 4),
	"journal_entry_id" uuid,
	"stock_document_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"cancel_journal_entry_id" uuid,
	"cancel_stock_document_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "invoices_no_uq" UNIQUE("company_id","invoice_no"),
	CONSTRAINT "invoices_type_ck" CHECK ("invoices"."type" in ('sales','purchase','expense','sales_return','purchase_return')),
	CONSTRAINT "invoices_status_ck" CHECK ("invoices"."status" in ('draft','posted','cancelled')),
	CONSTRAINT "invoices_posted_ck" CHECK ("invoices"."status" = 'draft' or ("invoices"."invoice_no" is not null and "invoices"."posted_at" is not null and "invoices"."journal_entry_id" is not null and "invoices"."fx_rate" is not null and "invoices"."gross_total_base" is not null)),
	CONSTRAINT "invoices_cancelled_ck" CHECK ("invoices"."status" <> 'cancelled' or ("invoices"."cancelled_at" is not null and "invoices"."cancel_reason" is not null and "invoices"."cancel_journal_entry_id" is not null)),
	CONSTRAINT "invoices_totals_ck" CHECK ("invoices"."net_total" >= 0 and "invoices"."vat_total" >= 0 and "invoices"."gross_total" >= 0 and "invoices"."gross_total" = "invoices"."net_total" + "invoices"."vat_total"),
	CONSTRAINT "invoices_due_ck" CHECK ("invoices"."due_date" is null or "invoices"."due_date" >= "invoices"."invoice_date")
);
--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_account_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("invoice_id","company_id") REFERENCES "public"."invoices"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_account_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_source_fk" FOREIGN KEY ("source_line_id","company_id") REFERENCES "public"."invoice_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_return_of_fk" FOREIGN KEY ("return_of_id","company_id") REFERENCES "public"."invoices"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_journal_fk" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_stock_document_fk" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancel_journal_fk" FOREIGN KEY ("cancel_journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancel_stock_document_fk" FOREIGN KEY ("cancel_stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_item_idx" ON "invoice_lines" USING btree ("company_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_external_no_uq" ON "invoices" USING btree ("company_id","party_id","external_no") WHERE "invoices"."external_no" is not null and "invoices"."status" <> 'draft';--> statement-breakpoint
CREATE INDEX "invoices_date_idx" ON "invoices" USING btree ("company_id","type","invoice_date");--> statement-breakpoint
CREATE INDEX "invoices_party_idx" ON "invoices" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_uq" ON "journal_entries" USING btree ("company_id","source_type","source_id") WHERE "journal_entries"."source_id" is not null and "journal_entries"."reversal_of_id" is null;