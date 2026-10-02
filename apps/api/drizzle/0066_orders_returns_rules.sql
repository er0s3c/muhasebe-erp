-- =========================================================================
-- İade irsaliyesi, satış teklif/siparişi, toplu faturalama (Faz X2): RLS, yetki, denetim izi ve iş kuralları.
-- Teklif/sipariş/toplu faturalama kuralları ERRCODE ERP15 ile yükselir (API'de 422 SALES_RULE_VIOLATION);
-- iade irsaliyesi kuralları mevcut irsaliye kodunu (ERP04), fatura bağı kuralları fatura kodunu (ERP03) kullanır.
-- Durum geçişleri uygulama kodundaki tabloyla (shared/sales-order-calc.ts) birebir aynıdır.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik ve denetim izi (başlıklar izlenir; satırlar taslakta sık değişir)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_orders', 'sales_order_lines', 'sales_order_events', 'invoice_batches', 'invoice_batch_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['sales_orders', 'invoice_batches'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2) Yetkiler (erp_app şema sahibi değildir). Olaylar ve toplu işlem kalemleri yalnızca eklenir.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON sales_orders, sales_order_lines TO erp_app;
    GRANT SELECT, INSERT ON sales_order_events, invoice_batch_items TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON invoice_batches TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Durum geçiş tablosu (teklif ve sipariş)
CREATE FUNCTION sales_transition_ok(k text, f text, t text) RETURNS boolean LANGUAGE sql IMMUTABLE AS
$$
  SELECT CASE k
    WHEN 'quote' THEN
      (f = 'draft' AND t IN ('sent', 'cancelled'))
      OR (f = 'sent' AND t IN ('accepted', 'rejected', 'cancelled', 'draft'))
      OR (f = 'accepted' AND t IN ('converted', 'cancelled'))
    WHEN 'order' THEN
      (f = 'draft' AND t IN ('confirmed', 'cancelled'))
      OR (f = 'confirmed' AND t IN ('closed', 'cancelled'))
    ELSE false
  END
$$;
--> statement-breakpoint

-- 4) Sipariş satırı kullanımı: kaydedilmiş irsaliyelerden teslim, kaydedilmiş faturalardan faturalanan ve bunun irsaliyesiz (doğrudan) kısmı.
--    p_note / p_invoice: kaydedilmekte olan belge (henüz taslak görünür) kendini sayar.
CREATE FUNCTION sales_order_line_usage(p_line uuid, p_note uuid, p_invoice uuid, OUT delivered numeric, OUT invoiced numeric, OUT direct numeric)
LANGUAGE plpgsql AS
$$
BEGIN
  SELECT coalesce(sum(l.quantity), 0) INTO delivered
    FROM delivery_note_lines l JOIN delivery_notes n ON n.id = l.note_id
   WHERE l.sales_order_line_id = p_line AND (n.status = 'posted' OR n.id = p_note);
  SELECT coalesce(sum(l.quantity), 0), coalesce(sum(l.quantity) FILTER (WHERE l.delivery_line_id IS NULL), 0)
    INTO invoiced, direct
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
   WHERE l.sales_order_line_id = p_line AND (i.status = 'posted' OR i.id = p_invoice);
END
$$;
--> statement-breakpoint

