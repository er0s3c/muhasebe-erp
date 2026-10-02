-- =========================================================================
-- Fiyat listeleri, cari özel fiyat/iskonto ve seri no takibi (Faz X3): RLS, yetki, denetim izi ve iş kuralları.
-- Fiyat kuralları ERRCODE ERP16 (API'de 422 PRICE_RULE_VIOLATION), seri no kuralları ERP17 (422 SERIAL_RULE_VIOLATION) ile yükselir.
-- Seri durumu yalnızca salt-eklenir seri hareketiyle (serial_events) ve tetikleyici içinden değişir; stok hareketi ile seri sayısı eşleşmelidir.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik ve denetim izi (fiyat satırı değişiklikleri izlenir)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_lists', 'price_list_items', 'party_prices', 'item_serials', 'serial_events', 'document_line_serials'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['price_lists', 'price_list_items', 'party_prices'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2) Yetkiler (erp_app şema sahibi değildir). Seri hareketleri yalnızca eklenir; sicil satırı silinmez.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON price_lists, price_list_items, party_prices TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON item_serials TO erp_app;
    GRANT SELECT, INSERT ON serial_events TO erp_app;
    GRANT USAGE, SELECT ON SEQUENCE serial_events_seq_seq TO erp_app;
    GRANT SELECT, INSERT, DELETE ON document_line_serials TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Tekillik (ifade içeren indeksler) ve biçim kuralları
CREATE UNIQUE INDEX "price_list_items_uq" ON "price_list_items" USING btree ("price_list_id", "item_id", "min_qty", (coalesce("valid_from", '0001-01-01'::date)));--> statement-breakpoint
CREATE UNIQUE INDEX "party_prices_uq" ON "party_prices" USING btree ("party_id", "item_id", "kind", "min_qty", (coalesce("valid_from", '0001-01-01'::date)));--> statement-breakpoint
ALTER TABLE items ADD CONSTRAINT items_serial_goods_ck CHECK (NOT tracks_serial OR kind = 'goods');--> statement-breakpoint
ALTER TABLE item_serials ADD CONSTRAINT item_serials_format_ck CHECK (serial_no <> '' AND serial_no = upper(btrim(serial_no)));--> statement-breakpoint
ALTER TABLE document_line_serials ADD CONSTRAINT document_line_serials_format_ck CHECK (serial_no <> '' AND serial_no = upper(btrim(serial_no)));--> statement-breakpoint

-- 4) Fiyat listesi: tür ve para birimi satırı olan listede değişmez (fiyatların anlamı kayar)
CREATE FUNCTION price_lists_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM price_list_items WHERE price_list_id = OLD.id) THEN
      RAISE EXCEPTION 'Fiyat satırı olan liste silinemez; pasifleştirin' USING ERRCODE = 'ERP16';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.kind <> OLD.kind OR NEW.currency_code <> OLD.currency_code)
     AND EXISTS (SELECT 1 FROM price_list_items WHERE price_list_id = OLD.id) THEN
    RAISE EXCEPTION 'Fiyat satırı olan listenin türü ve para birimi değiştirilemez' USING ERRCODE = 'ERP16';
  END IF;
  IF NEW.is_default AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'Pasif liste şirket varsayılanı olamaz' USING ERRCODE = 'ERP16';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER price_lists_guard BEFORE INSERT OR UPDATE OR DELETE ON price_lists
  FOR EACH ROW EXECUTE FUNCTION price_lists_guard();
--> statement-breakpoint

-- 5) Cariye atanan liste ilgili türde olmalı
CREATE FUNCTION parties_price_list_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.sales_price_list_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM price_lists WHERE id = NEW.sales_price_list_id AND company_id = NEW.company_id AND kind = 'sales') THEN
    RAISE EXCEPTION 'Satış fiyat listesi olarak bir satış listesi seçilmeli' USING ERRCODE = 'ERP16';
  END IF;
  IF NEW.purchase_price_list_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM price_lists WHERE id = NEW.purchase_price_list_id AND company_id = NEW.company_id AND kind = 'purchase') THEN
    RAISE EXCEPTION 'Alış fiyat listesi olarak bir alış listesi seçilmeli' USING ERRCODE = 'ERP16';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER parties_price_list_guard BEFORE INSERT OR UPDATE OF sales_price_list_id, purchase_price_list_id ON parties
  FOR EACH ROW EXECUTE FUNCTION parties_price_list_guard();
