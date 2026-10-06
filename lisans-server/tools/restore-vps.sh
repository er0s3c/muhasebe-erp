#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 && $# == 1 ]] || { echo 'sudo erp-license-restore /tam/yedek.tar.gz'; exit 1; }
FILE=$(realpath -- "$1"); [[ $FILE == /* && -f $FILE && -f $FILE.sha256 ]] || exit 1
read -r expected _ < "$FILE.sha256"
[[ $expected =~ ^[a-f0-9]{64}$ && $(sha256sum "$FILE" | cut -d' ' -f1) == "$expected" ]] || { echo 'Yedek özeti uyuşmuyor'; exit 1; }
read -r -p 'Bu işlem mevcut lisans verisini geri yükler. GERİ YÜKLE yazın: ' confirmation
[[ $confirmation == 'GERİ YÜKLE' ]] || exit 1
BASE=/etc/muhasebe-lisans
exec 9> "$BASE/deploy.lock"; flock -n 9 || exit 1
/usr/local/sbin/erp-license-backup
STAGE=$(mktemp -d /var/backups/license-restore-XXXXXXXX); chmod 700 "$STAGE"
trap 'rm -rf -- "$STAGE"' EXIT
# Local administrator-selected backup only. Reject links and archive paths escaping the stage.
tar -tzf "$FILE" | awk '/(^\/|(^|\/)\.\.($|\/))/ {bad=1} END {exit bad}'
if tar -tvzf "$FILE" | awk '$1 ~ /^[lh]/ {found=1} END {exit !found}'; then echo 'Bağlantılı arşiv reddedildi'; exit 1; fi
tar -xzf "$FILE" -C "$STAGE" --no-same-owner
for required in database.dump .env keys/signing-key.json releases.tar.gz current-image; do [[ -f "$STAGE/$required" ]] || exit 1; done
tar -tzf "$STAGE/releases.tar.gz" | awk '/(^\/|(^|\/)\.\.($|\/))/ {bad=1} END {exit bad}'
if tar -tvzf "$STAGE/releases.tar.gz" | awk '$1 ~ /^[lh]/ {found=1} END {exit !found}'; then echo 'Dosya deposundaki bağlantılı arşiv reddedildi'; exit 1; fi
DC=(docker compose --project-directory "$BASE" --env-file "$BASE/.env" -f "$BASE/compose.yml")
if [[ -f "$BASE/compose.tunnel.yml" ]]; then DC+=(-f "$BASE/compose.tunnel.yml"); fi
"${DC[@]}" stop license
"${DC[@]}" exec -T db sh -c 'PGPASSWORD="$ERP_OWNER_PASSWORD" pg_restore -h 127.0.0.1 -U erp -d erp_license --clean --if-exists --single-transaction --exit-on-error' < "$STAGE/database.dump"
# PostgreSQL cluster/role passwords are not restored by pg_restore. Preserve the live credentials.
grep -E '^(POSTGRES_PASSWORD|DB_OWNER_PASSWORD|DB_APP_PASSWORD)=' "$BASE/.env" > "$STAGE/database-credentials"
grep -vE '^(POSTGRES_PASSWORD|DB_OWNER_PASSWORD|DB_APP_PASSWORD)=' "$STAGE/.env" > "$BASE/.env.next"
cat "$STAGE/database-credentials" >> "$BASE/.env.next"; chmod 600 "$BASE/.env.next"; mv "$BASE/.env.next" "$BASE/.env"
cp -a "$STAGE/keys/." "$BASE/keys/"; chown -R 1000:1000 "$BASE/keys"
cp "$STAGE/current-image" "$BASE/current-image"
# Preserve this server's Tunnel identity during a normal data restore. A rotated token
# in a newer live configuration must not be overwritten by an old backup.
# Replace the release store with the matching snapshot while the HTTP service is stopped.
"${DC[@]}" run --rm --no-deps --entrypoint sh license -c 'find /var/lib/erp-license/releases -mindepth 1 -delete; tar -xzf - -C /var/lib/erp-license' < "$STAGE/releases.tar.gz"
"${DC[@]}" up -d license
for i in $(seq 1 30); do
  if "${DC[@]}" exec -T license node -e 'fetch("http://127.0.0.1:4000/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then echo 'Geri yükleme tamamlandı; sunucu sağlık kontrolü geçti.'; exit 0; fi
  sleep 2
done
echo 'Veri geri yüklendi ancak sağlık kontrolü geçmedi. Hizmet günlüklerini inceleyin.' >&2; exit 1
