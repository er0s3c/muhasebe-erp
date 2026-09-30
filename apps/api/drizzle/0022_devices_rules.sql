-- =========================================================================
-- Cihaz koltukları: yetkiler ve kurallar (ERRCODE ERP08, lisans durumu kurallarıyla aynı aile).
-- devices kiracı tablosu değildir (company_id yok, RLS yok): kuruluma özgü koltuk kaydıdır.
-- =========================================================================

-- 1) Yetkiler: erp_app okur, ekler, günceller; SİLEMEZ (cihaz kaydı iptal edilir, silinmez).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON devices TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 2) Kurallar: silinemez/boşaltılamaz, gizli değer sabit, iptal geri alınamaz (iptal edilen cihaz yeniden etkinleşmez;
--    tarayıcı yeni bir cihaz olarak, boş koltuk varsa kaydolur).
CREATE FUNCTION devices_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Cihaz kayıtları silinemez; cihaz iptal edilir' USING ERRCODE = 'ERP08';
  END IF;
  IF NEW.secret_hash <> OLD.secret_hash THEN
    RAISE EXCEPTION 'Cihaz gizli değeri değiştirilemez' USING ERRCODE = 'ERP08';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NULL OR NEW.revoked_at <> OLD.revoked_at) THEN
    RAISE EXCEPTION 'İptal edilen cihaz yeniden etkinleştirilemez' USING ERRCODE = 'ERP08';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER devices_guard
  BEFORE UPDATE OR DELETE ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_guard();
--> statement-breakpoint
CREATE TRIGGER devices_no_truncate
  BEFORE TRUNCATE ON devices
  FOR EACH STATEMENT EXECUTE FUNCTION devices_guard();
