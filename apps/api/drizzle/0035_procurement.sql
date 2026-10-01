CREATE TABLE "po_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	CONSTRAINT "po_receipt_lines_uq" UNIQUE("receipt_id","order_line_id"),
	CONSTRAINT "po_receipt_lines_qty_ck" CHECK ("po_receipt_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "po_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"receipt_no" text NOT NULL,
	"receipt_date" date NOT NULL,
	"delivery_note_id" uuid,
	"note" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "po_receipts_no_uq" UNIQUE("company_id","receipt_no"),
	CONSTRAINT "po_receipts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "po_receipts_status_ck" CHECK ("po_receipts"."status" in ('posted','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"request_line_id" uuid,
	"item_id" uuid,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"wbs_id" uuid,
	CONSTRAINT "purchase_order_lines_no_uq" UNIQUE("order_id","line_no"),
	CONSTRAINT "purchase_order_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "purchase_order_lines_amount_ck" CHECK ("purchase_order_lines"."quantity" > 0 and "purchase_order_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"request_id" uuid,
	"offer_id" uuid,
	"currency_code" text NOT NULL,
	"vat_code" text,
	"vat_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"payment_days" integer DEFAULT 30 NOT NULL,
	"delivery_location" text,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"issued_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "purchase_orders_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "purchase_orders_id_project_uq" UNIQUE("id","project_id"),
	CONSTRAINT "purchase_orders_status_ck" CHECK ("purchase_orders"."status" in ('draft','issued','closed','cancelled')),
	CONSTRAINT "purchase_orders_terms_ck" CHECK ("purchase_orders"."payment_days" between 0 and 365 and "purchase_orders"."vat_rate" between 0 and 100),
	CONSTRAINT "purchase_orders_issued_ck" CHECK (("purchase_orders"."status" in ('issued','closed')) = ("purchase_orders"."issued_at" is not null) or "purchase_orders"."status" = 'cancelled')
);
--> statement-breakpoint
CREATE TABLE "purchase_request_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_id" uuid,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"est_unit_price" numeric(19, 4),
	"wbs_id" uuid,
	CONSTRAINT "purchase_request_lines_no_uq" UNIQUE("request_id","line_no"),
	CONSTRAINT "purchase_request_lines_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "purchase_request_lines_qty_ck" CHECK ("purchase_request_lines"."quantity" > 0 and ("purchase_request_lines"."est_unit_price" is null or "purchase_request_lines"."est_unit_price" >= 0))
);
--> statement-breakpoint
CREATE TABLE "purchase_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"need_date" date,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"rejection_note" text,
	"requested_by" uuid,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_requests_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "purchase_requests_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "purchase_requests_id_project_uq" UNIQUE("id","project_id"),
	CONSTRAINT "purchase_requests_status_ck" CHECK ("purchase_requests"."status" in ('draft','submitted','approved','rejected','ordered','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "rfq_offer_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"request_line_id" uuid NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	CONSTRAINT "rfq_offer_lines_uq" UNIQUE("offer_id","request_line_id"),
	CONSTRAINT "rfq_offer_lines_price_ck" CHECK ("rfq_offer_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rfq_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"delivery_days" integer,
	"payment_days" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_offers_party_uq" UNIQUE("rfq_id","party_id"),
	CONSTRAINT "rfq_offers_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "rfq_offers_terms_ck" CHECK ("rfq_offers"."payment_days" between 0 and 365 and ("rfq_offers"."delivery_days" is null or "rfq_offers"."delivery_days" >= 0))
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_date" date,
	"note" text,
	"awarded_offer_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfqs_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "rfqs_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "rfqs_status_ck" CHECK ("rfqs"."status" in ('open','awarded','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "approval_rules" DROP CONSTRAINT "approval_rules_doc_type_ck";--> statement-breakpoint
ALTER TABLE "po_receipt_lines" ADD CONSTRAINT "po_receipt_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipt_lines" ADD CONSTRAINT "po_receipt_lines_receipt_fk" FOREIGN KEY ("receipt_id","company_id") REFERENCES "public"."po_receipts"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipt_lines" ADD CONSTRAINT "po_receipt_lines_line_fk" FOREIGN KEY ("order_line_id","company_id") REFERENCES "public"."purchase_order_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_order_fk" FOREIGN KEY ("order_id","company_id") REFERENCES "public"."purchase_orders"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_note_fk" FOREIGN KEY ("delivery_note_id","company_id") REFERENCES "public"."delivery_notes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_fk" FOREIGN KEY ("order_id","project_id") REFERENCES "public"."purchase_orders"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_request_line_fk" FOREIGN KEY ("request_line_id","company_id") REFERENCES "public"."purchase_request_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_request_fk" FOREIGN KEY ("request_id","company_id") REFERENCES "public"."purchase_requests"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_offer_fk" FOREIGN KEY ("offer_id","company_id") REFERENCES "public"."rfq_offers"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_request_fk" FOREIGN KEY ("request_id","project_id") REFERENCES "public"."purchase_requests"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_item_fk" FOREIGN KEY ("item_id","company_id") REFERENCES "public"."items"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_offer_lines" ADD CONSTRAINT "rfq_offer_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_offer_lines" ADD CONSTRAINT "rfq_offer_lines_offer_fk" FOREIGN KEY ("offer_id","company_id") REFERENCES "public"."rfq_offers"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_offer_lines" ADD CONSTRAINT "rfq_offer_lines_line_fk" FOREIGN KEY ("request_line_id","company_id") REFERENCES "public"."purchase_request_lines"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_offers" ADD CONSTRAINT "rfq_offers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_offers" ADD CONSTRAINT "rfq_offers_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_offers" ADD CONSTRAINT "rfq_offers_rfq_fk" FOREIGN KEY ("rfq_id","company_id") REFERENCES "public"."rfqs"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_offers" ADD CONSTRAINT "rfq_offers_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_request_fk" FOREIGN KEY ("request_id","company_id") REFERENCES "public"."purchase_requests"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "po_receipt_lines_line_idx" ON "po_receipt_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "po_receipts_order_idx" ON "po_receipts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_wbs_idx" ON "purchase_order_lines" USING btree ("wbs_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_project_idx" ON "purchase_orders" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_party_idx" ON "purchase_orders" USING btree ("company_id","party_id");--> statement-breakpoint
CREATE INDEX "purchase_requests_project_idx" ON "purchase_requests" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rfqs_request_open_uq" ON "rfqs" USING btree ("request_id") WHERE "rfqs"."status" <> 'cancelled';--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_doc_type_ck" CHECK ("approval_rules"."doc_type" in ('progress_payment','employer_claim','purchase_request'));