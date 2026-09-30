CREATE TABLE "admin_passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_passkeys_credential_uq" ON "admin_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "admin_passkeys_admin_idx" ON "admin_passkeys" USING btree ("admin_id");--> statement-breakpoint

-- Çalışma zamanı rolü giriş anahtarlarını ekler, sayaçlarını günceller ve siler (yönetici panelden kaldırabilir).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON admin_passkeys TO erp_app;
  END IF;
END
$$;
