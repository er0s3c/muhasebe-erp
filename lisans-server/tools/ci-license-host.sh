#!/usr/bin/env bash
# CI / yerel doğrulama: GERÇEK lisans sunucusunu ana makinede süreç olarak kurar (uçtan uca testler ve üretim paketi için).
#
#   lisans-server/tools/ci-license-host.sh [çıktı-klasörü]
#
# Akış: lisans sunucusunu derler → imza anahtar çifti üretir (parolayı rastgele) → lisans veritabanını sıfırlar ve migrate eder →
# sunucuyu 127.0.0.1:4100'de başlatır → üç sektörlü, bol cihaz/şirket kotalı bir lisans verir.
# Çıktılar (GITHUB_ENV varsa oraya, yoksa <çıktı-klasörü>/env dosyasına): LICENSE_PUBLIC_KEYS_JSON, LICENSE_SERVER_URL,
# LICENSE_ALLOW_INSECURE_URL, E2E_LICENSE_CODE, E2E_PANEL_URL/EMAIL/PASSWORD/TOTP_SECRET (yönetim paneli testi), LICENSE_CI_DIR. Üretim paketi BUNLARLA derlenmelidir (açık anahtar pakete gömülür).
# Gerekenler: PostgreSQL (erp/erp sahip, erp_app/erp_app; erp_license_dev veritabanı: infra/postgres/init.sql), node, openssl.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT="${1:-${RUNNER_TEMP:-/tmp}/license-ci}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ENVFILE="${GITHUB_ENV:-$OUT/env}"
PORT="${LICENSE_CI_PORT:-4100}"

# Lisans sunucusu + yönetim paneli (panel aynı kökenden sunulur: PANEL_DIST_DIR)
npm run build:license > "$OUT/build.log" 2>&1 || { cat "$OUT/build.log"; exit 1; }

export LICENSE_SIGNING_KEY_PASSPHRASE="$(openssl rand -hex 16)"
export LICENSE_DATA_KEY="$(openssl rand -base64 48 | tr -d '\n')"
export MIGRATION_DATABASE_URL="${LICENSE_CI_MIGRATION_DATABASE_URL:-postgres://erp:erp@localhost:5432/erp_license_dev}"
export DATABASE_URL="${LICENSE_CI_DATABASE_URL:-postgres://erp_app:erp_app@localhost:5432/erp_license_dev}"
export LICENSE_SIGNING_KEY_FILE="$OUT/signing-key.json"
export PORT HOST=127.0.0.1 RATE_LIMIT_ENABLED=false NODE_ENV=development PANEL_DIST_DIR="$PWD/lisans-server/panel/dist"
rm -f "$LICENSE_SIGNING_KEY_FILE"

KEYGEN="$(node lisans-server/server/dist/cli.js keygen --kid=ci1 --out="$LICENSE_SIGNING_KEY_FILE")"
PUB="$(printf '%s\n' "$KEYGEN" | sed -n 's/.*"ci1": "\([^"]*\)".*/\1/p' | head -1)"
[ -n "$PUB" ] || { echo "açık anahtar okunamadı: $KEYGEN" >&2; exit 1; }

# Lisans veritabanını sıfırla (yalnızca bu betiğin kullandığı geliştirme/CI veritabanı) ve migrate et
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' >/dev/null
node lisans-server/server/dist/migrate.js

nohup node lisans-server/server/dist/server.js > "$OUT/server.log" 2>&1 &
echo $! > "$OUT/server.pid"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1; then break; fi
  if [ "$i" = 40 ]; then echo "lisans sunucusu başlamadı:" >&2; cat "$OUT/server.log" >&2; exit 1; fi
  sleep 0.5
done

# Yönetim paneli testi için yönetici (parola ve TOTP sırrı yalnızca bu çıktıda görünür)
ADMIN="$(node lisans-server/server/dist/cli.js admin:create --email=ci-admin@example.com --name='CI Yönetici')"
ADMIN_PASSWORD="$(printf '%s\n' "$ADMIN" | sed -n 's/^Parola[^:]*: //p' | head -1)"
ADMIN_TOTP="$(printf '%s\n' "$ADMIN" | sed -n 's/^TOTP sırrı[^:]*: //p' | head -1)"
[ -n "$ADMIN_PASSWORD" ] && [ -n "$ADMIN_TOTP" ] || { echo "yönetici bilgileri okunamadı" >&2; exit 1; }

ISSUE="$(node lisans-server/server/dist/cli.js license:issue --customer='CI Müşterisi' --sectors=CONSTRUCTION,RETAIL_MARKET,COMMERCE,MANUFACTURING_WHOLESALE \
  --devices=500 --companies=500 --valid-until="$(date -u -d '+2 years' +%F)")"
CODE="$(printf '%s\n' "$ISSUE" | grep -oE '[0-9A-Z]{5}(-[0-9A-Z]{5}){4}' | head -1)"
[ -n "$CODE" ] || { echo "etkinleştirme kodu okunamadı: $ISSUE" >&2; exit 1; }

{
  echo "LICENSE_PUBLIC_KEYS_JSON={\"keys\":{\"ci1\":\"$PUB\"}}"
  echo "LICENSE_SERVER_URL=http://127.0.0.1:$PORT"
  echo "LICENSE_ALLOW_INSECURE_URL=true"
  echo "E2E_LICENSE_CODE=$CODE"
  echo "E2E_PANEL_URL=http://127.0.0.1:$PORT"
  echo "E2E_PANEL_EMAIL=ci-admin@example.com"
  echo "E2E_PANEL_PASSWORD=$ADMIN_PASSWORD"
  echo "E2E_PANEL_TOTP_SECRET=$ADMIN_TOTP"
  echo "LICENSE_CI_DIR=$OUT"
} >> "$ENVFILE"
echo "Lisans sunucusu hazır (http://127.0.0.1:$PORT); çıktılar: $ENVFILE"
