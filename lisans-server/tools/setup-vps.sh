#!/usr/bin/env bash
# Run the downloaded, checksum-verified distribution kit; do not pipe a remote script into a shell.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'sudo ile çalıştırın.' >&2; exit 1; }
source /etc/os-release
[[ ${ID:-} == ubuntu || ${ID:-} == debian ]] || { echo 'Ubuntu/Debian gerekli.' >&2; exit 1; }
BASE=/etc/muhasebe-lisans
[[ ! -e "$BASE/.env" ]] || { echo 'Kurulum zaten var; deploy/backup araçlarını kullanın.' >&2; exit 1; }
read -r -p 'Lisans alan adı (varsayılan admin.er0s3c.com): ' domain
domain=${domain:-admin.er0s3c.com}
read -r -p 'Yönetici e-postası: ' email
read -r -p 'Özel GHCR imajı (ghcr.io/...@sha256:...): ' image
read -r -p 'GitHub depo adı (sahip/depo): ' repository
read -r -p 'GitHub sayısal depo kimliği: ' repository_id
[[ $domain =~ ^[a-zA-Z0-9.-]+$ && $domain == *.* && $email == *@* && $repository =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ && $repository_id =~ ^[0-9]+$ && $image =~ ^ghcr.io/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Girdi biçimi geçersiz.' >&2; exit 1; }
read -r -p 'Yedekleme klasörü (varsayılan /var/backups/muhasebe-lisans): ' backups
backups=${backups:-/var/backups/muhasebe-lisans}
[[ $backups == /* && $backups != / && $backups != *$'\n'* ]] || exit 1
read -r -p 'Tunnel: 1=aynı Docker kurulumu (varsayılan), 2=mevcut sunucu hizmeti: ' tunnel_mode
tunnel_mode=${tunnel_mode:-1}
[[ $tunnel_mode == 1 || $tunnel_mode == 2 ]] || { echo 'Tunnel seçeneği geçersiz'; exit 1; }
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
  read -r -p 'GHCR kullanıcı adı: ' registry_user
  read -r -s -p 'Yalnız packages:read yetkili GHCR anahtarı: ' registry_token; echo
  printf '%s' "$registry_token" | docker login ghcr.io -u "$registry_user" --password-stdin
  unset registry_token
  docker pull "$image"
fi
HERE=$(cd "$(dirname "$0")" && pwd)
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
install -m 700 "$HERE/../deploy/init-prod.sh" "$BASE/init-prod.sh"
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
chown 1000:1000 "$BASE/keys"
docker run --rm --user 1000:1000 -e LICENSE_SIGNING_KEY_PASSPHRASE -v "$BASE/keys:/keys" "$image" node dist/cli.js keygen --kid=vendor1 --out=/keys/signing-key.json
unset LICENSE_SIGNING_KEY_PASSPHRASE POSTGRES_PASSWORD DB_OWNER_PASSWORD DB_APP_PASSWORD LICENSE_DATA_KEY
DC=(docker compose --project-directory "$BASE" --env-file "$BASE/.env" -f "$BASE/compose.yml" -f "$BASE/compose.tunnel.yml")
"${DC[@]}" up -d --wait db
"${DC[@]}" run --rm migrate
services=(license caddy)
if [[ $tunnel_mode == 1 ]]; then services+=(cloudflared); fi
"${DC[@]}" up -d --wait --wait-timeout 120 "${services[@]}"
for tool in backup-vps deploy-vps restore-vps; do install -m 700 "$HERE/$tool.sh" "/usr/local/sbin/erp-license-${tool%-vps}"; done
install -m 700 "$HERE/configure-deploy.sh" /usr/local/sbin/erp-license-configure-deploy
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
systemctl daemon-reload; systemctl enable --now erp-license-backup.timer
if [[ $tunnel_mode == 1 ]]; then echo "Cloudflare yayımlanan uygulama: $domain -> HTTP http://caddy:80"; else echo "Mevcut Tunnel hedefi: $domain -> HTTP http://127.0.0.1:4080"; fi
echo "İlk yönetici: https://$domain/setup (e-posta: $email). MFA kurulumu zorunludur."
"${DC[@]}" exec -T license node dist/cli.js setup:token
echo 'İmza anahtarını ve .env dosyasını ayrı, güvenli bir çevrimdışı depoya yedekleyin.'
