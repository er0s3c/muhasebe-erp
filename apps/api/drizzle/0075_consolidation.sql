CREATE TABLE "consolidation_elimination_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"elimination_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_code" text NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	CONSTRAINT "consolidation_elimination_lines_uq" UNIQUE("elimination_id","line_no"),
	CONSTRAINT "consolidation_elimination_lines_amount_ck" CHECK ("consolidation_elimination_lines"."debit" >= 0 and "consolidation_elimination_lines"."credit" >= 0 and ("consolidation_elimination_lines"."debit" > 0) <> ("consolidation_elimination_lines"."credit" > 0)),
	CONSTRAINT "consolidation_elimination_lines_code_ck" CHECK ("consolidation_elimination_lines"."account_code" ~ '^[0-9][0-9A-Za-z.]{0,19}$')
);
--> statement-breakpoint
CREATE TABLE "consolidation_eliminations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"kind" text DEFAULT 'intercompany_balance' NOT NULL,
	"description" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "consolidation_eliminations_kind_ck" CHECK ("consolidation_eliminations"."kind" in ('intercompany_balance','intercompany_sales','other')),
	CONSTRAINT "consolidation_eliminations_period_ck" CHECK ("consolidation_eliminations"."period_from" <= "consolidation_eliminations"."period_to"),
	CONSTRAINT "consolidation_eliminations_desc_ck" CHECK (length(btrim("consolidation_eliminations"."description")) >= 2),
	CONSTRAINT "consolidation_eliminations_void_ck" CHECK (("consolidation_eliminations"."voided_at" is null) = ("consolidation_eliminations"."voided_by" is null) and ("consolidation_eliminations"."voided_at" is null) = ("consolidation_eliminations"."void_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "consolidation_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"reporting_currency" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consolidation_groups_name_uq" UNIQUE("owner_user_id","name"),
	CONSTRAINT "consolidation_groups_name_ck" CHECK (length(btrim("consolidation_groups"."name")) >= 2)
);
--> statement-breakpoint
CREATE TABLE "consolidation_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"member_company_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consolidation_members_uq" UNIQUE("group_id","member_company_id")
);
--> statement-breakpoint
ALTER TABLE "consolidation_elimination_lines" ADD CONSTRAINT "consolidation_elimination_lines_elimination_id_consolidation_eliminations_id_fk" FOREIGN KEY ("elimination_id") REFERENCES "public"."consolidation_eliminations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_elimination_lines" ADD CONSTRAINT "consolidation_elimination_lines_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_eliminations" ADD CONSTRAINT "consolidation_eliminations_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_eliminations" ADD CONSTRAINT "consolidation_eliminations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_eliminations" ADD CONSTRAINT "consolidation_eliminations_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_reporting_currency_currencies_code_fk" FOREIGN KEY ("reporting_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_members" ADD CONSTRAINT "consolidation_members_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_members" ADD CONSTRAINT "consolidation_members_member_company_id_companies_id_fk" FOREIGN KEY ("member_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consolidation_eliminations_group_idx" ON "consolidation_eliminations" USING btree ("group_id","period_from","period_to");--> statement-breakpoint
CREATE INDEX "consolidation_members_company_idx" ON "consolidation_members" USING btree ("member_company_id");