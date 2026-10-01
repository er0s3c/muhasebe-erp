CREATE TABLE "subcontract_material_issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"issue_date" date NOT NULL,
	"stock_document_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_base" numeric(19, 4) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subcontract_material_issues_doc_uq" UNIQUE("stock_document_id"),
	CONSTRAINT "subcontract_material_issues_amount_ck" CHECK ("subcontract_material_issues"."amount" > 0 and "subcontract_material_issues"."amount_base" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_mappings" DROP CONSTRAINT "account_mappings_key_ck";--> statement-breakpoint
ALTER TABLE "construction_params" DROP CONSTRAINT "construction_params_kind_ck";--> statement-breakpoint
ALTER TABLE "progress_payments" DROP CONSTRAINT "progress_payments_amounts_ck";--> statement-breakpoint
ALTER TABLE "progress_payments" DROP CONSTRAINT "progress_payments_net_ck";--> statement-breakpoint
ALTER TABLE "progress_payments" ADD COLUMN "vat_withholding_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "progress_payments" ADD COLUMN "vat_withholding" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "progress_payments" ADD COLUMN "material" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "subcontracts" ADD COLUMN "vat_withholding_pct" numeric(7, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "subcontract_material_issues" ADD CONSTRAINT "subcontract_material_issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_material_issues" ADD CONSTRAINT "subcontract_material_issues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_material_issues" ADD CONSTRAINT "subcontract_material_issues_subcontract_fk" FOREIGN KEY ("subcontract_id","company_id") REFERENCES "public"."subcontracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_material_issues" ADD CONSTRAINT "subcontract_material_issues_doc_fk" FOREIGN KEY ("stock_document_id","company_id") REFERENCES "public"."stock_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subcontract_material_issues_sc_idx" ON "subcontract_material_issues" USING btree ("company_id","subcontract_id");--> statement-breakpoint
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_key_ck" CHECK ("account_mappings"."key" in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable'));--> statement-breakpoint
ALTER TABLE "construction_params" ADD CONSTRAINT "construction_params_kind_ck" CHECK ("construction_params"."kind" in ('retention_pct','withholding_pct','advance_recoup_pct','vat_withholding_pct'));--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_material_ck" CHECK ("progress_payments"."direction" = 'payable' or "progress_payments"."material" = 0);--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_amounts_ck" CHECK ("progress_payments"."gross" >= 0 and "progress_payments"."vat" >= 0 and "progress_payments"."vat_withholding" >= 0 and "progress_payments"."vat_withholding" <= "progress_payments"."vat" and "progress_payments"."retention" >= 0 and "progress_payments"."advance" >= 0 and "progress_payments"."withholding" >= 0 and "progress_payments"."material" >= 0 and "progress_payments"."other_deductions" >= 0 and "progress_payments"."net" >= 0);--> statement-breakpoint
ALTER TABLE "progress_payments" ADD CONSTRAINT "progress_payments_net_ck" CHECK ("progress_payments"."net" = "progress_payments"."gross" + "progress_payments"."vat" - "progress_payments"."vat_withholding" - "progress_payments"."retention" - "progress_payments"."advance" - "progress_payments"."withholding" - "progress_payments"."material" - "progress_payments"."other_deductions");