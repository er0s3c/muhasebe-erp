import { parseReleaseManifest, updateOfferSchema, type PublicKeyring } from '@erp/license-core';
import type { Db } from '../../db/client';
import { appUpdates } from '../../db/schema';

/**
 * Kalp atışıyla gelen teklifi doğrular (satıcı imzası + şema) ve saklar. Aynı sürüm yeniden gelirse manifesto ve indirme belirteci
 * yenilenir; onaylanmış/süren/biten kaydın durumu korunur.
 */
export async function storeUpdateOffer(db: Db, keyring: PublicKeyring, raw: unknown): Promise<void> {
  const offer = updateOfferSchema.parse(raw);
  const m = parseReleaseManifest(offer.manifest, keyring);
  await db
    .insert(appUpdates)
    .values({ version: m.version, notes: m.notes, manifest: offer.manifest, files: m.files, downloadToken: offer.downloadToken })
    .onConflictDoUpdate({
      target: appUpdates.version,
      set: { notes: m.notes, manifest: offer.manifest, files: m.files, downloadToken: offer.downloadToken, offeredAt: new Date(), updatedAt: new Date() },
    });
}
