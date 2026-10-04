CREATE TABLE "notification_digests" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"digest_date" date NOT NULL,
	"item_count" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_digests_company_id_user_id_digest_date_pk" PRIMARY KEY("company_id","user_id","digest_date"),
	CONSTRAINT "notification_digests_count_ck" CHECK ("notification_digests"."item_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	"lead_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_company_id_user_id_kind_pk" PRIMARY KEY("company_id","user_id","kind"),
	CONSTRAINT "notification_preferences_kind_ck" CHECK ("notification_preferences"."kind" ~ '^[a-z][a-z_]{1,40}$'),
	CONSTRAINT "notification_preferences_lead_ck" CHECK ("notification_preferences"."lead_days" is null or "notification_preferences"."lead_days" between 0 and 365)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"dedupe_key" text NOT NULL,
	"bucket_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "notifications_dedupe_uq" UNIQUE("company_id","user_id","kind","dedupe_key","bucket_date"),
	CONSTRAINT "notifications_kind_ck" CHECK ("notifications"."kind" ~ '^[a-z][a-z_]{1,40}$'),
	CONSTRAINT "notifications_severity_ck" CHECK ("notifications"."severity" in ('info','warning','critical')),
	CONSTRAINT "notifications_title_ck" CHECK (length(btrim("notifications"."title")) between 1 and 200),
	CONSTRAINT "notifications_body_ck" CHECK (length("notifications"."body") <= 1000),
	CONSTRAINT "notifications_link_ck" CHECK ("notifications"."link" ~ '^/[^/]' or "notifications"."link" = '/'),
	CONSTRAINT "notifications_count_ck" CHECK ("notifications"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("company_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_open_idx" ON "notifications" USING btree ("company_id","user_id") WHERE "notifications"."resolved_at" is null and "notifications"."dismissed_at" is null;