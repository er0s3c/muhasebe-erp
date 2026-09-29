-- =========================================================================
-- Stok: RLS, yetki, denetim izi, değiştirilemez stok defteri ve iş kuralları
-- Stok kuralları ERRCODE ERP02 ile yükselir (API'de 422 STOCK_RULE_VIOLATION);
-- ERP01 defter (yevmiye) kuralları içindir.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'item_categories', 'warehouses', 'items', 'stock_documents', 'stock_movements',
    'stock_counts', 'stock_count_lines'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2) Yetkiler (erp_app şema sahibi değildir). Stok defterinde silme/güncelleme yetkisi hiç yok;
--    belge başlığı yalnızca reversed_by_id için güncellenebilir (tetikleyici de denetler).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      item_categories, warehouses, items, stock_counts, stock_count_lines TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON stock_documents TO erp_app;
    GRANT SELECT, INSERT ON stock_movements TO erp_app;
    GRANT USAGE, SELECT ON SEQUENCE stock_movements_seq_seq TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Denetim izi (hareket satırları zaten değiştirilemez bir kayıttır; sayım satırları taslakta sık değişir)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item_categories', 'warehouses', 'items', 'stock_documents', 'stock_counts'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 4) Mevcut şirketler için varsayılan depo
INSERT INTO warehouses (id, company_id, code, name, is_default)
SELECT gen_random_uuid(), c.id, 'ANA', 'Ana depo', true FROM companies c;
--> statement-breakpoint

-- 5) Stok belgesi: tarih/dönem uyumu ve açık dönem şartı; silinemez, yalnızca reversed_by_id dolabilir
CREATE FUNCTION stock_documents_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  p fiscal_periods%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO p FROM fiscal_periods WHERE id = NEW.period_id AND company_id = NEW.company_id;
    IF NOT FOUND OR NEW.doc_date < p.start_date OR NEW.doc_date > p.end_date THEN
      RAISE EXCEPTION 'Stok belgesi tarihi dönemiyle uyuşmuyor' USING ERRCODE = 'ERP02';
    END IF;
    IF p.status <> 'open' THEN
      RAISE EXCEPTION 'Dönem kapalı: %-%', p.year, lpad(p.month::text, 2, '0') USING ERRCODE = 'ERP02';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stok belgesi silinemez; ters belge oluşturun' USING ERRCODE = 'ERP02';
  END IF;

  -- UPDATE: yalnızca reversed_by_id (boş -> dolu) değişebilir
  IF OLD.reversed_by_id IS NOT NULL
     OR (to_jsonb(NEW) - 'reversed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_id') THEN
    RAISE EXCEPTION 'Stok belgesi değiştirilemez; ters belge oluşturun' USING ERRCODE = 'ERP02';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_documents_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_documents
  FOR EACH ROW EXECUTE FUNCTION stock_documents_guard();
--> statement-breakpoint

-- 6) Stok hareketi: ürün satırını kilitler (aynı ürüne paralel hareketler sıraya girer),
--    hizmet kaleminin hareket görmesini ve negatif bakiyeyi (ayar kapalıyken) engeller.
CREATE FUNCTION stock_movements_insert_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  it items%ROWTYPE;
  d stock_documents%ROWTYPE;
  allow_neg boolean;
  bal numeric;
BEGIN
  SELECT * INTO it FROM items WHERE id = NEW.item_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stok kartı bulunamadı' USING ERRCODE = 'ERP02';
  END IF;
  IF it.kind <> 'goods' THEN
    RAISE EXCEPTION 'Hizmet kalemi stok hareketi görmez: %', it.code USING ERRCODE = 'ERP02';
  END IF;

  SELECT * INTO d FROM stock_documents WHERE id = NEW.document_id AND company_id = NEW.company_id;
  IF NOT FOUND OR d.doc_date <> NEW.movement_date THEN
    RAISE EXCEPTION 'Hareket tarihi belge tarihiyle uyuşmuyor' USING ERRCODE = 'ERP02';
  END IF;

  IF NEW.qty < 0 THEN
    SELECT allow_negative_stock INTO allow_neg FROM companies WHERE id = NEW.company_id;
    IF NOT coalesce(allow_neg, false) THEN
      SELECT coalesce(sum(qty), 0) INTO bal FROM stock_movements
       WHERE company_id = NEW.company_id AND item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id;
      IF bal + NEW.qty < 0 THEN
        RAISE EXCEPTION 'Yetersiz stok: % (depoda %, çıkış %)', it.code, bal, -NEW.qty
          USING ERRCODE = 'ERP02';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_insert_guard
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_insert_guard();
--> statement-breakpoint

CREATE FUNCTION stock_movements_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'Stok hareketleri değiştirilemez; ters belge oluşturun' USING ERRCODE = 'ERP02';
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_immutable();
--> statement-breakpoint

-- 7) Sayım: kaydedilmiş sayım ve satırları değiştirilemez (taslak -> kayıtlı geçişi serbest)
CREATE FUNCTION stock_counts_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Sayım önce taslak olarak oluşturulmalı' USING ERRCODE = 'ERP02';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Kaydedilmiş sayım değiştirilemez veya silinemez' USING ERRCODE = 'ERP02';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_counts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION stock_counts_guard();
--> statement-breakpoint

CREATE FUNCTION stock_count_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM stock_counts
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.count_id ELSE NEW.count_id END;
  -- Üst kayıt yoksa (taslak silinirken cascade) izin ver; kayıtlıysa engelle.
  IF FOUND AND s <> 'draft' THEN
    RAISE EXCEPTION 'Kaydedilmiş sayımın satırları değiştirilemez' USING ERRCODE = 'ERP02';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_count_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION stock_count_lines_guard();
