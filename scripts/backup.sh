#!/usr/bin/env bash
# Muhasebe ERP yedeği: PostgreSQL özel biçimli döküm (pg_dump -Fc), sha256 özeti ve eski yedeklerin temizliği.
#
#   Doğrudan:  MIGRATION_DATABASE_URL=postgres://erp:...@host:5432/erp scripts/backup.sh [--dir DİZİN] [--keep-days N | --keep-count N]
#   Compose:   scripts/backup.sh --compose [--dir DİZİN] [--keep-days N | --keep-count N]   (deploy/.env içinden okur)
#
# Sahip rolüyle (erp) alınır; RLS sahip rolü etkilemediğinden TÜM şirketlerin verisi dökümde olur. Döküm erişim
# izinlerini (GRANT) ve migration geçmişini de içerir. Yedek dosyası tüm müşteri verisidir: dizin yalnızca sahibine
# açık (0700) oluşturulur; yedekleri şifreli ve başka bir makinede saklayın (docs/OPERATIONS.md).
# Kısmi dosya bırakmaz: önce geçici dosyaya yazar, arşivi doğrular, sonra adını değiştirir. Parola komut satırına yazılmaz
# (compose: kap içi yerel soket; doğrudan: PG* ortam değişkenleri). Temizlik yalnızca bu betiğin adlandırdığı
# erp-<veritabanı>-<YYYYMMDDTHHMMSSZ>.dump dosyalarına dokunur; --keep-count en az 1'dir (yeni yedek asla silinmez).
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'echo "$(basename "$0"): $LINENO. satırda beklenmedik hata" >&2' ERR

MODE=direct
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
KEEP_COUNT="${BACKUP_KEEP_COUNT:-}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
FILES_DIR="${CONSTRUCTION_STORAGE_DIR:-apps/api/data/construction}"
ENV_FILE="${ENV_FILE:-deploy/.env}"

while [ $# -gt 0 ]; do
  case "$1" in
    --compose) MODE=compose ;;
    --files-dir) FILES_DIR="${2:?--files-dir bir değer ister}"; shift ;;
    --dir) DIR="${2:?--dir bir değer ister}"; shift ;;
    --keep-days) KEEP="${2:?--keep-days bir değer ister}"; shift ;;
    --keep-count) KEEP_COUNT="${2:?--keep-count bir değer ister}"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Bilinmeyen seçenek: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$KEEP" in ''|*[!0-9]*) echo "--keep-days sayı olmalı" >&2; exit 2 ;; esac
case "$KEEP_COUNT" in *[!0-9]*) echo "--keep-count sayı olmalı" >&2; exit 2 ;; esac
if [ -n "$KEEP_COUNT" ] && [ "$((10#$KEEP_COUNT))" -lt 1 ]; then echo "--keep-count en az 1 olmalı (yeni alınan yedek her zaman kalır)" >&2; exit 2; fi
if [ "$((10#$KEEP))" -lt 1 ]; then echo "--keep-days en az 1 olmalı" >&2; exit 2; fi

# Anahtar dosyada yoksa boş değer döner (hata değil): `set -e` + `pipefail` altında eşleşmeyen grep betiği sessizce sonlandırırdı.
envval() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
urldec() { printf '%b' "${1//%/\\x}"; }
# postgres://[kullanıcı[:parola]@]sunucu[:port]/veritabanı[?sslmode=…] → PG* ortam değişkenleri (parola ps çıktısında görünmez)
pg_env_from_url() {
  local re='^postgres(ql)?://(([^:@/]*)(:([^@]*))?@)?([^:/?]*)(:([0-9]+))?/([^?]+)(\?(.*))?$'
  [[ "$1" =~ $re ]] || { echo "Veritabanı adresi okunamadı (postgres://kullanıcı:parola@sunucu:port/veritabanı)" >&2; exit 1; }
  local user="${BASH_REMATCH[3]}" pass="${BASH_REMATCH[5]}" host="${BASH_REMATCH[6]}" port="${BASH_REMATCH[8]}" db="${BASH_REMATCH[9]}" q="${BASH_REMATCH[11]}"
  if [ -n "$user" ]; then PGUSER="$(urldec "$user")"; export PGUSER; fi
  if [ -n "$pass" ]; then PGPASSWORD="$(urldec "$pass")"; export PGPASSWORD; fi
  if [ -n "$host" ]; then export PGHOST="$host"; fi
  if [ -n "$port" ]; then export PGPORT="$port"; fi
  PGDATABASE="$(urldec "$db")"; export PGDATABASE
  if [[ "$q" =~ (^|&)sslmode=([a-z-]+) ]]; then export PGSSLMODE="${BASH_REMATCH[2]}"; fi
  return 0
}

