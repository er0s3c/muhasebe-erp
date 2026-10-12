CREATE TABLE "sales_restructures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"restructure_date" date NOT NULL,
	"reason" text NOT NULL,
	"old_plan" jsonb NOT NULL,
	"new_plan" jsonb NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"entry_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_restructures_id_company_uq" UNIQUE("id","company_id")
);
--> statement-breakpoint
ALTER TABLE "sales_installments" ADD COLUMN "restructure_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_installments" ADD COLUMN "restructured_in" uuid;--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD COLUMN "restructure_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_restructures" ADD CONSTRAINT "sales_restructures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_restructures" ADD CONSTRAINT "sales_restructures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_restructures" ADD CONSTRAINT "sales_restructures_contract_fk" FOREIGN KEY ("contract_id","company_id") REFERENCES "public"."sales_contracts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_restructures" ADD CONSTRAINT "sales_restructures_entry_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_restructures_contract_idx" ON "sales_restructures" USING btree ("company_id","contract_id");--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_restructure_fk" FOREIGN KEY ("restructure_id","company_id") REFERENCES "public"."sales_restructures"("id","company_id");
--> statement-breakpoint
ALTER TABLE "sales_installments" ADD CONSTRAINT "sales_installments_restructured_in_fk" FOREIGN KEY ("restructured_in","company_id") REFERENCES "public"."sales_restructures"("id","company_id");
--> statement-breakpoint
ALTER TABLE "sales_writeoffs" ADD CONSTRAINT "sales_writeoffs_restructure_fk" FOREIGN KEY ("restructure_id","company_id") REFERENCES "public"."sales_restructures"("id","company_id");
--> statement-breakpoint
ALTER TABLE sales_restructures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sales_restructures USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT ON sales_restructures TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Yeniden yapılandırma yalnız etkin ya da teslim edilmiş sözleşmede yapılır; kayıt değişmez ve silinmez.
CREATE FUNCTION sales_restructures_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Yeniden yapılandırma kaydı değiştirilemez veya silinemez' USING ERRCODE = 'ERP12';
  END IF;
  SELECT status INTO st FROM sales_contracts WHERE id = NEW.contract_id AND company_id = NEW.company_id FOR UPDATE;
  IF st IS NULL OR st NOT IN ('active', 'handed_over') THEN
    RAISE EXCEPTION 'Taksit planı yalnız etkin ya da teslim edilmiş sözleşmede yeniden yapılandırılır' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_restructures_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_restructures FOR EACH ROW EXECUTE FUNCTION sales_restructures_guard();
--> statement-breakpoint
-- Taksit planı taslakta serbest; etkin sözleşmede yalnız yeniden yapılandırma yeni taksit ekler ve eski taksidi işaretler.
CREATE OR REPLACE FUNCTION sales_installments_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  c sales_contracts%ROWTYPE;
  cid uuid;
BEGIN
  cid := CASE WHEN TG_OP = 'DELETE' THEN OLD.contract_id ELSE NEW.contract_id END;
  SELECT * INTO c FROM sales_contracts WHERE id = cid FOR SHARE;
  IF TG_OP = 'UPDATE' AND NEW.contract_id <> OLD.contract_id THEN
    RAISE EXCEPTION 'Taksidin sözleşmesi değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;
  IF FOUND AND c.status = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF FOUND AND c.status IN ('active', 'handed_over') THEN
    IF TG_OP = 'INSERT' AND NEW.restructure_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM sales_restructures r WHERE r.id = NEW.restructure_id AND r.contract_id = NEW.contract_id) THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.restructured_in IS NULL AND NEW.restructured_in IS NOT NULL
       AND (to_jsonb(NEW) - 'restructured_in') = (to_jsonb(OLD) - 'restructured_in')
       AND EXISTS (SELECT 1 FROM sales_restructures r WHERE r.id = NEW.restructured_in AND r.contract_id = NEW.contract_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Taksit planı yalnızca taslak sözleşmede değiştirilebilir (etkin sözleşmede yeniden yapılandırma kullanılır)' USING ERRCODE = 'ERP12';
END
$$;
--> statement-breakpoint
-- Kasasız kalem kapatma: fesih (yapılandırmasız) yalnız etkin sözleşmede; yapılandırma devri etkin/teslim edilmiş sözleşmede.
CREATE FUNCTION sales_writeoffs_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Kalem kapatma kaydı değiştirilemez veya silinemez' USING ERRCODE = 'ERP12';
  END IF;
  SELECT status INTO st FROM sales_contracts WHERE id = NEW.contract_id AND company_id = NEW.company_id FOR UPDATE;
  IF NEW.restructure_id IS NULL THEN
    IF st IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Yalnızca etkin sözleşme feshedilir (teslimden sonra fesih desteklenmez)' USING ERRCODE = 'ERP12';
    END IF;
  ELSIF st NOT IN ('active', 'handed_over')
     OR NOT EXISTS (SELECT 1 FROM sales_restructures r WHERE r.id = NEW.restructure_id AND r.contract_id = NEW.contract_id) THEN
    RAISE EXCEPTION 'Yapılandırma devri yalnız aynı sözleşmenin yapılandırmasıyla yapılır' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER sales_writeoffs_guard ON sales_writeoffs;
--> statement-breakpoint
CREATE TRIGGER sales_writeoffs_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_writeoffs FOR EACH ROW EXECUTE FUNCTION sales_writeoffs_guard();
