-- Deri aksesuar ve moda: sektör/rol kaydı ve ortak satın alma bağlamı.
ALTER TABLE companies DROP CONSTRAINT companies_sector_ck;
ALTER TABLE companies ADD CONSTRAINT companies_sector_ck CHECK (sector IN ('CONSTRUCTION','RETAIL_MARKET','COMMERCE','LEATHER_FASHION'));
ALTER TABLE memberships DROP CONSTRAINT memberships_role_ck;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_ck CHECK (role IN ('owner','admin','accountant','sales','site_manager','viewer','operations_manager','operator'));
--> statement-breakpoint
-- Eski modül erişim istisnaları aynı izin alanıyla devam eder; metadata korunur.
ALTER TABLE member_module_access DISABLE TRIGGER member_module_access_guard;
UPDATE member_module_access SET module_key = 'core.procurement' WHERE module_key = 'construction.procurement';
ALTER TABLE member_module_access ENABLE TRIGGER member_module_access_guard;
--> statement-breakpoint
ALTER TABLE purchase_requests ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE purchase_request_lines ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE purchase_orders ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE purchase_order_lines ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_request_company_fk FOREIGN KEY (request_id,company_id) REFERENCES purchase_requests(id,company_id) ON DELETE CASCADE;
ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_order_company_fk FOREIGN KEY (order_id,company_id) REFERENCES purchase_orders(id,company_id) ON DELETE CASCADE;
ALTER TABLE purchase_request_lines ADD CONSTRAINT purchase_request_lines_project_ck CHECK (wbs_id IS NULL OR project_id IS NOT NULL);
ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_project_ck CHECK (wbs_id IS NULL OR project_id IS NOT NULL);
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
  IF company_sector IS NULL OR company_sector NOT IN ('CONSTRUCTION','LEATHER_FASHION')
     OR (company_sector = 'LEATHER_FASHION' AND NEW.project_id IS NOT NULL)
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
  IF company_sector IS NULL OR company_sector NOT IN ('CONSTRUCTION','LEATHER_FASHION')
     OR (company_sector = 'LEATHER_FASHION' AND NEW.project_id IS NOT NULL)
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
ALTER TABLE items ADD COLUMN inventory_role text NOT NULL DEFAULT 'merchandise';
ALTER TABLE items ADD CONSTRAINT items_inventory_role_ck CHECK (inventory_role IN ('raw_material','semi_finished','finished_goods','merchandise'));
ALTER TABLE account_mappings DROP CONSTRAINT account_mappings_key_ck;
ALTER TABLE account_mappings ADD CONSTRAINT account_mappings_key_ck CHECK (key in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable','payroll_labor_cost','payroll_employer_cost','payroll_payable','payroll_social_payable','payroll_tax_payable','payroll_other_payable','cheque_portfolio','note_portfolio','docs_in_collection','cheque_issued','note_payable','import_cost_clearing','employee_advance','year_end_profit','year_end_loss','year_end_retained_profit','year_end_retained_loss','raw_material_stock','semi_finished_stock','finished_goods_stock','production_wip','produced_cogs','goods_receipt_accrual'));
INSERT INTO account_mappings(company_id,key,account_id)
SELECT a.company_id, k.key, a.id FROM accounts a JOIN (VALUES
 ('raw_material_stock','150'),('semi_finished_stock','151'),('finished_goods_stock','152'),
 ('production_wip','151'),('produced_cogs','620'),('goods_receipt_accrual','381')
) AS k(key,code) ON a.code=k.code
ON CONFLICT(company_id,key) DO NOTHING;

--> statement-breakpoint
ALTER TABLE work_items DROP CONSTRAINT work_items_record_kind_ck;
ALTER TABLE work_items ADD CONSTRAINT work_items_record_kind_ck CHECK(record_kind IS NULL OR record_kind IN (
 'party','invoice','project','subcontract','sales_contract','employee','foreign_worker_doc','transaction','site_report','defect','rfi','site_instruction','quality_check','safety',
 'leather_model','leather_piece','leather_production','leather_subcontract','leather_custom_order','leather_service','pos_sale'
));
ALTER TABLE record_documents DROP CONSTRAINT record_documents_kind_ck;
ALTER TABLE record_documents ADD CONSTRAINT record_documents_kind_ck CHECK(record_kind IN (
 'party','invoice','project','subcontract','sales_contract','employee','foreign_worker_doc','transaction','site_report','defect','rfi','site_instruction','quality_check','safety',
 'leather_model','leather_piece','leather_production','leather_subcontract','leather_custom_order','leather_service','pos_sale'
));
