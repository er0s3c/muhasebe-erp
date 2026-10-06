#!/usr/bin/env bash
# Run the downloaded, checksum-verified distribution kit; do not pipe a remote script into a shell.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'sudo ile çalıştırın.' >&2; exit 1; }
source /etc/os-release
[[ ${ID:-} == ubuntu || ${ID:-} == debian ]] || { echo 'Ubuntu/Debian gerekli.' >&2; exit 1; }
BASE=/etc/muhasebe-lisans
HERE=$(cd "$(dirname "$0")" && pwd)
[[ -f "$HERE/setup-input.sh" ]] || { echo 'setup-input.sh eksik. Tam VPS kurulum paketini aynı klasöre açın.' >&2; exit 1; }
source "$HERE/setup-input.sh"
require_setup_files "$HERE/.."
if [[ -e "$BASE/.env" ]]; then
  echo 'Mevcut kurulum ayarları bulundu. Devam etmek için bash tools/resume-setup-vps.sh çalıştırın; .env dosyasını silmeyin.' >&2
  exit 1
fi
repository=er0s3c/muhasebe-erp
repository_id=1395438415
default_image=$(default_image_prompt "$HERE/..")
echo 'Ok tuşlarıyla düzenleyebilirsiniz. Enter, ekrandaki varsayılanı kullanır.'
echo "GitHub deposu otomatik: $repository (kimlik: $repository_id)"
while true; do
  prompt_input domain 'Lisans alan adı: ' admin.er0s3c.com
  [[ $domain =~ ^[a-zA-Z0-9.-]+$ && $domain == *.* ]] && break
  echo 'Alan adı geçersiz; örnek: admin.er0s3c.com' >&2
done
while true; do
  prompt_input email 'Yönetici e-postası: '
  [[ $email == *@* && $email != *[[:space:]]* && $email != *$'\n'* ]] && break
  echo 'E-posta adresi geçersiz; tekrar girin.' >&2
done
while true; do
  prompt_input image_input 'İmaj / docker pull komutu: ' "$default_image"
  if image=$(normalize_image_input "$image_input"); then break; fi
done
while true; do
  prompt_input backups 'Yedekleme klasörü: ' /var/backups/muhasebe-lisans
  [[ $backups == /* && $backups != / && $backups != *$'\n'* ]] && break
  echo 'Yedekleme klasörü tam yol olmalı; örnek: /var/backups/muhasebe-lisans' >&2
done
while true; do
  prompt_input tunnel_mode 'Tunnel: 1=aynı Docker kurulumu, 2=mevcut sunucu hizmeti: ' 1
  [[ $tunnel_mode == 1 || $tunnel_mode == 2 ]] && break
  echo 'Tunnel için 1 veya 2 girin.' >&2
done
if [[ $tunnel_mode == 1 ]]; then
  read -r -s -p 'Cloudflare Tunnel token (ekranda gösterilmez): ' tunnel_token; echo
  [[ $tunnel_token =~ ^[A-Za-z0-9_+/=-]{32,8192}$ ]] || { echo 'Tunnel token biçimi geçersiz'; exit 1; }
fi
apt-get update
apt-get install -y ca-certificates openssl curl gnupg
if ! docker compose version >/dev/null 2>&1; then
  install -d -m 755 /etc/apt/keyrings
  curl --fail --proto '=https' --tlsv1.2 "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  fingerprint=$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '$1=="fpr" {print $10;exit}')
  [[ $fingerprint == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || { echo 'Docker yayıncı anahtarı doğrulanamadı'; exit 1; }
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" > /etc/apt/sources.list.d/muhasebe-docker.list
  apt-get update
  packages=(docker-compose-plugin)
  if ! command -v docker >/dev/null; then packages+=(docker-ce docker-ce-cli containerd.io); fi
  if apt-get --simulate install "${packages[@]}" | grep -q '^Remv '; then echo 'Mevcut paketleri kaldırmayı gerektiren Docker kurulumu durduruldu; sistem yöneticiniz paket çakışmasını çözmeli.'; exit 1; fi
  apt-get install -y "${packages[@]}"
fi
systemctl enable --now docker
if ! docker pull "$image"; then
  echo 'Özel GHCR imajı için GitHub Personal access token (classic), read:packages yetkisi gerekir.'
  echo 'Anahtar oluşturma: https://github.com/settings/tokens/new?scopes=read:packages'
  echo 'GitHub hesabınızın parolasını veya Cloudflare tokenını bu alana girmeyin.'
  prompt_input registry_user 'GHCR kullanıcı adı: ' er0s3c
  read -r -s -p 'GitHub token (classic, read:packages; ekranda gösterilmez): ' registry_token; echo
  printf '%s' "$registry_token" | docker login ghcr.io -u "$registry_user" --password-stdin
  unset registry_token
  docker pull "$image"
fi
image=$(resolve_image_digest "$image")
echo "Kurulum için sabitlenen imaj: $image"
umask 077
install -d -m 700 "$BASE" "$BASE/keys" "$backups"
install -m 600 "$HERE/../deploy/compose.runtime.yml" "$BASE/compose.yml"
install -m 600 "$HERE/../deploy/Caddyfile.tunnel" "$BASE/Caddyfile"
if [[ $tunnel_mode == 1 ]]; then
  install -m 600 "$HERE/../deploy/compose.managed-tunnel.yml" "$BASE/compose.tunnel.yml"
  printf '%s' "$tunnel_token" > "$BASE/tunnel-token"
  chown 65532:65532 "$BASE/tunnel-token"; chmod 400 "$BASE/tunnel-token"
  unset tunnel_token
else
  install -m 600 "$HERE/../deploy/compose.host-tunnel.yml" "$BASE/compose.tunnel.yml"
fi
# The PostgreSQL entrypoint runs as UID 999 and must be able to read this script.
# It contains no secrets; passwords are supplied via the container environment.
install -m 644 "$HERE/../deploy/init-prod.sh" "$BASE/init-prod.sh"
POSTGRES_PASSWORD=$(openssl rand -hex 24)
DB_OWNER_PASSWORD=$(openssl rand -hex 24)
DB_APP_PASSWORD=$(openssl rand -hex 24)
LICENSE_DATA_KEY=$(openssl rand -hex 32)
LICENSE_SIGNING_KEY_PASSPHRASE=$(openssl rand -hex 32)
cat > "$BASE/.env" <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DB_OWNER_PASSWORD=$DB_OWNER_PASSWORD
DB_APP_PASSWORD=$DB_APP_PASSWORD
LICENSE_DATA_KEY=$LICENSE_DATA_KEY
LICENSE_SIGNING_KEY_PASSPHRASE=$LICENSE_SIGNING_KEY_PASSPHRASE
LICENSE_DOMAIN=$domain
LICENSE_IMAGE=$image
GITHUB_REPOSITORY=$repository
GITHUB_REPOSITORY_ID=$repository_id
CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07
EOF
printf '%s\n' "$image" > "$BASE/current-image"
printf '%s\n' "${image%@*}" > "$BASE/image-repository"
printf '%s\n' "$backups" > "$BASE/backup-directory"
unset LICENSE_SIGNING_KEY_PASSPHRASE POSTGRES_PASSWORD DB_OWNER_PASSWORD DB_APP_PASSWORD LICENSE_DATA_KEY
bash "$HERE/resume-setup-vps.sh"
