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

/** Sürüm karşılaştırması (X.Y.Z; ön sürüm eki aynı X.Y.Z'nin kararlısından küçüktür). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split('-', 2) as [string, string | undefined];
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
