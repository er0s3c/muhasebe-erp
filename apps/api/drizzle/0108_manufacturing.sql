ALTER TABLE companies DROP CONSTRAINT companies_sector_ck;
ALTER TABLE companies ADD CONSTRAINT companies_sector_ck CHECK(sector IN ('CONSTRUCTION','RETAIL_MARKET','COMMERCE','LEATHER_FASHION','MANUFACTURING_WHOLESALE'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purchase_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  company_sector text;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Taslak dışındaki satın alma talebi silinemez' USING ERRCODE = 'ERP11';
    END IF;
    RETURN OLD;
  END IF;
  SELECT sector INTO company_sector FROM companies WHERE id = NEW.company_id;
  IF company_sector IS NULL OR company_sector NOT IN ('CONSTRUCTION','LEATHER_FASHION','MANUFACTURING_WHOLESALE')
     OR (company_sector IN ('LEATHER_FASHION','MANUFACTURING_WHOLESALE') AND NEW.project_id IS NOT NULL)
     OR (company_sector = 'CONSTRUCTION' AND NEW.project_id IS NULL) THEN
    RAISE EXCEPTION 'Satın alma proje bağlamı şirketin sektörüne uymuyor' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.project_id IS NOT NULL THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye talep açılamaz' USING ERRCODE = 'ERP11';
    END IF;
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Talep taslak olarak açılır' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'Talebin kodu ve projesi değiştirilemez' USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' AND OLD.status <> 'rejected'
       AND (to_jsonb(NEW) - 'rejection_note') IS DISTINCT FROM (to_jsonb(OLD) - 'rejection_note') THEN
      RAISE EXCEPTION 'Taslak dışındaki talep değiştirilemez' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;
  ok := (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
     OR (OLD.status = 'submitted' AND NEW.status IN ('draft', 'approved', 'rejected'))
     OR (OLD.status = 'rejected' AND NEW.status IN ('draft', 'cancelled'))
     OR (OLD.status = 'approved' AND NEW.status IN ('ordered', 'cancelled'))
     OR (OLD.status = 'ordered' AND NEW.status = 'approved');
  IF NOT ok THEN
    RAISE EXCEPTION 'Geçersiz talep durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = 'submitted' AND NOT EXISTS (SELECT 1 FROM purchase_request_lines WHERE request_id = NEW.id) THEN
    RAISE EXCEPTION 'Satırsız talep onaya gönderilemez' USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purchase_request_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  r purchase_requests%ROWTYPE;
  rid uuid;
BEGIN
  rid := CASE WHEN TG_OP = 'DELETE' THEN OLD.request_id ELSE NEW.request_id END;
  SELECT * INTO r FROM purchase_requests WHERE id = rid FOR SHARE;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; -- cascade
  END IF;
  IF r.status NOT IN ('draft', 'rejected') THEN
    RAISE EXCEPTION 'Yalnızca taslak talebin satırları değiştirilir' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP <> 'DELETE' AND (NEW.company_id IS DISTINCT FROM r.company_id OR NEW.project_id IS DISTINCT FROM r.project_id) THEN
    RAISE EXCEPTION 'Satın alma satırı üst belgenin şirketi ve projesiyle aynı olmalı' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purchase_orders_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  company_sector text;
  pk text;
  rq purchase_requests%ROWTYPE;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Taslak dışındaki sipariş silinemez; iptal edilir' USING ERRCODE = 'ERP11';
    END IF;
    RETURN OLD;
  END IF;
  SELECT sector INTO company_sector FROM companies WHERE id = NEW.company_id;
  IF company_sector IS NULL OR company_sector NOT IN ('CONSTRUCTION','LEATHER_FASHION','MANUFACTURING_WHOLESALE')
     OR (company_sector IN ('LEATHER_FASHION','MANUFACTURING_WHOLESALE') AND NEW.project_id IS NOT NULL)
     OR (company_sector = 'CONSTRUCTION' AND NEW.project_id IS NULL) THEN
    RAISE EXCEPTION 'Satın alma proje bağlamı şirketin sektörüne uymuyor' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.project_id IS NOT NULL THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye sipariş açılamaz' USING ERRCODE = 'ERP11';
    END IF;
    END IF;
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk = 'customer' THEN
      RAISE EXCEPTION 'Sipariş tedarikçi türünde bir cariye verilir' USING ERRCODE = 'ERP11';
    END IF;
    IF NEW.request_id IS NOT NULL THEN
      SELECT * INTO rq FROM purchase_requests WHERE id = NEW.request_id AND company_id = NEW.company_id;
      IF NOT FOUND OR rq.status NOT IN ('approved', 'ordered') OR rq.project_id IS DISTINCT FROM NEW.project_id THEN
        RAISE EXCEPTION 'Sipariş yalnızca aynı projenin onaylı talebinden oluşturulur' USING ERRCODE = 'ERP11';
      END IF;
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Sipariş taslak olarak açılır' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.party_id <> OLD.party_id THEN
    RAISE EXCEPTION 'Siparişin kodu, projesi ve tedarikçisi değiştirilemez' USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft'
       AND (to_jsonb(NEW) - 'cancel_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'cancel_reason') THEN
      RAISE EXCEPTION 'Taslak dışındaki sipariş değiştirilemez' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;
  ok := (OLD.status = 'draft' AND NEW.status IN ('issued', 'cancelled'))
     OR (OLD.status = 'issued' AND NEW.status IN ('closed', 'cancelled'))
     OR (OLD.status = 'closed' AND NEW.status = 'issued');
  IF NOT ok THEN
    RAISE EXCEPTION 'Geçersiz sipariş durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = 'issued' AND OLD.status = 'draft' THEN
    IF NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE order_id = NEW.id) THEN
      RAISE EXCEPTION 'Satırsız sipariş verilemez' USING ERRCODE = 'ERP11';
    END IF;
  END IF;
  IF NEW.status = 'cancelled' AND EXISTS (
       SELECT 1 FROM po_receipts WHERE order_id = NEW.id AND status = 'posted') THEN
    RAISE EXCEPTION 'Mal kabulü olan sipariş iptal edilemez; kalan miktar için siparişi kapatın' USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION purchase_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  o purchase_orders%ROWTYPE;
  oid uuid;
BEGIN
  oid := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  SELECT * INTO o FROM purchase_orders WHERE id = oid FOR SHARE;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; -- cascade
  END IF;
  IF o.status <> 'draft' THEN
    RAISE EXCEPTION 'Yalnızca taslak siparişin satırları değiştirilir' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP <> 'DELETE' AND (NEW.company_id IS DISTINCT FROM o.company_id OR NEW.project_id IS DISTINCT FROM o.project_id) THEN
    RAISE EXCEPTION 'Satın alma satırı üst belgenin şirketi ve projesiyle aynı olmalı' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TABLE manufacturing_records (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 kind text NOT NULL CHECK(kind IN ('resource','calendar','maintenance','schedule','transfer','bin','lot','placement','shipment','connection','integration_event','demo_dataset','department','custom_field','attendance')),
 code text NOT NULL, status text NOT NULL DEFAULT 'draft', order_id uuid, item_id uuid, warehouse_id uuid, source_document_id uuid, request_key uuid, config jsonb NOT NULL DEFAULT '{}',
 UNIQUE(id,company_id), UNIQUE(company_id,kind,code), UNIQUE(company_id,kind,request_key),
 FOREIGN KEY(order_id,company_id) REFERENCES leather_production_orders(id,company_id),
 FOREIGN KEY(item_id,company_id) REFERENCES items(id,company_id),
 FOREIGN KEY(warehouse_id,company_id) REFERENCES warehouses(id,company_id)
);
--> statement-breakpoint
CREATE INDEX manufacturing_records_kind_idx ON manufacturing_records(company_id,kind,status);
ALTER TABLE manufacturing_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON manufacturing_records USING(company_id=app_company_id()) WITH CHECK(company_id=app_company_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON manufacturing_records TO erp_app;
CREATE TRIGGER audit_manufacturing_records AFTER INSERT OR UPDATE OR DELETE ON manufacturing_records FOR EACH ROW EXECUTE FUNCTION audit_row_change();

--> statement-breakpoint
ALTER TABLE work_items DROP CONSTRAINT work_items_record_kind_ck;
ALTER TABLE work_items ADD CONSTRAINT work_items_record_kind_ck CHECK(record_kind IS NULL OR record_kind IN (
 'party','invoice','project','subcontract','sales_contract','employee','foreign_worker_doc','transaction','site_report','defect','rfi','site_instruction','quality_check','safety',
 'manufacturing_model','manufacturing_production','manufacturing_subcontract','manufacturing_resource','manufacturing_maintenance','wms_lot','logistics_shipment','leather_model','leather_piece','leather_production','leather_subcontract','leather_custom_order','leather_service','pos_sale'
));
