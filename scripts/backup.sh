#!/usr/bin/env bash
# Muhasebe ERP yedeği: PostgreSQL özel biçimli döküm (pg_dump -Fc), sha256 özeti ve eski yedeklerin temizliği.
#
#   Doğrudan:  MIGRATION_DATABASE_URL=postgres://erp:...@host:5432/erp scripts/backup.sh [--dir DİZİN] [--keep-days N]
#   Compose:   scripts/backup.sh --compose [--dir DİZİN] [--keep-days N]   (deploy/.env içinden okur)
#
# Sahip rolüyle (erp) alınır; RLS sahip rolü etkilemediğinden TÜM şirketlerin verisi dökümde olur. Döküm erişim
# izinlerini (GRANT) ve migration geçmişini de içerir. Yedek dosyası tüm müşteri verisidir: dizin yalnızca sahibine
# açık (0700) oluşturulur; yedekleri şifreli ve başka bir makinede saklayın (docs/OPERATIONS.md).
# Kısmi dosya bırakmaz: önce geçici dosyaya yazar, arşivi doğrular, sonra adını değiştirir.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'echo "$(basename "$0"): $LINENO. satırda beklenmedik hata" >&2' ERR

MODE=direct
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
KEEP_COUNT="${BACKUP_KEEP_COUNT:-}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-deploy/.env}"

while [ $# -gt 0 ]; do
  case "$1" in
    --compose) MODE=compose ;;
    --dir) DIR="${2:?--dir bir değer ister}"; shift ;;
    --keep-days) KEEP="${2:?--keep-days bir değer ister}"; shift ;;
    --keep-count) KEEP_COUNT="${2:?--keep-count bir değer ister}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Bilinmeyen seçenek: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$KEEP" in ''|*[!0-9]*) echo "--keep-days sayı olmalı" >&2; exit 2 ;; esac
case "$KEEP_COUNT" in *[!0-9]*) echo "--keep-count sayı olmalı" >&2; exit 2 ;; esac

# Anahtar dosyada yoksa boş değer döner (hata değil): `set -e` + `pipefail` altında eşleşmeyen grep betiği sessizce sonlandırırdı.
envval() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }

if [ "$MODE" = compose ]; then
  [ -f "$ENV_FILE" ] || { echo "$ENV_FILE yok" >&2; exit 1; }
  # Lisans sunucusu compose'u için: ENV_FILE=deploy/license/.env COMPOSE_FILE=deploy/license/docker-compose.yml ERP_DB_NAME=erp_license (DB_OWNER_PASSWORD de kabul edilir)
  DB="${ERP_DB_NAME:-$(envval ERP_DB_NAME)}"; DB="${DB:-erp}"
  OWNER_PW="$(envval ERP_OWNER_PASSWORD)"; OWNER_PW="${OWNER_PW:-$(envval DB_OWNER_PASSWORD)}"
  [ -n "$OWNER_PW" ] || { echo "ERP_OWNER_PASSWORD (ya da DB_OWNER_PASSWORD) $ENV_FILE içinde yok" >&2; exit 1; }
  DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
  dump() { "${DC[@]}" exec -T -e PGPASSWORD="$OWNER_PW" db pg_dump -h 127.0.0.1 -U erp -Fc "$DB"; }
  list() { "${DC[@]}" exec -T db pg_restore --list > /dev/null; }
else
  : "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL (sahip rolün bağlantı adresi) gerekli}"
  DB="$(printf '%s' "${MIGRATION_DATABASE_URL##*/}" | sed 's/?.*//')"
  dump() { pg_dump -Fc "$MIGRATION_DATABASE_URL"; }
  list() { pg_restore --list > /dev/null; }
fi

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$DIR/erp-$DB-$STAMP.dump"
PARTIAL="$FINAL.partial"
trap 'rm -f "$PARTIAL"' EXIT

dump > "$PARTIAL"
[ -s "$PARTIAL" ] || { echo "Döküm boş" >&2; exit 1; }
list < "$PARTIAL" || { echo "Döküm arşivi doğrulanamadı (pg_restore --list)" >&2; exit 1; }
mv "$PARTIAL" "$FINAL"
( cd "$DIR" && sha256sum "$(basename "$FINAL")" > "$(basename "$FINAL").sha256" )

# Eski yedekleri temizle (yalnızca bu betiğin adlandırdığı dosyalar)
if [ -n "$KEEP_COUNT" ]; then
  # Sayıya göre: en yeni N döküm kalır (özet dosyalarıyla birlikte)
  ls -1t "$DIR"/erp-*.dump 2>/dev/null | tail -n +$((KEEP_COUNT + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
else
  find "$DIR" -maxdepth 1 -type f \( -name 'erp-*.dump' -o -name 'erp-*.dump.sha256' \) -mtime +"$KEEP" -delete
fi

SIZE="$(du -h "$FINAL" | cut -f1)"
if [ -n "$KEEP_COUNT" ]; then echo "Yedek alındı: $FINAL ($SIZE); en yeni ${KEEP_COUNT} yedek tutuldu."; else echo "Yedek alındı: $FINAL ($SIZE); ${KEEP} günden eski yedekler silindi."; fi
