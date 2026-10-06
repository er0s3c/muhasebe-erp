import { z } from 'zod';
import { LicenseTokenError, verifyToken, type PublicKeyring } from './token';

/**
 * Uzaktan güncelleme: satıcının imzaladığı sürüm manifestosu (belirteç türü `release`). Kurulum kitinin her hedef için dosya adı,
 * SHA-256 özeti ve boyutu manifestodadır; güncelleyici indirdiği dosyayı bu özete, manifestoyu gömülü satıcı anahtarına göre doğrular.
 */
export const RELEASE_TARGETS = ['linux-x64', 'win-x64'] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export const releaseVersionSchema = z
  .string()
  .max(40)
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, 'Sürüm X.Y.Z biçiminde olmalı');

/** Kit arşivinin adı (npm run release ile aynı). */
export const releaseFileName = (version: string, target: ReleaseTarget) => `muhasebe-erp-${version}-${target}.${target === 'win-x64' ? 'zip' : 'tar.gz'}`;

export const releaseFileSchema = z.object({
  target: z.enum(RELEASE_TARGETS),
  name: z.string().regex(/^muhasebe-erp-[0-9A-Za-z.-]+-(linux-x64\.tar\.gz|win-x64\.zip)$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 ** 3),
});
export type ReleaseFile = z.infer<typeof releaseFileSchema>;

export const releaseManifestSchema = z.object({
  v: z.literal(1),
  typ: z.literal('release'),
  version: releaseVersionSchema,
  notes: z.string().max(4000),
  publishedAt: z.number().int().min(0),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  protocolVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  files: z.array(releaseFileSchema).min(1).max(RELEASE_TARGETS.length),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Kalp atışı yanıtındaki güncelleme teklifi: imzalı manifesto + kısa ömürlü, kuruluma özel indirme belirteci. */
export const updateOfferSchema = z.object({
  manifest: z.string().min(20).max(8192),
  downloadToken: z.string().min(20).max(512),
});
export type UpdateOffer = z.infer<typeof updateOfferSchema>;

/** Manifestoyu imza ve şema açısından doğrular. */
export function parseReleaseManifest(token: string, ring: PublicKeyring): ReleaseManifest {
  const parsed = releaseManifestSchema.safeParse(verifyToken('release', token, ring));
  if (!parsed.success) throw new LicenseTokenError('BAD_PAYLOAD', 'Sürüm manifestosu geçersiz');
  for (const f of parsed.data.files) {
    if (f.name !== releaseFileName(parsed.data.version, f.target)) throw new LicenseTokenError('BAD_PAYLOAD', 'Manifesto dosya adı sürümle uyuşmuyor');
  }
  return parsed.data;
}

/**
 * Sürüm karşılaştırması (SemVer 2.0 önceliği): X.Y.Z sayısal; ön sürüm eki (`-rc.1`) aynı X.Y.Z'nin kararlısından küçüktür;
 * ön sürüm alanları noktayla ayrılır, sayısal alanlar sayı olarak, diğerleri ASCII olarak karşılaştırılır, sayısal alan sayısal
 * olmayandan küçüktür, alanları önek olan daha kısa ek küçüktür. Derleme üst verisi (`+...`) yok sayılır.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const noBuild = v.trim().replace(/^v/, '').split('+', 1)[0]!;
    const dash = noBuild.indexOf('-');
    const core = dash < 0 ? noBuild : noBuild.slice(0, dash);
    const pre = dash < 0 ? undefined : noBuild.slice(dash + 1);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre === undefined || pre === '' ? undefined : pre.split('.') };
  };
  const sign = (d: number) => (d < 0 ? -1 : d > 0 ? 1 : 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return sign(d);
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d !== 0) return sign(d);
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}
