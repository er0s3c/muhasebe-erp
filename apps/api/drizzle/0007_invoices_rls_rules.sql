-- =========================================================================
-- Fatura ve hesap eşlemesi: RLS, yetki, denetim izi, varsayılan eşlemeler ve iş kuralları.
-- Fatura kuralları ERRCODE ERP03 ile yükselir (API'de 422 INVOICE_RULE_VIOLATION);
-- ERP01 defter (yevmiye), ERP02 stok kuralları içindir.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_mappings', 'invoices', 'invoice_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2) Yetkiler (erp_app şema sahibi değildir)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON account_mappings, invoices, invoice_lines TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Denetim izi (fatura satırları taslakta sık değişir; başlık ve eşleme izlenir)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_mappings', 'invoices'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 4) Mevcut şirketler için varsayılan hesap eşlemesi (hesap planında bulunanlar; stok hesabı sektöre göre).
--    Varsayılanlar genel Tekdüzen yapıya dayanır ve mali müşavirce doğrulanmamıştır.
INSERT INTO account_mappings (id, company_id, key, account_id)
SELECT gen_random_uuid(), c.id, m.key, a.id
FROM companies c
CROSS JOIN (VALUES
  ('receivable', '120'), ('payable', '320'), ('sales_revenue', '600'), ('sales_return', '610'),
  ('cogs', '621'), ('stock', '150'), ('vat_output', '391'), ('vat_input', '191'),
  ('default_expense', '632'), ('stock_gain', '649'), ('stock_loss', '659'),
  ('consumption', '710'), ('opening_offset', '500')
) AS m(key, code)
JOIN accounts a ON a.company_id = c.id
 AND a.code = CASE WHEN m.key = 'stock' AND c.sector <> 'CONSTRUCTION' THEN '153' ELSE m.code END
ON CONFLICT (company_id, key) DO NOTHING;
--> statement-breakpoint

-- 5) Fatura başlığı: taslak dışı silinemez; kaydedilmiş fatura yalnızca iptal alanlarıyla değişir;
--    kaydedilirken satır toplamları, yevmiye kaynağı ve cari tutar başlıkla tutarlı olmalı.
CREATE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  l_net numeric;
  l_vat numeric;
  l_gross numeric;
  l_count int;
  party_base numeric;
  je journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Fatura önce taslak olarak oluşturulmalı' USING ERRCODE = 'ERP03';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Kaydedilmiş fatura silinemez; iptal edin' USING ERRCODE = 'ERP03';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş fatura değiştirilemez' USING ERRCODE = 'ERP03';
  END IF;

  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - 'status' - 'updated_at' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason'
                         - 'cancel_journal_entry_id' - 'cancel_stock_document_id')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'updated_at' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason'
                         - 'cancel_journal_entry_id' - 'cancel_stock_document_id') THEN
      RAISE EXCEPTION 'Kaydedilmiş fatura değiştirilemez; iptal edin' USING ERRCODE = 'ERP03';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'draft'
  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'Taslak fatura iptal edilemez; silin' USING ERRCODE = 'ERP03';
  END IF;
  IF NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'Fatura türü değiştirilemez' USING ERRCODE = 'ERP03';
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT count(*), coalesce(sum(net), 0), coalesce(sum(vat), 0), coalesce(sum(gross), 0)
      INTO l_count, l_net, l_vat, l_gross
      FROM invoice_lines WHERE invoice_id = NEW.id;
    IF l_count = 0 THEN
      RAISE EXCEPTION 'Faturada satır yok' USING ERRCODE = 'ERP03';
    END IF;
    IF l_net <> NEW.net_total OR l_vat <> NEW.vat_total OR l_gross <> NEW.gross_total THEN
      RAISE EXCEPTION 'Fatura toplamları satır toplamlarıyla uyuşmuyor' USING ERRCODE = 'ERP03';
    END IF;
    IF NEW.gross_total = 0 THEN
      RAISE EXCEPTION 'Fatura tutarı sıfır olamaz' USING ERRCODE = 'ERP03';
    END IF;

    SELECT * INTO je FROM journal_entries WHERE id = NEW.journal_entry_id AND company_id = NEW.company_id;
    IF NOT FOUND OR je.status <> 'posted' OR je.source_type IS DISTINCT FROM 'invoice' OR je.source_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'Fatura yevmiyesi bulunamadı veya bu faturaya ait değil' USING ERRCODE = 'ERP03';
    END IF;
    -- Cari (kontrol hesabı) satırlarının defter tutarı, faturanın brüt tutarına eşit olmalı
    SELECT coalesce(sum(l.debit_base + l.credit_base), 0) INTO party_base
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = NEW.journal_entry_id AND a.party_control IS NOT NULL;
    IF party_base <> NEW.gross_total_base THEN
      RAISE EXCEPTION 'Cari tutarı (%) fatura brüt tutarıyla (%) uyuşmuyor', party_base, NEW.gross_total_base
        USING ERRCODE = 'ERP03';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();
--> statement-breakpoint

-- 6) Fatura satırları: yalnızca taslak faturada eklenir/değişir/silinir
CREATE FUNCTION invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM invoices
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  -- Üst kayıt yoksa (taslak silinirken cascade) izin ver; kayıtlı/iptalse engelle.
  IF FOUND AND s <> 'draft' THEN
    RAISE EXCEPTION 'Kaydedilmiş faturanın satırları değiştirilemez' USING ERRCODE = 'ERP03';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();
