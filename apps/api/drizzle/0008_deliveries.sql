CREATE TABLE "delivery_note_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit" text,
	"unit_cost" numeric(19, 6),
	"currency_code" text,
	"fx_rate" numeric(19, 8),
	"stock_value" numeric(19, 4),
	"adjust_value" numeric(19, 4),
	CONSTRAINT "delivery_note_lines_uq" UNIQUE("note_id","line_no"),
	CONSTRAINT "delivery_note_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "delivery_note_lines_amounts_ck" CHECK ("delivery_note_lines"."quantity" > 0 and ("delivery_note_lines"."unit_cost" is null or "delivery_note_lines"."unit_cost" >= 0) and ("delivery_note_lines"."stock_value" is null or "delivery_note_lines"."stock_value" >= 0))
);
--> statement-breakpoint
CREATE TABLE "delivery_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note_no" text,
	"external_no" text,
	"note_date" date NOT NULL,
	"party_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"vehicle_plate" text,
	"driver_name" text,
	"description" text,
	"stock_document_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"cancel_stock_document_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_notes_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "delivery_notes_no_uq" UNIQUE("company_id","note_no"),
	CONSTRAINT "delivery_notes_type_ck" CHECK ("delivery_notes"."type" in ('sales','purchase')),
	CONSTRAINT "delivery_notes_status_ck" CHECK ("delivery_notes"."status" in ('draft','posted','cancelled')),
	CONSTRAINT "delivery_notes_posted_ck" CHECK ("delivery_notes"."status" = 'draft' or ("delivery_notes"."note_no" is not null and "delivery_notes"."posted_at" is not null and "delivery_notes"."stock_document_id" is not null)),
	CONSTRAINT "delivery_notes_cancelled_ck" CHECK ("delivery_notes"."status" <> 'cancelled' or ("delivery_notes"."cancelled_at" is not null and "delivery_notes"."cancel_reason" is not null and "delivery_notes"."cancel_stock_document_id" is not null))
);
--> statement-breakpoint
DROP INDEX "invoices_external_no_uq";--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "delivery_line_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "delivery_value" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "delivery_adjust" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_note_fk" FOREIGN KEY ("note_id","company_id") REFERENCES "public"."delivery_notes"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_warehouse_fk" FOREIGN KEY ("warehouse_id","company_id") REFERENCES "public"."warehouses"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_stock_document_fk" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_cancel_stock_document_fk" FOREIGN KEY ("cancel_stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_note_lines_item_idx" ON "delivery_note_lines" USING btree ("company_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_notes_external_no_uq" ON "delivery_notes" USING btree ("company_id","party_id","external_no") WHERE "delivery_notes"."external_no" is not null and "delivery_notes"."status" = 'posted';--> statement-breakpoint
CREATE INDEX "delivery_notes_date_idx" ON "delivery_notes" USING btree ("company_id","type","note_date");--> statement-breakpoint
CREATE INDEX "delivery_notes_party_idx" ON "delivery_notes" USING btree ("company_id","party_id");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_delivery_fk" FOREIGN KEY ("delivery_line_id","company_id") REFERENCES "public"."delivery_note_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_delivery_idx" ON "invoice_lines" USING btree ("delivery_line_id") WHERE "invoice_lines"."delivery_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_external_no_uq" ON "invoices" USING btree ("company_id","party_id","external_no") WHERE "invoices"."external_no" is not null and "invoices"."status" = 'posted';--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_link_ck" CHECK ("invoice_lines"."delivery_line_id" is null or "invoice_lines"."source_line_id" is null);