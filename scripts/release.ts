/**
 * Sürüm kiti (müşteriye kaynaksız teslim) üretimi.
 *
 *   LICENSE_SERVER_URL=https://lisans.firma.com npm run release -- --version=1.2.0 [--targets=linux-x64,win-x64] [--skip-build]
 *       [--keep] [--out=release] [--allow-no-license-server]
 *
 * Lisans sunucusu adresi (LICENSE_SERVER_URL, https) derlemeye gömülür ve kit.json'a yazılır; yoksa müşteri kurulumunda
 * çevrimiçi etkinleştirme yapılamaz (LICENSE_SERVER_NOT_CONFIGURED). Bu yüzden adres verilmeden kit üretilmez; yalnızca
 * çevrimdışı etkinleştirmeyle teslim edilecek bir kit için bilerek --allow-no-license-server verilir.
 *
 * Her hedef için tek arşiv üretir (release/<sürüm>/):
 *   muhasebe-erp-<sürüm>-linux-x64.tar.gz   Linux ve WSL (Ubuntu/Debian) — ./install.sh
 *   muhasebe-erp-<sürüm>-win-x64.zip        Windows 10/11, Server 2019+   — Kur.cmd
 *
 * Kit içeriği: derlenmiş API (`app/dist`) + web arayüzü (`app/web`, kaynak haritası yok) + hedef platformun üretim
 * bağımlılıkları (`app/node_modules`, yerel argon2 ikilisi dahil) + resmî Node.js çalışma zamanı (`app/runtime`, nodejs.org
 * SHA-256 doğrulamalı) + kurulum sihirbazı + Docker yolu için compose dosyaları. Windows kitinde ayrıca WinSW hizmet sarmalayıcısı
 * (sabitlenmiş SHA-256) ve Docker yolu için Linux bağımlılıkları (`docker/node_modules`) bulunur. Böylece aynı kitle hem
 * Docker'lı hem Docker'sız kurulum yapılır (Docker yolu imajı bu dosyalardan yerelde oluşturur).
 *
 * Lisans: API paketi lisans denetimiyle ve satıcı açık anahtarıyla derlenir (apps/api/scripts/build.ts); derlemeyi satıcı yapar.
 * İndirmeler `release/.cache` altında saklanır.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { unzipSync, Zip, ZipDeflate } from 'fflate';

type Target = 'linux-x64' | 'win-x64';
const ALL_TARGETS: Target[] = ['linux-x64', 'win-x64'];
const NODE_MAJOR = 22;
const WINSW = {
  version: '2.12.0',
  url: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
  licenseUrl: 'https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt',
};
const CADDY = { version: '2.11.7', sha256: '0a1edc0b799512051c57071ce0e798d3f2cf67dc98171366f1d2b326072e3b06' };
const WORKSPACE_PKGS = [
  'apps/api',
  'apps/web',
  'lisans-server/server',
  'lisans-server/panel',
  'packages/shared',
  'lisans-server/core',
];

const root = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k!, v.length ? v.join('=') : 'true'];
  }),
);
const version = args.version ?? '';
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version))
  fail('--version=X.Y.Z gerekli (ör. --version=1.2.0)');
const targets = (args.targets ? args.targets.split(',') : ALL_TARGETS) as Target[];
for (const t of targets)
  if (!ALL_TARGETS.includes(t)) fail(`Bilinmeyen hedef: ${t} (${ALL_TARGETS.join(', ')})`);
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// Lisans sunucusu adresi: kitin çevrimiçi etkinleştirebilmesi için zorunlu (bilinçli istisna: --allow-no-license-server)
const licenseServerUrl = (process.env.LICENSE_SERVER_URL ?? '').trim();
const allowNoLicenseServer = args['allow-no-license-server'] === 'true';
if (!licenseServerUrl && !allowNoLicenseServer) {
  fail(
    'LICENSE_SERVER_URL verilmedi: bu kit lisansı çevrimiçi etkinleştiremez. Adresi verin (LICENSE_SERVER_URL=https://lisans.firma.com npm run release -- …) ' +
      'ya da yalnızca çevrimdışı etkinleştirme için bilerek --allow-no-license-server ekleyin.',
  );
}
if (
  licenseServerUrl &&
  !/^https:\/\/[^/\s]+(\/\S*)?$/.test(licenseServerUrl) &&
  process.env.LICENSE_ALLOW_INSECURE_URL !== 'true'
) {
  fail(`LICENSE_SERVER_URL https:// ile başlamalı (verilen: ${licenseServerUrl})`);
}
if (!licenseServerUrl)
  console.warn(
    '! UYARI: lisans sunucusu adresi YOK (--allow-no-license-server): kit yalnızca çevrimdışı etkinleştirilebilir.',
  );

// --out göreli ya da mutlak olabilir (mutlak yol depo altına eklenmez)
const outBase = resolve(root, args.out ?? 'release');
const outDir = join(outBase, version);
const cache = join(outBase, '.cache');
mkdirSync(outDir, { recursive: true });
mkdirSync(cache, { recursive: true });
const log = (m: string) => console.log(`• ${m}`);
const sha256 = (buf: Buffer | Uint8Array) => createHash('sha256').update(buf).digest('hex');
const run = (cmd: string, argv: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(cmd, argv, { cwd, stdio: 'inherit', env });

async function download(url: string, file: string): Promise<Buffer> {
  const path = join(cache, file);
  if (existsSync(path)) return readFileSync(path);
  log(`indiriliyor: ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`${url} indirilemedi (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return buf;
}

// ---- 1) Derleme -----------------------------------------------------------------------------------------------------
if (args['skip-build'] !== 'true') {
  log('derleniyor (web + API)…');
  run('npm', ['run', 'build']);
  run('npm', ['run', 'licenses:notices']);
}
const apiDist = join(root, 'apps/api/dist');
const webDist = join(root, 'apps/web/dist');
const notices = join(root, 'THIRD-PARTY-NOTICES.md');
// --skip-build: önceden derlenmiş paketin aynı lisans sunucusu adresiyle derlendiğini doğrula (derlemeye gömülüdür)
if (args['skip-build'] === 'true' && licenseServerUrl && existsSync(join(apiDist, 'server.js'))) {
  if (
    !readFileSync(join(apiDist, 'server.js'), 'utf8').includes(
      JSON.stringify(licenseServerUrl).slice(1, -1),
    )
  ) {
    fail(
      `apps/api/dist bu lisans sunucusu adresiyle (${licenseServerUrl}) derlenmemiş: --skip-build olmadan yeniden derleyin`,
    );
  }
}
for (const p of [
  join(apiDist, 'server.js'),
  join(apiDist, 'migrate.js'),
  join(webDist, 'index.html'),
  notices,
]) {
  if (!existsSync(p))
    fail(`${relative(root, p)} yok: önce derleyin (--skip-build olmadan çalıştırın)`);
}

// ---- 2) Node.js çalışma zamanı (nodejs.org, SHA-256) ---------------------------------------------------------------
const shasums = (
  await (await fetch(`https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt`)).text()
).trim();
const sumOf = (name: string) =>
  shasums
    .split('\n')
    .find((l) => l.endsWith(`  ${name}`))
    ?.split(/\s+/)[0];
const nodeVersion =
  /node-v(\d+\.\d+\.\d+)-/.exec(shasums)?.[1] ?? fail('Node sürümü bulunamadı (SHASUMS256.txt)');
log(`Node.js çalışma zamanı: ${nodeVersion}`);

async function nodeRuntime(target: Target, dest: string) {
  mkdirSync(dest, { recursive: true });
  const name =
    target === 'win-x64'
      ? `node-v${nodeVersion}-win-x64.zip`
      : `node-v${nodeVersion}-linux-x64.tar.xz`;
  const expected = sumOf(name) ?? fail(`${name} için özet yok`);
  const buf = await download(`https://nodejs.org/dist/v${nodeVersion}/${name}`, name);
  if (sha256(buf) !== expected) {
    rmSync(join(cache, name), { force: true });
    fail(`${name}: SHA-256 tutmadı (indirme bozuk; önbellekten silindi, yeniden deneyin)`);
  }
  const dir = name.replace(/\.(zip|tar\.xz)$/, '');
  if (target === 'win-x64') {
    const files = unzipSync(new Uint8Array(buf), {
      filter: (f) => f.name === `${dir}/node.exe` || f.name === `${dir}/LICENSE`,
    });
    writeFileSync(join(dest, 'node.exe'), files[`${dir}/node.exe`]!);
    writeFileSync(join(dest, 'LICENSE'), files[`${dir}/LICENSE`]!);
  } else {
    const tmp = join(cache, `x-${dir}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    run('tar', ['-xJf', join(cache, name), '-C', tmp, `${dir}/bin/node`, `${dir}/LICENSE`]);
    cpSync(join(tmp, dir, 'bin/node'), join(dest, 'node'));
    cpSync(join(tmp, dir, 'LICENSE'), join(dest, 'LICENSE'));
    chmodSync(join(dest, 'node'), 0o755);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 3) Hedef platformun üretim bağımlılıkları ---------------------------------------------------------------------
const lockHash = sha256(readFileSync(join(root, 'package-lock.json'))).slice(0, 12);
function prodDeps(os: 'linux' | 'win32'): string {
  const dir = join(cache, `deps-${os}-x64-${lockHash}`);
  if (existsSync(join(dir, 'node_modules'))) return join(dir, 'node_modules');
  log(`üretim bağımlılıkları kuruluyor (${os}-x64)…`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  cpSync(join(root, 'package-lock.json'), join(dir, 'package-lock.json'));
  for (const p of WORKSPACE_PKGS) {
    mkdirSync(join(dir, p), { recursive: true });
    cpSync(join(root, p, 'package.json'), join(dir, p, 'package.json'));
  }
  run(
    'npm',
    [
      'ci',
      '--omit=dev',
      '-w',
      '@erp/api',
      `--os=${os}`,
      '--cpu=x64',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    dir,
  );
  // Çalışma alanı bağları (@erp/*) pakete gömülüdür; kitte boşta kalan bağ olmasın
  rmSync(join(dir, 'node_modules/@erp'), { recursive: true, force: true });
  rmSync(join(dir, 'node_modules/.bin'), { recursive: true, force: true });
  // --omit=dev bazı geliştirme araçlarının boş kapsam klasörlerini (ör. node_modules/@types) bırakır
  removeEmptyDirs(join(dir, 'node_modules'));
  const argon = readdirSync(join(dir, 'node_modules/@node-rs')).filter((n) =>
    n.startsWith('argon2-'),
  );
  const want = os === 'win32' ? 'argon2-win32-x64-msvc' : 'argon2-linux-x64-gnu';
  if (!argon.includes(want)) fail(`${want} kurulmadı (bulunan: ${argon.join(', ') || 'yok'})`);
  return join(dir, 'node_modules');
}

/** Boş klasörleri (alttan üste) siler; klasörün kendisi boş kalırsa onu da. */
function removeEmptyDirs(dir: string): boolean {
  let empty = true;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.isSymbolicLink()) {
      if (!removeEmptyDirs(join(dir, e.name))) empty = false;
    } else empty = false;
  }
  if (empty) rmSync(dir, { recursive: true, force: true });
  return empty;
}

