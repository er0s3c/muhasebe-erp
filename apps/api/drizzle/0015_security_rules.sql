-- =========================================================================
-- Güvenlik sağlamlaştırması: yenileme token'ı temizliği ve salt-eklenir denetim kaydı.
-- ERRCODE ERP07 = denetim kaydı kuralı (API'de 422 AUDIT_RULE_VIOLATION).
-- =========================================================================

-- 1) Süresi dolan/eski iptal edilmiş yenileme token'ları girişte temizlenir (kullanıcı başına).
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT DELETE ON refresh_tokens TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 2) Denetim kaydı yalnızca eklenir: değiştirme ve silme şema sahibi rolü için de reddedilir.
--    (Saklama süresi dolan kayıtları budamak bilinçli bir bakım işidir: tetikleyici geçici olarak devre dışı bırakılır,
--    bkz. docs/OPERATIONS.md.) Toplu TRUNCATE ve şemanın bütünüyle silinmesi satır tetikleyicisine takılmaz.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'Denetim kaydı yalnızca eklenir; değiştirilemez ve silinemez' USING ERRCODE = 'ERP07';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
