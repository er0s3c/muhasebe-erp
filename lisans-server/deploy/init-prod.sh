#!/bin/bash
# Üretim için roller ve veritabanı (postgres imajının /docker-entrypoint-initdb.d klasörü, yalnızca İLK açılışta çalışır).
# Rol adları sabittir (migration'lar `erp_app` rolüne yetki verir); parolalar ortamdan gelir, koda gömülmez.
#   erp     : şema sahibi; yalnızca migrate kabı kullanır (RLS'i sahip olduğu için atlar)
#   erp_app : çalışma zamanı rolü; sahip değil, BYPASSRLS yok => RLS her zaman uygulanır
set -euo pipefail
: "${ERP_OWNER_PASSWORD:?ERP_OWNER_PASSWORD gerekli}"
: "${ERP_APP_PASSWORD:?ERP_APP_PASSWORD gerekli}"
DB="${ERP_DB_NAME:-erp}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v dbname="$DB" <<'SQL'
\getenv owner_pw ERP_OWNER_PASSWORD
\getenv app_pw ERP_APP_PASSWORD
CREATE ROLE erp LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE erp_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE :"dbname" OWNER erp;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO erp_app;
SQL
