import { compareVersions, parseReleaseManifest, updateOfferSchema, type PublicKeyring } from '@erp/license-core';
import type { Db } from '../../db/client';
import { appUpdates } from '../../db/schema';

/**
 * Kalp atışıyla gelen teklifi doğrular (satıcı imzası + şema) ve saklar. Aynı sürüm yeniden gelirse manifesto ve indirme belirteci
 * yenilenir; onaylanmış/süren/biten kaydın durumu korunur.
 *
 * Sürüm düşürme koruması: çalışan sürüm (SemVer) biliniyorsa yalnızca ondan YENİ sürümler saklanır; aynı ya da eski sürümün
 * teklifi sessizce yok sayılır (`false` döner).
 */
export const isSemver = (v: string | null | undefined): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(v);

/** `version` çalışan sürümden yeni mi? Çalışan sürüm SemVer değilse (geliştirme: 'dev', 'test') karşılaştırma yapılmaz. */
export const isNewerThanCurrent = (version: string, current: string | null | undefined) => !isSemver(current) || compareVersions(version, current) > 0;

export async function storeUpdateOffer(db: Db, keyring: PublicKeyring, raw: unknown, currentVersion?: string): Promise<boolean> {
  const offer = updateOfferSchema.parse(raw);
  const m = parseReleaseManifest(offer.manifest, keyring);
  if (!isNewerThanCurrent(m.version, currentVersion)) return false;
  await db
    .insert(appUpdates)
    .values({ version: m.version, notes: m.notes, manifest: offer.manifest, files: m.files, downloadToken: offer.downloadToken })
    .onConflictDoUpdate({
      target: appUpdates.version,
      set: { notes: m.notes, manifest: offer.manifest, files: m.files, downloadToken: offer.downloadToken, offeredAt: new Date(), updatedAt: new Date() },
    });
  return true;
}
