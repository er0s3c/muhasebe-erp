-- Uygulama kullanıcısı iki adımlı doğrulama: user_mfa kiracı tablosu değildir (company_id yok, RLS yok); erp_app'e yalnızca gereken yetkiler verilir.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa TO erp_app;
  END IF;
END
$$;
