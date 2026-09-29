CREATE TABLE "item_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_categories_company_name_uq" UNIQUE("company_id","name"),
	CONSTRAINT "item_categories_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'goods' NOT NULL,
	"unit" text DEFAULT 'adet' NOT NULL,
	"category_id" uuid,
	"barcode" text,
	"vat_code" text,
	"purchase_price" numeric(19, 6),
	"purchase_currency" text DEFAULT 'TRY' NOT NULL,
	"sale_price" numeric(19, 6),
	"sale_currency" text DEFAULT 'TRY' NOT NULL,
	"min_level" numeric(19, 4),
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "items_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "items_kind_ck" CHECK ("items"."kind" in ('goods','service')),
	CONSTRAINT "items_amounts_ck" CHECK (("items"."purchase_price" is null or "items"."purchase_price" >= 0) and ("items"."sale_price" is null or "items"."sale_price" >= 0) and ("items"."min_level" is null or "items"."min_level" >= 0))
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"counted_qty" numeric(19, 4),
	"system_qty" numeric(19, 4),
	"diff_qty" numeric(19, 4),
	CONSTRAINT "stock_count_lines_uq" UNIQUE("count_id","item_id"),
	CONSTRAINT "stock_count_lines_qty_ck" CHECK ("stock_count_lines"."counted_qty" is null or "stock_count_lines"."counted_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"count_no" text,
	"count_date" date NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"document_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "stock_counts_no_uq" UNIQUE("company_id","count_no"),
	CONSTRAINT "stock_counts_status_ck" CHECK ("stock_counts"."status" in ('draft','posted')),
	CONSTRAINT "stock_counts_posted_ck" CHECK ("stock_counts"."status" = 'draft' or ("stock_counts"."count_no" is not null and "stock_counts"."posted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "stock_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_no" text NOT NULL,
	"doc_date" date NOT NULL,
	"period_id" uuid NOT NULL,
	"type" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid,
	"description" text,
	"source_type" text,
	"source_id" uuid,
	"reversal_of_id" uuid,
	"reversed_by_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_documents_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "stock_documents_no_uq" UNIQUE("company_id","doc_no"),
	CONSTRAINT "stock_documents_type_ck" CHECK ("stock_documents"."type" in ('opening','receipt','issue','waste','transfer','count')),
	CONSTRAINT "stock_documents_transfer_ck" CHECK (("stock_documents"."type" = 'transfer') = ("stock_documents"."to_warehouse_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"document_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text DEFAULT 'qty' NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"movement_date" date NOT NULL,
	"qty" numeric(19, 4) NOT NULL,
	"value" numeric(19, 4) NOT NULL,
	"currency_code" text,
	"unit_cost" numeric(19, 6),
	"fx_rate" numeric(19, 8),
	CONSTRAINT "stock_movements_seq_uq" UNIQUE("seq"),
	CONSTRAINT "stock_movements_kind_ck" CHECK ("stock_movements"."kind" in ('qty','cost_adjust')),
	CONSTRAINT "stock_movements_shape_ck" CHECK (("stock_movements"."kind" = 'qty' and "stock_movements"."qty" <> 0 and ("stock_movements"."value" = 0 or sign("stock_movements"."qty") = sign("stock_movements"."value"))) or ("stock_movements"."kind" = 'cost_adjust' and "stock_movements"."qty" = 0 and "stock_movements"."value" <> 0))
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "warehouses_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "allow_negative_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_categories" ADD CONSTRAINT "item_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_currency_currencies_code_fk" FOREIGN KEY ("purchase_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_sale_currency_currencies_code_fk" FOREIGN KEY ("sale_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_category_fk" FOREIGN KEY ("category_id","company_id") REFERENCES "public"."item_categories"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_fk" FOREIGN KEY ("count_id","company_id") REFERENCES "public"."stock_counts"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_document_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_period_fk" FOREIGN KEY ("period_id","company_id") REFERENCES "public"."fiscal_periods"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_to_warehouse_fk" FOREIGN KEY ("to_warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_reversal_of_fk" FOREIGN KEY ("reversal_of_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_reversed_by_fk" FOREIGN KEY ("reversed_by_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_document_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "items_company_barcode_uq" ON "items" USING btree ("company_id","barcode") WHERE "items"."barcode" is not null;--> statement-breakpoint
CREATE INDEX "items_name_idx" ON "items" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "stock_documents_date_idx" ON "stock_documents" USING btree ("company_id","doc_date");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("company_id","item_id","seq");--> statement-breakpoint
CREATE INDEX "stock_movements_wh_item_idx" ON "stock_movements" USING btree ("company_id","warehouse_id","item_id");--> statement-breakpoint
CREATE INDEX "stock_movements_date_idx" ON "stock_movements" USING btree ("company_id","movement_date");--> statement-breakpoint
CREATE INDEX "stock_movements_doc_idx" ON "stock_movements" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_default_uq" ON "warehouses" USING btree ("company_id") WHERE "warehouses"."is_default";