CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"project_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"separate_requester" boolean DEFAULT true NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "approval_requests_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "approval_requests_status_ck" CHECK ("approval_requests"."status" in ('pending','approved','rejected','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "approval_rule_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"step_no" integer NOT NULL,
	"approver_role" text,
	"approver_user_id" uuid,
	"label" text,
	CONSTRAINT "approval_rule_steps_uq" UNIQUE("rule_id","step_no"),
	CONSTRAINT "approval_rule_steps_no_ck" CHECK ("approval_rule_steps"."step_no" >= 1),
	CONSTRAINT "approval_rule_steps_approver_ck" CHECK (("approval_rule_steps"."approver_role" is not null) <> ("approval_rule_steps"."approver_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "approval_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"project_id" uuid,
	"min_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"max_amount" numeric(19, 4),
	"separate_requester" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_rules_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "approval_rules_doc_type_ck" CHECK ("approval_rules"."doc_type" in ('progress_payment')),
	CONSTRAINT "approval_rules_range_ck" CHECK ("approval_rules"."min_amount" >= 0 and ("approval_rules"."max_amount" is null or "approval_rules"."max_amount" > "approval_rules"."min_amount"))
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"step_no" integer NOT NULL,
	"approver_role" text,
	"approver_user_id" uuid,
	"label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "approval_steps_uq" UNIQUE("request_id","step_no"),
	CONSTRAINT "approval_steps_status_ck" CHECK ("approval_steps"."status" in ('pending','approved','rejected')),
	CONSTRAINT "approval_steps_approver_ck" CHECK (not ("approval_steps"."approver_role" is not null and "approval_steps"."approver_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "construction_params" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" numeric(7, 4) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"source_note" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "construction_params_uq" UNIQUE("company_id","kind","valid_from"),
	CONSTRAINT "construction_params_kind_ck" CHECK ("construction_params"."kind" in ('retention_pct','withholding_pct','advance_recoup_pct')),
	CONSTRAINT "construction_params_value_ck" CHECK ("construction_params"."value" >= 0 and "construction_params"."value" <= 100),
	CONSTRAINT "construction_params_range_ck" CHECK ("construction_params"."valid_to" is null or "construction_params"."valid_to" >= "construction_params"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rule_steps" ADD CONSTRAINT "approval_rule_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rule_steps" ADD CONSTRAINT "approval_rule_steps_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rule_steps" ADD CONSTRAINT "approval_rule_steps_rule_fk" FOREIGN KEY ("rule_id","company_id") REFERENCES "public"."approval_rules"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_request_fk" FOREIGN KEY ("request_id","company_id") REFERENCES "public"."approval_requests"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_params" ADD CONSTRAINT "construction_params_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_pending_uq" ON "approval_requests" USING btree ("company_id","doc_type","doc_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("company_id","status");