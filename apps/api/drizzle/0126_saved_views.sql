CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"branch_scope" text NOT NULL,
	"page" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_page_ck" CHECK ("saved_views"."page" ~ '^[a-z][a-z0-9-]{1,60}$'),
	CONSTRAINT "saved_views_branch_ck" CHECK ("saved_views"."branch_scope" ~ '^(all|unassigned|[0-9a-f-]{36})$'),
	CONSTRAINT "saved_views_name_ck" CHECK (char_length("saved_views"."name") between 1 and 40),
	CONSTRAINT "saved_views_filters_ck" CHECK (jsonb_typeof("saved_views"."filters") = 'object' and octet_length("saved_views"."filters"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_page_idx" ON "saved_views" USING btree ("company_id","page","branch_scope");
--> statement-breakpoint
-- Kayıtlı görünümler: şirket yalıtımı; okuma kendi + ortak görünümler, yazma yalnız sahibine.
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON saved_views USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE POLICY owner_or_shared_read ON saved_views AS RESTRICTIVE FOR SELECT USING (owner_user_id = app_user_id() OR shared);
--> statement-breakpoint
CREATE POLICY owner_insert ON saved_views AS RESTRICTIVE FOR INSERT WITH CHECK (owner_user_id = app_user_id());
--> statement-breakpoint
CREATE POLICY owner_update ON saved_views AS RESTRICTIVE FOR UPDATE USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id());
--> statement-breakpoint
CREATE POLICY owner_delete ON saved_views AS RESTRICTIVE FOR DELETE USING (owner_user_id = app_user_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON saved_views TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Görünümün şirketi, sahibi, ekranı ve şube kapsamı sonradan değişmez (ortak görünüm başka ekrana taşınamaz).
CREATE FUNCTION saved_views_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.owner_user_id <> OLD.owner_user_id OR NEW.page <> OLD.page OR NEW.branch_scope <> OLD.branch_scope THEN
    RAISE EXCEPTION 'Görünümün şirketi, sahibi, ekranı ve şube kapsamı değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER saved_views_guard BEFORE UPDATE ON saved_views FOR EACH ROW EXECUTE FUNCTION saved_views_guard();
