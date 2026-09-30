/**
 * Lisans sunucusu üretim derlemesi: `dist/server.js`, `dist/migrate.js`, `dist/cli.js`.
 * `@erp/shared` ve `@erp/license-core` (ham TS) pakete gömülür; dependencies dışarıda kalır.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
const workspace = new Set(['@erp/shared', '@erp/license-core']);
const deps = Object.keys(pkg.dependencies).filter((d) => !workspace.has(d));
const outdir = join(root, 'dist');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { server: 'src/server.ts', migrate: 'src/db/migrate-cli.ts', cli: 'src/cli.ts' },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Kaynak haritası üretilmez: dağıtılan paketten kaynak okunamasın.
  sourcemap: false,
  external: deps.flatMap((d) => [d, `${d}/*`]),
  metafile: true,
  logLevel: 'info',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});

const bundled = Object.keys(result.metafile.inputs).filter((p) => p.includes('node_modules/') && !p.includes('/@erp/') && !p.includes('packages/'));
if (bundled.length > 0) throw new Error(`Pakete gömülmemesi gereken bağımlılıklar var:\n${bundled.slice(0, 10).join('\n')}`);
const missing = new Set<string>();
for (const out of Object.values(result.metafile.outputs)) {
  for (const imp of out.imports) {
    if (!imp.external || imp.path.startsWith('node:')) continue;
    const name = imp.path.startsWith('@') ? imp.path.split('/').slice(0, 2).join('/') : imp.path.split('/')[0]!;
    if (!deps.includes(name)) missing.add(imp.path);
  }
}
if (missing.size > 0) throw new Error(`Dış içe aktarma dependencies içinde yok: ${[...missing].join(', ')}`);
cpSync(join(root, 'drizzle'), join(outdir, 'drizzle'), { recursive: true });
console.log(`Lisans sunucusu derlemesi tamam: ${outdir}`);
