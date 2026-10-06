import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(version ?? '')) throw new Error('Tam kaynak commit kimliği gerekli');
const imageIndex = process.argv.indexOf('--image');
const runtimeImage = imageIndex === -1 ? undefined : process.argv[imageIndex + 1];
if (!/^ghcr\.io\/er0s3c\/muhasebe-erp-license@sha256:[a-f0-9]{64}$/.test(runtimeImage ?? '')) {
  throw new Error('--image ile yayımlanmış lisans imajının tam @sha256 adresi gerekli; kaynak commit kimliği yayımlanmış imaj anlamına gelmez');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (head !== version) throw new Error('Paket kaynağı seçilen commit ile aynı olmalı');
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
const localTest = process.argv.includes('--local-test');
if (dirty && !localTest) throw new Error('Üretim kurulum paketi temiz Git checkout gerektirir');
const stage = join(root, '.runtime', 'license-vps-kit', version);
if (!stage.startsWith(join(root, '.runtime') + sep)) throw new Error('Geçersiz çıktı yolu');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
// Deliberate allowlist: no source repo, database, signing key or environment files.
const files = [
  'deploy/compose.runtime.yml', 'deploy/compose.host-tunnel.yml', 'deploy/compose.managed-tunnel.yml',
  'deploy/Caddyfile.tunnel', 'deploy/init-prod.sh',
  'tools/setup-vps.sh', 'tools/setup-input.sh', 'tools/resume-setup-vps.sh', 'tools/configure-deploy.sh', 'tools/deploy-vps.sh',
  'tools/backup-vps.sh', 'tools/restore-vps.sh', 'docs/DOCKER-TUNNEL-KURULUM.md',
];
for (const file of files) {
  const destination = join(stage, file);
  await mkdir(dirname(destination), { recursive: true });
  const contents = (await readFile(join(root, 'lisans-server', file), 'utf8')).replace(/\r\n/g, '\n');
  await writeFile(destination, contents, { mode: file.endsWith('.sh') ? 0o700 : 0o600 });
}
await writeFile(join(stage, 'COMMIT'), `${version}\n`);
await writeFile(join(stage, 'RUNTIME_IMAGE'), `${runtimeImage}\n`);
await writeFile(join(stage, 'build-info.json'), JSON.stringify({ sourceCommit: version, runtimeImage, localTest, dirty }, null, 2));
const out = join(root, 'release', 'license-vps');
await mkdir(out, { recursive: true });
const archive = `lisans-vps-${version}.tar.gz`;
execFileSync('tar', ['-czf', join(out, archive), '-C', stage, '.'], { stdio: 'inherit' });
const hash = createHash('sha256').update(await readFile(join(out, archive))).digest('hex');
await writeFile(join(out, 'SHA256SUMS'), `${hash}  ${archive}\n`);
await copyFile(join(root, 'lisans-server/docs/DOCKER-TUNNEL-KURULUM.md'), join(out, 'KURULUM.md'));
console.log(`VPS kurulum paketi: ${join(out, archive)}`);