--> statement-breakpoint

-- 6) Cari özel fiyatı: satış fiyatı müşteri/ikisi, alış fiyatı tedarikçi/ikisi olan cariye girilir
CREATE FUNCTION party_prices_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE k text;
BEGIN
  SELECT kind INTO k FROM parties WHERE id = NEW.party_id AND company_id = NEW.company_id;
  IF k IS NULL OR (NEW.kind = 'sales' AND k = 'supplier') OR (NEW.kind = 'purchase' AND k = 'customer') THEN
    RAISE EXCEPTION 'Cari özel fiyatın türü carinin türüyle uyuşmuyor' USING ERRCODE = 'ERP16';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER party_prices_guard BEFORE INSERT OR UPDATE ON party_prices
  FOR EACH ROW EXECUTE FUNCTION party_prices_guard();
--> statement-breakpoint

-- 7) Stok kartı: seri takibi bayrağı hareketi olan kartta değişmez (eski hareketlerin serisi yoktur)
CREATE FUNCTION items_serial_flag_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.tracks_serial IS DISTINCT FROM OLD.tracks_serial
     AND (EXISTS (SELECT 1 FROM stock_movements WHERE item_id = OLD.id) OR EXISTS (SELECT 1 FROM stock_count_lines WHERE item_id = OLD.id)) THEN
    RAISE EXCEPTION 'Hareketi olan kartın seri takibi değiştirilemez' USING ERRCODE = 'ERP17';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER items_serial_flag_guard BEFORE UPDATE OF tracks_serial ON items
  FOR EACH ROW EXECUTE FUNCTION items_serial_flag_guard();
--> statement-breakpoint

-- 8) Seri sicili: satır yalnızca 'pending' olarak doğar; durum/depo yalnızca seri hareketi tetikleyicisinden (iç içe tetikleyici) değişir; silinmez.
CREATE FUNCTION item_serials_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE tracked boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Seri no sicili silinemez' USING ERRCODE = 'ERP17';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT tracks_serial INTO tracked FROM items WHERE id = NEW.item_id AND company_id = NEW.company_id;
    IF NOT coalesce(tracked, false) THEN
      RAISE EXCEPTION 'Stok kartı seri takipli değil' USING ERRCODE = 'ERP17';
    END IF;
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'Seri no yalnızca giriş hareketiyle sicile eklenir' USING ERRCODE = 'ERP17';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.item_id <> OLD.item_id OR NEW.serial_no <> OLD.serial_no OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Seri no ve kart değiştirilemez' USING ERRCODE = 'ERP17';
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Seri durumu yalnızca seri hareketiyle değişir' USING ERRCODE = 'ERP17';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER item_serials_guard BEFORE INSERT OR UPDATE OR DELETE ON item_serials
  FOR EACH ROW EXECUTE FUNCTION item_serials_guard();
--> statement-breakpoint

-- İşlem sonunda 'pending' kalmış (hareketi yazılmamış) sicil satırı olamaz
CREATE FUNCTION item_serials_pending_check() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM item_serials WHERE id = NEW.id AND status = 'pending') THEN
    RAISE EXCEPTION 'Seri no % için giriş hareketi yazılmamış', NEW.serial_no USING ERRCODE = 'ERP17';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER item_serials_pending_check AFTER INSERT ON item_serials
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION item_serials_pending_check();
--> statement-breakpoint

