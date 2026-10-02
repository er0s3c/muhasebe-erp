CREATE TABLE "expense_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code" text,
	"withholding_rate" numeric(7, 4),
	"project_id" uuid,
	"wbs_id" uuid,
	"cost_code_id" uuid,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_cards_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "expense_cards_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "expense_cards_withholding_ck" CHECK ("expense_cards"."withholding_rate" is null or ("expense_cards"."withholding_rate" >= 0 and "expense_cards"."withholding_rate" <= 100)),
	CONSTRAINT "expense_cards_dim_ck" CHECK (("expense_cards"."wbs_id" is null and "expense_cards"."cost_code_id" is null) or "expense_cards"."project_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "expense_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_no" text NOT NULL,
	"entry_date" date NOT NULL,
	"card_id" uuid NOT NULL,
	"description" text NOT NULL,
	"party_id" uuid,
	"payment_kind" text NOT NULL,
	"treasury_account_id" uuid,
	"due_date" date,
	"net" numeric(19, 4) NOT NULL,
	"vat_code" text,
	"vat_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"withholding_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"withholding" numeric(19, 4) NOT NULL,
	"gross" numeric(19, 4) NOT NULL,
	"payable" numeric(19, 4) NOT NULL,
	"document_ref" text,
	"project_id" uuid,
	"wbs_id" uuid,
	"cost_code_id" uuid,
	"journal_entry_id" uuid NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"cancel_journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_entries_no_uq" UNIQUE("company_id","entry_no"),
	CONSTRAINT "expense_entries_status_ck" CHECK ("expense_entries"."status" in ('posted','cancelled')),
	CONSTRAINT "expense_entries_payment_ck" CHECK (("expense_entries"."payment_kind" = 'treasury' and "expense_entries"."treasury_account_id" is not null) or ("expense_entries"."payment_kind" = 'party' and "expense_entries"."party_id" is not null and "expense_entries"."treasury_account_id" is null)),
	CONSTRAINT "expense_entries_amounts_ck" CHECK ("expense_entries"."net" > 0 and "expense_entries"."vat" >= 0 and "expense_entries"."withholding" >= 0 and "expense_entries"."gross" = "expense_entries"."net" + "expense_entries"."vat" and "expense_entries"."payable" = "expense_entries"."gross" - "expense_entries"."withholding" and "expense_entries"."payable" >= 0),
	CONSTRAINT "expense_entries_cancel_ck" CHECK (("expense_entries"."status" = 'cancelled') = ("expense_entries"."cancelled_at" is not null and "expense_entries"."cancel_journal_entry_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "import_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"import_file_id" uuid NOT NULL,
	"cost_line_id" uuid NOT NULL,
	"file_line_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "import_allocations_uq" UNIQUE("cost_line_id","file_line_id"),
	CONSTRAINT "import_allocations_amount_ck" CHECK ("import_allocations"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_cost_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"import_file_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"party_id" uuid,
	"invoice_id" uuid,
	"currency_code" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"fx_rate" numeric(19, 8),
	"amount_base" numeric(19, 4) NOT NULL,
	"method" text NOT NULL,
	"credit_account_id" uuid,
	"reference" text,
	CONSTRAINT "import_cost_lines_uq" UNIQUE("import_file_id","line_no"),
	CONSTRAINT "import_cost_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "import_cost_lines_kind_ck" CHECK ("import_cost_lines"."kind" in ('freight','insurance','customs_duty','other_tax','brokerage','other')),
	CONSTRAINT "import_cost_lines_method_ck" CHECK ("import_cost_lines"."method" in ('value','quantity','weight','manual')),
	CONSTRAINT "import_cost_lines_amount_ck" CHECK ("import_cost_lines"."amount" > 0 and "import_cost_lines"."amount_base" > 0 and ("import_cost_lines"."fx_rate" is null or "import_cost_lines"."fx_rate" > 0))
);
--> statement-breakpoint
CREATE TABLE "import_file_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"import_file_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_file_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"import_file_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"source_kind" text NOT NULL,
	"invoice_line_id" uuid,
	"delivery_line_id" uuid,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"source_doc_no" text NOT NULL,
	"source_date" date NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"value_base" numeric(19, 4) NOT NULL,
	"weight" numeric(19, 4),
	"stocked_amount" numeric(19, 4),
	"cogs_amount" numeric(19, 4),
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "import_file_lines_uq" UNIQUE("import_file_id","line_no"),
	CONSTRAINT "import_file_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "import_file_lines_source_ck" CHECK (("import_file_lines"."source_kind" = 'invoice' and "import_file_lines"."invoice_line_id" is not null and "import_file_lines"."delivery_line_id" is null) or ("import_file_lines"."source_kind" = 'delivery' and "import_file_lines"."delivery_line_id" is not null and "import_file_lines"."invoice_line_id" is null)),
	CONSTRAINT "import_file_lines_qty_ck" CHECK ("import_file_lines"."quantity" > 0 and "import_file_lines"."value_base" >= 0 and ("import_file_lines"."weight" is null or "import_file_lines"."weight" > 0))
);
--> statement-breakpoint
CREATE TABLE "import_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"reference" text,
	"description" text,
	"method" text DEFAULT 'value' NOT NULL,
	"file_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"allocated_at" timestamp with time zone,
	"post_date" date,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"stock_document_id" uuid,
	"journal_entry_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"cancel_stock_document_id" uuid,
	"cancel_journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_files_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "import_files_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "import_files_method_ck" CHECK ("import_files"."method" in ('value','quantity','weight','manual')),
	CONSTRAINT "import_files_status_ck" CHECK ("import_files"."status" in ('draft','allocated','posted','cancelled')),
	CONSTRAINT "import_files_posted_ck" CHECK ("import_files"."status" not in ('posted') or ("import_files"."journal_entry_id" is not null and "import_files"."posted_at" is not null and "import_files"."post_date" is not null))
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "expense_cards" ADD CONSTRAINT "expense_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_cards" ADD CONSTRAINT "expense_cards_account_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_cards" ADD CONSTRAINT "expense_cards_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_cards" ADD CONSTRAINT "expense_cards_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_cards" ADD CONSTRAINT "expense_cards_cost_code_fk" FOREIGN KEY ("cost_code_id","company_id") REFERENCES "public"."cost_codes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_card_fk" FOREIGN KEY ("card_id","company_id") REFERENCES "public"."expense_cards"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_treasury_fk" FOREIGN KEY ("treasury_account_id","company_id") REFERENCES "public"."treasury_accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_cost_code_fk" FOREIGN KEY ("cost_code_id","company_id") REFERENCES "public"."cost_codes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_entry_fk" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_cancel_entry_fk" FOREIGN KEY ("cancel_journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_allocations" ADD CONSTRAINT "import_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_allocations" ADD CONSTRAINT "import_allocations_file_fk" FOREIGN KEY ("import_file_id","company_id") REFERENCES "public"."import_files"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_allocations" ADD CONSTRAINT "import_allocations_cost_fk" FOREIGN KEY ("cost_line_id","company_id") REFERENCES "public"."import_cost_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_allocations" ADD CONSTRAINT "import_allocations_line_fk" FOREIGN KEY ("file_line_id","company_id") REFERENCES "public"."import_file_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_cost_lines" ADD CONSTRAINT "import_cost_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_cost_lines" ADD CONSTRAINT "import_cost_lines_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_cost_lines" ADD CONSTRAINT "import_cost_lines_file_fk" FOREIGN KEY ("import_file_id","company_id") REFERENCES "public"."import_files"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_cost_lines" ADD CONSTRAINT "import_cost_lines_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_cost_lines" ADD CONSTRAINT "import_cost_lines_invoice_fk" FOREIGN KEY ("invoice_id","company_id") REFERENCES "public"."invoices"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_cost_lines" ADD CONSTRAINT "import_cost_lines_account_fk" FOREIGN KEY ("credit_account_id","company_id") REFERENCES "public"."accounts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_events" ADD CONSTRAINT "import_file_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_events" ADD CONSTRAINT "import_file_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_events" ADD CONSTRAINT "import_file_events_file_fk" FOREIGN KEY ("import_file_id","company_id") REFERENCES "public"."import_files"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_lines" ADD CONSTRAINT "import_file_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_lines" ADD CONSTRAINT "import_file_lines_file_fk" FOREIGN KEY ("import_file_id","company_id") REFERENCES "public"."import_files"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_lines" ADD CONSTRAINT "import_file_lines_invoice_line_fk" FOREIGN KEY ("invoice_line_id","company_id") REFERENCES "public"."invoice_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_lines" ADD CONSTRAINT "import_file_lines_delivery_line_fk" FOREIGN KEY ("delivery_line_id","company_id") REFERENCES "public"."delivery_note_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_lines" ADD CONSTRAINT "import_file_lines_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_file_lines" ADD CONSTRAINT "import_file_lines_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_stock_doc_fk" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_cancel_stock_doc_fk" FOREIGN KEY ("cancel_stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_entry_fk" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_cancel_entry_fk" FOREIGN KEY ("cancel_journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_entries_date_idx" ON "expense_entries" USING btree ("company_id","entry_date");--> statement-breakpoint
CREATE INDEX "expense_entries_card_idx" ON "expense_entries" USING btree ("company_id","card_id");--> statement-breakpoint
CREATE INDEX "import_file_events_file_idx" ON "import_file_events" USING btree ("import_file_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_file_lines_invoice_active_uq" ON "import_file_lines" USING btree ("invoice_line_id") WHERE "import_file_lines"."is_active" and "import_file_lines"."invoice_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "import_file_lines_delivery_active_uq" ON "import_file_lines" USING btree ("delivery_line_id") WHERE "import_file_lines"."is_active" and "import_file_lines"."delivery_line_id" is not null;--> statement-breakpoint
CREATE INDEX "import_file_lines_item_idx" ON "import_file_lines" USING btree ("company_id","item_id");--> statement-breakpoint
CREATE INDEX "import_files_status_idx" ON "import_files" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable','payroll_labor_cost','payroll_employer_cost','payroll_payable','payroll_social_payable','payroll_tax_payable','payroll_other_payable','cheque_portfolio','note_portfolio','docs_in_collection','cheque_issued','note_payable','import_cost_clearing'));