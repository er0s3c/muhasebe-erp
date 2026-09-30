CREATE TABLE "activations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"license_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"app_version" text,
	"status" text DEFAULT 'active' NOT NULL,
	"offline" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ip" text,
	"last_ts" bigint DEFAULT 0 NOT NULL,
	"reported_devices" integer DEFAULT 0 NOT NULL,
	"reported_companies" integer DEFAULT 0 NOT NULL,
	"ip_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint_changes" integer DEFAULT 0 NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" text,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "activations_status_ck" CHECK ("activations"."status" in ('active', 'deactivated'))
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text NOT NULL,
	"totp_last_counter" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text DEFAULT 'commercial' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sectors" text[] NOT NULL,
	"device_limit" integer NOT NULL,
	"company_limit" integer DEFAULT 1 NOT NULL,
	"device_idle_days" integer DEFAULT 30 NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"lease_days" integer DEFAULT 7 NOT NULL,
	"grace_days" integer DEFAULT 14 NOT NULL,
	"max_activations" integer DEFAULT 1 NOT NULL,
	"offline_allowed" boolean DEFAULT false NOT NULL,
	"code_hash" text NOT NULL,
	"code_prefix" text NOT NULL,
	"transfers_used" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_kind_ck" CHECK ("licenses"."kind" in ('commercial', 'trial', 'demo')),
	CONSTRAINT "licenses_status_ck" CHECK ("licenses"."status" in ('active', 'suspended', 'revoked')),
	CONSTRAINT "licenses_sectors_ck" CHECK (cardinality("licenses"."sectors") >= 1 and "licenses"."sectors" <@ array['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE']::text[]),
	CONSTRAINT "licenses_limits_ck" CHECK ("licenses"."device_limit" between 1 and 10000 and "licenses"."company_limit" between 1 and 10000 and "licenses"."max_activations" between 1 and 20),
	CONSTRAINT "licenses_days_ck" CHECK ("licenses"."lease_days" between 1 and 60 and "licenses"."grace_days" between 0 and 90 and "licenses"."device_idle_days" between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "activations" ADD CONSTRAINT "activations_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activations_installation_uq" ON "activations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "activations_license_idx" ON "activations" USING btree ("license_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_idx" ON "admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admins_email_uq" ON "admins" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "licenses_code_hash_uq" ON "licenses" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "licenses_customer_idx" ON "licenses" USING btree ("customer_id");