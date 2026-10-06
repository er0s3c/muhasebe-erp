#!/usr/bin/env bash
set +x
set -euo pipefail

validate_repair_container() {
  local id=$1 labels mount volume
  [[ $id =~ ^[a-f0-9]{12,64}$ ]] || return 1
  labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}|{{.Config.Image}}' "$id") || return 1
  [[ $labels == 'muhasebe-lisans|db|true|postgres:16' ]] || { echo 'Beklenen lisans PostgreSQL konteyneri değil; işlem durduruldu.' >&2; return 1; }
  mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Name}}{{end}}{{end}}' "$id") || return 1
  [[ $mount == volume\|* ]] || return 1
  volume=${mount#volume|}
  labels=$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' "$volume") || return 1
  [[ $labels == 'muhasebe-lisans|licensedata' ]] || { echo 'Veri birimi lisans projesine ait değil; işlem durduruldu.' >&2; return 1; }
}

repair_psql() {
  docker exec -i "$REPAIR_DB_ID" psql -X -q -v ON_ERROR_STOP=1 -v ECHO=none -v VERBOSITY=terse -U postgres -d postgres "$@"
}

verify_repaired_logins() {
  local role
  for role in erp erp_app; do
    if ! docker exec -e REPAIR_OWNER_PASSWORD -e REPAIR_APP_PASSWORD "$REPAIR_DB_ID" sh -c '
      if [ "$1" = erp ]; then PGPASSWORD=$REPAIR_OWNER_PASSWORD; else PGPASSWORD=$REPAIR_APP_PASSWORD; fi
      export PGPASSWORD
      psql -X -w -h "$HOSTNAME" -U "$1" -d erp_license -Atc "SELECT 1" >/dev/null
    ' repair-login "$role" 2>/dev/null; then return 1; fi
  done
}

