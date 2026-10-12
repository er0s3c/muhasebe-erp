CREATE TABLE "user_ui_preferences" (
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ui_preferences_company_id_user_id_key_pk" PRIMARY KEY("company_id","user_id","key"),
	CONSTRAINT "user_ui_preferences_key_ck" CHECK ("user_ui_preferences"."key" ~ '^[a-z][a-z.]{1,40}$'),
	CONSTRAINT "user_ui_preferences_size_ck" CHECK (octet_length("user_ui_preferences"."value"::text) <= 16384)
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "fx_auto_import" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "fx_auto_enabled_by" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "fx_auto_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "fx_auto_last_error" text;--> statement-breakpoint
ALTER TABLE "user_ui_preferences" ADD CONSTRAINT "user_ui_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ui_preferences" ADD CONSTRAINT "user_ui_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_fx_auto_enabled_by_users_id_fk" FOREIGN KEY ("fx_auto_enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Kişisel arayüz tercihleri: şirket yalıtımı + kısıtlayıcı sahiplik (kullanıcı yalnız kendi satırını görür/yazar).
ALTER TABLE user_ui_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_ui_preferences USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE POLICY user_owner ON user_ui_preferences AS RESTRICTIVE USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_ui_preferences TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Satırın şirketi, kullanıcısı ve anahtarı sonradan değişmez (bildirim tercihleriyle aynı kural).
CREATE FUNCTION user_ui_preferences_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.user_id <> OLD.user_id OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'Tercihin şirketi, kullanıcısı ve anahtarı değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER user_ui_preferences_guard
  BEFORE UPDATE ON user_ui_preferences
  FOR EACH ROW EXECUTE FUNCTION user_ui_preferences_guard();
