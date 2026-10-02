CREATE TABLE "foreign_doc_renewals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"prev_issue_date" date,
	"prev_expiry_date" date,
	"prev_number_last4" text,
	"new_issue_date" date,
	"new_expiry_date" date,
	"new_number_last4" text,
	"note" text,
	"renewed_by" uuid,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foreign_doc_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foreign_doc_types_uq" UNIQUE("company_id","code"),
	CONSTRAINT "foreign_doc_types_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "foreign_worker_docs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"number_enc" text,
	"number_last4" text,
	"issuing_authority" text,
	"issue_date" date,
	"expiry_date" date,
	"reference_note" text,
	"note" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foreign_worker_docs_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "foreign_worker_docs_dates_ck" CHECK ("foreign_worker_docs"."expiry_date" is null or "foreign_worker_docs"."issue_date" is null or "foreign_worker_docs"."expiry_date" >= "foreign_worker_docs"."issue_date"),
	CONSTRAINT "foreign_worker_docs_revoke_ck" CHECK (("foreign_worker_docs"."revoked_at" is null) = ("foreign_worker_docs"."revoke_reason" is null) and ("foreign_worker_docs"."revoked_at" is null) = ("foreign_worker_docs"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "foreign_worker_guarantees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"doc_id" uuid,
	"param_id" uuid NOT NULL,
	"project_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"param_verified" boolean DEFAULT false NOT NULL,
	"deposited_date" date NOT NULL,
	"deposit_reference" text,
	"status" text DEFAULT 'held' NOT NULL,
	"resolved_date" date,
	"resolution_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foreign_worker_guarantees_status_ck" CHECK ("foreign_worker_guarantees"."status" in ('held','refunded','forfeited')),
	CONSTRAINT "foreign_worker_guarantees_amount_ck" CHECK ("foreign_worker_guarantees"."amount" > 0 and "foreign_worker_guarantees"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "foreign_worker_guarantees_resolved_ck" CHECK (("foreign_worker_guarantees"."status" = 'held') = ("foreign_worker_guarantees"."resolved_date" is null) and ("foreign_worker_guarantees"."resolved_date" is null or "foreign_worker_guarantees"."resolved_date" >= "foreign_worker_guarantees"."deposited_date"))
);
--> statement-breakpoint
CREATE TABLE "foreign_worker_params" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" numeric(19, 4) NOT NULL,
	"currency" text,
	"effective_from" date NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"source_note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foreign_worker_params_uq" UNIQUE("company_id","key","effective_from"),
	CONSTRAINT "foreign_worker_params_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "foreign_worker_params_key_ck" CHECK ("foreign_worker_params"."key" in ('guarantee_amount','expiry_warning_days')),
	CONSTRAINT "foreign_worker_params_value_ck" CHECK ("foreign_worker_params"."value" >= 0 and ("foreign_worker_params"."key" <> 'expiry_warning_days' or ("foreign_worker_params"."value" = trunc("foreign_worker_params"."value") and "foreign_worker_params"."value" <= 3650))),
	CONSTRAINT "foreign_worker_params_currency_ck" CHECK (("foreign_worker_params"."key" = 'guarantee_amount' and "foreign_worker_params"."currency" is not null and "foreign_worker_params"."currency" ~ '^[A-Z]{3}$') or ("foreign_worker_params"."key" <> 'guarantee_amount' and "foreign_worker_params"."currency" is null))
);
--> statement-breakpoint
ALTER TABLE "personal_data_access_log" DROP CONSTRAINT "personal_data_access_log_field_ck";--> statement-breakpoint
ALTER TABLE "foreign_doc_renewals" ADD CONSTRAINT "foreign_doc_renewals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_doc_renewals" ADD CONSTRAINT "foreign_doc_renewals_renewed_by_users_id_fk" FOREIGN KEY ("renewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_doc_renewals" ADD CONSTRAINT "foreign_doc_renewals_doc_fk" FOREIGN KEY ("doc_id","company_id") REFERENCES "public"."foreign_worker_docs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_doc_types" ADD CONSTRAINT "foreign_doc_types_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_docs" ADD CONSTRAINT "foreign_worker_docs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_docs" ADD CONSTRAINT "foreign_worker_docs_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_docs" ADD CONSTRAINT "foreign_worker_docs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_docs" ADD CONSTRAINT "foreign_worker_docs_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_docs" ADD CONSTRAINT "foreign_worker_docs_type_fk" FOREIGN KEY ("type_id","company_id") REFERENCES "public"."foreign_doc_types"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_guarantees" ADD CONSTRAINT "foreign_worker_guarantees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_guarantees" ADD CONSTRAINT "foreign_worker_guarantees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_guarantees" ADD CONSTRAINT "foreign_worker_guarantees_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_guarantees" ADD CONSTRAINT "foreign_worker_guarantees_doc_fk" FOREIGN KEY ("doc_id","company_id") REFERENCES "public"."foreign_worker_docs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_guarantees" ADD CONSTRAINT "foreign_worker_guarantees_param_fk" FOREIGN KEY ("param_id","company_id") REFERENCES "public"."foreign_worker_params"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_guarantees" ADD CONSTRAINT "foreign_worker_guarantees_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_params" ADD CONSTRAINT "foreign_worker_params_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "foreign_worker_params" ADD CONSTRAINT "foreign_worker_params_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "foreign_doc_renewals_doc_idx" ON "foreign_doc_renewals" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "foreign_worker_docs_emp_idx" ON "foreign_worker_docs" USING btree ("company_id","employee_id");--> statement-breakpoint
CREATE INDEX "foreign_worker_docs_expiry_idx" ON "foreign_worker_docs" USING btree ("company_id","expiry_date");--> statement-breakpoint
CREATE INDEX "foreign_worker_guarantees_emp_idx" ON "foreign_worker_guarantees" USING btree ("company_id","employee_id");--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_field_ck" CHECK ("personal_data_access_log"."field" in ('id_number','birth_date','iban','export','payroll','social_security_no','social_security','foreign_doc_no','foreign_docs'));