import type { Tx } from './client';
import { taxRates } from './schema';

/** Demo geçmişi gerçek mevzuat paketini geriye taşımaz. Bu oranlar yalnız örnek işlemler içindir. */
export async function seedDemoTaxHistory(tx: Tx, companyId: string) {
  await tx.insert(taxRates).values([0, 5, 10, 16, 20].map((rate) => ({
    companyId, jurisdiction: 'KKTC' as const, code: `KDV-${rate}`,
    name: `Demo KDV %${rate}`, rate: String(rate), validFrom: '2000-01-01',
    validTo: '2026-09-15', rulePackVersion: 'synthetic-demo-history-v1',
    sourceNote: 'Yalnız demo senaryolarına ait sentetik geçmiş oranı; resmî mevzuat değildir.',
  }))).onConflictDoNothing();
}
