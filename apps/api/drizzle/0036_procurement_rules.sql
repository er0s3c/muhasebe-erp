-- =========================================================================
-- Satın alma zinciri (talep, RFQ/teklif, sipariş, mal kabul): RLS, yetki, denetim izi, iş kuralları.
-- Kurallar ERRCODE ERP11 ile yükselir (API'de 422 PROCUREMENT_RULE_VIOLATION).
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_requests', 'purchase_request_lines', 'rfqs', 'rfq_offers', 'rfq_offer_lines',
                           'purchase_orders', 'purchase_order_lines', 'po_receipts', 'po_receipt_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_requests, purchase_request_lines, rfq_offers, rfq_offer_lines,
                                            purchase_orders, purchase_order_lines TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON rfqs, po_receipts TO erp_app;
    GRANT SELECT, INSERT ON po_receipt_lines TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 1) Talep
CREATE FUNCTION purchase_requests_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'Taslak dışındaki satın alma talebi silinemez' USING ERRCODE = 'ERP11';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye talep açılamaz' USING ERRCODE = 'ERP11';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Talep taslak olarak açılır' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id <> OLD.project_id THEN
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
CREATE TRIGGER purchase_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION purchase_requests_guard();
--> statement-breakpoint

-- 2) Talep satırı: yalnızca taslak talepte; iş kalemi yaprak olmalı
CREATE FUNCTION purchase_request_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
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
  IF TG_OP <> 'DELETE' AND NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER purchase_request_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_request_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_request_lines_guard();
--> statement-breakpoint

-- 3) RFQ: yalnızca onaylı talepten; açık → verildi/iptal
CREATE FUNCTION rfqs_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  r purchase_requests%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RFQ silinemez; iptal edilir' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO r FROM purchase_requests WHERE id = NEW.request_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR r.status <> 'approved' THEN
      RAISE EXCEPTION 'RFQ yalnızca onaylı talepten açılır' USING ERRCODE = 'ERP11';
    END IF;
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'RFQ açık olarak başlar' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.code <> OLD.code OR NEW.request_id <> OLD.request_id THEN
    RAISE EXCEPTION 'RFQ kodu ve talebi değiştirilemez' USING ERRCODE = 'ERP11';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Sonuçlanmış RFQ değiştirilemez' USING ERRCODE = 'ERP11';
  END IF;
  IF NEW.status = 'awarded' THEN
    IF NEW.awarded_offer_id IS NULL OR NOT EXISTS (SELECT 1 FROM rfq_offers WHERE id = NEW.awarded_offer_id AND rfq_id = NEW.id) THEN
      RAISE EXCEPTION 'Kazanan teklif bu RFQ''ya ait olmalı' USING ERRCODE = 'ERP11';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rfqs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rfqs
  FOR EACH ROW EXECUTE FUNCTION rfqs_guard();
--> statement-breakpoint

-- 4) Teklif ve satırı: yalnızca açık RFQ'da; teklif veren tedarikçi (supplier/both) olmalı
CREATE FUNCTION rfq_offers_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  q rfqs%ROWTYPE;
  pk text;
BEGIN
  SELECT * INTO q FROM rfqs WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.rfq_id ELSE NEW.rfq_id END FOR SHARE;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; -- cascade
  END IF;
  IF q.status <> 'open' THEN
    RAISE EXCEPTION 'Yalnızca açık RFQ''da teklif girilir veya değiştirilir' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk = 'customer' THEN
      RAISE EXCEPTION 'Teklif veren cari tedarikçi türünde olmalı' USING ERRCODE = 'ERP11';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rfq_offers_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rfq_offers
  FOR EACH ROW EXECUTE FUNCTION rfq_offers_guard();
--> statement-breakpoint
CREATE FUNCTION rfq_offer_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  q rfqs%ROWTYPE;
  oid uuid;
  line_req uuid;
BEGIN
  oid := CASE WHEN TG_OP = 'DELETE' THEN OLD.offer_id ELSE NEW.offer_id END;
  SELECT q2.* INTO q FROM rfqs q2 JOIN rfq_offers o ON o.rfq_id = q2.id WHERE o.id = oid FOR SHARE OF q2;
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; -- cascade
  END IF;
  IF q.status <> 'open' THEN
    RAISE EXCEPTION 'Yalnızca açık RFQ''nun teklif satırları değiştirilir' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT request_id INTO line_req FROM purchase_request_lines WHERE id = NEW.request_line_id;
    IF line_req IS DISTINCT FROM q.request_id THEN
      RAISE EXCEPTION 'Teklif satırı RFQ''nun talebine ait olmalı' USING ERRCODE = 'ERP11';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER rfq_offer_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON rfq_offer_lines
  FOR EACH ROW EXECUTE FUNCTION rfq_offer_lines_guard();
