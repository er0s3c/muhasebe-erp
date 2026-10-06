/**
 * API üretim derlemesi: `node dist/server.js`, `node dist/migrate.js`, `node dist/demo.js` ve `node dist/admin.js` girişlerini üretir.
 *
 * - `@erp/shared` ve `@erp/license-core` çalışma alanı paketleri ham TypeScript olduğundan pakete GÖMÜLÜR.
 * - `apps/api` `dependencies` içindeki her şey DIŞARIDA kalır (yerel modül `@node-rs/argon2` gömülemez;
 *   çalışma zamanı kabında `npm ci --omit=dev -w @erp/api` ile kurulur).
 * - Migration SQL dosyaları `dist/drizzle` altına kopyalanır (migrate.js yanında aranır).
 * - Derleme sonrası metafile denetlenir: node_modules içinden hiçbir şey gömülmemiş olmalı ve
 *   her dış içe aktarma `dependencies` içinde olmalı; aksi halde derleme hata verir.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyringUsable, parseKeyring } from '../src/licensing/keyring';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
const deps = Object.keys(pkg.dependencies);
const outdir = join(root, 'dist');

// Lisans: üretim paketi her zaman lisans denetimiyle derlenir (ortam değişkeniyle kapatılamaz) ve satıcının açık anahtarını gömer.
//  - Anahtar halkası: LICENSE_PUBLIC_KEYS_JSON (yayın/CI) ya da depodaki src/licensing/public-keys.json.
//  - Güvenilir anahtar yoksa derleme başarısız olur (kullanılamaz bir paket üretilmesin).
//    LICENSE_ALLOW_EMPTY_KEYRING=true yalnızca derlemenin derlenebildiğini doğrulamak içindir (CI `check` işi): boş halkayla
//    paket kapalı kalır (hiçbir lisans etkinleştirilemez), yani güvenli yönde hata verir.
const ring = parseKeyring(process.env.LICENSE_PUBLIC_KEYS_JSON?.trim() || readFileSync(join(root, 'src/licensing/public-keys.json'), 'utf8'));
if (!keyringUsable(ring) && process.env.LICENSE_ALLOW_EMPTY_KEYRING !== 'true') {
  throw new Error(
    'Güvenilir satıcı açık anahtarı yok: LICENSE_PUBLIC_KEYS_JSON verin ya da açık anahtarı apps/api/src/licensing/public-keys.json dosyasına ekleyin (docs/LICENSING.md)',
  );
}
const licenseServerUrl = process.env.LICENSE_SERVER_URL?.trim() ?? '';
if (licenseServerUrl && !licenseServerUrl.startsWith('https://') && process.env.LICENSE_ALLOW_INSECURE_URL !== 'true') {
  throw new Error('LICENSE_SERVER_URL https olmalı (yalnızca test düzenekleri için LICENSE_ALLOW_INSECURE_URL=true)');
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { server: 'src/server.ts', migrate: 'src/db/migrate-cli.ts', demo: 'src/db/demo-cli.ts', admin: 'src/db/admin-cli.ts' },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Kaynak haritası üretim paketinde yok: hem boyut hem de kapıları bulmayı/yamalamayı zorlaştırmak için (API_SOURCEMAP=true yalnızca hata ayıklama)
  sourcemap: process.env.API_SOURCEMAP === 'true',
  minify: true,
  define: {
    __LICENSE_ENFORCED__: 'true',
    __LICENSE_KEYRING__: JSON.stringify(JSON.stringify(ring)),
    __LICENSE_SERVER_URL__: JSON.stringify(licenseServerUrl),
  },
  // Alt yollar da (ör. drizzle-orm/node-postgres) dış sayılsın
  external: deps.flatMap((d) => [d, `${d}/*`]),
  metafile: true,
  logLevel: 'info',
  // ESM paketinde CommonJS bağımlılıkların `require` kullanabilmesi için
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

// 1) node_modules'tan hiçbir şey gömülmemiş olmalı (yalnızca kendi kaynağımız ve @erp/shared)
const bundled = Object.keys(result.metafile.inputs).filter(
  (p) => p.includes('node_modules/') && !p.includes('/@erp/shared/') && !p.includes('packages/shared') && !p.includes('/@erp/license-core/') && !p.includes('packages/license-core'),
);
if (bundled.length > 0) {
  throw new Error(`Pakete gömülmemesi gereken bağımlılıklar var (dependencies'e ekleyin ya da dış bırakın):\n${bundled.slice(0, 10).join('\n')}`);
}
// 2) Her dış içe aktarma api dependencies içinde olmalı (çalışma zamanında kurulu olacak tek küme)
const builtin = (s: string) => s.startsWith('node:');
const missing = new Set<string>();
for (const out of Object.values(result.metafile.outputs)) {
  for (const imp of out.imports) {
    if (!imp.external || builtin(imp.path)) continue;
    const name = imp.path.startsWith('@') ? imp.path.split('/').slice(0, 2).join('/') : imp.path.split('/')[0]!;
    if (!deps.includes(name)) missing.add(imp.path);
  }
}
if (missing.size > 0) throw new Error(`Dış içe aktarma dependencies içinde yok: ${[...missing].join(', ')}`);

// Ana makine güncelleyicisi: kurulumun dışında (node_modules olmadan) çalışır; bu yüzden TÜM bağımlılıkları gömülü tek dosyadır.
await build({
  absWorkingDir: root,
  entryPoints: { updater: 'src/updater/cli.ts' },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  define: { __LICENSE_KEYRING__: JSON.stringify(JSON.stringify(ring)) },
  logLevel: 'warning',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

cpSync(join(root, 'drizzle'), join(outdir, 'drizzle'), { recursive: true });
cpSync(join(root,'src/modules/construction-control/construction-worker.py'),join(outdir,'construction-worker.py'));
cpSync(join(root,'../../installer/tools/construction-files.mjs'),join(outdir,'construction-files.mjs'));
console.log(`API derlemesi tamam: ${outdir} (server.js, migrate.js, demo.js, admin.js, updater.js, drizzle/)`);
