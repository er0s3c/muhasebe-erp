-- Uzaktan güncelleme sürümleri: çalışma zamanı rolü taslak sürümü silebilir; yayımlanmış sürüm silinmez (geri çekilir).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON releases TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
CREATE FUNCTION releases_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Yayımlanmış sürüm silinemez; geri çekilir' USING ERRCODE = 'LIC03';
    END IF;
    RETURN OLD;
  END IF;
  -- İmzalı manifesto ve dosya listesi yayımdan sonra değişmez (kurulumlar bu özetlere güvenir)
  IF OLD.status <> 'draft' AND (NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.files IS DISTINCT FROM OLD.files OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'Yayımlanmış sürümün içeriği değiştirilemez' USING ERRCODE = 'LIC03';
  END IF;
  IF OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'Geri çekilen sürüm yeniden yayımlanamaz; yeni sürüm numarası verin' USING ERRCODE = 'LIC03';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER releases_guard BEFORE UPDATE OR DELETE ON releases
  FOR EACH ROW EXECUTE FUNCTION releases_guard();
