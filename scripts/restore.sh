#!/usr/bin/env bash
# Yedekten geri yükleme. Hedef veritabanı BOŞ olmalıdır; dolu bir veritabanının üzerine yazmaz.
#
#   Doğrudan:  RESTORE_DATABASE_URL=postgres://erp:...@host:5432/BOŞ_VERİTABANI scripts/restore.sh yedek.dump
#   Compose:   scripts/restore.sh --compose [--target-db AD] yedek.dump
#              scripts/restore.sh --compose --recreate --yes yedek.dump   (felaket kurtarma: uygulamayı durdurur,
#                                                                          veritabanını SİLİP yeniden yaratır, geri yükler)
#
# Roller (erp, erp_app) KÜME genelindedir ve dökümde yoktur: hedef sunucuda önceden var olmalıdır
# (infra/postgres/init-prod.sh ya da init.sql). Erişim izinleri dökümdedir ve geri yüklenir (--no-acl KULLANILMAZ).
# PostgreSQL ana sürümü yedeği alan sunucuyla aynı ya da daha yeni olmalıdır. Tek işlemde çalışır: hata olursa
# hedefte yarım veri kalmaz. Migration geçmişi dökümde olduğundan geri yüklenen sürüm kendi şemasını bilir;
# uygulamayı aynı sürümün imajıyla başlatın, sonra yükseltin.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'echo "$(basename "$0"): $LINENO. satırda beklenmedik hata" >&2' ERR

MODE=direct
TARGET=""
RECREATE=no
YES=no
DUMP=""
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-deploy/.env}"

while [ $# -gt 0 ]; do
  case "$1" in
    --compose) MODE=compose ;;
    --target-db) TARGET="${2:?--target-db bir değer ister}"; shift ;;
    --recreate) RECREATE=yes ;;
    --yes) YES=yes ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) echo "Bilinmeyen seçenek: $1" >&2; exit 2 ;;
    *) [ -z "$DUMP" ] || { echo "Tek yedek dosyası verin" >&2; exit 2; }; DUMP="$1" ;;
  esac
  shift
done
[ -n "$DUMP" ] || { echo "Kullanım: scripts/restore.sh [--compose] [--target-db AD] [--recreate --yes] YEDEK.dump" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "Yedek dosyası yok: $DUMP" >&2; exit 1; }
if [ "$RECREATE" = yes ]; then
  [ "$MODE" = compose ] || { echo "--recreate yalnızca --compose ile kullanılır" >&2; exit 2; }
  [ "$YES" = yes ] || { echo "--recreate veritabanını SİLER; onaylamak için --yes ekleyin" >&2; exit 2; }
fi

# Bütünlük: özet dosyası varsa doğrula
if [ -f "$DUMP.sha256" ]; then
  ( cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256" > /dev/null ) || { echo "sha256 özeti uyuşmuyor: yedek bozuk" >&2; exit 1; }
fi

# Anahtar dosyada yoksa boş değer döner (hata değil): `set -e` + `pipefail` altında eşleşmeyen grep betiği sessizce sonlandırırdı.
envval() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
EMPTY_SQL="select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','v','m','S','f','p')"

if [ "$MODE" = compose ]; then
  [ -f "$ENV_FILE" ] || { echo "$ENV_FILE yok" >&2; exit 1; }
  # Lisans sunucusu compose'u için: ENV_FILE=deploy/license/.env COMPOSE_FILE=deploy/license/docker-compose.yml ERP_DB_NAME=erp_license (DB_OWNER_PASSWORD de kabul edilir)
  DB="${TARGET:-${ERP_DB_NAME:-$(envval ERP_DB_NAME)}}"; DB="${DB:-erp}"
  OWNER_PW="$(envval ERP_OWNER_PASSWORD)"; OWNER_PW="${OWNER_PW:-$(envval DB_OWNER_PASSWORD)}"
  [ -n "$OWNER_PW" ] || { echo "ERP_OWNER_PASSWORD (ya da DB_OWNER_PASSWORD) $ENV_FILE içinde yok" >&2; exit 1; }
  DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
  owner_psql() { "${DC[@]}" exec -T -e PGPASSWORD="$OWNER_PW" db psql -h 127.0.0.1 -U erp -d "$DB" -Atq -v ON_ERROR_STOP=1 "$@"; }
  if [ "$RECREATE" = yes ]; then
    echo "Uygulama durduruluyor ve \"$DB\" veritabanı yeniden yaratılıyor…"
    "${DC[@]}" stop app > /dev/null
    # Bakım bağlantısı: postgres süper kullanıcısı (kapsayıcı içinde yerel güvenilir bağlantı)
    "${DC[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
      -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" \
      -c "CREATE DATABASE \"$DB\" OWNER erp" \
      -c "REVOKE ALL ON DATABASE \"$DB\" FROM PUBLIC" \
      -c "GRANT CONNECT ON DATABASE \"$DB\" TO erp_app"
  fi
  [ "$(owner_psql -c "$EMPTY_SQL")" = 0 ] || { echo "Hedef veritabanı \"$DB\" boş değil. Boş bir veritabanı kullanın ya da --recreate --yes verin." >&2; exit 1; }
  echo "Geri yükleniyor: $DUMP → $DB"
  "${DC[@]}" exec -T -e PGPASSWORD="$OWNER_PW" db pg_restore --exit-on-error --single-transaction --no-owner --role=erp \
    -h 127.0.0.1 -U erp -d "$DB" < "$DUMP"
else
  : "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL (sahip rolün, BOŞ hedef veritabanına bağlantı adresi) gerekli}"
  [ "$(psql "$RESTORE_DATABASE_URL" -Atq -v ON_ERROR_STOP=1 -c "$EMPTY_SQL")" = 0 ] || { echo "Hedef veritabanı boş değil; boş bir veritabanı kullanın." >&2; exit 1; }
  echo "Geri yükleniyor: $DUMP"
  pg_restore --exit-on-error --single-transaction --no-owner --role=erp --dbname="$RESTORE_DATABASE_URL" "$DUMP"
fi
echo "Geri yükleme tamamlandı. Uygulamayı başlatmadan önce /api/health/ready ve bir oturum açma denemesiyle doğrulayın."
