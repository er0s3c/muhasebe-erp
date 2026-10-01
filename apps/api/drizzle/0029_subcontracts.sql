CREATE TABLE "subcontract_boq_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"line_key" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_no" text,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"wbs_id" uuid NOT NULL,
	"cost_code_id" uuid,
	CONSTRAINT "subcontract_boq_lines_rev_key_uq" UNIQUE("revision_id","line_key"),
	CONSTRAINT "subcontract_boq_lines_rev_no_uq" UNIQUE("revision_id","line_no"),
	CONSTRAINT "subcontract_boq_lines_amount_ck" CHECK ("subcontract_boq_lines"."quantity" > 0 and "subcontract_boq_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subcontract_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subcontract_revisions_no_uq" UNIQUE("subcontract_id","revision_no"),
	CONSTRAINT "subcontract_revisions_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "subcontract_revisions_status_ck" CHECK ("subcontract_revisions"."status" in ('draft','approved','superseded')),
	CONSTRAINT "subcontract_revisions_approved_ck" CHECK (("subcontract_revisions"."status" = 'draft' and "subcontract_revisions"."approved_at" is null) or ("subcontract_revisions"."status" <> 'draft' and "subcontract_revisions"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "subcontracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"title" text NOT NULL,
	"currency_code" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"payment_days" integer DEFAULT 30 NOT NULL,
	"retention_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"advance_recoup_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"withholding_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"penalty_note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subcontracts_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "subcontracts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "subcontracts_id_project_uq" UNIQUE("id","project_id"),
	CONSTRAINT "subcontracts_status_ck" CHECK ("subcontracts"."status" in ('draft','active','completed','terminated')),
	CONSTRAINT "subcontracts_dates_ck" CHECK ("subcontracts"."start_date" is null or "subcontracts"."end_date" is null or "subcontracts"."end_date" >= "subcontracts"."start_date"),
	CONSTRAINT "subcontracts_days_ck" CHECK ("subcontracts"."payment_days" between 0 and 365),
	CONSTRAINT "subcontracts_pct_ck" CHECK ("subcontracts"."retention_pct" between 0 and 100 and "subcontracts"."advance_recoup_pct" between 0 and 100 and "subcontracts"."withholding_pct" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "subcontract_boq_lines" ADD CONSTRAINT "subcontract_boq_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_boq_lines" ADD CONSTRAINT "subcontract_boq_lines_revision_fk" FOREIGN KEY ("revision_id","company_id") REFERENCES "public"."subcontract_revisions"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_boq_lines" ADD CONSTRAINT "subcontract_boq_lines_subcontract_fk" FOREIGN KEY ("subcontract_id","project_id") REFERENCES "public"."subcontracts"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_boq_lines" ADD CONSTRAINT "subcontract_boq_lines_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_boq_lines" ADD CONSTRAINT "subcontract_boq_lines_cost_code_fk" FOREIGN KEY ("cost_code_id","company_id") REFERENCES "public"."cost_codes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_revisions" ADD CONSTRAINT "subcontract_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_revisions" ADD CONSTRAINT "subcontract_revisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_revisions" ADD CONSTRAINT "subcontract_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontract_revisions" ADD CONSTRAINT "subcontract_revisions_subcontract_fk" FOREIGN KEY ("subcontract_id","company_id") REFERENCES "public"."subcontracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subcontracts" ADD CONSTRAINT "subcontracts_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subcontract_boq_lines_sub_idx" ON "subcontract_boq_lines" USING btree ("subcontract_id","line_key");--> statement-breakpoint
CREATE INDEX "subcontract_boq_lines_wbs_idx" ON "subcontract_boq_lines" USING btree ("wbs_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subcontract_revisions_draft_uq" ON "subcontract_revisions" USING btree ("subcontract_id") WHERE "subcontract_revisions"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "subcontracts_project_idx" ON "subcontracts" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "subcontracts_party_idx" ON "subcontracts" USING btree ("company_id","party_id");