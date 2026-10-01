CREATE TABLE "variation_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"revision_id" uuid,
	"base_revision_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"description" text,
	"time_extension_days" integer DEFAULT 0 NOT NULL,
	"previous_end_date" date,
	"new_end_date" date,
	"amount_before" numeric(19, 4),
	"amount_after" numeric(19, 4),
	"amount_delta" numeric(19, 4),
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"approved_at" timestamp with time zone,
	"client_accepted_at" date,
	"client_reference" text,
	"applied_at" timestamp with time zone,
	"rejection_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variation_orders_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "variation_orders_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "variation_orders_status_ck" CHECK ("variation_orders"."status" in ('draft','submitted','awaiting_client','applied','rejected','cancelled')),
	CONSTRAINT "variation_orders_reason_ck" CHECK ("variation_orders"."reason" in ('client_request','design_change','site_condition','omission_error','other')),
	CONSTRAINT "variation_orders_direction_ck" CHECK ("variation_orders"."direction" in ('payable','receivable')),
	CONSTRAINT "variation_orders_days_ck" CHECK ("variation_orders"."time_extension_days" between 0 and 3650)
);
--> statement-breakpoint
ALTER TABLE "approval_rules" DROP CONSTRAINT "approval_rules_doc_type_ck";--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_revision_id_subcontract_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."subcontract_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_subcontract_fk" FOREIGN KEY ("subcontract_id","project_id") REFERENCES "public"."subcontracts"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variation_orders" ADD CONSTRAINT "variation_orders_base_revision_fk" FOREIGN KEY ("base_revision_id","company_id") REFERENCES "public"."subcontract_revisions"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "variation_orders_revision_uq" ON "variation_orders" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "variation_orders_subcontract_idx" ON "variation_orders" USING btree ("subcontract_id","status");--> statement-breakpoint
CREATE INDEX "variation_orders_project_idx" ON "variation_orders" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_doc_type_ck" CHECK ("approval_rules"."doc_type" in ('progress_payment','employer_claim','purchase_request','variation_order'));