-- 5) İrsaliye başlığı: iade irsaliyesi (stok yönü, orijinal irsaliye bağı, iade miktarı sınırı), sipariş bağı ve iade edilmiş irsaliyenin iptali
CREATE OR REPLACE FUNCTION delivery_notes_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  sd stock_documents%ROWTYPE;
  orig delivery_notes%ROWTYPE;
  l_count int;
  l_qty numeric;
  l_value numeric;
  l_adjust numeric;
  l_unset int;
  m_qty numeric;
  m_value numeric;
  m_adjust numeric;
  billed int;
  u record;
  so_id uuid;
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
    -- Faturalama, iade ve iptal aynı satır kilitlerinden geçer: biri bitmeden diğeri ilerlemez
    PERFORM 1 FROM delivery_note_lines WHERE note_id = OLD.id ORDER BY id FOR UPDATE;
    SELECT count(*) INTO billed
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      JOIN delivery_note_lines dl ON dl.id = il.delivery_line_id
     WHERE dl.note_id = OLD.id AND i.status = 'posted';
    IF billed > 0 THEN
      RAISE EXCEPTION 'Faturalanmış irsaliye iptal edilemez; önce faturayı iptal edin' USING ERRCODE = 'ERP04';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM delivery_note_lines rl
        JOIN delivery_notes rn ON rn.id = rl.note_id
        JOIN delivery_note_lines ol ON ol.id = rl.source_line_id
       WHERE ol.note_id = OLD.id AND rn.status = 'posted'
    ) THEN
      RAISE EXCEPTION 'İade irsaliyesi kesilmiş irsaliye iptal edilemez; önce iade irsaliyesini iptal edin' USING ERRCODE = 'ERP04';
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
       OR sd.type NOT IN ('issue', 'receipt')
       OR (sd.type = 'issue') <> (NEW.type IN ('sales', 'purchase_return'))
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

    -- İade irsaliyesi: orijinal irsaliye kaydedilmiş, aynı cari ve karşı yönde olmalı; iade edilen toplam teslim edileni aşamaz
    IF NEW.type IN ('sales_return', 'purchase_return') THEN
      IF NEW.return_of_id IS NOT NULL THEN
        SELECT * INTO orig FROM delivery_notes WHERE id = NEW.return_of_id AND company_id = NEW.company_id;
        IF NOT FOUND OR orig.status <> 'posted' OR orig.party_id <> NEW.party_id
           OR orig.type <> (CASE NEW.type WHEN 'sales_return' THEN 'sales' ELSE 'purchase' END) THEN
          RAISE EXCEPTION 'İade irsaliyesinin orijinali kaydedilmiş, aynı cariye ait ve karşı türde bir irsaliye olmalı' USING ERRCODE = 'ERP04';
        END IF;
      END IF;
      IF EXISTS (SELECT 1 FROM delivery_note_lines WHERE note_id = NEW.id AND source_line_id IS NOT NULL) THEN
        IF NEW.return_of_id IS NULL THEN
          RAISE EXCEPTION 'Satır bağı için orijinal irsaliye seçilmeli' USING ERRCODE = 'ERP04';
        END IF;
        PERFORM 1 FROM delivery_note_lines
         WHERE id IN (SELECT source_line_id FROM delivery_note_lines WHERE note_id = NEW.id AND source_line_id IS NOT NULL)
         ORDER BY id FOR UPDATE;
        IF EXISTS (
          SELECT 1
            FROM delivery_note_lines rl JOIN delivery_note_lines ol ON ol.id = rl.source_line_id
           WHERE rl.note_id = NEW.id AND (ol.note_id <> NEW.return_of_id OR ol.item_id <> rl.item_id)
        ) THEN
          RAISE EXCEPTION 'İade satırı orijinal irsaliyenin aynı kartlı satırına bağlı olmalı' USING ERRCODE = 'ERP04';
        END IF;
        IF EXISTS (
          SELECT 1 FROM delivery_note_lines ol
           WHERE ol.id IN (SELECT source_line_id FROM delivery_note_lines WHERE note_id = NEW.id AND source_line_id IS NOT NULL)
             AND ol.quantity < (
               SELECT coalesce(sum(x.quantity), 0)
                 FROM delivery_note_lines x JOIN delivery_notes xn ON xn.id = x.note_id
                WHERE x.source_line_id = ol.id AND (xn.status = 'posted' OR xn.id = NEW.id))
        ) THEN
          RAISE EXCEPTION 'İade miktarı orijinal irsaliyede teslim edilen miktarı aşıyor' USING ERRCODE = 'ERP04';
        END IF;
      END IF;
    END IF;

    -- Satış siparişi bağı: onaylı sipariş, aynı cari ve kart; teslim edilen miktar sipariş miktarını aşamaz
    IF EXISTS (SELECT 1 FROM delivery_note_lines WHERE note_id = NEW.id AND sales_order_line_id IS NOT NULL) THEN
      IF NEW.type <> 'sales' THEN
        RAISE EXCEPTION 'Sipariş bağı yalnızca satış irsaliyesinde kullanılır' USING ERRCODE = 'ERP04';
      END IF;
      PERFORM 1 FROM sales_order_lines
       WHERE id IN (SELECT sales_order_line_id FROM delivery_note_lines WHERE note_id = NEW.id AND sales_order_line_id IS NOT NULL)
       ORDER BY id FOR UPDATE;
      IF EXISTS (
        SELECT 1
          FROM delivery_note_lines dl
          JOIN sales_order_lines ol ON ol.id = dl.sales_order_line_id
          JOIN sales_orders o ON o.id = ol.order_id
         WHERE dl.note_id = NEW.id
           AND (o.kind <> 'order' OR o.status <> 'confirmed' OR o.party_id <> NEW.party_id OR ol.item_id IS DISTINCT FROM dl.item_id)
      ) THEN
        RAISE EXCEPTION 'Sipariş bağı geçersiz: onaylı sipariş, aynı cari ve aynı kart olmalı' USING ERRCODE = 'ERP04';
      END IF;
      FOR so_id IN
        SELECT DISTINCT sales_order_line_id FROM delivery_note_lines WHERE note_id = NEW.id AND sales_order_line_id IS NOT NULL
      LOOP
        SELECT * INTO u FROM sales_order_line_usage(so_id, NEW.id, NULL);
        IF (SELECT quantity FROM sales_order_lines WHERE id = so_id) < u.delivered + u.direct THEN
          RAISE EXCEPTION 'Sipariş satırı için teslim edilen miktar sipariş miktarını aşıyor' USING ERRCODE = 'ERP04';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- 6) İrsaliye satırları: yalnızca taslak irsaliyede değişir; yalnızca stoklu mal kartı; yalnızca alış irsaliyesinde maliyet;
