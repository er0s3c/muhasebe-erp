import { JURISDICTION_PROFILES, type Jurisdiction } from '@erp/shared';
import type { Tx } from '../../db/client';
import { taxRates } from '../../db/schema';

/** Oran kümesi ürünün hukuki sınıfını belirlemez; müşavir doğrulaması ayrı işlemdir. */
export function defaultVatRates(jurisdiction: Jurisdiction) {
  return [...new Set([...JURISDICTION_PROFILES[jurisdiction].vatRates, 0])].map((value) => ({
    code: `KDV-${value}`, name: value === 0 ? 'KDV Sıfır Oran' : `KDV %${value}`, rate: String(value),
  }));
}

export async function seedTaxRates(tx: Tx, companyId: string, jurisdiction: Jurisdiction, effectiveFrom?: string): Promise<void> {
  const profile = JURISDICTION_PROFILES[jurisdiction];
  const validFrom = effectiveFrom && effectiveFrom > profile.vatEffectiveFrom ? effectiveFrom : profile.vatEffectiveFrom;
  await tx.insert(taxRates).values(defaultVatRates(jurisdiction).map((r) => ({
    companyId, ...r, validFrom, jurisdiction, rulePackVersion: profile.taxPackVersion,
    sourceUrl: profile.vatSourceUrl,
    sourceNote: `${profile.label} oran kümesi. Mal/hizmet kategorisi ve sıfır oran/istisna gerekçesi ayrıca değerlendirilmelidir; mali müşavirce doğrulanmadı.`,
  }))).onConflictDoNothing();
}

