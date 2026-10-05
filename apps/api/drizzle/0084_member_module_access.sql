CREATE TABLE "member_module_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"level" text NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "member_module_access_uq" UNIQUE("company_id","user_id","module_key"),
	CONSTRAINT "member_module_access_level_ck" CHECK ("member_module_access"."level" in ('none','read','write')),
	CONSTRAINT "member_module_access_key_ck" CHECK ("member_module_access"."module_key" ~ '^[a-z][a-z0-9_.]{2,59}$'),
	CONSTRAINT "member_module_access_note_ck" CHECK ("member_module_access"."note" is null or length("member_module_access"."note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "member_module_access" ADD CONSTRAINT "member_module_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_module_access" ADD CONSTRAINT "member_module_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_module_access" ADD CONSTRAINT "member_module_access_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_module_access_user_idx" ON "member_module_access" USING btree ("company_id","user_id");