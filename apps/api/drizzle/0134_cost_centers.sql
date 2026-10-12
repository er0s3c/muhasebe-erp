CREATE TABLE "cost_centers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_centers_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "cost_centers_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "cost_centers_code_ck" CHECK ("cost_centers"."code" ~ '^[A-Za-z0-9._-]{1,20}$'),
	CONSTRAINT "cost_centers_name_ck" CHECK (char_length("cost_centers"."name") between 2 and 80)
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_cost_center_fk FOREIGN KEY (cost_center_id, company_id) REFERENCES cost_centers (id, company_id);
--> statement-breakpoint
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_cost_center_fk FOREIGN KEY (cost_center_id, company_id) REFERENCES cost_centers (id, company_id);
--> statement-breakpoint
CREATE INDEX journal_lines_cost_center_idx ON journal_lines (company_id, cost_center_id) WHERE cost_center_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE cost_centers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cost_centers USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON cost_centers TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Maliyet merkezinin kodu ve şirketi değişmez (raporlar kodla okunur); ad ve etkinlik değişebilir.
CREATE FUNCTION cost_centers_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.code <> OLD.code OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Maliyet merkezinin kodu değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER cost_centers_guard BEFORE UPDATE ON cost_centers FOR EACH ROW EXECUTE FUNCTION cost_centers_guard();
