-- =========================================================================
-- Lisanslama: yetkiler, lisans durumu tetikleyicisi (ERRCODE ERP08) ve şirket sayımı için SECURITY DEFINER işlevi.
-- license_state kiracı tablosu değildir (company_id yok, RLS yok): tek satırlık kuruluma özgü durumdur.
-- =========================================================================

-- 1) Yetkiler: erp_app okur, ekler ve günceller; SİLEMEZ.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON license_state TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 2) Kurallar: satır silinemez/boşaltılamaz, kurulum kimliği ve anahtarı sabit, saat işareti geri gitmez.
--    (Şema sahibi rol tetikleyiciyi devre dışı bırakabilir; bu, uygulama hesabının yanlışlıkla/kasıtlı değişikliğini önler,
--    asıl koruma kiranın imzalı olmasıdır.)
CREATE FUNCTION license_state_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Lisans durumu silinemez' USING ERRCODE = 'ERP08';
  END IF;
  IF NEW.installation_id <> OLD.installation_id OR NEW.public_key <> OLD.public_key OR NEW.private_key_pem <> OLD.private_key_pem THEN
    RAISE EXCEPTION 'Kurulum kimliği ve anahtarı değiştirilemez' USING ERRCODE = 'ERP08';
  END IF;
  IF NEW.high_water < OLD.high_water THEN
    RAISE EXCEPTION 'Saat işareti geri alınamaz' USING ERRCODE = 'ERP08';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER license_state_guard
  BEFORE UPDATE OR DELETE ON license_state
  FOR EACH ROW EXECUTE FUNCTION license_state_guard();
--> statement-breakpoint
CREATE TRIGGER license_state_no_truncate
  BEFORE TRUNCATE ON license_state
  FOR EACH STATEMENT EXECUTE FUNCTION license_state_guard();
--> statement-breakpoint

-- 3) Kuruluma göre toplam şirket sayısı (şirket sınırı için). `companies` tablosu RLS ile kuruluş bazında yalıtıldığından,
--    tüm kuruluşları sayabilmek için tek amaçlı, yalnızca sayı döndüren SECURITY DEFINER işlev kullanılır.
CREATE FUNCTION license_company_count() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT count(*)::integer FROM companies $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION license_company_count() FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION license_company_count() TO erp_app;
  END IF;
END
$$;
