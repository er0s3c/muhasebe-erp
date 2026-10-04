-- =========================================================================
-- Bildirimler: RLS, yetki ve iş kuralları (ERRCODE ERP25 -> API'de 422 NOTIFICATION_RULE_VIOLATION).
-- Bildirim satırı kullanıcıya adreslidir: tenant_isolation (şirket) + kısıtlayıcı kullanıcı politikası (kullanıcı yalnızca kendi satırını
-- görür/yazar). Zamanlayıcı her kullanıcı için o kullanıcının bağlamında (app.user_id) yazar; RLS'i aşan yol YOKTUR. Yalnızca iki tek
-- amaçlı SECURITY DEFINER işlevi vardır: şirket kimliklerini listeleyen (zamanlayıcı şirketleri tek tek gezer) ve süresi dolan KAPANMIŞ
-- bildirimleri budayan (yalnızca app_company_id() şirketinde).
-- =========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences', 'notification_digests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
    EXECUTE format(
      'CREATE POLICY user_owner ON %I AS RESTRICTIVE USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    -- Silme yetkisi yoktur: kapanmış bildirimler yalnızca notification_prune ile (aşağıda) silinir
    GRANT SELECT, INSERT, UPDATE ON notifications, notification_preferences TO erp_app;
    GRANT SELECT, INSERT ON notification_digests TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- ---- Bildirim koruyucusu --------------------------------------------------------------------------------------------
-- Eklenirken açık (okunmamış, kapatılmamış, çözülmemiş) ve şirketin üyesine adreslidir. Sonradan yalnızca okundu / kapatıldı / çözüldü
-- işaretleri değişir (içerik, tür, önem, bağlantı, sayı, anahtar, gün, sahibi değişmez; okundu ve kapatıldı geri alınmaz; çözüldü
-- koşul yeniden doğunca açılır). Yalnızca kapanmış satır silinebilir.
CREATE FUNCTION notifications_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.read_at IS NOT NULL OR NEW.dismissed_at IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'Bildirim açık (okunmamış, çözülmemiş) olarak oluşturulur' USING ERRCODE = 'ERP25';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = NEW.company_id AND m.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'Bildirim yalnızca şirketin üyesine adreslenir' USING ERRCODE = 'ERP25';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.read_at IS NULL AND OLD.dismissed_at IS NULL AND OLD.resolved_at IS NULL THEN
      RAISE EXCEPTION 'Açık bildirim silinemez; önce okunmalı, kapatılmalı ya da çözülmelidir' USING ERRCODE = 'ERP25';
    END IF;
    RETURN OLD;
  END IF;

  IF (to_jsonb(NEW) - 'read_at' - 'dismissed_at' - 'resolved_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at' - 'dismissed_at' - 'resolved_at') THEN
    RAISE EXCEPTION 'Bildirimin içeriği değiştirilemez; yalnızca okundu, kapatıldı ya da çözüldü işaretlenir' USING ERRCODE = 'ERP25';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'Okundu işareti geri alınamaz' USING ERRCODE = 'ERP25';
  END IF;
  IF OLD.dismissed_at IS NOT NULL AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at THEN
    RAISE EXCEPTION 'Kapatıldı işareti geri alınamaz' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER notifications_guard
  BEFORE INSERT OR UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_guard();
--> statement-breakpoint

-- Tercih ve özet kaydı: şirket/kullanıcı kimliği sonradan değişmez
CREATE FUNCTION notification_aux_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.user_id <> OLD.user_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'Tercihin şirketi, kullanıcısı ve türü değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER notification_preferences_guard
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION notification_aux_guard();
--> statement-breakpoint

-- ---- Tek amaçlı SECURITY DEFINER işlevleri ------------------------------------------------------------------------
-- Şirket kimliklerini listeler (kuruluş RLS'ini aşar; yalnızca iki kimlik döndürür). Zamanlayıcı her şirkete ayrı işlemde,
-- o şirketin kendi RLS bağlamıyla (app.org_id + app.company_id) girer; şirket verisi bu işlevden okunmaz.
CREATE FUNCTION notification_scan_targets() RETURNS TABLE (company_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT c.id, c.organization_id FROM companies c ORDER BY c.created_at, c.id $$;
--> statement-breakpoint

-- Saklama süresi (gün) dolan KAPANMIŞ (okunmuş / kapatılmış / çözülmüş) bildirimleri ve eski özet kayıtlarını siler; açık bildirime
-- dokunmaz (yalnız artık üye/etkin olmayan kullanıcıların açık bildirimlerini çözer). Yalnızca etkin şirket bağlamında (app_company_id()) çalışır; bağlam yoksa hiçbir şey yapmaz. Silinen bildirim sayısını döndürür.
CREATE FUNCTION notification_prune(p_days integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  cid uuid := app_company_id();
  cutoff timestamptz;
  n integer;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    RAISE EXCEPTION 'Saklama süresi en az 1 gün olmalı' USING ERRCODE = 'ERP25';
  END IF;
  IF cid IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := now() - make_interval(days => p_days);
  -- Artık taranmayan (üyelikten çıkarılmış ya da pasifleştirilmiş) kullanıcıların açık bildirimleri çözülür; yaşları dolunca silinir
  UPDATE notifications n SET resolved_at = now()
   WHERE n.company_id = cid AND n.resolved_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = n.company_id AND m.user_id = n.user_id AND u.is_active);
  DELETE FROM notifications
   WHERE company_id = cid AND greatest(read_at, dismissed_at, resolved_at) < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM notification_digests WHERE company_id = cid AND sent_at < cutoff;
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION notification_scan_targets() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION notification_prune(integer) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION notification_scan_targets() TO erp_app;
    GRANT EXECUTE ON FUNCTION notification_prune(integer) TO erp_app;
  END IF;
END
$$;
