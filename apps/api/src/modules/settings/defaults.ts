import type { Tx } from '../../db/client';
import { taxRates } from '../../db/schema';

/**
 * Yeni şirkete tohumlanan KDV oranları: 2025 KDV Oranları Tüzüğü cetvellerindeki oran
 * kümesi (%0/5/10/16/20; 2026 incelemesi, LEGAL-NOTES §3). Hangi mal/hizmete hangi
 * oranın uygulanacağı cetvele bağlıdır ve tüzük 2026'da sık değişmiştir; oranlar
 * DOĞRULANMAMIŞTIR. `verified_at` boş bırakılır; arayüz "Doğrulanmamış" rozeti gösterir
 * ve mali müşavir onayıyla işaretlenene kadar raporlarda uyarı çıkar.
 */
export const DEFAULT_VAT_RATES = [
  { code: 'KDV-20', name: 'KDV Yüksek Oran', rate: '20' },
  { code: 'KDV-16', name: 'KDV Genel Oran', rate: '16' },
  { code: 'KDV-10', name: 'KDV İndirimli Oran', rate: '10' },
  { code: 'KDV-5', name: 'KDV İndirimli Oran (Düşük)', rate: '5' },
  { code: 'KDV-0', name: 'KDV İstisna / Sıfır', rate: '0' },
] as const;

export async function seedTaxRates(tx: Tx, companyId: string): Promise<void> {
  await tx.insert(taxRates).values(
    DEFAULT_VAT_RATES.map((r) => ({
      companyId,
      code: r.code,
      name: r.name,
      rate: r.rate,
      validFrom: '2020-01-01',
      sourceNote: 'Oran kümesi 2025 KDV Oranları Tüzüğü cetvellerine göre; resmî metinden ve mali müşavirce doğrulanmadı.',
    })),
  );
}

