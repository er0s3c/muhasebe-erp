-- =========================================================================
-- İrsaliye: RLS, yetki, denetim izi ve iş kuralları.
-- İrsaliye kuralları ERRCODE ERP04 ile yükselir (API'de 422 DELIVERY_RULE_VIOLATION);
-- ERP01 defter, ERP02 stok, ERP03 fatura kuralları içindir.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['delivery_notes', 'delivery_note_lines'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_notes, delivery_note_lines TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Denetim izi (satırlar taslakta sık değişir; başlık izlenir)
CREATE TRIGGER audit_delivery_notes
  AFTER INSERT OR UPDATE OR DELETE ON delivery_notes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint

-- 4) İrsaliye başlığı: taslak dışı silinemez; kaydedilmiş irsaliye yalnızca iptal alanlarıyla değişir;
--    kaydedilirken stok belgesi (kaynak, yön, depo, tarih, miktar ve değer) satırlarla tutarlı olmalı;
--    faturaya bağlanmış irsaliye iptal edilemez.
CREATE FUNCTION delivery_notes_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sd stock_documents%ROWTYPE;
  l_count int;
  l_qty numeric;
  l_value numeric;
  l_adjust numeric;
  l_unset int;
  m_qty numeric;
  m_value numeric;
  m_adjust numeric;
  billed int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'İrsaliye önce taslak olarak oluşturulmalı' USING ERRCODE = 'ERP04';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Kaydedilmiş irsaliye silinemez; iptal edin' USING ERRCODE = 'ERP04';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş irsaliye değiştirilemez' USING ERRCODE = 'ERP04';
  END IF;

  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'cancelled'
       OR (to_jsonb(NEW) - 'status' - 'updated_at' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason' - 'cancel_stock_document_id')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'status' - 'updated_at' - 'cancelled_at' - 'cancelled_by' - 'cancel_reason' - 'cancel_stock_document_id') THEN
      RAISE EXCEPTION 'Kaydedilmiş irsaliye değiştirilemez; iptal edin' USING ERRCODE = 'ERP04';
    END IF;
    -- Faturalama ile iptal aynı satır kilitlerinden geçer: biri bitmeden diğeri ilerlemez
    PERFORM 1 FROM delivery_note_lines WHERE note_id = OLD.id ORDER BY id FOR UPDATE;
    SELECT count(*) INTO billed
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      JOIN delivery_note_lines dl ON dl.id = il.delivery_line_id
     WHERE dl.note_id = OLD.id AND i.status = 'posted';
    IF billed > 0 THEN
      RAISE EXCEPTION 'Faturalanmış irsaliye iptal edilemez; önce faturayı iptal edin' USING ERRCODE = 'ERP04';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD.status = 'draft'
  IF NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'Taslak irsaliye iptal edilemez; silin' USING ERRCODE = 'ERP04';
  END IF;
  IF NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'İrsaliye türü değiştirilemez' USING ERRCODE = 'ERP04';
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT count(*), coalesce(sum(quantity), 0), coalesce(sum(stock_value), 0), coalesce(sum(adjust_value), 0),
           count(*) FILTER (WHERE stock_value IS NULL OR adjust_value IS NULL)
      INTO l_count, l_qty, l_value, l_adjust, l_unset
      FROM delivery_note_lines WHERE note_id = NEW.id;
    IF l_count = 0 THEN
      RAISE EXCEPTION 'İrsaliyede satır yok' USING ERRCODE = 'ERP04';
    END IF;
    IF l_unset > 0 THEN
      RAISE EXCEPTION 'İrsaliye satırlarının stok değeri yazılmamış' USING ERRCODE = 'ERP04';
    END IF;

    SELECT * INTO sd FROM stock_documents WHERE id = NEW.stock_document_id AND company_id = NEW.company_id;
    IF NOT FOUND
       OR sd.source_type IS DISTINCT FROM 'delivery_note' OR sd.source_id IS DISTINCT FROM NEW.id
       OR sd.reversal_of_id IS NOT NULL
       OR sd.type NOT IN ('issue', 'receipt') OR (sd.type = 'issue') <> (NEW.type = 'sales')
       OR sd.warehouse_id <> NEW.warehouse_id OR sd.doc_date <> NEW.note_date THEN
      RAISE EXCEPTION 'İrsaliye stok belgesi bulunamadı veya bu irsaliyeye ait değil' USING ERRCODE = 'ERP04';
    END IF;

    -- Stok defteri ile satırlar aynı miktar ve değeri taşımalı
    SELECT coalesce(sum(abs(qty)) FILTER (WHERE kind = 'qty'), 0),
           coalesce(sum(abs(value)) FILTER (WHERE kind = 'qty'), 0),
           coalesce(sum(value) FILTER (WHERE kind = 'cost_adjust'), 0)
      INTO m_qty, m_value, m_adjust
      FROM stock_movements WHERE document_id = NEW.stock_document_id;
    IF m_qty <> l_qty OR m_value <> l_value OR m_adjust <> l_adjust THEN
      RAISE EXCEPTION 'İrsaliye satırları stok defteriyle uyuşmuyor (miktar %/%, değer %/%)', l_qty, m_qty, l_value, m_value
        USING ERRCODE = 'ERP04';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER delivery_notes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON delivery_notes
  FOR EACH ROW EXECUTE FUNCTION delivery_notes_guard();
--> statement-breakpoint

-- 5) İrsaliye satırları: yalnızca taslak irsaliyede eklenir/değişir/silinir; yalnızca stoklu mal kartı;
--    satış irsaliyesinde maliyet girilmez.
CREATE FUNCTION delivery_note_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  n delivery_notes%ROWTYPE;
  k text;
BEGIN
  SELECT * INTO n FROM delivery_notes
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.note_id ELSE NEW.note_id END;
  -- Üst kayıt yoksa (taslak silinirken cascade) izin ver; kayıtlı/iptalse engelle.
  IF FOUND AND n.status <> 'draft' THEN
    RAISE EXCEPTION 'Kaydedilmiş irsaliyenin satırları değiştirilemez' USING ERRCODE = 'ERP04';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT kind INTO k FROM items WHERE id = NEW.item_id AND company_id = NEW.company_id;
  IF k IS DISTINCT FROM 'goods' THEN
    RAISE EXCEPTION 'İrsaliye yalnızca stoklu mal kartlarıyla düzenlenir' USING ERRCODE = 'ERP04';
  END IF;
  IF n.type = 'sales' AND (NEW.unit_cost IS NOT NULL OR NEW.currency_code IS NOT NULL OR NEW.fx_rate IS NOT NULL) THEN
    RAISE EXCEPTION 'Satış irsaliyesinde maliyet girilmez' USING ERRCODE = 'ERP04';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER delivery_note_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON delivery_note_lines
  FOR EACH ROW EXECUTE FUNCTION delivery_note_lines_guard();
--> statement-breakpoint

-- 6) Fatura başlığı koruması genişler: irsaliyeye bağlı satırlar kaydedilirken irsaliye kaydedilmiş, aynı cari,
--    aynı yön ve aynı kart olmalı; faturalanan toplam miktar irsaliye miktarını aşamaz (satırlar kilitlenir).
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS
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

    -- İrsaliyeye bağlı satırlar
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL) THEN
      IF NEW.type NOT IN ('sales', 'purchase') THEN
        RAISE EXCEPTION 'İrsaliye bağı yalnızca satış ve alış faturasında kullanılır' USING ERRCODE = 'ERP03';
      END IF;
      -- Aynı irsaliye satırına paralel faturalama ve irsaliye iptali sıraya girer
      PERFORM 1 FROM delivery_note_lines
       WHERE id IN (SELECT delivery_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL)
       ORDER BY id FOR UPDATE;
      IF EXISTS (
        SELECT 1
          FROM invoice_lines il
          JOIN delivery_note_lines dl ON dl.id = il.delivery_line_id
          JOIN delivery_notes n ON n.id = dl.note_id
         WHERE il.invoice_id = NEW.id
           AND (n.status <> 'posted' OR n.party_id <> NEW.party_id OR n.type <> NEW.type
                OR dl.item_id IS DISTINCT FROM il.item_id)
      ) THEN
        RAISE EXCEPTION 'İrsaliye bağı geçersiz: irsaliye kaydedilmiş, aynı cari, aynı yön ve aynı kart olmalı'
          USING ERRCODE = 'ERP03';
      END IF;
      IF EXISTS (
        SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL
           AND (delivery_value IS NULL OR delivery_adjust IS NULL)
      ) THEN
        RAISE EXCEPTION 'Bağlı fatura satırının irsaliye payı yazılmamış' USING ERRCODE = 'ERP03';
      END IF;
      IF EXISTS (
        SELECT 1 FROM delivery_note_lines dl
         WHERE dl.id IN (SELECT delivery_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL)
           AND dl.quantity < (
             SELECT coalesce(sum(x.quantity), 0)
               FROM invoice_lines x JOIN invoices xi ON xi.id = x.invoice_id
              WHERE x.delivery_line_id = dl.id AND (xi.status = 'posted' OR xi.id = NEW.id))
      ) THEN
        RAISE EXCEPTION 'İrsaliye satırı için faturalanan miktar irsaliye miktarını aşıyor' USING ERRCODE = 'ERP03';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