// ---- 4) Kit klasörü ----------------------------------------------------------------------------------------------------
const copyFiltered = (from: string, to: string, skip: (name: string) => boolean) =>
  cpSync(from, to, { recursive: true, filter: (src) => !skip(basename(src)) });

async function stage(target: Target): Promise<string> {
  const name = `muhasebe-erp-${version}-${target}`;
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  log(`kit hazırlanıyor: ${name}`);
  const app = join(dir, 'app');
  copyFiltered(apiDist, join(app, 'dist'), (n) => n.endsWith('.map') || n === 'construction-worker.py');
  const worker = resolve(root, args['worker-dir'] ?? `.runtime/compiled-worker/${target}/construction-worker.dist`);
  const workerName = target === 'win-x64' ? 'construction-worker.exe' : 'construction-worker';
  if (!existsSync(join(worker, workerName))) fail(`Derlenmiş IFC/OCR işleyicisi yok: ${worker}. Önce installer/runtime/build-worker aracını çalıştırın.`);
  cpSync(worker, join(app, 'worker'), { recursive: true });
  const tessdata = resolve(root, args['tessdata-dir'] ?? 'apps/api/data/construction-runtime/tessdata');
  for (const lang of ['tur', 'eng']) if (!existsSync(join(tessdata, `${lang}.traineddata.gz`))) fail(`OCR dili eksik: ${lang}`);
  cpSync(tessdata, join(app, 'tessdata'), { recursive: true });
  copyFiltered(webDist, join(app, 'web'), (n) => n.endsWith('.map'));
  cpSync(notices, join(app, 'THIRD-PARTY-NOTICES.md'));
  cpSync(notices, join(app, 'web', 'THIRD-PARTY-NOTICES.md'));
  const noMaps = { recursive: true, filter: (src: string) => !src.endsWith('.map') };
  cpSync(prodDeps(target === 'win-x64' ? 'win32' : 'linux'), join(app, 'node_modules'), noMaps);
  removeEmptyDirs(join(app, 'node_modules'));
  await nodeRuntime(target, join(app, 'runtime'));
  if (target === 'win-x64') {
    // Docker yolu (Docker Desktop Linux kapları çalıştırır): imaj için Linux bağımlılıkları
    cpSync(prodDeps('linux'), join(dir, 'docker', 'node_modules'), noMaps);
    removeEmptyDirs(join(dir, 'docker', 'node_modules'));
    const exe = await download(WINSW.url, `WinSW-${WINSW.version}-x64.exe`);
    if (sha256(exe) !== WINSW.sha256) fail('WinSW SHA-256 tutmadı');
    mkdirSync(join(dir, 'winsw'), { recursive: true });
    writeFileSync(join(dir, 'winsw', 'MuhasebeERP.exe'), exe);
    writeFileSync(
      join(dir, 'winsw', 'LICENSE.txt'),
      await download(WINSW.licenseUrl, `WinSW-${WINSW.version}-LICENSE.txt`),
    );
    const proxy = await download(`https://github.com/caddyserver/caddy/releases/download/v${CADDY.version}/caddy_${CADDY.version}_windows_amd64.zip`, `caddy-${CADDY.version}-windows.zip`);
    if (sha256(proxy) !== CADDY.sha256) fail('Caddy SHA-256 tutmadı');
    const contents = unzipSync(proxy);
    if (!contents['caddy.exe']) fail('Caddy çalıştırılabilir dosyası bulunamadı');
    mkdirSync(join(app, 'proxy'), { recursive: true });
    writeFileSync(join(app, 'proxy/caddy.exe'), contents['caddy.exe']);
    if (contents['LICENSE']) writeFileSync(join(app, 'proxy/LICENSE.txt'), contents['LICENSE']);
  }
  // Kurulum sihirbazı ve Docker yolu dosyaları
  copyFiltered(join(root, 'installer'), join(dir, 'installer'), (n) => ['bin', 'obj', 'Wizard', 'Bundle', 'build.ps1', 'build-worker.ps1', 'build-worker.sh'].includes(n) || n.endsWith('.cs') || n.endsWith('.csproj') || n.endsWith('.wxs') || n.endsWith('.wixproj'));
  if (target === 'win-x64') cpSync(join(root, 'Kur.cmd'), join(dir, 'Kur.cmd'));
  else cpSync(join(root, 'install.sh'), join(dir, 'install.sh'));
  for (const f of [
    'deploy/docker-compose.prod.yml',
    'deploy/Caddyfile',
    'deploy/.env.production.example',
    'infra/postgres/init-prod.sh',
    'scripts/backup.sh',
    'scripts/restore.sh',
    'scripts/construction-runtime.sh',
    'scripts/construction-runtime.ps1',
    'docs/CONSTRUCTION-360.md',
    'docs/OPERATIONS.md',
  ]) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    cpSync(join(root, f), join(dir, f));
  }
  let commit = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    // depo dışı derleme
  }
  writeFileSync(
    join(dir, 'kit.json'),
    `${JSON.stringify({ product: 'muhasebe-erp', version, target, node: nodeVersion, builtAt: new Date().toISOString(), commit, licenseServerUrl: licenseServerUrl || null }, null, 2)}\n`,
  );
  const inspect = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, item.name), path = relative(dir, file).replaceAll('\\', '/');
      if (item.isSymbolicLink()) fail(`Paket içinde sembolik bağ: ${path}`);
      if (/^(lisans-server|\.git|apps|packages|test|tests|e2e)(\/|$)/.test(path) || /(^|\/)(\.env|signing-key\.json|.*\.pem|.*\.key)$/.test(path)) fail(`Satıcı dosyası pakete girdi: ${path}`);
      if (item.isDirectory()) inspect(file);
      else if (!path.includes('/node_modules/') && !path.includes('/worker/') && /\.(ts|tsx|cs|csproj|wxs|wixproj|map)$/.test(path)) fail(`Geliştirme kaynağı pakete girdi: ${path}`);
      else if (/construction-worker\.py$/.test(path)) fail(`Uygulama işleyicisinin kaynağı pakete girdi: ${path}`);
    }
  };
  inspect(dir);
  writeFileSync(join(dir, 'PACKAGE-CHECK.json'), JSON.stringify({ sourceLeakCheck: 'passed', version, target, checkedAt: new Date().toISOString() }));
  return dir;
}