--> statement-breakpoint

-- 5) Sipariş
CREATE FUNCTION purchase_orders_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
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
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR pr.status IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye sipariş açılamaz' USING ERRCODE = 'ERP11';
    END IF;
    SELECT kind INTO pk FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk = 'customer' THEN
      RAISE EXCEPTION 'Sipariş tedarikçi türünde bir cariye verilir' USING ERRCODE = 'ERP11';
    END IF;
    IF NEW.request_id IS NOT NULL THEN
      SELECT * INTO rq FROM purchase_requests WHERE id = NEW.request_id AND company_id = NEW.company_id;
      IF NOT FOUND OR rq.status NOT IN ('approved', 'ordered') OR rq.project_id <> NEW.project_id THEN
        RAISE EXCEPTION 'Sipariş yalnızca aynı projenin onaylı talebinden oluşturulur' USING ERRCODE = 'ERP11';
      END IF;
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Sipariş taslak olarak açılır' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.code <> OLD.code OR NEW.project_id <> OLD.project_id OR NEW.party_id <> OLD.party_id THEN
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
CREATE TRIGGER purchase_orders_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();
--> statement-breakpoint

CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
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
  IF TG_OP <> 'DELETE' AND NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
CREATE TRIGGER purchase_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();
--> statement-breakpoint

-- 6) Mal kabul: yalnızca verilmiş siparişe; kayıtlar değişmez, yalnızca iptal; satırlar yalnızca eklenir
CREATE FUNCTION po_receipts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  o purchase_orders%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Mal kabul kaydı silinemez; iptal edilir' USING ERRCODE = 'ERP11';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO o FROM purchase_orders WHERE id = NEW.order_id AND company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND OR o.status <> 'issued' THEN
      RAISE EXCEPTION 'Mal kabul yalnızca verilmiş (açık) siparişe girilir' USING ERRCODE = 'ERP11';
    END IF;
    IF NEW.status <> 'posted' THEN
      RAISE EXCEPTION 'Mal kabul kaydedilmiş olarak girilir' USING ERRCODE = 'ERP11';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'posted' OR NEW.status <> 'cancelled'
     OR (to_jsonb(NEW) - 'status' - 'cancel_reason' - 'cancelled_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'cancel_reason' - 'cancelled_at') THEN
    RAISE EXCEPTION 'Mal kabul yalnızca iptal edilebilir' USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER po_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON po_receipts
  FOR EACH ROW EXECUTE FUNCTION po_receipts_guard();
--> statement-breakpoint

CREATE FUNCTION po_receipt_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  rc po_receipts%ROWTYPE;
  ol purchase_order_lines%ROWTYPE;
  received numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Mal kabul satırı değiştirilemez' USING ERRCODE = 'ERP11';
  END IF;
  SELECT * INTO rc FROM po_receipts WHERE id = NEW.receipt_id AND company_id = NEW.company_id;
  IF NOT FOUND OR rc.status <> 'posted' THEN
    RAISE EXCEPTION 'Satır kaydedilmiş bir mal kabule eklenir' USING ERRCODE = 'ERP11';
  END IF;
  SELECT * INTO ol FROM purchase_order_lines WHERE id = NEW.order_line_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND OR ol.order_id <> rc.order_id THEN
    RAISE EXCEPTION 'Satır, mal kabulün siparişine ait olmalı' USING ERRCODE = 'ERP11';
  END IF;
  SELECT coalesce(sum(l.quantity), 0) INTO received
    FROM po_receipt_lines l JOIN po_receipts r ON r.id = l.receipt_id
   WHERE l.order_line_id = NEW.order_line_id AND r.status = 'posted' AND l.id <> NEW.id;
  IF received + NEW.quantity > ol.quantity THEN
    RAISE EXCEPTION 'Kabul edilen miktar sipariş miktarını aşamaz' USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER po_receipt_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON po_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION po_receipt_lines_guard();
