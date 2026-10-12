CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"activation_id" uuid,
	"customer_id" uuid,
	"customer_name" text NOT NULL,
	"request_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"company_id" uuid NOT NULL,
	"company_name" text NOT NULL,
	"company_sector" text NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reporter_name" text NOT NULL,
	"reporter_email" text NOT NULL,
	"page_path" text NOT NULL,
	"page_title" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"steps" text DEFAULT '' NOT NULL,
	"expected" text DEFAULT '' NOT NULL,
	"app_version" text NOT NULL,
	"screenshot_name" text,
	"screenshot_mime" text,
	"screenshot_size" integer,
	"screenshot_data" "bytea",
	"internal_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_status_ck" CHECK ("feedback"."status" in ('new','in_review','resolved')),
	CONSTRAINT "feedback_content_ck" CHECK (length(btrim("feedback"."message")) > 0 or "feedback"."screenshot_data" is not null),
	CONSTRAINT "feedback_screenshot_ck" CHECK (("feedback"."screenshot_data" is null and "feedback"."screenshot_name" is null and "feedback"."screenshot_mime" is null and "feedback"."screenshot_size" is null) or ("feedback"."screenshot_data" is not null and "feedback"."screenshot_name" is not null and "feedback"."screenshot_mime" is not null and "feedback"."screenshot_mime" in ('image/png','image/jpeg') and "feedback"."screenshot_size" is not null and "feedback"."screenshot_size" between 1 and 5242880 and octet_length("feedback"."screenshot_data") = "feedback"."screenshot_size"))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_activation_id_activations_id_fk" FOREIGN KEY ("activation_id") REFERENCES "public"."activations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_reference_uq" ON "feedback" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_installation_request_uq" ON "feedback" USING btree ("installation_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_installation_nonce_uq" ON "feedback" USING btree ("installation_id","nonce");--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "feedback_status_created_idx" ON "feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_customer_idx" ON "feedback" USING btree ("customer_id");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON feedback TO erp_app;
  END IF;
END $$;
