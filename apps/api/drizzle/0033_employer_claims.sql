ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "approval_rules" DROP CONSTRAINT "approval_rules_doc_type_ck";--> statement-breakpoint
ALTER TABLE "progress_payments" ADD COLUMN "direction" text DEFAULT 'payable' NOT NULL;--> statement-breakpoint
ALTER TABLE "subcontracts" ADD COLUMN "direction" text DEFAULT 'payable' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subcontracts_employer_uq" ON "subcontracts" USING btree ("project_id") WHERE "subcontracts"."direction" = 'receivable' and "subcontracts"."status" <> 'terminated';--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable'));--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_doc_type_ck" CHECK ("approval_rules"."doc_type" in ('progress_payment','employer_claim'));--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_direction_ck" CHECK ("progress_payments"."direction" in ('payable','receivable'));--> statement-breakpoint
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_direction_ck" CHECK ("subcontracts"."direction" in ('payable','receivable'));