-- 9) Seri hareketi: salt-eklenir; önceki durum sicildeki güncel durumdur; geçiş geçerli olmalı; sicil durumu bu tetikleyicide ilerler.
--    Ters hareket, tersine çevrilen hareketin tam tersi ve ters stok belgesine bağlı olmalıdır.
CREATE FUNCTION serial_events_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  s item_serials%ROWTYPE;
  o serial_events%ROWTYPE;
  d stock_documents%ROWTYPE;
  ok boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Seri hareketleri değiştirilemez veya silinemez' USING ERRCODE = 'ERP17';
  END IF;
  SELECT * INTO s FROM item_serials WHERE id = NEW.serial_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND OR s.item_id <> NEW.item_id THEN
    RAISE EXCEPTION 'Seri no bulunamadı' USING ERRCODE = 'ERP17';
  END IF;
  SELECT * INTO d FROM stock_documents WHERE id = NEW.stock_document_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Seri hareketi bir stok belgesine bağlı olmalı' USING ERRCODE = 'ERP17';
  END IF;
  IF s.status <> NEW.from_status OR s.warehouse_id IS DISTINCT FROM NEW.from_warehouse_id THEN
    RAISE EXCEPTION 'Seri no % bu durumda değil (sicilde: %, istenen: %)', s.serial_no, s.status, NEW.from_status USING ERRCODE = 'ERP17';
  END IF;

  IF NEW.event = 'reversal' THEN
    SELECT * INTO o FROM serial_events WHERE id = NEW.reversal_of_id AND company_id = NEW.company_id;
    IF NOT FOUND OR o.serial_id <> NEW.serial_id OR o.event = 'reversal'
       OR d.reversal_of_id IS DISTINCT FROM o.stock_document_id
       OR NEW.from_status <> o.to_status OR NEW.from_warehouse_id IS DISTINCT FROM o.to_warehouse_id
       OR NEW.to_status <> (CASE o.from_status WHEN 'pending' THEN 'void' ELSE o.from_status END)
       OR NEW.to_warehouse_id IS DISTINCT FROM o.from_warehouse_id THEN
      RAISE EXCEPTION 'Ters seri hareketi tersine çevrilen hareketin tam tersi olmalı' USING ERRCODE = 'ERP17';
    END IF;
  ELSE
    ok := CASE NEW.event
      WHEN 'receive' THEN NEW.from_status IN ('pending', 'returned') AND NEW.to_status = 'in_stock'
        AND NEW.from_warehouse_id IS NULL AND NEW.to_warehouse_id IS NOT NULL
      WHEN 'issue' THEN NEW.from_status = 'in_stock' AND NEW.to_status = 'issued'
        AND NEW.from_warehouse_id IS NOT NULL AND NEW.to_warehouse_id IS NULL
      WHEN 'return_in' THEN NEW.from_status = 'issued' AND NEW.to_status = 'in_stock'
        AND NEW.from_warehouse_id IS NULL AND NEW.to_warehouse_id IS NOT NULL
      WHEN 'return_out' THEN NEW.from_status = 'in_stock' AND NEW.to_status = 'returned'
        AND NEW.from_warehouse_id IS NOT NULL AND NEW.to_warehouse_id IS NULL
      WHEN 'scrap' THEN NEW.from_status = 'in_stock' AND NEW.to_status = 'scrapped'
        AND NEW.from_warehouse_id IS NOT NULL AND NEW.to_warehouse_id IS NULL
      WHEN 'transfer' THEN NEW.from_status = 'in_stock' AND NEW.to_status = 'in_stock'
        AND NEW.from_warehouse_id IS NOT NULL AND NEW.to_warehouse_id IS NOT NULL AND NEW.from_warehouse_id <> NEW.to_warehouse_id
      ELSE false
    END;
    IF NOT ok THEN
      RAISE EXCEPTION 'Geçersiz seri hareketi: % (% -> %)', NEW.event, NEW.from_status, NEW.to_status USING ERRCODE = 'ERP17';
    END IF;
    IF d.reversal_of_id IS NOT NULL THEN
      RAISE EXCEPTION 'Ters stok belgesine yalnızca ters seri hareketi bağlanır' USING ERRCODE = 'ERP17';
    END IF;
  END IF;

  UPDATE item_serials SET status = NEW.to_status, warehouse_id = NEW.to_warehouse_id, updated_at = now() WHERE id = s.id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER serial_events_guard BEFORE INSERT OR UPDATE OR DELETE ON serial_events
  FOR EACH ROW EXECUTE FUNCTION serial_events_guard();
