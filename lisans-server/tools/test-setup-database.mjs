import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = `erp-bootstrap-${randomUUID().slice(0, 8)}`;
const initVolume = `${name}-init`;
const db = `${name}-db`;
const cleanDb = `${name}-fresh`;
const server = `${name}-server`;
const keyVolume = `${name}-keys`;
const network = `${name}-network`;
const environment = { ...process.env, ERP_OWNER_PASSWORD: 'test-only-owner', ERP_APP_PASSWORD: 'test-only-app', POSTGRES_PASSWORD: 'test-only-postgres', LICENSE_SIGNING_KEY_PASSPHRASE: 'test-only-key-passphrase', MSYS_NO_PATHCONV: '1' };
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', env: environment, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
const sleep = () => new Promise((resolve) => setTimeout(resolve, 500));
const ready = async (container) => {
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1']); return; } catch { await sleep(); }
  }
  throw new Error('Test PostgreSQL başlamadı');
};
const start = (container) => docker(['run', '-d', '--name', container, '--network', network,
  '-e', 'POSTGRES_PASSWORD', '-e', 'ERP_OWNER_PASSWORD', '-e', 'ERP_APP_PASSWORD', '-e', 'ERP_DB_NAME=erp_license',
  '--mount', `type=volume,source=${initVolume},target=/docker-entrypoint-initdb.d,readonly`, 'postgres:16']);
const verifyRoles = (container) => {
  docker(['exec', container, 'sh', '-c', 'PGPASSWORD="$ERP_OWNER_PASSWORD" psql -X -w -h "$HOSTNAME" -U erp -d erp_license -Atc "SELECT 1"']);
  docker(['exec', container, 'sh', '-c', 'PGPASSWORD="$ERP_APP_PASSWORD" psql -X -w -h "$HOSTNAME" -U erp_app -d erp_license -Atc "SELECT 1"']);
};
const sql = readFileSync(join(root, 'lisans-server/deploy/ensure-database.sql'), 'utf8');
const repair = () => docker(['exec', '-i', db, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], { input: sql });
try {
  docker(['volume', 'create', initVolume]);
  docker(['network', 'create', network]);
  // Linux volume permissions reproduce the VPS bug even when the host is Windows.
  docker(['run', '--rm', '--mount', `type=bind,source=${join(root, 'lisans-server/deploy')},target=/source,readonly`,
    '--mount', `type=volume,source=${initVolume},target=/init`, 'node:22-bookworm-slim', 'bash', '-c',
    'cp /source/init-prod.sh /init/10-init-prod.sh; chmod 700 /init/10-init-prod.sh']);
  start(db);
  let exited = false;
  for (let i = 0; i < 60; i++) {
    if (docker(['inspect', '--format', '{{.State.Status}}', db]).trim() === 'exited') { exited = true; break; }
    await sleep();
  }
  assert.ok(exited, 'The root-only init script must reproduce the old bootstrap failure');
  const logs = spawnSync('docker', ['logs', db], { encoding: 'utf8', env: environment, timeout: 30_000 });
  assert.match(`${logs.stdout}${logs.stderr}`, /Permission denied/);
  docker(['start', db]);
  await ready(db);
  assert.equal(docker(['exec', db, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-Atc', "SELECT count(*) FROM pg_roles WHERE rolname='erp'"]).trim(), '0');
  repair();
  verifyRoles(db);
  docker(['exec', db, 'psql', '-X', '-U', 'postgres', '-d', 'erp_license', '-c', "CREATE TABLE installation_sentinel (marker text); INSERT INTO installation_sentinel VALUES ('preserve-me')"]);
  repair();
  assert.equal(docker(['exec', db, 'psql', '-X', '-U', 'postgres', '-d', 'erp_license', '-Atc', 'SELECT marker FROM installation_sentinel']).trim(), 'preserve-me');
  // Existing passwords must not be silently reset by partial-bootstrap recovery.
  docker(['exec', db, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-c', "ALTER ROLE erp PASSWORD 'test-only-different'"]);
  repair();
  assert.throws(() => verifyRoles(db));
  docker(['run', '--rm', '--mount', `type=volume,source=${initVolume},target=/init`, 'node:22-bookworm-slim', 'chmod', '644', '/init/10-init-prod.sh']);
  start(cleanDb);
  await ready(cleanDb);
  verifyRoles(cleanDb);
  if (process.env.LICENSE_TEST_IMAGE) {
    docker(['run', '--rm', '--network', network, '-e', `MIGRATION_DATABASE_URL=postgres://erp:test-only-owner@${cleanDb}:5432/erp_license`, process.env.LICENSE_TEST_IMAGE, 'node', 'dist/migrate.js']);
    docker(['volume', 'create', keyVolume]);
    docker(['run', '--rm', '--mount', `type=volume,source=${keyVolume},target=/keys`, 'node:22-bookworm-slim', 'chown', '1000:1000', '/keys']);
    docker(['run', '--rm', '--user', '1000:1000', '--mount', `type=volume,source=${keyVolume},target=/keys`,
      '-e', 'LICENSE_SIGNING_KEY_PASSPHRASE', process.env.LICENSE_TEST_IMAGE, 'node', 'dist/cli.js', 'keygen', '--kid=test-vendor', '--out=/keys/signing-key.json']);
    docker(['run', '-d', '--name', server, '--network', network,
      '-e', `DATABASE_URL=postgres://erp_app:test-only-app@${cleanDb}:5432/erp_license`,
      '-e', 'LICENSE_DATA_KEY=0123456789abcdef0123456789abcdef',
      '-e', 'LICENSE_SIGNING_KEY_PASSPHRASE', '-e', 'LICENSE_SIGNING_KEY_FILE=/run/keys/signing-key.json',
      '-e', 'LICENSE_ADMIN_ORIGIN=https://admin.example.test',
      '--mount', `type=volume,source=${keyVolume},target=/run/keys,readonly`, process.env.LICENSE_TEST_IMAGE]);
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        docker(['exec', server, 'node', '-e', "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
        healthy = true; break;
      } catch { await sleep(); }
    }
    assert.ok(healthy, 'The installed license server must start with its sealed key and app database role');
    const setup = docker(['exec', server, 'node', 'dist/cli.js', 'setup:token']);
    assert.match(setup, /İlk yönetici kurulum kodu:/);
  }
  console.log('Başarılı: Linux izin hatası tekrarlandı; eksik roller kurtarıldı; veri/parolalar korundu; temiz kurulum, migration, sunucu sağlığı ve yönetici kurulum kodu doğrulandı.');
} finally {
  for (const container of [server, db, cleanDb]) { try { docker(['rm', '-fv', container]); } catch { /* Already gone. */ } }
  for (const volume of [initVolume, keyVolume]) { try { docker(['volume', 'rm', volume]); } catch { /* Already gone. */ } }
  try { docker(['network', 'rm', network]); } catch { /* Already gone. */ }
}
