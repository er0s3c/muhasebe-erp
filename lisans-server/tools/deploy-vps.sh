#!/usr/bin/env bash
# Install as a root-owned forced command. Input is ONLY an immutable image digest.
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]] || exit 1
BASE=/etc/muhasebe-lisans
read -r digest
[[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Geçersiz digest' >&2; exit 1; }
repository=$(cat "$BASE/image-repository")
[[ $repository =~ ^ghcr.io/[a-z0-9/_.-]+$ ]] || exit 1
image="$repository@$digest"
exec 9> "$BASE/deploy.lock"; flock -n 9 || { echo 'Dağıtım sürüyor'; exit 1; }
previous=$(cat "$BASE/current-image")
[[ $previous != "$image" ]] || exit 0
docker pull "$image"
docker run --rm "$image" node -e 'const m=require("./dist/deployment.json");if(m.backwardCompatible!==true)process.exit(1)'
/usr/local/sbin/erp-license-backup
umask 077
sed "s|^LICENSE_IMAGE=.*|LICENSE_IMAGE=$image|" "$BASE/.env" > "$BASE/.env.next"
cp "$BASE/.env" "$BASE/.env.previous"; mv "$BASE/.env.next" "$BASE/.env"
DC=(docker compose --project-directory "$BASE" --env-file "$BASE/.env" -f "$BASE/compose.yml")
if [[ -f "$BASE/compose.tunnel.yml" ]]; then DC+=(-f "$BASE/compose.tunnel.yml"); fi
rollback() {
  mv "$BASE/.env.previous" "$BASE/.env"
  "${DC[@]}" up -d --no-deps license
  echo 'Yeni dağıtım başarısız; uyumlu önceki imaja dönüldü.' >&2
}
if ! "${DC[@]}" run --rm migrate; then rollback; exit 1; fi
"${DC[@]}" up -d --no-deps license
for i in $(seq 1 30); do
  if "${DC[@]}" exec -T license node -e 'fetch("http://127.0.0.1:4000/healthz").then(async r=>{const h=await r.json();process.exit(r.ok&&h.ok&&h.protocolVersions?.includes(2)?0:1)}).catch(()=>process.exit(1))'; then
    printf '%s\n' "$image" > "$BASE/current-image"; echo "Dağıtıldı: $image"; exit 0
  fi
  sleep 2
done
rollback; exit 1
