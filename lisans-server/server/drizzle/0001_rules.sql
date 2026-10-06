-- =========================================================================
-- Lisans sunucusu kuralları: çalışma zamanı rolüne yalnızca gereken yetkiler; denetim kaydı yalnızca eklenir.
-- (Bu veritabanında kiracı yoktur: RLS gerekmez; güvenlik sınırı ağ/kimlik doğrulama ve dar yetkilerdir.)
-- =========================================================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT USAGE ON SCHEMA public TO erp_app;
    GRANT SELECT, INSERT, UPDATE ON admins, customers, licenses, activations TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON admin_sessions TO erp_app;
    GRANT SELECT, INSERT ON audit_log TO erp_app;
    GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- Denetim kaydı değiştirilemez ve silinemez (şema sahibi dahil; ERRCODE LIC01).
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'Denetim kaydı yalnızca eklenir; değiştirilemez ve silinemez' USING ERRCODE = 'LIC01';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint

-- Etkinleştirme kaydı silinemez (devre dışı bırakma `status` ile yapılır; geçmiş korunur).
CREATE FUNCTION activations_no_delete() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'Etkinleştirme kayıtları silinemez; devre dışı bırakılır' USING ERRCODE = 'LIC02';
END
$$;
--> statement-breakpoint
CREATE TRIGGER activations_no_delete
  BEFORE DELETE ON activations
  FOR EACH ROW EXECUTE FUNCTION activations_no_delete();
