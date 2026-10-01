-- Üretim veritabanı ve rolleri (yerel kurulum; idempotent). Kurulum sihirbazı süper kullanıcıyla çalıştırır:
--   psql -v ON_ERROR_STOP=1 -v owner_pw=... -v app_pw=... -v dbname=erp -f bootstrap-prod.sql
-- Rol adları sabittir (migration'lar erp_app rolüne yetki verir). Docker kurulumu aynı işi infra/postgres/init-prod.sh ile yapar.
--   erp     : şema sahibi; yalnızca migration çalıştıran işlem kullanır (RLS'i sahip olduğu için atlar)
--   erp_app : çalışma zamanı rolü; sahip değil, BYPASSRLS yok => RLS her zaman uygulanır
-- Rol zaten varsa parolası kurulumun ürettiği parolayla güncellenir (yeniden kurulum).

SELECT format('CREATE ROLE erp LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'owner_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp')\gexec
SELECT format('ALTER ROLE erp LOGIN PASSWORD %L', :'owner_pw')\gexec

SELECT format('CREATE ROLE erp_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'app_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app')\gexec
-- Çalışma zamanı rolü asla RLS'i atlayamaz (önceden farklı yaratılmış olsa bile düzeltilir)
SELECT format('ALTER ROLE erp_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_pw')\gexec

SELECT format('CREATE DATABASE %I OWNER erp', :'dbname')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'dbname')\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'dbname')\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO erp_app', :'dbname')\gexec

-- Türkçe sıralama (tr-TR-x-icu) yoksa uygulama sorguları çalışmaz: ICU'suz derlenmiş PostgreSQL'i erken yakala
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_collation WHERE collname = 'tr-TR-x-icu') THEN
    RAISE EXCEPTION 'PostgreSQL ICU desteği yok (tr-TR-x-icu sıralaması bulunamadı); ICU ile derlenmiş PostgreSQL 16 kurun';
  END IF;
END
$$;
