#!/usr/bin/env bash
# CI: lisans sunucusunu GERÇEK imajı ve satıcı compose'uyla kurar (anahtar töreni, db + migrate + sunucu), iki lisans verir
# (müşteri uygulaması ve demo örneği). Çıktılar GITHUB_ENV'e (yoksa <çıktı>/env dosyasına) yazılır:
#   LICENSE_PUBLIC_KEYS_JSON, LICENSE_SERVER_URL, LICENSE_ALLOW_INSECURE_URL, LICENSE_CODE, LICENSE_DEMO_CODE, LICENSE_CI_DIR
# Uygulama imajı BUNLARLA derlenmelidir (açık anahtar pakete gömülür); kaplar sunucuya host.docker.internal:4100 ile ulaşır.
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT="${1:-${RUNNER_TEMP:-/tmp}/license-docker}"
mkdir -p "$OUT/keys"
OUT="$(cd "$OUT" && pwd)"
chmod 777 "$OUT/keys" # kapta 'node' kullanıcısı yazar (anahtar dosyası 0600, yalnızca o okur)
ENVFILE="${GITHUB_ENV:-$OUT/env}"

docker build -f lisans-server/server/Dockerfile -t muhasebe-lisans:ci --build-arg APP_VERSION=ci .
test "$(docker run --rm --entrypoint id muhasebe-lisans:ci -u)" != "0" # root olmayan kullanıcı

PASS="$(openssl rand -hex 16)"
KEYGEN="$(docker run --rm -v "$OUT/keys:/out" -e LICENSE_SIGNING_KEY_PASSPHRASE="$PASS" muhasebe-lisans:ci node dist/cli.js keygen --kid=ci1 --out=/out/signing-key.json)"
PUB="$(printf '%s\n' "$KEYGEN" | sed -n 's/.*"ci1": "\([^"]*\)".*/\1/p' | head -1)"
[ -n "$PUB" ] || { echo "açık anahtar okunamadı: $KEYGEN" >&2; exit 1; }

cat > lisans-server/deploy/.env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
DB_OWNER_PASSWORD=$(openssl rand -hex 16)
DB_APP_PASSWORD=$(openssl rand -hex 16)
LICENSE_DATA_KEY=$(openssl rand -base64 48 | tr -d '\n')
LICENSE_KEY_DIR=$OUT/keys
LICENSE_SIGNING_KEY_PASSPHRASE=$PASS
LICENSE_DOMAIN=lisans.test
LICENSE_IMAGE=muhasebe-lisans:ci
ENV

LIC=(docker compose -f lisans-server/deploy/docker-compose.yml -f lisans-server/deploy/docker-compose.ci.yml --env-file lisans-server/deploy/.env)
"${LIC[@]}" up -d license
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4100/healthz > /dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then "${LIC[@]}" logs --no-color >&2; echo "lisans sunucusu başlamadı" >&2; exit 1; fi
  sleep 2
done

until_date="$(date -u -d '+2 years' +%F)"
issue() { # $1 = müşteri, $2 = tür
  local out code
  out="$("${LIC[@]}" exec -T license node dist/cli.js license:issue --customer="$1" --kind="$2" \
    --sectors=CONSTRUCTION,RETAIL_MARKET,COMMERCE,MANUFACTURING_WHOLESALE --devices=500 --companies=500 --valid-until="$until_date")"
  code="$(printf '%s\n' "$out" | grep -oE '[0-9A-Z]{5}(-[0-9A-Z]{5}){4}' | head -1)"
  [ -n "$code" ] || { echo "etkinleştirme kodu okunamadı: $out" >&2; exit 1; }
  printf '%s' "$code"
}
CODE="$(issue 'CI Müşterisi' commercial)"
DEMO_CODE="$(issue 'CI Demo' demo)"

{
  echo "LICENSE_PUBLIC_KEYS_JSON={\"keys\":{\"ci1\":\"$PUB\"}}"
  echo "LICENSE_SERVER_URL=http://host.docker.internal:4100"
  echo "LICENSE_ALLOW_INSECURE_URL=true"
  echo "LICENSE_CODE=$CODE"
  echo "LICENSE_DEMO_CODE=$DEMO_CODE"
  echo "LICENSE_CI_DIR=$OUT"
} >> "$ENVFILE"
echo "Lisans sunucusu hazır (http://127.0.0.1:4100)"
