CREATE TABLE "invoice_batch_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"status" text NOT NULL,
	"invoice_id" uuid,
	"note_ids" text DEFAULT '' NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_batch_items_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "invoice_batch_items_status_ck" CHECK ("invoice_batch_items"."status" in ('created','failed')),
	CONSTRAINT "invoice_batch_items_result_ck" CHECK (("invoice_batch_items"."status" = 'failed') = ("invoice_batch_items"."error_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "invoice_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_date" date NOT NULL,
	"grouping" text NOT NULL,
	"post" boolean NOT NULL,
	"invoices_created" integer DEFAULT 0 NOT NULL,
	"invoices_failed" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_batches_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "invoice_batches_grouping_ck" CHECK ("invoice_batches"."grouping" in ('party','note'))
);
--> statement-breakpoint
CREATE TABLE "sales_order_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_order_events_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
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
	"quote_line_id" uuid,
	CONSTRAINT "sales_order_lines_uq" UNIQUE("order_id","line_no"),
	CONSTRAINT "sales_order_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "sales_order_lines_amounts_ck" CHECK ("sales_order_lines"."quantity" > 0 and "sales_order_lines"."unit_price" >= 0 and "sales_order_lines"."discount_pct" between 0 and 100 and "sales_order_lines"."vat_rate" between 0 and 100 and "sales_order_lines"."net" >= 0 and "sales_order_lines"."vat" >= 0 and "sales_order_lines"."gross" = "sales_order_lines"."net" + "sales_order_lines"."vat")
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"doc_no" text,
	"party_id" uuid NOT NULL,
	"doc_date" date NOT NULL,
	"valid_until" date,
	"delivery_date" date,
	"currency_code" text NOT NULL,
	"vat_included" boolean DEFAULT false NOT NULL,
	"warehouse_id" uuid,
	"notes" text,
	"quote_id" uuid,
	"net_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"gross_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "sales_orders_no_uq" UNIQUE("company_id","doc_no"),
	CONSTRAINT "sales_orders_kind_ck" CHECK ("sales_orders"."kind" in ('quote','order')),
	CONSTRAINT "sales_orders_status_ck" CHECK ("sales_orders"."status" in ('draft','sent','accepted','rejected','converted','confirmed','closed','cancelled')),
	CONSTRAINT "sales_orders_numbered_ck" CHECK ("sales_orders"."status" = 'draft' or "sales_orders"."status" = 'cancelled' or "sales_orders"."doc_no" is not null),
	CONSTRAINT "sales_orders_totals_ck" CHECK ("sales_orders"."net_total" >= 0 and "sales_orders"."vat_total" >= 0 and "sales_orders"."gross_total" = "sales_orders"."net_total" + "sales_orders"."vat_total")
);
--> statement-breakpoint
ALTER TABLE "delivery_notes" DROP CONSTRAINT "delivery_notes_type_ck";--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD COLUMN "source_line_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD COLUMN "sales_order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD COLUMN "return_of_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "sales_order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "batch_item_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_batch_items" ADD CONSTRAINT "invoice_batch_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_batch_items" ADD CONSTRAINT "invoice_batch_items_batch_fk" FOREIGN KEY ("batch_id","company_id") REFERENCES "public"."invoice_batches"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_batch_items" ADD CONSTRAINT "invoice_batch_items_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_batches" ADD CONSTRAINT "invoice_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_events" ADD CONSTRAINT "sales_order_events_order_fk" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."sales_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_fk" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."sales_orders"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_quote_line_fk" FOREIGN KEY ("quote_line_id","company_id") REFERENCES "public"."sales_order_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quote_fk" FOREIGN KEY ("quote_id","company_id") REFERENCES "public"."sales_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_batch_items_batch_idx" ON "invoice_batch_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "sales_order_events_order_idx" ON "sales_order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "sales_orders_kind_idx" ON "sales_orders" USING btree ("company_id","kind","doc_date");--> statement-breakpoint
CREATE INDEX "sales_orders_party_idx" ON "sales_orders" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_quote_uq" ON "sales_orders" USING btree ("company_id","quote_id") WHERE "sales_orders"."quote_id" is not null;--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_source_fk" FOREIGN KEY ("source_line_id","company_id") REFERENCES "public"."delivery_note_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_so_line_fk" FOREIGN KEY ("sales_order_line_id","company_id") REFERENCES "public"."sales_order_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_return_of_fk" FOREIGN KEY ("return_of_id","company_id") REFERENCES "public"."delivery_notes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_so_line_fk" FOREIGN KEY ("sales_order_line_id","company_id") REFERENCES "public"."sales_order_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_batch_item_fk" FOREIGN KEY ("batch_item_id","company_id") REFERENCES "public"."invoice_batch_items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_note_lines_source_idx" ON "delivery_note_lines" USING btree ("source_line_id") WHERE "delivery_note_lines"."source_line_id" is not null;--> statement-breakpoint
CREATE INDEX "delivery_note_lines_so_line_idx" ON "delivery_note_lines" USING btree ("sales_order_line_id") WHERE "delivery_note_lines"."sales_order_line_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_lines_so_line_idx" ON "invoice_lines" USING btree ("sales_order_line_id") WHERE "invoice_lines"."sales_order_line_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_lines_batch_item_idx" ON "invoice_lines" USING btree ("batch_item_id") WHERE "invoice_lines"."batch_item_id" is not null;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_type_ck" CHECK ("delivery_notes"."type" in ('sales','purchase','sales_return','purchase_return'));