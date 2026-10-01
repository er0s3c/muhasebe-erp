-- =========================================================================
-- Faz B kapanışı: KDV tevkifatı ve malzeme mahsubu — RLS, yetki, denetim izi, hesap eşlemesi geri doldurma, iş kuralları (ERP10).
-- Taşerona verilen malzeme kaydı yalnızca eklenir; bağlı stok belgesi ters çevrilemez; hakedişte mahsup bakiyeyi aşamaz.
-- =========================================================================

ALTER TABLE subcontract_material_issues ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subcontract_material_issues
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
CREATE TRIGGER audit_subcontract_material_issues
  AFTER INSERT OR UPDATE OR DELETE ON subcontract_material_issues
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    -- Malzeme verme kaydı yalnızca eklenir
    GRANT SELECT, INSERT ON subcontract_material_issues TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Mevcut şirketler için yeni hesap eşlemeleri (genel Tekdüzen yapıya dayanır, doğrulanmamıştır)
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES
  ('vat_withholding_payable', '360'),
  ('vat_withholding_receivable', '136')
) AS m(key, code)
JOIN accounts a ON a.company_id = c.id AND a.code = m.code
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- Malzeme verme kaydı: taşeron sözleşmesi yürürlükte; bağlı belge proje etiketli, kaydedilmiş bir stok sarfı; bedel çıkış maliyetidir
CREATE FUNCTION subcontract_material_issues_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sc subcontracts%ROWTYPE;
  doc stock_documents%ROWTYPE;
  out_value numeric;
  bad int;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Taşerona verilen malzeme kaydı değiştirilemez' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO sc FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND OR sc.status <> 'active' THEN
    RAISE EXCEPTION 'Malzeme yalnızca yürürlükteki sözleşmeye verilir' USING ERRCODE = 'ERP10';
  END IF;
  IF sc.direction <> 'payable' THEN
    RAISE EXCEPTION 'Malzeme verme yalnızca taşeron sözleşmesinde olur' USING ERRCODE = 'ERP10';
  END IF;
  SELECT * INTO doc FROM stock_documents WHERE id = NEW.stock_document_id AND company_id = NEW.company_id;
  IF NOT FOUND OR doc.type <> 'issue' OR doc.reversal_of_id IS NOT NULL OR doc.reversed_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'Malzeme, ters çevrilmemiş bir stok sarf belgesine bağlı olmalı' USING ERRCODE = 'ERP10';
  END IF;
  SELECT count(*) INTO bad FROM stock_movements m
   WHERE m.document_id = doc.id AND m.kind = 'qty' AND m.project_id IS DISTINCT FROM sc.project_id;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Stok sarfı sözleşmenin projesine etiketli olmalı' USING ERRCODE = 'ERP10';
  END IF;
  SELECT abs(coalesce(sum(m.value), 0)) INTO out_value FROM stock_movements m WHERE m.document_id = doc.id;
  IF out_value <> NEW.amount_base THEN
    RAISE EXCEPTION 'Malzeme bedeli stok çıkış maliyetine eşit olmalı' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER subcontract_material_issues_guard
  BEFORE INSERT OR UPDATE OR DELETE ON subcontract_material_issues
  FOR EACH ROW EXECUTE FUNCTION subcontract_material_issues_guard();
--> statement-breakpoint

-- Malzeme verilen stok belgesi ters çevrilemez (malzeme kaydı bakiyeye dayanır)
CREATE FUNCTION stock_documents_material_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM subcontract_material_issues i WHERE i.stock_document_id = NEW.id) THEN
    RAISE EXCEPTION 'Taşerona verilen malzemeye bağlı stok belgesi ters çevrilemez' USING ERRCODE = 'ERP10';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_documents_material_guard
  BEFORE UPDATE ON stock_documents
  FOR EACH ROW EXECUTE FUNCTION stock_documents_material_guard();
--> statement-breakpoint

-- Hakedişte malzeme mahsubu: kaydedilince toplam mahsup, verilen malzeme bedelini aşamaz (sözleşme kilitli)
CREATE FUNCTION progress_payments_material_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  given numeric;
  recouped numeric;
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' AND NEW.material > 0 THEN
    PERFORM 1 FROM subcontracts WHERE id = NEW.subcontract_id AND company_id = NEW.company_id FOR UPDATE;
    SELECT coalesce(sum(amount), 0) INTO given FROM subcontract_material_issues WHERE subcontract_id = NEW.subcontract_id;
    SELECT coalesce(sum(material), 0) INTO recouped FROM progress_payments
     WHERE subcontract_id = NEW.subcontract_id AND status = 'posted' AND id <> NEW.id;
    IF recouped + NEW.material > given THEN
      RAISE EXCEPTION 'Malzeme mahsubu, taşerona verilen malzeme bakiyesini aşamaz' USING ERRCODE = 'ERP10';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER progress_payments_material_guard
  BEFORE UPDATE ON progress_payments
  FOR EACH ROW EXECUTE FUNCTION progress_payments_material_guard();