if [ "$MODE" = compose ]; then
  [ -f "$ENV_FILE" ] || { echo "$ENV_FILE yok" >&2; exit 1; }
  # Lisans sunucusu compose'u için: ENV_FILE=lisans-server/deploy/.env COMPOSE_FILE=lisans-server/deploy/docker-compose.yml ERP_DB_NAME=erp_license
  DB="${ERP_DB_NAME:-$(envval ERP_DB_NAME)}"; DB="${DB:-erp}"
  DC=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
  # Kap içindeki yerel soket bağlantısı (postgres imajında yerel bağlantı güvenilir): parola gerekmez, komut satırında görünmez
  dump() { "${DC[@]}" exec -T db pg_dump -U erp -Fc "$DB"; }
  list() { "${DC[@]}" exec -T db pg_restore --list > /dev/null; }
else
  : "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL (sahip rolün bağlantı adresi) gerekli}"
  pg_env_from_url "$MIGRATION_DATABASE_URL"
  DB="$PGDATABASE"
  dump() { pg_dump -Fc; }
  list() { pg_restore --list > /dev/null; }
fi
case "$DB" in *[!A-Za-z0-9_.-]*|'') echo "Veritabanı adı dosya adına uygun değil: $DB" >&2; exit 1 ;; esac

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
if [ "$MODE" = compose ] && [ "$FILES_DIR" = apps/api/data/construction ]; then
  FILES_DIR="${CONSTRUCTION_FILES_DIR:-$(envval CONSTRUCTION_FILES_DIR)}"; FILES_DIR="${FILES_DIR:-construction-data}"
  [[ "$FILES_DIR" = /* ]] || FILES_DIR="$(dirname "$ENV_FILE")/$FILES_DIR"
fi
FILES_NODE="${NODE_BIN:-node}"; if [ -z "${NODE_BIN:-}" ] && [ -x app/runtime/node ]; then FILES_NODE=app/runtime/node; fi
"$FILES_NODE" installer/tools/construction-files.mjs --mode=backup --root="$FILES_DIR" --archive="$FINAL.files.gz"
mv "$PARTIAL" "$FINAL"
( cd "$DIR" && sha256sum "$(basename "$FINAL")" > "$(basename "$FINAL").sha256" )

# Eski yedekleri temizle: YALNIZCA bu betiğin bu veritabanı için adlandırdığı dosyalar (başka dosyalara dokunulmaz)
OWN_RE=".*/erp-$(printf '%s' "$DB" | sed 's/[.]/\\./g')-[0-9]{8}T[0-9]{6}Z\.dump"
if [ -n "$KEEP_COUNT" ]; then
  # Sayıya göre: en yeni N döküm kalır (özet dosyalarıyla birlikte); ad zaman damgası içerdiğinden ada göre sıralanır
  find "$DIR" -maxdepth 1 -type f -regextype posix-extended -regex "$OWN_RE" -print | sort -r | tail -n +"$((10#$KEEP_COUNT + 1))" \
    | while IFS= read -r old; do [ "$old" = "$FINAL" ] || rm -f -- "$old" "$old.sha256" "$old.files.gz" "$old.files.gz.sha256"; done
else
  find "$DIR" -maxdepth 1 -type f -regextype posix-extended -regex "$OWN_RE" -mtime +"$KEEP" -print \
    | while IFS= read -r old; do [ "$old" = "$FINAL" ] || rm -f -- "$old" "$old.sha256" "$old.files.gz" "$old.files.gz.sha256"; done
fi

SIZE="$(du -h "$FINAL" | cut -f1)"
if [ -n "$KEEP_COUNT" ]; then echo "Yedek alındı: $FINAL ($SIZE); en yeni ${KEEP_COUNT} yedek tutuldu."; else echo "Yedek alındı: $FINAL ($SIZE); ${KEEP} günden eski yedekler silindi."; fi
