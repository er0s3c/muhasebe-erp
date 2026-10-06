CREATE TABLE "construction_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"result_hash" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lease_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"reviewed_record_kind" text,
	"reviewed_record_id" uuid,
	CONSTRAINT "cj_id_company" UNIQUE("id","company_id"),
	CONSTRAINT "cj_kind" CHECK ("construction_jobs"."kind" in ('ifc','ocr')),
	CONSTRAINT "cj_status" CHECK ("construction_jobs"."status" in ('queued','running','completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "construction_model_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"guid" text NOT NULL,
	"wbs_id" uuid,
	"operation_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cml_element" UNIQUE("company_id","job_id","guid")
);
--> statement-breakpoint
ALTER TABLE "construction_photos" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "construction_jobs" ADD CONSTRAINT "construction_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_jobs" ADD CONSTRAINT "construction_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_jobs" ADD CONSTRAINT "construction_jobs_project_id_company_id_projects_id_company_id_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_jobs" ADD CONSTRAINT "construction_jobs_asset_id_company_id_construction_assets_id_company_id_fk" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."construction_assets"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_model_links" ADD CONSTRAINT "construction_model_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_model_links" ADD CONSTRAINT "construction_model_links_job_id_company_id_construction_jobs_id_company_id_fk" FOREIGN KEY ("job_id","company_id") REFERENCES "public"."construction_jobs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "construction_model_links" ADD CONSTRAINT "construction_model_links_wbs_id_company_id_project_wbs_id_company_id_fk" FOREIGN KEY ("wbs_id","company_id") REFERENCES "public"."project_wbs"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cj_queue" ON "construction_jobs" USING btree ("company_id","status","created_at");--> statement-breakpoint
ALTER TABLE "construction_photos" ADD CONSTRAINT "cphoto_client" UNIQUE("company_id","client_id");
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['construction_jobs','construction_model_links'] LOOP
EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id())',t);
EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t);
EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_app',t);
END LOOP; END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION real_estate_units_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  live text;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'available' OR EXISTS (SELECT 1 FROM sales_contracts WHERE unit_id = OLD.id) THEN
      RAISE EXCEPTION 'Sözleşmesi olan birim silinemez' USING ERRCODE = 'ERP12';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.kind <> 'own' THEN
      RAISE EXCEPTION 'Birim yalnızca kendi projesine (satış projesi) eklenir' USING ERRCODE = 'ERP12';
    END IF;
    IF pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye birim eklenemez' USING ERRCODE = 'ERP12';
    END IF;
    IF NEW.status <> 'available' THEN
      RAISE EXCEPTION 'Birim satışa açık olarak eklenir' USING ERRCODE = 'ERP12';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'Birimin projesi değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;
  IF NEW.status <> OLD.status THEN
    ok := (OLD.status = 'available' AND NEW.status IN ('reserved', 'sold'))
       OR (OLD.status = 'reserved' AND NEW.status IN ('available', 'sold'))
       OR (OLD.status = 'sold' AND NEW.status IN ('available', 'handed_over'));
    IF NOT ok THEN
      RAISE EXCEPTION 'Geçersiz birim durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP12';
    END IF;
    -- Durum, canlı sözleşmeyle tutarlı olmalıdır
    SELECT status INTO live FROM sales_contracts
     WHERE unit_id = NEW.id AND status IN ('draft', 'active', 'handed_over');
    IF NEW.status = 'available' AND (live IS NOT NULL OR EXISTS(SELECT 1 FROM construction_workflows WHERE company_id=NEW.company_id AND kind='lead' AND status='reserved' AND payload->>'unitId'=NEW.id::text)) THEN
      RAISE EXCEPTION 'Canlı sözleşmesi olan birim satışa açılamaz' USING ERRCODE = 'ERP12';
    END IF;
    IF (NEW.status = 'reserved' AND live IS DISTINCT FROM 'draft' AND NOT EXISTS(SELECT 1 FROM construction_workflows WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND kind='lead' AND status='reserved' AND payload->>'unitId'=NEW.id::text AND (payload->>'reservationUntil')::date>=current_date))
       OR (NEW.status = 'sold' AND live IS DISTINCT FROM 'active')
       OR (NEW.status = 'handed_over' AND live IS DISTINCT FROM 'handed_over') THEN
      RAISE EXCEPTION 'Birim durumu sözleşme durumuyla uyuşmuyor' USING ERRCODE = 'ERP12';
    END IF;
  ELSIF OLD.status <> 'available' AND (NEW.block <> OLD.block OR NEW.unit_no <> OLD.unit_no) THEN
    RAISE EXCEPTION 'Sözleşmeye bağlı birimin blok ve numarası değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION sales_contracts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  un real_estate_units%ROWTYPE;
  pk text;
  ok boolean;
  n int;
  total numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Satış sözleşmesi silinemez; iptal edilir' USING ERRCODE = 'ERP12';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Satış sözleşmesi taslak olarak açılır' USING ERRCODE = 'ERP12';
    END IF;
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.kind <> 'own' OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Satış sözleşmesi açık, kendi projesine ait birim için yapılır' USING ERRCODE = 'ERP12';
    END IF;
    SELECT * INTO un FROM real_estate_units WHERE id = NEW.unit_id AND company_id = NEW.company_id FOR UPDATE;
    IF NOT FOUND OR (un.status <> 'available' AND NOT (un.status = 'reserved' AND EXISTS (SELECT 1 FROM construction_workflows WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND kind='lead' AND status='reserved' AND payload->>'unitId'=NEW.unit_id::text AND (payload->>'partyId' IS NULL OR payload->>'partyId'=NEW.party_id::text) AND (payload->>'reservationUntil')::date>=current_date))) THEN
      RAISE EXCEPTION 'Birim satışa açık değil' USING ERRCODE = 'ERP12';
    END IF;
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk = 'supplier' THEN
      RAISE EXCEPTION 'Alıcı müşteri türünde bir cari olmalı' USING ERRCODE = 'ERP12';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.unit_id <> OLD.unit_id OR NEW.project_id <> OLD.project_id
     OR NEW.party_id <> OLD.party_id OR NEW.currency_code <> OLD.currency_code THEN
    RAISE EXCEPTION 'Sözleşmenin kodu, birimi, alıcısı ve para birimi değiştirilemez' USING ERRCODE = 'ERP12';
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft'
       AND (to_jsonb(NEW) - 'penalty_note') IS DISTINCT FROM (to_jsonb(OLD) - 'penalty_note') THEN
      RAISE EXCEPTION 'Taslak dışındaki sözleşme değiştirilemez' USING ERRCODE = 'ERP12';
    END IF;
    RETURN NEW;
  END IF;

  ok := (OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled'))
     OR (OLD.status = 'active' AND NEW.status IN ('handed_over', 'terminated', 'cancelled'));
  IF NOT ok THEN
    RAISE EXCEPTION 'Geçersiz sözleşme durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP12';
  END IF;

  IF NEW.status = 'active' THEN
    SELECT count(*) FILTER (WHERE kind <> 'fee'), coalesce(sum(amount) FILTER (WHERE kind <> 'fee'), 0) INTO n, total
      FROM sales_installments WHERE contract_id = NEW.id;
    IF n = 0 THEN
      RAISE EXCEPTION 'Taksit planı olmayan sözleşme etkinleştirilemez' USING ERRCODE = 'ERP12';
    END IF;
    IF total <> NEW.price THEN
      RAISE EXCEPTION 'Taksit toplamı (%) sözleşme bedeline (%) eşit olmalı', total, NEW.price USING ERRCODE = 'ERP12';
    END IF;
    IF EXISTS (SELECT 1 FROM sales_installments WHERE contract_id = NEW.id AND journal_line_id IS NULL) THEN
      RAISE EXCEPTION 'Etkinleşmede her taksit bir cari kaleme bağlanmalı' USING ERRCODE = 'ERP12';
    END IF;
  END IF;

  IF NEW.status = 'terminated' AND NOT EXISTS (SELECT 1 FROM sales_terminations WHERE contract_id = NEW.id) THEN
    RAISE EXCEPTION 'Fesih kaydı olmadan sözleşme feshedilemez' USING ERRCODE = 'ERP12';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status = 'active' AND EXISTS (
       SELECT 1
         FROM sales_installments si
         JOIN party_allocations pa ON pa.charge_line_id = si.journal_line_id
         JOIN treasury_transactions t ON t.id = pa.transaction_id AND t.status = 'posted'
        WHERE si.contract_id = NEW.id) THEN
    RAISE EXCEPTION 'Tahsilatı olan sözleşme iptal edilemez; fesih kaydı açın' USING ERRCODE = 'ERP12';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.cancel_reason IS NULL THEN
    RAISE EXCEPTION 'İptal nedeni gerekli' USING ERRCODE = 'ERP12';
  END IF;
  RETURN NEW;
END
$$;

