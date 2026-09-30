-- Geliştirme ortamı için roller ve veritabanları (idempotent).
-- docker-compose bu dosyayı ilk açılışta çalıştırır; docker yoksa:
--   su postgres -c "psql -f infra/postgres/init.sql"
--
-- erp      : şema sahibi, migration/seed için (RLS'i sahip olduğu için atlar)
-- erp_app  : çalışma zamanı rolü; sahip değil, BYPASSRLS yok => RLS her zaman uygulanır

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp') THEN
    CREATE ROLE erp LOGIN PASSWORD 'erp' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    CREATE ROLE erp_app LOGIN PASSWORD 'erp_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

SELECT 'CREATE DATABASE erp_dev OWNER erp'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'erp_dev')\gexec
SELECT 'CREATE DATABASE erp_test OWNER erp'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'erp_test')\gexec
-- Lisans sunucusu (apps/license-server) geliştirme ve test veritabanları
SELECT 'CREATE DATABASE erp_license_dev OWNER erp'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'erp_license_dev')\gexec
SELECT 'CREATE DATABASE erp_license_test OWNER erp'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'erp_license_test')\gexec
-- Uygulamanın (apps/api) lisans entegrasyon testleri: lisans durumu kuruluma özgü tek satırdır, ortak test veritabanını kirletmesin
SELECT 'CREATE DATABASE erp_license_apitest OWNER erp'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'erp_license_apitest')\gexec
