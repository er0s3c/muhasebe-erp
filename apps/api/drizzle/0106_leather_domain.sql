CREATE TABLE "leather_cost_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid,
	"receipt_line_id" uuid,
	"root_id" uuid NOT NULL,
	"source_journal_line_id" uuid NOT NULL,
	"amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"request_key" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lca_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lca_request" UNIQUE("company_id","request_key"),
	CONSTRAINT "lca_target" CHECK (("leather_cost_allocations"."order_id" is null)<>("leather_cost_allocations"."receipt_line_id" is null) and "leather_cost_allocations"."amount">0)
);
--> statement-breakpoint
CREATE TABLE "leather_cost_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"root_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"stock_document_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lcc_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lcc_source_root" UNIQUE("company_id","root_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "leather_cost_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"root_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"from_key" text,
	"to_key" text NOT NULL,
	"share" numeric(38, 24) NOT NULL,
	"value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"date" date NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leather_cost_roots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"line_no" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid,
	"order_id" uuid,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"provisional_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"current_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"settled_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"settled_provisional" numeric(19, 4) DEFAULT '0' NOT NULL,
	"accrued" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lcroot_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lcroot_source" UNIQUE("company_id","source_type","source_id","line_no","kind")
);
--> statement-breakpoint
CREATE TABLE "leather_cost_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"root_id" uuid NOT NULL,
	"target_key" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"item_id" uuid,
	"warehouse_id" uuid,
	"order_id" uuid,
	"share" numeric(38, 24) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lcshare_target" UNIQUE("root_id","target_key"),
	CONSTRAINT "lcshare_positive" CHECK ("leather_cost_shares"."share">=0)
);
--> statement-breakpoint
CREATE TABLE "leather_custom_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"party_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"deposit_transaction_id" uuid,
	"invoice_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lco_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lco_deposit" UNIQUE("company_id","deposit_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "leather_lots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"delivery_note_id" uuid NOT NULL,
	"delivery_line_id" uuid NOT NULL,
	"date" date NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_area" numeric(19, 4) DEFAULT '0' NOT NULL,
	"provisional_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "ll_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "ll_code" UNIQUE("company_id","code")
);
--> statement-breakpoint
CREATE TABLE "leather_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	CONSTRAINT "lm_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lm_code" UNIQUE("company_id","code")
);
--> statement-breakpoint
CREATE TABLE "leather_piece_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"piece_id" uuid NOT NULL,
	"order_id" uuid,
	"document_id" uuid,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lpe_company_id" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "leather_pieces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lot_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"area" numeric(19, 4) DEFAULT '0' NOT NULL,
	"remaining_area" numeric(19, 4) DEFAULT '0' NOT NULL,
	"usable_area" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'quarantine' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lp_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lp_code" UNIQUE("company_id","code"),
	CONSTRAINT "lp_area" CHECK ("leather_pieces"."area">0 and "leather_pieces"."remaining_area">=0 and "leather_pieces"."remaining_area"<="leather_pieces"."area" and "leather_pieces"."usable_area">=0 and "leather_pieces"."usable_area"<="leather_pieces"."area"),
	CONSTRAINT "lp_status" CHECK ("leather_pieces"."status" in ('quarantine','available','second','rejected','consumed','split'))
);
--> statement-breakpoint
CREATE TABLE "leather_production_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"stock_document_id" uuid,
	"journal_entry_id" uuid,
	"request_key" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lpd_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lpd_request" UNIQUE("company_id","request_key")
);
--> statement-breakpoint
CREATE TABLE "leather_production_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"variant_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"output_warehouse_id" uuid NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"completed_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"wip_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"due_date" date,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lpo_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lpo_code" UNIQUE("company_id","code"),
	CONSTRAINT "lpo_quantity" CHECK ("leather_production_orders"."quantity">0 and "leather_production_orders"."completed_qty">=0 and "leather_production_orders"."completed_qty"<="leather_production_orders"."quantity" and "leather_production_orders"."wip_value">=0),
	CONSTRAINT "lpo_status" CHECK ("leather_production_orders"."status" in ('planned','released','in_progress','completed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "leather_quality_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope" text NOT NULL,
	"source_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"inspected_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"passed_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "lqc_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lqc_qty" CHECK ("leather_quality_checks"."inspected_qty">0 and "leather_quality_checks"."passed_qty">=0 and "leather_quality_checks"."passed_qty"<="leather_quality_checks"."inspected_qty")
);
--> statement-breakpoint
CREATE TABLE "leather_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"piece_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"consumed_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	CONSTRAINT "lres_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lres_quantity" CHECK ("leather_reservations"."quantity">0 and "leather_reservations"."consumed_qty">=0 and "leather_reservations"."consumed_qty"<="leather_reservations"."quantity")
);
--> statement-breakpoint
CREATE TABLE "leather_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "lr_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lr_revision" UNIQUE("model_id","revision"),
	CONSTRAINT "lr_status" CHECK ("leather_revisions"."status" in ('draft','approved','retired'))
);
--> statement-breakpoint
CREATE TABLE "leather_service_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"party_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"invoice_line_id" uuid,
	"serial_id" uuid,
	"date" date NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"invoice_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lsc_company_id" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "leather_subcontract_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"returned_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"due_date" date,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lsj_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lsj_qty" CHECK ("leather_subcontract_jobs"."quantity">0 and "leather_subcontract_jobs"."returned_qty">=0 and "leather_subcontract_jobs"."returned_qty"<="leather_subcontract_jobs"."quantity")
);
--> statement-breakpoint
CREATE TABLE "leather_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "lv_company_id" UNIQUE("id","company_id"),
	CONSTRAINT "lv_item" UNIQUE("company_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "leather_cost_allocations" ADD CONSTRAINT "leather_cost_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_allocations" ADD CONSTRAINT "leather_cost_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_allocations" ADD CONSTRAINT "lca_order" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."leather_production_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_allocations" ADD CONSTRAINT "lca_receipt" FOREIGN KEY ("receipt_line_id","company_id") REFERENCES "public"."delivery_note_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_allocations" ADD CONSTRAINT "lca_root" FOREIGN KEY ("root_id","company_id") REFERENCES "public"."leather_cost_roots"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_allocations" ADD CONSTRAINT "lca_journal_line" FOREIGN KEY ("source_journal_line_id","company_id") REFERENCES "public"."journal_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_corrections" ADD CONSTRAINT "leather_cost_corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_corrections" ADD CONSTRAINT "leather_cost_corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_corrections" ADD CONSTRAINT "lcc_root" FOREIGN KEY ("root_id","company_id") REFERENCES "public"."leather_cost_roots"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_corrections" ADD CONSTRAINT "lcc_journal" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_corrections" ADD CONSTRAINT "lcc_stock" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_events" ADD CONSTRAINT "leather_cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_events" ADD CONSTRAINT "leather_cost_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_events" ADD CONSTRAINT "lce_root" FOREIGN KEY ("root_id","company_id") REFERENCES "public"."leather_cost_roots"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_roots" ADD CONSTRAINT "leather_cost_roots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_roots" ADD CONSTRAINT "leather_cost_roots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_roots" ADD CONSTRAINT "lcroot_item" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_roots" ADD CONSTRAINT "lcroot_order" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."leather_production_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_shares" ADD CONSTRAINT "leather_cost_shares_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_shares" ADD CONSTRAINT "lcshare_root" FOREIGN KEY ("root_id","company_id") REFERENCES "public"."leather_cost_roots"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_shares" ADD CONSTRAINT "lcshare_item" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_shares" ADD CONSTRAINT "lcshare_wh" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_cost_shares" ADD CONSTRAINT "lcshare_order" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."leather_production_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_custom_orders" ADD CONSTRAINT "leather_custom_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_custom_orders" ADD CONSTRAINT "leather_custom_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_custom_orders" ADD CONSTRAINT "lco_party" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_custom_orders" ADD CONSTRAINT "lco_variant" FOREIGN KEY ("variant_id","company_id") REFERENCES "public"."leather_variants"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_custom_orders" ADD CONSTRAINT "lco_deposit_fk" FOREIGN KEY ("deposit_transaction_id","company_id") REFERENCES "public"."treasury_transactions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_custom_orders" ADD CONSTRAINT "lco_invoice" FOREIGN KEY ("invoice_id","company_id") REFERENCES "public"."invoices"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_lots" ADD CONSTRAINT "leather_lots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_lots" ADD CONSTRAINT "leather_lots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_lots" ADD CONSTRAINT "ll_item" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_lots" ADD CONSTRAINT "ll_wh" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_lots" ADD CONSTRAINT "ll_party" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_lots" ADD CONSTRAINT "ll_delivery" FOREIGN KEY ("delivery_note_id","company_id") REFERENCES "public"."delivery_notes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_lots" ADD CONSTRAINT "ll_delivery_line" FOREIGN KEY ("delivery_line_id","company_id") REFERENCES "public"."delivery_note_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_models" ADD CONSTRAINT "leather_models_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_models" ADD CONSTRAINT "leather_models_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_piece_events" ADD CONSTRAINT "leather_piece_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_piece_events" ADD CONSTRAINT "leather_piece_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_piece_events" ADD CONSTRAINT "lpe_piece" FOREIGN KEY ("piece_id","company_id") REFERENCES "public"."leather_pieces"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_piece_events" ADD CONSTRAINT "lpe_order" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."leather_production_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_piece_events" ADD CONSTRAINT "lpe_document" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."leather_production_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_pieces" ADD CONSTRAINT "leather_pieces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_pieces" ADD CONSTRAINT "leather_pieces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_pieces" ADD CONSTRAINT "lp_lot" FOREIGN KEY ("lot_id","company_id") REFERENCES "public"."leather_lots"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_pieces" ADD CONSTRAINT "lp_item" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_pieces" ADD CONSTRAINT "lp_wh" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_documents" ADD CONSTRAINT "leather_production_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_documents" ADD CONSTRAINT "leather_production_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_documents" ADD CONSTRAINT "lpd_order" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."leather_production_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_documents" ADD CONSTRAINT "lpd_stock" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_documents" ADD CONSTRAINT "lpd_journal" FOREIGN KEY ("journal_entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_orders" ADD CONSTRAINT "leather_production_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_orders" ADD CONSTRAINT "leather_production_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_orders" ADD CONSTRAINT "lpo_variant" FOREIGN KEY ("variant_id","company_id") REFERENCES "public"."leather_variants"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_orders" ADD CONSTRAINT "lpo_revision" FOREIGN KEY ("revision_id","company_id") REFERENCES "public"."leather_revisions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_orders" ADD CONSTRAINT "lpo_item" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_orders" ADD CONSTRAINT "lpo_wh" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_production_orders" ADD CONSTRAINT "lpo_output_wh" FOREIGN KEY ("output_warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_quality_checks" ADD CONSTRAINT "leather_quality_checks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_quality_checks" ADD CONSTRAINT "leather_quality_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_quality_checks" ADD CONSTRAINT "leather_quality_checks_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_reservations" ADD CONSTRAINT "leather_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_reservations" ADD CONSTRAINT "leather_reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_reservations" ADD CONSTRAINT "lres_order" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."leather_production_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_reservations" ADD CONSTRAINT "lres_item" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_reservations" ADD CONSTRAINT "lres_piece" FOREIGN KEY ("piece_id","company_id") REFERENCES "public"."leather_pieces"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_reservations" ADD CONSTRAINT "lres_wh" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_revisions" ADD CONSTRAINT "leather_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_revisions" ADD CONSTRAINT "leather_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_revisions" ADD CONSTRAINT "leather_revisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_revisions" ADD CONSTRAINT "lr_model" FOREIGN KEY ("model_id","company_id") REFERENCES "public"."leather_models"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_service_cases" ADD CONSTRAINT "leather_service_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_service_cases" ADD CONSTRAINT "leather_service_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_service_cases" ADD CONSTRAINT "lsc_party" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_service_cases" ADD CONSTRAINT "lsc_item" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_service_cases" ADD CONSTRAINT "lsc_sale" FOREIGN KEY ("invoice_line_id","company_id") REFERENCES "public"."invoice_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_service_cases" ADD CONSTRAINT "lsc_serial" FOREIGN KEY ("serial_id","company_id") REFERENCES "public"."item_serials"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_service_cases" ADD CONSTRAINT "lsc_invoice" FOREIGN KEY ("invoice_id","company_id") REFERENCES "public"."invoices"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_subcontract_jobs" ADD CONSTRAINT "leather_subcontract_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_subcontract_jobs" ADD CONSTRAINT "leather_subcontract_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_subcontract_jobs" ADD CONSTRAINT "lsj_order" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."leather_production_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_subcontract_jobs" ADD CONSTRAINT "lsj_party" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_variants" ADD CONSTRAINT "leather_variants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_variants" ADD CONSTRAINT "leather_variants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_variants" ADD CONSTRAINT "lv_model" FOREIGN KEY ("model_id","company_id") REFERENCES "public"."leather_models"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_variants" ADD CONSTRAINT "lv_revision" FOREIGN KEY ("revision_id","company_id") REFERENCES "public"."leather_revisions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leather_variants" ADD CONSTRAINT "lv_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lcshare_target_idx" ON "leather_cost_shares" USING btree ("company_id","target_key");
--> statement-breakpoint
ALTER TABLE leather_pieces ADD CONSTRAINT lp_parent FOREIGN KEY(parent_id,company_id) REFERENCES leather_pieces(id,company_id);
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['leather_models','leather_revisions','leather_variants','leather_lots','leather_pieces','leather_production_orders','leather_reservations','leather_production_documents','leather_piece_events','leather_cost_roots','leather_cost_shares','leather_cost_events','leather_cost_corrections','leather_cost_allocations','leather_quality_checks','leather_subcontract_jobs','leather_custom_orders','leather_service_cases'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_app',t);
  IF t <> 'leather_cost_shares' THEN EXECUTE format('CREATE TRIGGER audit_%I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t,t); END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION leather_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Deri işlem geçmişi değiştirilemez; yeni düzeltme belgesi oluşturun' USING ERRCODE='ERP19';
END $$;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['leather_lots','leather_production_documents','leather_piece_events','leather_cost_events','leather_cost_corrections','leather_cost_allocations'] LOOP
  EXECUTE format('REVOKE UPDATE ON %I FROM erp_app',t);
  EXECUTE format('CREATE TRIGGER immutable_%I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION leather_immutable_guard()',t,t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION leather_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p fiscal_periods%ROWTYPE; BEGIN
 SELECT * INTO p FROM fiscal_periods WHERE company_id=NEW.company_id AND NEW.date BETWEEN start_date AND end_date FOR SHARE;
 IF NOT FOUND OR p.status<>'open' THEN RAISE EXCEPTION 'Deri belgesi açık döneme kaydedilmeli' USING ERRCODE='ERP19'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['leather_lots','leather_production_documents','leather_piece_events','leather_cost_events','leather_cost_corrections','leather_cost_allocations'] LOOP
  EXECUTE format('CREATE TRIGGER period_%I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION leather_period_guard()',t,t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION leather_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.status<>'draft') THEN RAISE EXCEPTION 'Onaylı reçete revizyonu değiştirilemez' USING ERRCODE='ERP19'; END IF;
 IF TG_OP='INSERT' AND (NEW.status<>'draft' OR NEW.approved_by IS NOT NULL) THEN RAISE EXCEPTION 'Reçete taslak olarak başlamalı' USING ERRCODE='ERP19'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.model_id<>OLD.model_id OR NEW.revision<>OLD.revision) THEN RAISE EXCEPTION 'Revizyon kimliği değiştirilemez' USING ERRCODE='ERP19'; END IF;
 IF NEW.status='approved' AND (NEW.config->>'sampleApproved' IS DISTINCT FROM 'true' OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN RAISE EXCEPTION 'Numune kabulü ve onaylayıcı gerekli' USING ERRCODE='ERP19'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER leather_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON leather_revisions FOR EACH ROW EXECUTE FUNCTION leather_revision_guard();
--> statement-breakpoint
CREATE FUNCTION leather_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r leather_revisions%ROWTYPE; v leather_variants%ROWTYPE; BEGIN
 SELECT * INTO r FROM leather_revisions WHERE id=NEW.revision_id AND company_id=NEW.company_id;
 SELECT * INTO v FROM leather_variants WHERE id=NEW.variant_id AND company_id=NEW.company_id;
 IF r.status IS DISTINCT FROM 'approved' OR v.revision_id IS DISTINCT FROM NEW.revision_id OR v.item_id IS DISTINCT FROM NEW.item_id THEN RAISE EXCEPTION 'Üretim onaylı varyant reçetesinden açılmalı' USING ERRCODE='ERP19'; END IF;
 IF TG_OP='UPDATE' AND (NEW.revision_id<>OLD.revision_id OR NEW.variant_id<>OLD.variant_id OR NEW.item_id<>OLD.item_id OR NEW.quantity<>OLD.quantity OR NEW.warehouse_id<>OLD.warehouse_id OR NEW.output_warehouse_id<>OLD.output_warehouse_id) THEN RAISE EXCEPTION 'Üretim emrinin reçetesi ve kapsamı sabittir' USING ERRCODE='ERP19'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER leather_order_guard BEFORE INSERT OR UPDATE ON leather_production_orders FOR EACH ROW EXECUTE FUNCTION leather_order_guard();
--> statement-breakpoint
CREATE FUNCTION leather_piece_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.lot_id<>OLD.lot_id OR NEW.item_id<>OLD.item_id OR NEW.area<>OLD.area OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.code<>OLD.code) THEN RAISE EXCEPTION 'Deri parça kimliği ve başlangıç alanı sabittir' USING ERRCODE='ERP19'; END IF;
 IF NEW.parent_id=NEW.id THEN RAISE EXCEPTION 'Parça kendisinin kalanı olamaz' USING ERRCODE='ERP19'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER leather_piece_guard BEFORE INSERT OR UPDATE ON leather_pieces FOR EACH ROW EXECUTE FUNCTION leather_piece_guard();
--> statement-breakpoint
CREATE TABLE leather_deposit_settlements (
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies(id),created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 custom_order_id uuid NOT NULL,party_id uuid NOT NULL,deposit_transaction_id uuid NOT NULL,invoice_id uuid NOT NULL,charge_line_id uuid NOT NULL,settle_line_id uuid NOT NULL,entry_id uuid NOT NULL,amount numeric(19,4) NOT NULL DEFAULT 0,amount_base numeric(19,4) NOT NULL DEFAULT 0,
 CONSTRAINT lds_company_id UNIQUE(id,company_id),CONSTRAINT lds_entry_unique UNIQUE(entry_id),
 CONSTRAINT lds_order FOREIGN KEY(custom_order_id,company_id) REFERENCES leather_custom_orders(id,company_id),
 CONSTRAINT lds_party FOREIGN KEY(party_id,company_id) REFERENCES parties(id,company_id),
 CONSTRAINT lds_deposit_fk FOREIGN KEY(deposit_transaction_id,company_id) REFERENCES treasury_transactions(id,company_id),
 CONSTRAINT lds_invoice FOREIGN KEY(invoice_id,company_id) REFERENCES invoices(id,company_id),
 CONSTRAINT lds_charge FOREIGN KEY(charge_line_id,company_id) REFERENCES journal_lines(id,company_id),
 CONSTRAINT lds_settle FOREIGN KEY(settle_line_id,company_id) REFERENCES journal_lines(id,company_id),
 CONSTRAINT lds_entry FOREIGN KEY(entry_id,company_id) REFERENCES journal_entries(id,company_id)
);
--> statement-breakpoint
ALTER TABLE leather_deposit_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leather_deposit_settlements USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id());
GRANT SELECT,INSERT ON leather_deposit_settlements TO erp_app;
CREATE TRIGGER audit_leather_deposit_settlements AFTER INSERT OR UPDATE OR DELETE ON leather_deposit_settlements FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER immutable_leather_deposit_settlements BEFORE UPDATE OR DELETE ON leather_deposit_settlements FOR EACH ROW EXECUTE FUNCTION leather_immutable_guard();
--> statement-breakpoint
CREATE FUNCTION leather_deposit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE o leather_custom_orders%ROWTYPE; i invoices%ROWTYPE; t treasury_transactions%ROWTYPE; c journal_lines%ROWTYPE; s journal_lines%ROWTYPE; e journal_entries%ROWTYPE;
 BEGIN
 SELECT * INTO o FROM leather_custom_orders WHERE id=NEW.custom_order_id AND company_id=NEW.company_id FOR UPDATE;
 SELECT * INTO i FROM invoices WHERE id=NEW.invoice_id AND company_id=NEW.company_id;
 SELECT * INTO t FROM treasury_transactions WHERE id=NEW.deposit_transaction_id AND company_id=NEW.company_id FOR UPDATE;
 SELECT * INTO c FROM journal_lines WHERE id=NEW.charge_line_id AND company_id=NEW.company_id;
 SELECT * INTO s FROM journal_lines WHERE id=NEW.settle_line_id AND company_id=NEW.company_id;
 SELECT * INTO e FROM journal_entries WHERE id=NEW.entry_id AND company_id=NEW.company_id;
 IF o.party_id IS DISTINCT FROM NEW.party_id OR o.deposit_transaction_id IS DISTINCT FROM t.id OR i.party_id IS DISTINCT FROM NEW.party_id OR i.type<>'sales' OR i.status<>'posted' OR t.status<>'posted' OR t.type<>'other_receipt' OR t.party_id IS DISTINCT FROM NEW.party_id OR t.currency_code IS DISTINCT FROM i.currency_code OR c.party_id IS DISTINCT FROM NEW.party_id OR s.party_id IS DISTINCT FROM NEW.party_id OR s.entry_id<>e.id OR e.status<>'posted' OR c.debit<=0 OR s.credit<=0 OR NEW.amount<=0 OR NEW.amount_base<=0 OR NEW.amount>t.amount OR NEW.amount>s.credit OR NEW.amount_base>s.credit_base THEN
 RAISE EXCEPTION 'Kapora mahsubu müşteri, kaynak ve kayıtlı fatura kalemiyle eşleşmeli' USING ERRCODE='ERP19'; END IF;
 IF EXISTS(SELECT 1 FROM leather_deposit_settlements d JOIN journal_entries j ON j.id=d.entry_id WHERE d.deposit_transaction_id=t.id AND j.reversed_by_id IS NULL) THEN RAISE EXCEPTION 'Kapora bir kez mahsup edilebilir' USING ERRCODE='ERP19'; END IF;
 RETURN NEW;
 END $$;
--> statement-breakpoint
CREATE TRIGGER leather_deposit_guard BEFORE INSERT ON leather_deposit_settlements FOR EACH ROW EXECUTE FUNCTION leather_deposit_guard();
