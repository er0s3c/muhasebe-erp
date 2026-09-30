/**
 * API üretim derlemesi: `node dist/server.js`, `node dist/migrate.js`, `node dist/demo.js` ve `node dist/admin.js` girişlerini üretir.
 *
 * - `@erp/shared` çalışma alanı paketi ham TypeScript olduğundan pakete GÖMÜLÜR.
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
const deps = Object.keys(pkg.dependencies);
const outdir = join(root, 'dist');

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
  sourcemap: true,
  // Alt yollar da (ör. drizzle-orm/node-postgres) dış sayılsın
  external: deps.flatMap((d) => [d, `${d}/*`]),
  metafile: true,
  logLevel: 'info',
  // ESM paketinde CommonJS bağımlılıkların `require` kullanabilmesi için
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

// 1) node_modules'tan hiçbir şey gömülmemiş olmalı (yalnızca kendi kaynağımız ve @erp/shared)
const bundled = Object.keys(result.metafile.inputs).filter((p) => p.includes('node_modules/') && !p.includes('/@erp/shared/') && !p.includes('packages/shared'));
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

cpSync(join(root, 'drizzle'), join(outdir, 'drizzle'), { recursive: true });
console.log(`API derlemesi tamam: ${outdir} (server.js, migrate.js, demo.js, admin.js, drizzle/)`);
