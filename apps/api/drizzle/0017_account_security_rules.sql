-- =========================================================================
-- Hesap güvenliği: yetkiler, mevcut kullanıcıların doğrulanmış sayılması, salt-eklenir güvenlik olayları.
-- user_tokens ve security_events kiracı tablosu değildir (company_id yok, RLS yok): erp_app'e YALNIZCA gereken yetkiler verilir.
-- =========================================================================

-- 1) Yetkiler: jetonlar kullanılır/temizlenir; olaylar yalnızca eklenir ve okunur.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_tokens TO erp_app;
    GRANT SELECT, INSERT ON security_events TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 2) Bu sürümden önce kayıtlı kullanıcılar doğrulanmış sayılır (aksi halde herkes birden doğrulama uyarısı görürdü).
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;
--> statement-breakpoint

-- 3) Güvenlik olayları da yalnızca eklenir (şema sahibi dahil; ERRCODE ERP07, audit_log ile aynı kural).
CREATE FUNCTION security_events_append_only() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'Güvenlik olayları yalnızca eklenir; değiştirilemez ve silinemez' USING ERRCODE = 'ERP07';
END
$$;
--> statement-breakpoint
CREATE TRIGGER security_events_append_only
  BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION security_events_append_only();