// ---- 5) Arşiv ------------------------------------------------------------------------------------------------------------
async function zipDir(dir: string, out: string) {
  const output = createWriteStream(out); let blocked = false; let failure: Error | null = null;
  output.on('error', (e) => { failure = e; });
  const zip = new Zip((err, data, final) => { if (err) { failure = err; output.destroy(err); return; } blocked = !output.write(data) || blocked; if (final) output.end(); });
  const flush = async () => { if (failure) throw failure; if (blocked && output.writableNeedDrain) await once(output, 'drain'); blocked = false; };
  const prefix = basename(dir);
  const walk = async (p: string) => {
    for (const e of readdirSync(p)) {
      const full = join(p, e);
      const st = statSync(full);
      if (st.isDirectory()) await walk(full);
      else {
        const entry = new ZipDeflate(`${prefix}/${relative(dir, full).split('\\').join('/')}`, { level: 6 }); entry.mtime = st.mtime; zip.add(entry);
        for await (const chunk of createReadStream(full)) { entry.push(chunk as Buffer); await flush(); }
        entry.push(new Uint8Array(), true); await flush();
      }
    }
  };
  await walk(dir); zip.end(); await finished(output);
}

const sums: string[] = [];
for (const target of targets) {
  const dir = await stage(target);
  const name = basename(dir);
  const archive = target === 'win-x64' ? `${name}.zip` : `${name}.tar.gz`;
  const out = join(outDir, archive);
  log(`arşivleniyor: ${archive}`);
  if (target === 'win-x64') await zipDir(dir, out);
  else run('tar', ['-czf', out, '-C', outDir, name]);
  const digest = createHash('sha256'); for await (const chunk of createReadStream(out)) digest.update(chunk);
  sums.push(`${digest.digest('hex')}  ${archive}`);
  if (args.keep !== 'true') rmSync(dir, { recursive: true, force: true });
}
// Hedefler ayrı ayrı üretilebilir: önceki satırlar korunur, aynı arşivin satırı yenilenir
const sumsFile = join(outDir, 'SHA256SUMS');
const kept = existsSync(sumsFile)
  ? readFileSync(sumsFile, 'utf8')
      .split('\n')
      .filter((l) => l && !sums.some((s) => s.split('  ')[1] === l.split('  ')[1]))
  : [];
writeFileSync(
  sumsFile,
  `${[...kept, ...sums].sort((a, b) => a.split('  ')[1]!.localeCompare(b.split('  ')[1]!)).join('\n')}\n`,
);
console.log(`\n✓ Kitler hazır: ${relative(root, outDir)}\n${sums.map((s) => `  ${s}`).join('\n')}`);