--> statement-breakpoint

-- 10) Stok hareketi satırı: seri takipli kartta miktar tam sayı ve satırın seri hareketi sayısına eşit olmalı; depolar uyuşmalı.
--     (Hareket eklenmeden önce seri hareketleri yazılır; bu tetikleyici hareket eklendikten sonra çalışır.)
CREATE FUNCTION stock_movements_serial_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  tracked boolean;
  t text;
  need numeric;
  n int;
  bad int;
BEGIN
  IF NEW.kind <> 'qty' THEN
    RETURN NEW;
  END IF;
  SELECT tracks_serial INTO tracked FROM items WHERE id = NEW.item_id AND company_id = NEW.company_id;
  SELECT type INTO t FROM stock_documents WHERE id = NEW.document_id AND company_id = NEW.company_id;
  IF NOT coalesce(tracked, false) THEN
    RETURN NEW;
  END IF;
  -- Transferde yalnızca çıkış satırı sayılır (giriş satırı aynı seri hareketini paylaşır)
  IF t = 'transfer' AND NEW.qty > 0 THEN
    RETURN NEW;
  END IF;
  need := abs(NEW.qty);
  IF need <> trunc(need) THEN
    RAISE EXCEPTION 'Seri takipli kartta miktar tam sayı olmalı (satır %)', NEW.line_no USING ERRCODE = 'ERP17';
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE (NEW.qty < 0 AND from_warehouse_id IS DISTINCT FROM NEW.warehouse_id)
                             OR (NEW.qty > 0 AND to_warehouse_id IS DISTINCT FROM NEW.warehouse_id))
    INTO n, bad
    FROM serial_events
   WHERE stock_document_id = NEW.document_id AND company_id = NEW.company_id AND line_no = NEW.line_no AND item_id = NEW.item_id;
  IF n <> need THEN
    RAISE EXCEPTION 'Seri takipli satırda miktar (%) ile seri no sayısı (%) eşit olmalı (satır %)', need, n, NEW.line_no USING ERRCODE = 'ERP17';
  END IF;
  IF bad > 0 THEN
    RAISE EXCEPTION 'Seri hareketinin deposu stok hareketinin deposuyla uyuşmuyor (satır %)', NEW.line_no USING ERRCODE = 'ERP17';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_serial_guard AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_serial_guard();
--> statement-breakpoint

-- 11) Taslak satıra girilen seri no'lar: yalnızca taslak irsaliye/fatura satırına, yalnızca seri takipli kart için eklenir; sonradan değiştirilemez.
CREATE FUNCTION document_line_serials_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  st text;
  tracked boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Satıra girilen seri no değiştirilemez; silip yeniden girin' USING ERRCODE = 'ERP17';
  END IF;
  IF NEW.delivery_line_id IS NOT NULL THEN
    SELECT n.status, i.tracks_serial INTO st, tracked
      FROM delivery_note_lines l JOIN delivery_notes n ON n.id = l.note_id JOIN items i ON i.id = l.item_id
     WHERE l.id = NEW.delivery_line_id AND l.company_id = NEW.company_id;
  ELSE
    SELECT n.status, i.tracks_serial INTO st, tracked
      FROM invoice_lines l JOIN invoices n ON n.id = l.invoice_id JOIN items i ON i.id = l.item_id
     WHERE l.id = NEW.invoice_line_id AND l.company_id = NEW.company_id;
  END IF;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Seri no yalnızca taslak belge satırına girilir' USING ERRCODE = 'ERP17';
  END IF;
  IF NOT coalesce(tracked, false) THEN
    RAISE EXCEPTION 'Satırın stok kartı seri takipli değil' USING ERRCODE = 'ERP17';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER document_line_serials_guard BEFORE INSERT OR UPDATE ON document_line_serials
  FOR EACH ROW EXECUTE FUNCTION document_line_serials_guard();