--    satır bağları yalnızca uygun irsaliye türünde.
CREATE OR REPLACE FUNCTION delivery_note_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
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
  IF n.type <> 'purchase' AND (NEW.unit_cost IS NOT NULL OR NEW.currency_code IS NOT NULL OR NEW.fx_rate IS NOT NULL) THEN
    RAISE EXCEPTION 'Bu irsaliye türünde maliyet girilmez' USING ERRCODE = 'ERP04';
  END IF;
  IF NEW.source_line_id IS NOT NULL AND (n.type NOT IN ('sales_return', 'purchase_return') OR n.return_of_id IS NULL) THEN
    RAISE EXCEPTION 'Satır bağı yalnızca orijinal irsaliyesi seçilmiş iade irsaliyesinde kullanılır' USING ERRCODE = 'ERP04';
  END IF;
  IF NEW.sales_order_line_id IS NOT NULL AND n.type <> 'sales' THEN
    RAISE EXCEPTION 'Sipariş bağı yalnızca satış irsaliyesinde kullanılır' USING ERRCODE = 'ERP04';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- 7) Fatura başlığı koruması genişler: iade irsaliyesine bağlı iade faturası; satış siparişi bağı (onaylı/kapanmış sipariş, aynı cari ve kart,
--    faturalanan miktar sipariş miktarını, irsaliyeli teslim + doğrudan faturalama sipariş miktarını aşamaz).
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  l_net numeric;
  l_vat numeric;
  l_gross numeric;
  l_count int;
  party_base numeric;
  je journal_entries%ROWTYPE;
  so_id uuid;
  u record;
  so_qty numeric;
  so_goods boolean;
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

    -- İrsaliyeye bağlı satırlar (satış/alış irsaliyesi ya da iade irsaliyesi → aynı türde fatura)
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id AND delivery_line_id IS NOT NULL) THEN
      IF NEW.type = 'expense' THEN
        RAISE EXCEPTION 'İrsaliye bağı gider faturasında kullanılamaz' USING ERRCODE = 'ERP03';
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

    -- Satış siparişine bağlı satırlar
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.id AND sales_order_line_id IS NOT NULL) THEN
      IF NEW.type <> 'sales' THEN
        RAISE EXCEPTION 'Sipariş bağı yalnızca satış faturasında kullanılır' USING ERRCODE = 'ERP03';
      END IF;
      PERFORM 1 FROM sales_order_lines
       WHERE id IN (SELECT sales_order_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND sales_order_line_id IS NOT NULL)
       ORDER BY id FOR UPDATE;
      IF EXISTS (
        SELECT 1
          FROM invoice_lines il
          JOIN sales_order_lines ol ON ol.id = il.sales_order_line_id
          JOIN sales_orders o ON o.id = ol.order_id
         WHERE il.invoice_id = NEW.id
           AND (o.kind <> 'order' OR o.status NOT IN ('confirmed', 'closed') OR o.party_id <> NEW.party_id
                OR ol.item_id IS DISTINCT FROM il.item_id)
      ) THEN
        RAISE EXCEPTION 'Sipariş bağı geçersiz: onaylı sipariş, aynı cari ve aynı kart olmalı' USING ERRCODE = 'ERP03';
      END IF;
      FOR so_id IN
        SELECT DISTINCT sales_order_line_id FROM invoice_lines WHERE invoice_id = NEW.id AND sales_order_line_id IS NOT NULL
      LOOP
        SELECT * INTO u FROM sales_order_line_usage(so_id, NULL, NEW.id);
        SELECT ol.quantity, coalesce(it.kind = 'goods', false) INTO so_qty, so_goods
          FROM sales_order_lines ol LEFT JOIN items it ON it.id = ol.item_id WHERE ol.id = so_id;
        IF so_qty < u.invoiced THEN
          RAISE EXCEPTION 'Sipariş satırı için faturalanan miktar sipariş miktarını aşıyor' USING ERRCODE = 'ERP03';
        END IF;
        IF so_goods AND so_qty < u.delivered + u.direct THEN
          RAISE EXCEPTION 'Sipariş satırı için teslim edilen ve doğrudan faturalanan miktar sipariş miktarını aşıyor' USING ERRCODE = 'ERP03';
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- 8) Toplu faturalama: aynı irsaliye satırı, taslak ya da kaydedilmiş iki toplu faturada yer alamaz (iptal edilen fatura satırı serbest bırakır).
CREATE FUNCTION invoice_lines_batch_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  bi invoice_batch_items%ROWTYPE;
BEGIN
  IF NEW.batch_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.delivery_line_id IS NULL THEN
    RAISE EXCEPTION 'Toplu fatura satırı irsaliye satırına bağlı olmalı' USING ERRCODE = 'ERP15';
  END IF;
  SELECT * INTO bi FROM invoice_batch_items WHERE id = NEW.batch_item_id AND company_id = NEW.company_id;
  IF NOT FOUND OR bi.status <> 'created' THEN
    RAISE EXCEPTION 'Toplu işlem kalemi bulunamadı ya da başarısız' USING ERRCODE = 'ERP15';
  END IF;
  -- Aynı satırda eşzamanlı iki toplu faturalama sıraya girer
  PERFORM 1 FROM delivery_note_lines WHERE id = NEW.delivery_line_id FOR UPDATE;
  IF EXISTS (
    SELECT 1
      FROM invoice_lines x JOIN invoices i ON i.id = x.invoice_id
     WHERE x.delivery_line_id = NEW.delivery_line_id AND x.batch_item_id IS NOT NULL AND x.id <> NEW.id
       AND i.status IN ('draft', 'posted')
  ) THEN
    RAISE EXCEPTION 'Bu irsaliye satırı başka bir toplu faturada zaten yer alıyor' USING ERRCODE = 'ERP15';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_batch_guard
  BEFORE INSERT OR UPDATE OF batch_item_id ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_batch_guard();
