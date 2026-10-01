CREATE TABLE "procurement_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"qty_tolerance_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"price_tolerance_pct" numeric(7, 4) DEFAULT '2' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_settings_ck" CHECK ("procurement_settings"."qty_tolerance_pct" between 0 and 100 and "procurement_settings"."price_tolerance_pct" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "po_line_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "match_override_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "match_override_by" uuid;--> statement-breakpoint
ALTER TABLE "procurement_settings" ADD CONSTRAINT "procurement_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_po_line_fk" FOREIGN KEY ("po_line_id","company_id") REFERENCES "public"."purchase_order_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_match_override_by_users_id_fk" FOREIGN KEY ("match_override_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_po_line_idx" ON "invoice_lines" USING btree ("po_line_id");