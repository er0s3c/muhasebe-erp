/**
 * Üçüncü taraf lisans bildirimi (THIRD-PARTY-NOTICES.md).
 *
 * MIT/BSD/Apache gibi lisanslar, ürünle birlikte DAĞITILAN kopyalarda telif bildiriminin ve lisans metninin
 * bulunmasını şart koşar. Bu betik, API ve web çalışma alanlarının ÜRETİM bağımlılık kümesini (geliştirme
 * bağımlılıkları hariç; web paketine gömülenler ve API imajına kurulanlar) `npm ls` ile çıkarır, her paketin lisans
 * dosyasını okur ve tek belgede toplar. Docker imajı derlenirken üretilir ve imaja konur (/app ve web kökü).
 *
 *   npm run licenses:notices            # THIRD-PARTY-NOTICES.md (depo kökü; depoya girmez)
 *   npm run licenses:notices -- out.md  # başka çıktı yolu
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface LsNode {
  version?: string;
  path?: string;
  dependencies?: Record<string, LsNode>;
}

const root = process.cwd();
const out = process.argv[2] ?? join(root, 'THIRD-PARTY-NOTICES.md');
const raw = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json', '--long', '-w', '@erp/api', '-w', '@erp/web'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  // npm ls, eksik/fazla bağımlılıkta 1 döner; çıktı yine de kullanılabilir
  stdio: ['ignore', 'pipe', 'ignore'],
});

const packages = new Map<string, { name: string; version: string; dir: string }>();
const walk = (deps: Record<string, LsNode> | undefined) => {
  for (const [name, node] of Object.entries(deps ?? {})) {
    if (!name.startsWith('@erp/') && node.version && node.path) {
      packages.set(`${name}@${node.version}`, { name, version: node.version, dir: node.path });
    }
    walk(node.dependencies);
  }
};
walk((JSON.parse(raw) as LsNode).dependencies);

const licenseFile = (dir: string): string | null => {
  const hit = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
  return hit ? join(dir, hit) : null;
};
const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'type' in v) return String((v as { type: unknown }).type);
  return 'bilinmiyor';
};

const sections: string[] = [];
const missing: string[] = [];
for (const key of [...packages.keys()].sort((a, b) => a.localeCompare(b))) {
  const p = packages.get(key)!;
  const pkg = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  const license = asText(pkg.license ?? (Array.isArray(pkg.licenses) ? (pkg.licenses as unknown[]).map(asText).join(' OR ') : undefined));
  const repo = asText(typeof pkg.repository === 'object' && pkg.repository ? (pkg.repository as { url?: string }).url : pkg.repository ?? pkg.homepage ?? '');
  const file = licenseFile(p.dir);
  if (!file) missing.push(key);
  const text = file && existsSync(file) ? readFileSync(file, 'utf8').trim() : `(Pakette ayrı bir lisans dosyası yok; lisans: ${license}. Kaynak: ${repo || 'belirtilmemiş'})`;
  sections.push(`## ${p.name} ${p.version}\n\nLisans: ${license}${repo ? `  \nKaynak: ${repo}` : ''}\n\n\`\`\`text\n${text}\n\`\`\`\n`);
}

const header = `# Üçüncü taraf bildirimleri

Bu ürün, aşağıdaki açık kaynak bileşenleri kendi lisanslarıyla kullanır (yalnızca üretim bağımlılıkları; ${packages.size} paket).
Bildirim, \`npm run licenses:notices\` ile kurulu paketlerden üretilmiştir.

`;
writeFileSync(out, header + sections.join('\n'));
console.log(`${packages.size} paket → ${out}${missing.length ? ` (lisans dosyası olmayan ${missing.length} paket: ${missing.join(', ')})` : ''}`);
