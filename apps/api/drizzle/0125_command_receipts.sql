CREATE TABLE "command_receipts" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipts_company_id_user_id_key_pk" PRIMARY KEY("company_id","user_id","key"),
	CONSTRAINT "command_receipts_key_ck" CHECK ("command_receipts"."key" ~ '^[A-Za-z0-9_-]{16,80}$'),
	CONSTRAINT "command_receipts_status_ck" CHECK ("command_receipts"."status_code" between 200 and 299)
);
--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "command_receipts_created_idx" ON "command_receipts" USING btree ("created_at");
--> statement-breakpoint
-- Komut makbuzları: şirket yalıtımı + kısıtlayıcı sahiplik (kullanıcı yalnız kendi makbuzunu görür ve yazar).
ALTER TABLE command_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON command_receipts USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE POLICY user_owner ON command_receipts AS RESTRICTIVE USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
--> statement-breakpoint
-- Makbuz değiştirilemez: uygulama rolü yalnız okur ve ekler (saklama süresi dolanlar bakım işiyle silinir).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT ON command_receipts TO erp_app;
  END IF;
END
$$;
