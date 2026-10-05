CREATE TABLE "cash_scenarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"assumptions" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"project_id" uuid,
	"party_id" uuid,
	"owner_id" uuid NOT NULL,
	"event_date" date NOT NULL,
	"due_date" date NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_entries_kind_ck" CHECK ("operation_entries"."kind" in ('collection','site_report','schedule','equipment','equipment_log','defect')),
	CONSTRAINT "operation_entries_status_ck" CHECK ("operation_entries"."status" in ('open','done','cancelled')),
	CONSTRAINT "operation_entries_title_ck" CHECK (length(btrim("operation_entries"."title")) between 2 and 200),
	CONSTRAINT "operation_entries_version_ck" CHECK ("operation_entries"."version">0),
	CONSTRAINT "operation_entries_ref_ck" CHECK (("operation_entries"."kind"='collection' and "operation_entries"."party_id" is not null) or ("operation_entries"."kind"<>'collection' and "operation_entries"."project_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "portal_access_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"action" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "portal_links_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "record_document_content" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"record_kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"previous_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_documents_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "record_documents_previous_uq" UNIQUE("previous_id"),
	CONSTRAINT "record_documents_size_ck" CHECK ("record_documents"."size" between 1 and 5242880),
	CONSTRAINT "record_documents_mime_ck" CHECK ("record_documents"."mime" in ('application/pdf','image/jpeg','image/png'))
);
--> statement-breakpoint
CREATE TABLE "work_alert_states" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"snoozed_until" date,
	"read_at" timestamp with time zone,
	CONSTRAINT "work_alert_states_company_id_user_id_key_pk" PRIMARY KEY("company_id","user_id","key")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"due_date" date NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"record_kind" text,
	"record_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_title_ck" CHECK (length(btrim("work_items"."title")) between 2 and 200),
	CONSTRAINT "work_items_priority_ck" CHECK ("work_items"."priority" in ('normal','high')),
	CONSTRAINT "work_items_status_ck" CHECK ("work_items"."status" in ('open','done','cancelled')),
	CONSTRAINT "work_items_version_ck" CHECK ("work_items"."version" > 0),
	CONSTRAINT "work_items_ref_ck" CHECK (("work_items"."record_kind" is null) = ("work_items"."record_id" is null))
);
--> statement-breakpoint
ALTER TABLE "cash_scenarios" ADD CONSTRAINT "cash_scenarios_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_scenarios" ADD CONSTRAINT "cash_scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_entries" ADD CONSTRAINT "operation_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_entries" ADD CONSTRAINT "operation_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_entries" ADD CONSTRAINT "operation_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_entries" ADD CONSTRAINT "operation_entries_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_entries" ADD CONSTRAINT "operation_entries_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_events" ADD CONSTRAINT "portal_access_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_events" ADD CONSTRAINT "portal_access_events_link_id_portal_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."portal_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_links" ADD CONSTRAINT "portal_links_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_document_content" ADD CONSTRAINT "record_document_content_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_document_content" ADD CONSTRAINT "record_document_content_document_fk" FOREIGN KEY ("id","company_id") REFERENCES "public"."record_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_documents" ADD CONSTRAINT "record_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_documents" ADD CONSTRAINT "record_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_documents" ADD CONSTRAINT "record_documents_previous_fk" FOREIGN KEY ("previous_id","company_id") REFERENCES "public"."record_documents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_alert_states" ADD CONSTRAINT "work_alert_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_alert_states" ADD CONSTRAINT "work_alert_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_entries_list_idx" ON "operation_entries" USING btree ("company_id","kind","status","due_date");--> statement-breakpoint
CREATE INDEX "operation_entries_project_idx" ON "operation_entries" USING btree ("company_id","project_id","kind");--> statement-breakpoint
CREATE INDEX "record_documents_record_idx" ON "record_documents" USING btree ("company_id","record_kind","record_id","created_at");--> statement-breakpoint
CREATE INDEX "work_items_due_idx" ON "work_items" USING btree ("company_id","owner_id","status","due_date");