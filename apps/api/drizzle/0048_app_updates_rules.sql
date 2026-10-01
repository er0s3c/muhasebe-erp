-- Uzaktan güncelleme kayıtları: kurulum geneli (company_id yok, RLS yok). Çalışma zamanı rolü teklifleri yazar ve günceller; silme yok.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON app_updates TO erp_app;
  END IF;
END
$$;
