\set ON_ERROR_STOP on
\set ECHO none
\getenv owner_pw ERP_OWNER_PASSWORD
\getenv app_pw ERP_APP_PASSWORD
-- Complete a partial first bootstrap. Existing passwords and records are preserved.
SELECT pg_advisory_lock(186453, 1);
SELECT format('CREATE ROLE erp LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'owner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp') \gexec
SELECT format('CREATE ROLE erp_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') \gexec
SELECT 'CREATE DATABASE erp_license OWNER erp'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'erp_license') \gexec
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('erp', 'erp_app') AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ERP rollerinin yetkileri beklenenden fazla; otomatik düzeltme durduruldu';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'erp_license' AND r.rolname = 'erp') THEN
    RAISE EXCEPTION 'Lisans veritabanı sahibi beklenenden farklı; otomatik düzeltme durduruldu';
  END IF;
END $$;
REVOKE ALL ON DATABASE erp_license FROM PUBLIC;
GRANT CONNECT ON DATABASE erp_license TO erp_app;
SELECT pg_advisory_unlock(186453, 1);
