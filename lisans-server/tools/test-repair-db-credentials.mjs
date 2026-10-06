import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = `erp-credential-test-${randomUUID().slice(0, 8)}`;
const db = `${name}-db`, volume = `${name}-data`, network = `${name}-network`;
const server = `${name}-server`, keyVolume = `${name}-keys`;
const owner = 'a'.repeat(48), app = 'b'.repeat(48);
const environment = { ...process.env, POSTGRES_PASSWORD: 'test-only-postgres', ERP_OWNER_PASSWORD: 'c'.repeat(48), ERP_APP_PASSWORD: 'd'.repeat(48), MSYS_NO_PATHCONV: '1' };
const docker = (args, options = {}) => execFileSync('docker', args, { env: environment, encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const query = (sql, database = 'postgres') => docker(['exec', db, 'psql', '-X', '-At', '-U', 'postgres', '-d', database, '-c', sql]).trim();
const roleSnapshot = () => hash(query("SELECT rolname, rolpassword, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_authid WHERE rolname IN ('erp','erp_app') ORDER BY rolname"));
const attributes = () => query("SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_roles WHERE rolname IN ('erp','erp_app') ORDER BY rolname");
const shell = (code) => docker(['exec', db, 'bash', '-c', code]);
const sleep = () => new Promise((resolve) => setTimeout(resolve, 500));
let id, labels, mount, volumeLabels;
const run = (apply, overrides = {}) => {
  const args = ['exec', '-e', 'PATH=/test/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '-e', `TEST_DB_ID=${id}`, '-e', `TEST_LABELS=${overrides.labels ?? labels}`, '-e', `TEST_MOUNT=${mount}`, '-e', `TEST_VOLUME_LABELS=${overrides.volumeLabels ?? volumeLabels}`,
    db, 'bash', '/test/kit/tools/repair-db-credentials.sh', ...(apply ? ['--apply'] : [])];
  const result = spawnSync('docker', args, { env: environment, encoding: 'utf8', timeout: 60_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.ok(!output.includes(owner) && !output.includes(app) && !output.includes('SCRAM-SHA-256$'), 'Passwords and stored verifiers must not appear in console output');
  return { status: result.status, output };
};
const adapter = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  inspect) if [[ $3 == *Mounts* ]]; then printf '%s\\n' "$TEST_MOUNT"; else printf '%s\\n' "$TEST_LABELS"; fi ;;
  volume) printf '%s\\n' "$TEST_VOLUME_LABELS" ;;
  compose)
    while [[ $# -gt 0 && $1 != ps ]]; do shift; done
    [[ $# -gt 0 ]] || exit 86
    if [[ "$*" == 'ps -q db' ]]; then printf '%s\\n' "$TEST_DB_ID";
    elif [[ "$*" == 'ps --status running -q license' ]]; then :;
    else exit 86; fi ;;
  exec)
    shift
    while [[ $1 == -i || $1 == -e ]]; do if [[ $1 == -e ]]; then shift 2; else shift; fi; done
    [[ $1 == "$TEST_DB_ID" ]] || exit 86; shift
    if [[ $1 == pg_dump && -f /test/fail-backup ]]; then exit 87; fi
    if [[ $1 == sh && -f /test/fail-verification ]]; then exit 88; fi
    exec "$@" ;;
  *) exit 86 ;;
esac
`;
try {
  docker(['volume', 'create', '--label', 'com.docker.compose.project=muhasebe-lisans', '--label', 'com.docker.compose.volume=licensedata', volume]);
  docker(['network', 'create', network]);
  id = docker(['run', '-d', '--name', db, '--network', network, '--label', 'com.docker.compose.project=muhasebe-lisans', '--label', 'com.docker.compose.service=db',
    '-e', 'POSTGRES_PASSWORD', '-e', 'ERP_OWNER_PASSWORD', '-e', 'ERP_APP_PASSWORD', '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`, 'postgres:16']).trim();
  let ready = false;
  for (let i = 0; i < 60; i++) { try { docker(['exec', db, 'pg_isready', '-h', '127.0.0.1']); ready = true; break; } catch { await sleep(); } }
  assert.ok(ready);
  docker(['exec', '-i', db, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres'], { input: readFileSync(join(root, 'lisans-server/deploy/ensure-database.sql'), 'utf8') });
  query("CREATE TABLE sentinel(marker text); INSERT INTO sentinel VALUES ('preserve-me')", 'erp_license');
  shell('mkdir -p /test/kit/tools /test/kit/deploy /test/bin /etc/muhasebe-lisans/keys; chmod 700 /etc/muhasebe-lisans /etc/muhasebe-lisans/keys');
  for (const file of ['setup-input.sh', 'resume-setup-vps.sh', 'repair-db-credentials.sh', 'setup-vps.sh', 'backup-vps.sh', 'deploy-vps.sh', 'restore-vps.sh', 'configure-deploy.sh']) {
    docker(['cp', join(root, 'lisans-server/tools', file), `${db}:/test/kit/tools/${file}`]);
  }
  for (const file of ['compose.runtime.yml', 'compose.host-tunnel.yml', 'compose.managed-tunnel.yml', 'Caddyfile.tunnel', 'init-prod.sh', 'ensure-database.sql', 'validate-credential-repair.sql']) {
    docker(['cp', join(root, 'lisans-server/deploy', file), `${db}:/test/kit/deploy/${file}`]);
  }
  docker(['exec', '-i', db, 'sh', '-c', 'cat > /test/bin/docker; chmod 755 /test/bin/docker'], { input: adapter });
  // Only the transport and the final service-start handoff are adapted. The
  // production root CLI, flock, backups, SQL and rollback execute unchanged.
  shell("sed -i 's|then resume_setup; fi|then touch /test/resume-called; fi|' /test/kit/tools/resume-setup-vps.sh");
  docker(['exec', '-i', db, 'sh', '-c', 'cat > /etc/muhasebe-lisans/.env; chmod 600 /etc/muhasebe-lisans/.env'], { input: `DB_OWNER_PASSWORD=${owner}\nDB_APP_PASSWORD=${app}\n` });
  shell("for file in compose.yml compose.tunnel.yml Caddyfile init-prod.sh current-image image-repository; do printf fixture > /etc/muhasebe-lisans/$file; done; printf /test/backups > /etc/muhasebe-lisans/backup-directory; printf preserved-key > /etc/muhasebe-lisans/keys/signing-key.json; printf preserved-token > /etc/muhasebe-lisans/tunnel-token; chmod 600 /etc/muhasebe-lisans/keys/signing-key.json /etc/muhasebe-lisans/tunnel-token");
  labels = docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}|{{.Config.Image}}', db]).trim();
  mount = docker(['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Name}}{{end}}{{end}}', db]).trim();
  volumeLabels = docker(['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}', volume]).trim();
  const original = roleSnapshot(), originalAttributes = attributes();
  const originalSettings = hash(shell('cat /etc/muhasebe-lisans/.env'));
  assert.equal(run(false).status, 2);
  assert.equal(roleSnapshot(), original);
  shell('chmod 644 /etc/muhasebe-lisans/.env');
  assert.notEqual(run(true).status, 0);
  shell('chmod 600 /etc/muhasebe-lisans/.env');
  assert.equal(roleSnapshot(), original);
  assert.equal(shell('find /etc/muhasebe-lisans -name "*.lock"').trim(), '');
  assert.notEqual(run(true, { labels: 'other-project|db|true|postgres:16' }).status, 0);
  assert.notEqual(run(true, { volumeLabels: 'other-project|licensedata' }).status, 0);
  assert.equal(roleSnapshot(), original);
  query('ALTER ROLE erp SUPERUSER');
  assert.notEqual(run(true).status, 0);
  query('ALTER ROLE erp NOSUPERUSER');
  assert.equal(roleSnapshot(), original);
  shell('touch /test/fail-backup');
  assert.notEqual(run(true).status, 0);
  assert.equal(roleSnapshot(), original);
  shell('rm /test/fail-backup; touch /test/fail-verification');
  const rollback = run(true);
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.output, /önceki rol parolaları geri getirildi/);
  assert.equal(roleSnapshot(), original);
  shell('rm /test/fail-verification');
  const success = run(true);
  assert.equal(success.status, 0, success.output);
  assert.equal(attributes(), originalAttributes);
  assert.equal(query('SELECT marker FROM sentinel', 'erp_license'), 'preserve-me');
  assert.equal(shell('cat /etc/muhasebe-lisans/keys/signing-key.json'), 'preserved-key');
  assert.equal(shell('cat /etc/muhasebe-lisans/tunnel-token'), 'preserved-token');
  assert.equal(hash(shell('cat /etc/muhasebe-lisans/.env')), originalSettings);
  assert.equal(shell('test -f /test/resume-called; printf yes'), 'yes');
  const after = roleSnapshot();
  assert.equal(run(true).status, 0);
  assert.equal(roleSnapshot(), after);
  assert.equal(run(false).status, 0);
  // Validate the verified dump by restoring it into a separate database.
  const backup = shell('find /test/backups -name SHA256SUMS -printf "%h\\n" | sort | tail -1').trim();
  shell(`cd '${backup}'; sha256sum -c SHA256SUMS >/dev/null; test "$(stat -c %a .)" = 700`);
  query('CREATE DATABASE backup_verification');
  shell(`pg_restore -U postgres -d backup_verification '${backup}/database.dump'`);
  assert.equal(query('SELECT marker FROM sentinel', 'backup_verification'), 'preserve-me');
  if (process.env.LICENSE_TEST_IMAGE) {
    docker(['run', '--rm', '--network', network, '-e', `MIGRATION_DATABASE_URL=postgres://erp:${owner}@${db}:5432/erp_license`, process.env.LICENSE_TEST_IMAGE, 'node', 'dist/migrate.js']);
    docker(['volume', 'create', keyVolume]);
    docker(['run', '--rm', '--mount', `type=volume,source=${keyVolume},target=/keys`, 'node:22-bookworm-slim', 'chown', '1000:1000', '/keys']);
    environment.LICENSE_SIGNING_KEY_PASSPHRASE = 'test-only-key-passphrase';
    docker(['run', '--rm', '--mount', `type=volume,source=${keyVolume},target=/keys`, '-e', 'LICENSE_SIGNING_KEY_PASSPHRASE',
      process.env.LICENSE_TEST_IMAGE, 'node', 'dist/cli.js', 'keygen', '--kid=test-vendor', '--out=/keys/signing-key.json']);
    docker(['run', '-d', '--name', server, '--network', network, '-e', `DATABASE_URL=postgres://erp_app:${app}@${db}:5432/erp_license`,
      '-e', 'LICENSE_DATA_KEY=0123456789abcdef0123456789abcdef', '-e', 'LICENSE_SIGNING_KEY_PASSPHRASE',
      '-e', 'LICENSE_SIGNING_KEY_FILE=/run/keys/signing-key.json', '-e', 'LICENSE_ADMIN_ORIGIN=https://admin.example.test',
      '--mount', `type=volume,source=${keyVolume},target=/run/keys,readonly`, process.env.LICENSE_TEST_IMAGE]);
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        docker(['exec', server, 'node', '-e', "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
        healthy = true; break;
      } catch { await sleep(); }
    }
    assert.ok(healthy, 'The license server must start after repairing both database passwords');
    assert.match(docker(['exec', server, 'node', 'dist/cli.js', 'setup:token']), /İlk yönetici kurulum kodu:/);
  }
  shell("flock -x /etc/muhasebe-lisans/setup.lock -c 'touch /test/lock-ready; sleep 60' >/dev/null 2>&1 &");
  for (let i = 0; i < 20; i++) { try { shell('test -f /test/lock-ready'); break; } catch { await sleep(); } }
  assert.notEqual(run(true).status, 0);
  assert.equal(roleSnapshot(), after);
  console.log('Başarılı: salt okunur teşhis, yanlış proje/volume/yetki/izin reddi, yedek hatası, gerçek parola geri dönüşü, veri/ayar/anahtar/token koruma, tekrar çalıştırma, dump geri yükleme, migration, sunucu sağlığı, yönetici kurulum kodu ve eşzamanlı kilit.');
} finally {
  try { docker(['rm', '-fv', server]); } catch { /* Already gone. */ }
  try { docker(['rm', '-fv', db]); } catch { /* Already gone. */ }
  try { docker(['volume', 'rm', keyVolume]); } catch { /* Already gone. */ }
  try { docker(['volume', 'rm', volume]); } catch { /* Already gone. */ }
  try { docker(['network', 'rm', network]); } catch { /* Already gone. */ }
}
