CREATE TABLE "document_line_serials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_line_id" uuid,
	"invoice_line_id" uuid,
	"serial_no" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_line_serials_one_ck" CHECK (("document_line_serials"."delivery_line_id" is null) <> ("document_line_serials"."invoice_line_id" is null))
);
--> statement-breakpoint
CREATE TABLE "item_serials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"serial_no" text NOT NULL,
	"status" text NOT NULL,
	"warehouse_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_serials_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "item_serials_status_ck" CHECK ("item_serials"."status" in ('pending','in_stock','issued','returned','scrapped','void')),
	CONSTRAINT "item_serials_warehouse_ck" CHECK (("item_serials"."status" = 'in_stock') = ("item_serials"."warehouse_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "party_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"currency_code" text,
	"price" numeric(19, 6),
	"discount_pct" numeric(7, 4),
	"min_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_prices_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "party_prices_kind_ck" CHECK ("party_prices"."kind" in ('sales','purchase')),
	CONSTRAINT "party_prices_ck" CHECK (("party_prices"."price" is not null or "party_prices"."discount_pct" is not null) and ("party_prices"."price" is null or "party_prices"."currency_code" is not null) and "party_prices"."price" >= 0 and "party_prices"."discount_pct" between 0 and 100 and "party_prices"."min_qty" >= 0 and ("party_prices"."valid_to" is null or "party_prices"."valid_from" is null or "party_prices"."valid_to" >= "party_prices"."valid_from"))
);
--> statement-breakpoint
CREATE TABLE "price_list_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"min_qty" numeric(19, 4) DEFAULT '0' NOT NULL,
	"price" numeric(19, 6) NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_items_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "price_list_items_ck" CHECK ("price_list_items"."price" >= 0 and "price_list_items"."min_qty" >= 0 and ("price_list_items"."valid_to" is null or "price_list_items"."valid_from" is null or "price_list_items"."valid_to" >= "price_list_items"."valid_from"))
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"currency_code" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "price_lists_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "price_lists_kind_ck" CHECK ("price_lists"."kind" in ('sales','purchase')),
	CONSTRAINT "price_lists_valid_ck" CHECK ("price_lists"."valid_to" is null or "price_lists"."valid_from" is null or "price_lists"."valid_to" >= "price_lists"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "serial_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"serial_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"from_warehouse_id" uuid,
	"to_warehouse_id" uuid,
	"stock_document_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"party_id" uuid,
	"reversal_of_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serial_events_seq_uq" UNIQUE("seq"),
	CONSTRAINT "serial_events_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "serial_events_event_ck" CHECK ("serial_events"."event" in ('receive','issue','return_in','return_out','scrap','transfer','reversal')),
	CONSTRAINT "serial_events_reversal_ck" CHECK (("serial_events"."event" = 'reversal') = ("serial_events"."reversal_of_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "tracks_serial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "sales_price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "purchase_price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "sales_discount_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "purchase_discount_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_line_serials" ADD CONSTRAINT "document_line_serials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_serials" ADD CONSTRAINT "document_line_serials_delivery_fk" FOREIGN KEY ("delivery_line_id","company_id") REFERENCES "public"."delivery_note_lines"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_line_serials" ADD CONSTRAINT "document_line_serials_invoice_fk" FOREIGN KEY ("invoice_line_id","company_id") REFERENCES "public"."invoice_lines"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_serials" ADD CONSTRAINT "item_serials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_serials" ADD CONSTRAINT "item_serials_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_serials" ADD CONSTRAINT "item_serials_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_prices" ADD CONSTRAINT "party_prices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_prices" ADD CONSTRAINT "party_prices_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_prices" ADD CONSTRAINT "party_prices_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_prices" ADD CONSTRAINT "party_prices_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_list_fk" FOREIGN KEY ("price_list_id","company_id") REFERENCES "public"."price_lists"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_items" ADD CONSTRAINT "price_list_items_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_events" ADD CONSTRAINT "serial_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_events" ADD CONSTRAINT "serial_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_events" ADD CONSTRAINT "serial_events_serial_fk" FOREIGN KEY ("serial_id","company_id") REFERENCES "public"."item_serials"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_events" ADD CONSTRAINT "serial_events_doc_fk" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_events" ADD CONSTRAINT "serial_events_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_events" ADD CONSTRAINT "serial_events_reversal_fk" FOREIGN KEY ("reversal_of_id","company_id") REFERENCES "public"."serial_events"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_line_serials_delivery_uq" ON "document_line_serials" USING btree ("delivery_line_id","serial_no") WHERE "document_line_serials"."delivery_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "document_line_serials_invoice_uq" ON "document_line_serials" USING btree ("invoice_line_id","serial_no") WHERE "document_line_serials"."invoice_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "item_serials_no_uq" ON "item_serials" USING btree ("company_id","item_id","serial_no") WHERE "item_serials"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "item_serials_status_idx" ON "item_serials" USING btree ("company_id","item_id","status");--> statement-breakpoint
CREATE INDEX "party_prices_lookup_idx" ON "party_prices" USING btree ("party_id","item_id","kind");--> statement-breakpoint
CREATE INDEX "price_list_items_lookup_idx" ON "price_list_items" USING btree ("price_list_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_default_uq" ON "price_lists" USING btree ("company_id","kind") WHERE "price_lists"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "serial_events_reversal_uq" ON "serial_events" USING btree ("reversal_of_id") WHERE "serial_events"."reversal_of_id" is not null;--> statement-breakpoint
CREATE INDEX "serial_events_serial_idx" ON "serial_events" USING btree ("serial_id","seq");--> statement-breakpoint
CREATE INDEX "serial_events_doc_idx" ON "serial_events" USING btree ("stock_document_id","line_no");--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_sales_list_fk" FOREIGN KEY ("sales_price_list_id","company_id") REFERENCES "public"."price_lists"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_purchase_list_fk" FOREIGN KEY ("purchase_price_list_id","company_id") REFERENCES "public"."price_lists"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_discount_ck" CHECK ("parties"."sales_discount_pct" between 0 and 100 and "parties"."purchase_discount_pct" between 0 and 100);