--> statement-breakpoint

-- 9) Toplu işlem başlığı yalnızca sayaçlarıyla değişir, silinmez; kalemleri yalnızca eklenir.
CREATE FUNCTION invoice_batches_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Toplu faturalama kaydı silinemez' USING ERRCODE = 'ERP15';
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'invoices_created' - 'invoices_failed') IS DISTINCT FROM (to_jsonb(OLD) - 'invoices_created' - 'invoices_failed') THEN
    RAISE EXCEPTION 'Toplu faturalama kaydı yalnızca sonuç sayaçlarıyla güncellenir' USING ERRCODE = 'ERP15';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_batches_guard
  BEFORE UPDATE OR DELETE ON invoice_batches
  FOR EACH ROW EXECUTE FUNCTION invoice_batches_guard();
--> statement-breakpoint
CREATE FUNCTION invoice_batch_items_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'Toplu faturalama sonuç kaydı değiştirilemez ve silinemez' USING ERRCODE = 'ERP15';
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_batch_items_guard
  BEFORE UPDATE OR DELETE ON invoice_batch_items
  FOR EACH ROW EXECUTE FUNCTION invoice_batch_items_guard();
--> statement-breakpoint

-- 10) Teklif/sipariş başlığı: kimlik/tür değişmez; taslak dışında gövde donar; durum yalnızca geçerli geçişle ve aynı işlemde yazılmış olayla değişir;
--     taslaktan çıkış satır, numara ve toplam tutarlılığı ister; teslim/faturalı sipariş iptal edilemez; teklif ancak siparişe dönüştüğünde 'converted' olur.
CREATE FUNCTION sales_orders_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  q sales_orders%ROWTYPE;
  l_count int;
  l_net numeric;
  l_vat numeric;
  l_gross numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.doc_no IS NOT NULL THEN
      RAISE EXCEPTION 'Numaralanmış ya da taslak dışındaki teklif/sipariş silinemez; iptal edin' USING ERRCODE = 'ERP15';
    END IF;
    IF OLD.quote_id IS NOT NULL THEN
      RAISE EXCEPTION 'Tekliften oluşan sipariş silinemez; iptal edin' USING ERRCODE = 'ERP15';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Teklif/sipariş önce taslak olarak oluşturulmalı' USING ERRCODE = 'ERP15';
    END IF;
    IF NEW.quote_id IS NOT NULL THEN
      SELECT * INTO q FROM sales_orders WHERE id = NEW.quote_id AND company_id = NEW.company_id;
      IF NEW.kind <> 'order' OR NOT FOUND OR q.kind <> 'quote' OR q.status <> 'accepted' OR q.party_id <> NEW.party_id THEN
        RAISE EXCEPTION 'Sipariş yalnızca aynı carinin kabul edilmiş teklifinden oluşturulur' USING ERRCODE = 'ERP15';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'Teklif/sipariş türü değiştirilemez' USING ERRCODE = 'ERP15';
  END IF;
  IF OLD.doc_no IS NOT NULL AND NEW.doc_no IS DISTINCT FROM OLD.doc_no THEN
    RAISE EXCEPTION 'Verilen numara değiştirilemez' USING ERRCODE = 'ERP15';
  END IF;
  IF OLD.status <> 'draft'
     AND (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION 'Taslak dışındaki teklif/sipariş değiştirilemez' USING ERRCODE = 'ERP15';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT sales_transition_ok(NEW.kind, OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'Geçersiz durum geçişi: % -> %', OLD.status, NEW.status USING ERRCODE = 'ERP15';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM sales_order_events e
       WHERE e.order_id = NEW.id AND e.company_id = NEW.company_id AND e.from_status = OLD.status AND e.to_status = NEW.status
         AND e.created_at = now()
    ) THEN
      RAISE EXCEPTION 'Durum değişikliği için aynı işlemde olay (geçmiş) kaydı gerekir' USING ERRCODE = 'ERP15';
    END IF;
    IF OLD.status = 'draft' AND NEW.status <> 'cancelled' THEN
      SELECT count(*), coalesce(sum(net), 0), coalesce(sum(vat), 0), coalesce(sum(gross), 0)
        INTO l_count, l_net, l_vat, l_gross FROM sales_order_lines WHERE order_id = NEW.id;
      IF l_count = 0 THEN
        RAISE EXCEPTION 'Satırı olmayan teklif/sipariş gönderilemez ya da onaylanamaz' USING ERRCODE = 'ERP15';
      END IF;
      IF l_net <> NEW.net_total OR l_vat <> NEW.vat_total OR l_gross <> NEW.gross_total THEN
        RAISE EXCEPTION 'Toplamlar satır toplamlarıyla uyuşmuyor' USING ERRCODE = 'ERP15';
      END IF;
      IF NEW.doc_no IS NULL THEN
        RAISE EXCEPTION 'Numara verilmeden taslaktan çıkılamaz' USING ERRCODE = 'ERP15';
      END IF;
    END IF;
    IF NEW.status = 'cancelled' AND NEW.kind = 'order' AND OLD.status = 'confirmed' THEN
      PERFORM 1 FROM sales_order_lines WHERE order_id = NEW.id ORDER BY id FOR UPDATE;
      IF EXISTS (
        SELECT 1 FROM delivery_note_lines dl JOIN delivery_notes n ON n.id = dl.note_id
          JOIN sales_order_lines ol ON ol.id = dl.sales_order_line_id
         WHERE ol.order_id = NEW.id AND n.status = 'posted'
      ) OR EXISTS (
        SELECT 1 FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
          JOIN sales_order_lines ol ON ol.id = il.sales_order_line_id
         WHERE ol.order_id = NEW.id AND i.status = 'posted'
      ) THEN
        RAISE EXCEPTION 'Teslim edilmiş ya da faturalanmış sipariş iptal edilemez; kapatın' USING ERRCODE = 'ERP15';
      END IF;
    END IF;
    IF NEW.status = 'converted' AND NOT EXISTS (
      SELECT 1 FROM sales_orders o WHERE o.quote_id = NEW.id AND o.company_id = NEW.company_id AND o.kind = 'order'
    ) THEN
      RAISE EXCEPTION 'Teklif yalnızca siparişe dönüştürülürken "dönüştürüldü" olur' USING ERRCODE = 'ERP15';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_orders_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION sales_orders_guard();
--> statement-breakpoint

-- 11) Teklif/sipariş satırları yalnızca taslakta eklenir/değişir/silinir
CREATE FUNCTION sales_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM sales_orders
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  -- Üst kayıt yoksa (taslak silinirken cascade) izin ver
  IF FOUND AND s <> 'draft' THEN
    RAISE EXCEPTION 'Taslak dışındaki teklif/sipariş satırları değiştirilemez' USING ERRCODE = 'ERP15';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION sales_order_lines_guard();
--> statement-breakpoint

-- 12) Olay geçmişi: yalnızca eklenir; önceki durum belgenin o anki durumudur ve geçiş geçerlidir.
CREATE FUNCTION sales_order_events_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  o sales_orders%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Teklif/sipariş geçmişi değiştirilemez ve silinemez' USING ERRCODE = 'ERP15';
  END IF;
  SELECT * INTO o FROM sales_orders WHERE id = NEW.order_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Teklif/sipariş bulunamadı' USING ERRCODE = 'ERP15';
  END IF;
  IF NEW.from_status IS DISTINCT FROM o.status OR NOT sales_transition_ok(o.kind, NEW.from_status, NEW.to_status) THEN
    RAISE EXCEPTION 'Olay, belgenin mevcut durumundan geçerli bir geçişi göstermeli (% -> %)', NEW.from_status, NEW.to_status USING ERRCODE = 'ERP15';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER sales_order_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_order_events
  FOR EACH ROW EXECUTE FUNCTION sales_order_events_guard();
