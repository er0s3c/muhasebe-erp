#!/usr/bin/env bash
set +x
set -euo pipefail

ensure_signing_key() {
  local keys=$1 image=$2
  if [[ -e "$keys/signing-key.json" ]]; then
    [[ -s "$keys/signing-key.json" ]] || { echo 'İmza anahtarı boş; mevcut dosya korunarak kurulum durduruldu.' >&2; return 1; }
    echo 'Mevcut imza anahtarı korunuyor.'
    return 0
  fi
  [[ ${#LICENSE_SIGNING_KEY_PASSPHRASE} -ge 12 ]] || { echo 'İmza anahtarı parolası eksik veya geçersiz.' >&2; return 1; }
  # -e NAME copies exported environment only; do not put the secret in argv.
  (
    export LICENSE_SIGNING_KEY_PASSPHRASE
    docker run --rm --user 1000:1000 -e LICENSE_SIGNING_KEY_PASSPHRASE \
      --mount "type=bind,source=$keys,target=/keys" "$image" \
      node dist/cli.js keygen --kid=vendor1 --out=/keys/signing-key.json
  )
}

read_setup_value() {
  local file=$1 name=$2 values
  mapfile -t values < <(sed -n "s/^${name}=//p" "$file")
  [[ ${#values[@]} == 1 ]] || { echo "Kurulum ayarı eksik veya tekrarlanmış: $name" >&2; return 1; }
  printf '%s' "${values[0]%$'\r'}"
}

resume_setup() {
  [[ $EUID == 0 ]] || { echo 'sudo ile çalıştırın.' >&2; return 1; }
  local base=/etc/muhasebe-lisans tools image domain file
  tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  source "$tools/setup-input.sh"
  require_setup_files "$tools/.."
  for file in .env compose.yml compose.tunnel.yml Caddyfile init-prod.sh current-image backup-directory; do
    [[ -s "$base/$file" ]] || { echo "Mevcut kurulum dosyası eksik: $file. Ayarları silmeden kurulumu kontrol edin." >&2; return 1; }
  done
  exec 9> "$base/setup.lock"
  flock -n 9 || { echo 'Başka bir kurulum işlemi çalışıyor.' >&2; return 1; }
  # Compose gives shell variables precedence over --env-file. Resume from saved settings.
  unset POSTGRES_PASSWORD DB_OWNER_PASSWORD DB_APP_PASSWORD LICENSE_IMAGE LICENSE_DOMAIN LICENSE_DATA_KEY \
    LICENSE_SIGNING_KEY_PASSPHRASE CLOUDFLARED_IMAGE GITHUB_REPOSITORY GITHUB_REPOSITORY_ID
  image=$(normalize_image_input "$(cat "$base/current-image")")
  [[ $image == *@sha256:* && $image == "$(read_setup_value "$base/.env" LICENSE_IMAGE)" ]] || { echo 'Kaydedilmiş imaj adresleri tutarsız; mevcut ayarlar korunuyor.' >&2; return 1; }
  domain=$(read_setup_value "$base/.env" LICENSE_DOMAIN)
  [[ $domain =~ ^[a-zA-Z0-9.-]+$ && $domain == *.* ]] || return 1
  LICENSE_SIGNING_KEY_PASSPHRASE=$(read_setup_value "$base/.env" LICENSE_SIGNING_KEY_PASSPHRASE)
  [[ $LICENSE_SIGNING_KEY_PASSPHRASE =~ ^[a-f0-9]{64}$ ]] || { echo 'Kaydedilmiş imza anahtarı parolası geçersiz; ayarlar korunuyor.' >&2; return 1; }
  echo '1/4 · Mevcut ayarlar ve imza anahtarı hazırlanıyor'
  install -d -m 700 "$base/keys"
  chown 1000:1000 "$base/keys"
  ensure_signing_key "$base/keys" "$image"
  unset LICENSE_SIGNING_KEY_PASSPHRASE
  local DC=(docker compose --project-directory "$base" --env-file "$base/.env" -f "$base/compose.yml" -f "$base/compose.tunnel.yml")
  echo '2/4 · Veritabanı ve migration'
  install -m 644 "$tools/../deploy/init-prod.sh" "$base/init-prod.sh"
  "${DC[@]}" up -d --wait db
  echo 'İlk kurulumda eksik kalmış veritabanı ve roller kontrol ediliyor.'
  "${DC[@]}" exec -T db psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$tools/../deploy/ensure-database.sql"
  # Loopback can use trust authentication; the container hostname uses the same
  # password-authenticated interface as migration and application connections.
  if ! "${DC[@]}" exec -T db sh -c 'PGPASSWORD="$ERP_OWNER_PASSWORD" psql -X -w -h "$HOSTNAME" -U erp -d erp_license -Atc "SELECT 1" >/dev/null' || \
     ! "${DC[@]}" exec -T db sh -c 'PGPASSWORD="$ERP_APP_PASSWORD" psql -X -w -h "$HOSTNAME" -U erp_app -d erp_license -Atc "SELECT 1" >/dev/null'; then
    echo 'Mevcut rol parolaları kaydedilmiş ayarlarla uyuşmuyor. Yedekli onarım için bash tools/repair-db-credentials.sh --apply çalıştırın. Parolalar ve veriler değiştirilmedi.' >&2
    return 1
  fi
  "${DC[@]}" run --rm migrate
  local services=(license caddy)
  if grep -q 'cloudflared:' "$base/compose.tunnel.yml"; then services+=(cloudflared); fi
  echo '3/4 · Lisans sunucusu ve Tunnel'
  "${DC[@]}" up -d --wait --wait-timeout 120 "${services[@]}"
  echo '4/4 · Bakım araçları ve günlük yedekleme'
  for tool in backup-vps deploy-vps restore-vps; do install -m 700 "$tools/$tool.sh" "/usr/local/sbin/erp-license-${tool%-vps}"; done
  install -m 700 "$tools/configure-deploy.sh" /usr/local/sbin/erp-license-configure-deploy
  cat > /etc/systemd/system/erp-license-backup.service <<EOF
[Unit]
Description=Lisans sunucusu yedeği
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/erp-license-backup
EOF
  cat > /etc/systemd/system/erp-license-backup.timer <<EOF
[Unit]
Description=Günlük lisans yedeği
[Timer]
OnCalendar=*-*-* 02:15:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now erp-license-backup.timer
  echo "Kurulum hizmetleri hazır: https://$domain/setup (MFA zorunlu)."
  if ! "${DC[@]}" exec -T license node dist/cli.js setup:token; then
    echo 'Kurulum kodu üretilemedi. Yönetici daha önce oluşturulduysa mevcut hesabınızla giriş yapın; aksi halde lisans hizmetini kontrol edin.' >&2
    return 1
  fi
  echo 'İmza anahtarını ve .env dosyasını ayrı, güvenli bir çevrimdışı depoya yedekleyin.'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then resume_setup; fi
