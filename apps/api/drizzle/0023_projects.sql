CREATE TABLE "project_budget_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_id" uuid NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	CONSTRAINT "project_budget_lines_uq" UNIQUE("budget_id","wbs_id"),
	CONSTRAINT "project_budget_lines_amount_ck" CHECK ("project_budget_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_budgets_revision_uq" UNIQUE("project_id","revision_no"),
	CONSTRAINT "project_budgets_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "project_budgets_id_project_uq" UNIQUE("id","project_id"),
	CONSTRAINT "project_budgets_status_ck" CHECK ("project_budgets"."status" in ('draft','approved','superseded')),
	CONSTRAINT "project_budgets_approved_ck" CHECK (("project_budgets"."status" = 'draft' and "project_budgets"."approved_at" is null) or ("project_budgets"."status" <> 'draft' and "project_budgets"."approved_at" is not null)),
	CONSTRAINT "project_budgets_rev_ck" CHECK ("project_budgets"."revision_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"wbs_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"percent" numeric(5, 2) NOT NULL,
	"etc_override" numeric(19, 2),
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_progress_percent_ck" CHECK ("project_progress"."percent" between 0 and 100),
	CONSTRAINT "project_progress_etc_ck" CHECK ("project_progress"."etc_override" is null or "project_progress"."etc_override" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_wbs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_wbs_project_code_uq" UNIQUE("project_id","code"),
	CONSTRAINT "project_wbs_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "project_wbs_id_project_uq" UNIQUE("id","project_id"),
	CONSTRAINT "project_wbs_parent_ck" CHECK ("project_wbs"."parent_id" is null or "project_wbs"."parent_id" <> "project_wbs"."id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'own' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"client_party_id" uuid,
	"start_date" date,
	"end_date" date,
	"location" text,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "projects_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "projects_kind_ck" CHECK ("projects"."kind" in ('own','contract')),
	CONSTRAINT "projects_status_ck" CHECK ("projects"."status" in ('planned','active','on_hold','completed','cancelled')),
	CONSTRAINT "projects_client_ck" CHECK (("projects"."kind" = 'contract' and "projects"."client_party_id" is not null) or ("projects"."kind" = 'own' and "projects"."client_party_id" is null)),
	CONSTRAINT "projects_dates_ck" CHECK ("projects"."start_date" is null or "projects"."end_date" is null or "projects"."end_date" >= "projects"."start_date")
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "wbs_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "wbs_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "wbs_id" uuid;--> statement-breakpoint
ALTER TABLE "project_budget_lines" ADD CONSTRAINT "project_budget_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_lines" ADD CONSTRAINT "project_budget_lines_budget_fk" FOREIGN KEY ("budget_id","project_id") REFERENCES "public"."project_budgets"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_lines" ADD CONSTRAINT "project_budget_lines_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_lines" ADD CONSTRAINT "project_budget_lines_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_parent_fk" FOREIGN KEY ("parent_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_fk" FOREIGN KEY ("client_party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_budget_lines_wbs_idx" ON "project_budget_lines" USING btree ("wbs_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_budgets_draft_uq" ON "project_budgets" USING btree ("project_id") WHERE "project_budgets"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "project_progress_wbs_idx" ON "project_progress" USING btree ("wbs_id","as_of_date","created_at");--> statement-breakpoint
CREATE INDEX "project_wbs_parent_idx" ON "project_wbs" USING btree ("project_id","parent_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_wbs_fk" FOREIGN KEY ("wbs_id","project_id") REFERENCES "public"."project_wbs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_project_idx" ON "invoice_lines" USING btree ("project_id","wbs_id") WHERE "invoice_lines"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "invoice_lines_wbs_idx" ON "invoice_lines" USING btree ("wbs_id") WHERE "invoice_lines"."wbs_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_project_idx" ON "journal_lines" USING btree ("company_id","project_id","wbs_id") WHERE "journal_lines"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_wbs_idx" ON "journal_lines" USING btree ("wbs_id") WHERE "journal_lines"."wbs_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_project_idx" ON "stock_movements" USING btree ("project_id","wbs_id") WHERE "stock_movements"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_wbs_idx" ON "stock_movements" USING btree ("wbs_id") WHERE "stock_movements"."wbs_id" is not null;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_wbs_ck" CHECK ("invoice_lines"."wbs_id" is null or "invoice_lines"."project_id" is not null);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_wbs_ck" CHECK ("journal_lines"."wbs_id" is null or "journal_lines"."project_id" is not null);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_wbs_ck" CHECK ("stock_movements"."wbs_id" is null or "stock_movements"."project_id" is not null);