CREATE TABLE "agenda_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_date" date NOT NULL,
	"all_day" boolean DEFAULT true NOT NULL,
	"start_time" text,
	"end_time" text,
	"remind_before_minutes" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"owner_id" uuid,
	"contact_id" uuid,
	"organization_id" uuid,
	"party_id" uuid,
	"project_id" uuid,
	"source_note_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_items_kind_ck" CHECK ("agenda_items"."kind" in ('task','appointment')),
	CONSTRAINT "agenda_items_status_ck" CHECK ("agenda_items"."status" in ('open','done','cancelled')),
	CONSTRAINT "agenda_items_title_ck" CHECK (length(btrim("agenda_items"."title")) >= 1),
	CONSTRAINT "agenda_items_time_ck" CHECK (("agenda_items"."all_day" and "agenda_items"."start_time" is null and "agenda_items"."end_time" is null) or (not "agenda_items"."all_day" and "agenda_items"."start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ("agenda_items"."end_time" is null or ("agenda_items"."end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "agenda_items"."end_time" > "agenda_items"."start_time")))),
	CONSTRAINT "agenda_items_remind_ck" CHECK ("agenda_items"."remind_before_minutes" is null or "agenda_items"."remind_before_minutes" between 0 and 43200),
	CONSTRAINT "agenda_items_done_ck" CHECK (("agenda_items"."status" = 'done') = ("agenda_items"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "directory_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"title" text,
	"organization_id" uuid,
	"phone" text,
	"phone2" text,
	"email" text,
	"email2" text,
	"address" text,
	"party_id" uuid,
	"employee_id" uuid,
	"project_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"merged_into_id" uuid,
	"anonymized_at" timestamp with time zone,
	"anonymized_by" uuid,
	"anonymize_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_contacts_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "directory_contacts_name_ck" CHECK (length(btrim("directory_contacts"."full_name")) >= 2),
	CONSTRAINT "directory_contacts_archive_ck" CHECK ("directory_contacts"."is_archived" = ("directory_contacts"."archived_at" is not null)),
	CONSTRAINT "directory_contacts_merged_ck" CHECK ("directory_contacts"."merged_into_id" is null or "directory_contacts"."is_archived"),
	CONSTRAINT "directory_contacts_anonymized_ck" CHECK (("directory_contacts"."anonymized_at" is null) = ("directory_contacts"."anonymize_reason" is null) and ("directory_contacts"."anonymized_at" is null or "directory_contacts"."is_archived"))
);
--> statement-breakpoint
CREATE TABLE "directory_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"organization_id" uuid,
	"kind" text NOT NULL,
	"note_date" date NOT NULL,
	"summary" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"project_id" uuid,
	"author_id" uuid NOT NULL,
	"cleared_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_notes_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "directory_notes_kind_ck" CHECK ("directory_notes"."kind" in ('call','meeting','email','other')),
	CONSTRAINT "directory_notes_visibility_ck" CHECK ("directory_notes"."visibility" in ('private','shared')),
	CONSTRAINT "directory_notes_subject_ck" CHECK ("directory_notes"."contact_id" is not null or "directory_notes"."organization_id" is not null),
	CONSTRAINT "directory_notes_summary_ck" CHECK (length(btrim("directory_notes"."summary")) >= 1)
);
--> statement-breakpoint
CREATE TABLE "directory_organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Diğer' NOT NULL,
	"address" text,
	"phone" text,
	"email" text,
	"web" text,
	"party_id" uuid,
	"note" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_organizations_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "directory_organizations_name_ck" CHECK (length(btrim("directory_organizations"."name")) >= 2),
	CONSTRAINT "directory_organizations_archive_ck" CHECK ("directory_organizations"."is_archived" = ("directory_organizations"."archived_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "personal_data_access_log" DROP CONSTRAINT "personal_data_access_log_field_ck";--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ALTER COLUMN "employee_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_contact_fk" FOREIGN KEY ("contact_id","company_id") REFERENCES "public"."directory_contacts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_org_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."directory_organizations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_items" ADD CONSTRAINT "agenda_items_note_fk" FOREIGN KEY ("source_note_id","company_id") REFERENCES "public"."directory_notes"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_anonymized_by_users_id_fk" FOREIGN KEY ("anonymized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_org_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."directory_organizations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_employee_fk" FOREIGN KEY ("employee_id","company_id") REFERENCES "public"."employees"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_contacts" ADD CONSTRAINT "directory_contacts_merged_fk" FOREIGN KEY ("merged_into_id","company_id") REFERENCES "public"."directory_contacts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notes" ADD CONSTRAINT "directory_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notes" ADD CONSTRAINT "directory_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notes" ADD CONSTRAINT "directory_notes_contact_fk" FOREIGN KEY ("contact_id","company_id") REFERENCES "public"."directory_contacts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notes" ADD CONSTRAINT "directory_notes_org_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."directory_organizations"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_notes" ADD CONSTRAINT "directory_notes_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_organizations" ADD CONSTRAINT "directory_organizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_organizations" ADD CONSTRAINT "directory_organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_organizations" ADD CONSTRAINT "directory_organizations_party_fk" FOREIGN KEY ("party_id","company_id") REFERENCES "public"."parties"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agenda_items_due_idx" ON "agenda_items" USING btree ("company_id","status","due_date");--> statement-breakpoint
CREATE INDEX "agenda_items_owner_idx" ON "agenda_items" USING btree ("company_id","owner_id","due_date");--> statement-breakpoint
CREATE INDEX "directory_contacts_name_idx" ON "directory_contacts" USING btree ("company_id","full_name");--> statement-breakpoint
CREATE INDEX "directory_contacts_org_idx" ON "directory_contacts" USING btree ("company_id","organization_id");--> statement-breakpoint
CREATE INDEX "directory_notes_contact_idx" ON "directory_notes" USING btree ("company_id","contact_id","note_date");--> statement-breakpoint
CREATE INDEX "directory_notes_org_idx" ON "directory_notes" USING btree ("company_id","organization_id","note_date");--> statement-breakpoint
CREATE INDEX "directory_organizations_name_idx" ON "directory_organizations" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_contact_fk" FOREIGN KEY ("contact_id","company_id") REFERENCES "public"."directory_contacts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_contact_fk" FOREIGN KEY ("contact_id","company_id") REFERENCES "public"."directory_contacts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_subject_ck" CHECK ("data_subject_requests"."employee_id" is null or "data_subject_requests"."contact_id" is null);--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_subject_ck" CHECK (("personal_data_access_log"."employee_id" is null) <> ("personal_data_access_log"."contact_id" is null));--> statement-breakpoint
ALTER TABLE "personal_data_access_log" ADD CONSTRAINT "personal_data_access_log_field_ck" CHECK ("personal_data_access_log"."field" in ('id_number','birth_date','iban','export','payroll','social_security_no','social_security','foreign_doc_no','foreign_docs','employee_ledger','directory_export','directory_anonymize'));