repair_credentials_core() (
  local base=$1 tools=$2 apply=$3 id backup='' was_running=false changed=false verified=false
  # Runs in a subshell so locks, exported secrets and traps cannot leak to callers.
  umask 077
  source "$tools/resume-setup-vps.sh"
  unset POSTGRES_PASSWORD DB_OWNER_PASSWORD DB_APP_PASSWORD LICENSE_IMAGE LICENSE_DOMAIN LICENSE_DATA_KEY \
    LICENSE_SIGNING_KEY_PASSPHRASE CLOUDFLARED_IMAGE GITHUB_REPOSITORY GITHUB_REPOSITORY_ID
  local DC=(docker compose --project-directory "$base" --env-file "$base/.env" -f "$base/compose.yml" -f "$base/compose.tunnel.yml")
  id=$("${DC[@]}" ps -q db)
  validate_repair_container "$id" || exit 1
  REPAIR_DB_ID=$id
  REPAIR_OWNER_PASSWORD=$(read_setup_value "$base/.env" DB_OWNER_PASSWORD)
  REPAIR_APP_PASSWORD=$(read_setup_value "$base/.env" DB_APP_PASSWORD)
  [[ $REPAIR_OWNER_PASSWORD =~ ^[a-f0-9]{48}$ && $REPAIR_APP_PASSWORD =~ ^[a-f0-9]{48}$ ]] || { echo 'Kaydedilmiş veritabanı parolaları kurulum biçiminde değil.' >&2; exit 1; }
  export REPAIR_OWNER_PASSWORD REPAIR_APP_PASSWORD
  repair_psql < "$tools/../deploy/validate-credential-repair.sql" || exit 1
  if [[ $apply == false ]]; then
    if verify_repaired_logins; then echo 'İki rol de mevcut ayarlarla giriş yapabiliyor; onarım gerekmiyor.'; exit 0; fi
    echo 'Rol parolaları mevcut ayarlarla uyuşmuyor. Yedekli onarım için --apply kullanın.'
    exit 2
  fi
  exec 9> "$base/setup.lock"; flock -n 9 || { echo 'Başka bir kurulum/onarım çalışıyor.' >&2; exit 1; }
  exec 8> "$base/deploy.lock"; flock -n 8 || { echo 'Sunucu dağıtımı çalışıyor.' >&2; exit 1; }
  exec 7> "$base/backup.lock"; flock -n 7 || { echo 'Yedekleme çalışıyor.' >&2; exit 1; }
  # Recheck identity and privileges after acquiring locks.
  [[ $("${DC[@]}" ps -q db) == "$id" ]] || exit 1
  validate_repair_container "$id" || exit 1
  repair_psql < "$tools/../deploy/validate-credential-repair.sql" || exit 1
  if verify_repaired_logins; then
    echo 'Rol parolaları zaten mevcut ayarlarla uyumlu; parola değişikliği yapılmadı.'
    exit 0
  fi
  cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [[ $changed == true && $verified != true ]]; then
      if { printf '%s\n' "SET log_statement='none'; SET log_min_error_statement='panic'; SET log_min_duration_statement=-1; SET log_duration=off; SET lock_timeout='10s'; BEGIN;"; cat "$backup/rollback-roles.sql"; printf '%s\n' 'COMMIT;'; } | repair_psql >/dev/null 2>&1; then
        echo 'Doğrulama tamamlanamadı; önceki rol parolaları geri getirildi.' >&2
      else
        echo "Rol parolaları geri getirilemedi. Korumalı kurtarma yedeği: $backup" >&2
        status=1
      fi
    fi
    if [[ $status != 0 && $changed == false ]]; then
      echo 'Hazırlık/yedekleme tamamlanamadı; rol parolaları değiştirilmedi.' >&2
    fi
    if [[ $was_running == true ]]; then
      "${DC[@]}" up -d --no-deps license >/dev/null 2>&1 || { echo 'Lisans hizmetini yeniden başlatın.' >&2; status=1; }
    fi
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' HUP TERM
  local running
  running=$("${DC[@]}" ps --status running -q license) || exit 1
  if [[ -n $running ]]; then
    was_running=true
    "${DC[@]}" stop -t 60 license >/dev/null || exit 1
  fi
  local out
  out=$(cat "$base/backup-directory")
  [[ $out == /* && $out != / && $out != *$'\n'* ]] || exit 1
  install -d -m 700 "$out" || exit 1
  backup=$(mktemp -d "$out/credential-repair-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX") || exit 1
  echo '1/3 · Veritabanı, roller, ayarlar ve anahtar yedeği'
  docker exec "$id" pg_dump -U postgres -d erp_license -Fc > "$backup/database.dump" || exit 1
  docker exec -i "$id" pg_restore --list < "$backup/database.dump" >/dev/null || exit 1
  docker exec "$id" pg_dumpall -U postgres --globals-only > "$backup/globals.sql" || exit 1
  repair_psql -Atc "SELECT format('ALTER ROLE %I PASSWORD %L;', rolname, rolpassword) FROM pg_authid WHERE rolname IN ('erp', 'erp_app') ORDER BY rolname" > "$backup/rollback-roles.sql" || exit 1
  [[ -s "$backup/globals.sql" && $(wc -l < "$backup/rollback-roles.sql") -eq 2 ]] || exit 1
  for file in .env compose.yml compose.tunnel.yml Caddyfile init-prod.sh current-image image-repository backup-directory; do
    cp -a "$base/$file" "$backup/$file" || exit 1
  done
  cp -a "$base/keys" "$backup/keys" || exit 1
  if [[ -f "$base/tunnel-token" ]]; then cp -a "$base/tunnel-token" "$backup/tunnel-token" || exit 1; fi
  (cd "$backup"; find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS; sha256sum -c SHA256SUMS >/dev/null) || exit 1
  echo "Doğrulanmış, sır içeren yedek: $backup (yalnız root erişimi)"
  echo '2/3 · Yalnız erp ve erp_app parolaları eşitleniyor'
  changed=true
  if ! docker exec -i -e REPAIR_OWNER_PASSWORD -e REPAIR_APP_PASSWORD "$id" psql -X -q -v ON_ERROR_STOP=1 -v ECHO=none -v VERBOSITY=terse -U postgres -d postgres >/dev/null 2>&1 <<'SQL'
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_duration = off;
SET lock_timeout = '10s';
BEGIN;
DO $$ BEGIN
  IF NOT pg_try_advisory_xact_lock(186453, 2) THEN
    RAISE EXCEPTION 'Başka bir parola onarımı çalışıyor';
  END IF;
END $$;
\getenv owner_pw REPAIR_OWNER_PASSWORD
\getenv app_pw REPAIR_APP_PASSWORD
SELECT format('ALTER ROLE erp PASSWORD %L', :'owner_pw') \gexec
SELECT format('ALTER ROLE erp_app PASSWORD %L', :'app_pw') \gexec
COMMIT;
SQL
  then echo 'Parola eşitlemesi başarısız; eski parolalar geri getiriliyor.' >&2; exit 1; fi
  echo '3/3 · Uygulamanın ağ bağlantısından iki rolün girişi doğrulanıyor'
  verify_repaired_logins || { echo 'Giriş doğrulaması başarısız; eski parolalar geri getiriliyor.' >&2; exit 1; }
  verified=true
  echo 'Rol parolaları onarıldı; kayıtlar, rol yetkileri ve imza anahtarı korundu.'
)

repair_db_main() {
  local apply=false base=/etc/muhasebe-lisans tools
  case "${1:-}" in
    '') [[ $# == 0 ]] || return 1 ;;
    --apply) [[ $# == 1 ]] || return 1; apply=true ;;
    --help) echo 'Kullanım: sudo bash tools/repair-db-credentials.sh [--apply]'; return 0 ;;
    *) echo 'Yalnız --apply veya --help kabul edilir.' >&2; return 1 ;;
  esac
  [[ $EUID == 0 ]] || { echo 'sudo ile çalıştırın.' >&2; return 1; }
  tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  source "$tools/setup-input.sh"
  require_setup_files "$tools/.."
  [[ -f "$base/.env" && ! -L "$base/.env" && $(stat -c %u "$base/.env") == 0 && $(stat -c %a "$base/.env") == 600 ]] || {
    echo '.env dosyası root sahibi, 0600 izinli ve normal dosya olmalı.' >&2; return 1;
  }
  repair_credentials_core "$base" "$tools" "$apply"
  if [[ $apply == true ]]; then
    echo 'Mevcut kurulum kaldığı yerden tamamlanıyor.'
    bash "$tools/resume-setup-vps.sh"
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then repair_db_main "$@"; fi
