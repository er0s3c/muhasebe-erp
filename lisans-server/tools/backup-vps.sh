#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || exit 1
BASE=/etc/muhasebe-lisans
OUT=$(cat "$BASE/backup-directory")
[[ $OUT == /* && $OUT != / ]] || exit 1
umask 077
install -d -m 700 "$OUT"
exec 9> "$BASE/backup.lock"; flock -n 9 || exit 1
STAGE=$(mktemp -d "$OUT/.stage-XXXXXXXX")
DC=(docker compose --project-directory "$BASE" --env-file "$BASE/.env" -f "$BASE/compose.yml")
if [[ -f "$BASE/compose.tunnel.yml" ]]; then DC+=(-f "$BASE/compose.tunnel.yml"); fi
restart_license=false
cleanup() {
  if [[ $restart_license == true ]]; then "${DC[@]}" up -d --no-deps license || echo 'Yedek sonrası lisans hizmetini başlatın.' >&2; fi
  rm -rf -- "$STAGE"
}
trap cleanup EXIT
# Stop accepting writes and wait for in-flight uploads before taking matching DB/files snapshots.
if [[ -n $("${DC[@]}" ps --status running -q license) ]]; then
  restart_license=true
  "${DC[@]}" stop -t 60 license
fi
"${DC[@]}" exec -T db sh -c 'PGPASSWORD="$ERP_OWNER_PASSWORD" pg_dump -h 127.0.0.1 -U erp -d erp_license -Fc' > "$STAGE/database.dump"
"${DC[@]}" exec -T db pg_restore --list < "$STAGE/database.dump" >/dev/null
cp "$BASE/.env" "$BASE/compose.yml" "$BASE/Caddyfile" "$BASE/init-prod.sh" "$BASE/current-image" "$STAGE/"
for optional in compose.tunnel.yml tunnel-token; do
  if [[ -f "$BASE/$optional" ]]; then cp -a "$BASE/$optional" "$STAGE/"; fi
done
cp -a "$BASE/keys" "$STAGE/keys"
# Published packages and resumable drafts are preserved as well as the database.
"${DC[@]}" run --rm --no-deps -T --entrypoint tar license -C /var/lib/erp-license -czf - releases > "$STAGE/releases.tar.gz"
FILE="$OUT/license-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -C "$STAGE" -czf "$FILE.partial" .
mv "$FILE.partial" "$FILE"
sha256sum "$FILE" > "$FILE.sha256"
echo "Yedek: $FILE (özel anahtar içerir; yalnızca güvenli/şifreli depoda saklayın)"
