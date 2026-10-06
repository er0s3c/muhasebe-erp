import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, chownSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stage = join(root, '.runtime', `vps-keygen-${randomUUID()}`);
if (!stage.startsWith(join(root, '.runtime') + sep)) throw new Error('Geçersiz test yolu');
const keys = join(stage, 'keys');
const image = process.env.LICENSE_TEST_IMAGE;
if (!image) throw new Error('Derlenmiş lisans sunucusu için LICENSE_TEST_IMAGE gerekli');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
mkdirSync(keys, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  // Linux CI runners can chown via their passwordless sudo; Docker runs as UID 1000.
  if (process.getuid() === 0 || process.getuid() === 1000) chownSync(keys, 1000, 1000);
  else execFileSync('sudo', ['chown', '1000:1000', keys]);
}
const environment = {
  ...process.env, MSYS_NO_PATHCONV: '1',
  ERP_KEYGEN_HELPER: join(root, 'lisans-server/tools/resume-setup-vps.sh').replaceAll('\\', '/'),
  ERP_KEYGEN_KEYS: keys.replaceAll('\\', '/'), ERP_KEYGEN_IMAGE: image,
  ERP_KEYGEN_TEST_PASSWORD: randomBytes(32).toString('hex'),
};
delete environment.LICENSE_SIGNING_KEY_PASSPHRASE;
const invoke = () => execFileSync(bash, ['-c', [
  'source "$ERP_KEYGEN_HELPER";',
  'unset LICENSE_SIGNING_KEY_PASSPHRASE;',
  'LICENSE_SIGNING_KEY_PASSPHRASE=$ERP_KEYGEN_TEST_PASSWORD;',
  'ensure_signing_key "$ERP_KEYGEN_KEYS" "$ERP_KEYGEN_IMAGE"',
].join('\n')], { env: environment, timeout: 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  invoke();
  const file = join(keys, 'signing-key.json');
  const before = readFileSync(file);
  assert.equal(JSON.parse(before).kid, 'vendor1');
  const checksum = createHash('sha256').update(before).digest('hex');
  assert.ok(!before.toString().includes(environment.ERP_KEYGEN_TEST_PASSWORD));
  invoke();
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), checksum);
  console.log('Başarılı: gerçek Docker CLI ile mühürlü anahtar üretimi, ortam parolası ve tekrar çalıştırmada anahtarın korunması.');
} finally {
  environment.ERP_KEYGEN_TEST_PASSWORD = '';
  if (process.platform !== 'win32' && process.getuid() !== 0 && process.getuid() !== 1000) {
    execFileSync('sudo', ['chown', '-R', `${process.getuid()}:${process.getgid()}`, stage]);
  }
  rmSync(stage, { recursive: true, force: true });
}
