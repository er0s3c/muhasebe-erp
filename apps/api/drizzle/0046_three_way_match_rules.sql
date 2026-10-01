-- =========================================================================
-- Üçlü eşleştirme (sipariş – mal kabul – fatura): tolerans tablosu için RLS/yetki/denetim ve alış faturası satırının
-- sipariş bağı koruması (ERRCODE ERP11 → API'de 422 PROCUREMENT_RULE_VIOLATION).
-- =========================================================================

ALTER TABLE procurement_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON procurement_settings
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE TRIGGER audit_procurement_settings AFTER INSERT OR UPDATE OR DELETE ON procurement_settings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON procurement_settings TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Sipariş bağlı fatura satırı: yalnızca alış faturası, siparişin tedarikçisi ve para birimi, verilmiş/kapatılmış sipariş.
CREATE FUNCTION invoice_lines_po_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  inv invoices%ROWTYPE;
  o purchase_orders%ROWTYPE;
BEGIN
  IF NEW.po_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.po_line_id IS NOT DISTINCT FROM OLD.po_line_id THEN
    RETURN NEW;
  END IF;
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id;
  SELECT po.* INTO o FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.order_id WHERE pl.id = NEW.po_line_id;
  IF inv.type <> 'purchase' THEN
    RAISE EXCEPTION 'Sipariş bağı yalnızca alış faturasında kullanılır' USING ERRCODE = 'ERP11';
  END IF;
  IF o.party_id <> inv.party_id THEN
    RAISE EXCEPTION 'Faturanın cari hesabı siparişin tedarikçisiyle aynı olmalı' USING ERRCODE = 'ERP11';
  END IF;
  IF o.currency_code <> inv.currency_code THEN
    RAISE EXCEPTION 'Fatura para birimi siparişin para birimiyle aynı olmalı' USING ERRCODE = 'ERP11';
  END IF;
  IF o.status NOT IN ('issued', 'closed') THEN
    RAISE EXCEPTION 'Yalnızca verilmiş ya da kapatılmış siparişe fatura bağlanır' USING ERRCODE = 'ERP11';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_po_guard BEFORE INSERT OR UPDATE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_po_guard();
