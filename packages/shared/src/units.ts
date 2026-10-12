import { dec, formatTR } from './money';
import { ITEM_UNIT_LABELS, ITEM_UNITS, type ItemUnit } from './schemas/inventory';

/**
 * Birimin olağan ondalık hassasiyeti (öneri 31): sayılan birimler tam sayıdır; ağırlık/hacim üç, uzunluk/alan iki basamaktır.
 * Veritabanı miktarı 4 ondalıkla saklar; bu tablo girişte uyarı içindir, kaydı engellemez.
 */
export const UNIT_DECIMALS: Record<ItemUnit, number> = {
  adet: 0, paket: 0, koli: 0, cuval: 0, takim: 0,
  rulo: 2, m: 2, m2: 2, saat: 2, gun: 1,
  kg: 3, ton: 3, m3: 3, lt: 3, g: 0,
};

/** Bir üst birime çevirme: girilen miktar bu eşiği aşınca büyük birim önerilir (ör. 2500 g → 2,5 kg). */
const LARGER_UNIT: Partial<Record<ItemUnit, { unit: string; factor: number }>> = {
  g: { unit: 'kg', factor: 1000 },
  kg: { unit: 'ton', factor: 1000 },
};

/** Bu büyüklükten sonraki miktar çoğunlukla fazladan basılmış sıfır ya da yanlış birimdir. */
export const UNUSUAL_QUANTITY = 1_000_000;

export type QuantityIssueKind = 'precision' | 'larger_unit' | 'unusual';
export interface QuantityIssue { kind: QuantityIssueKind; message: string }

const isUnit = (unit: string): unit is ItemUnit => (ITEM_UNITS as readonly string[]).includes(unit);

/**
 * Girilen miktarın birimiyle tutarlılığı. Boş, geçersiz veya sıfır miktar burada değerlendirilmez (form doğrulaması ayrıdır).
 * Tanımsız birimde yalnız büyüklük denetlenir.
 */
export function quantityIssues(quantity: string, unit: string | null | undefined): QuantityIssue[] {
  if (!/^\d+(\.\d+)?$/.test(quantity) || dec(quantity).lte(0)) return [];
  const issues: QuantityIssue[] = [];
  const value = dec(quantity);
  const known = unit && isUnit(unit) ? unit : null;
  const label = known ? ITEM_UNIT_LABELS[known] : unit ?? '';
  if (known) {
    const allowed = UNIT_DECIMALS[known];
    const decimals = quantity.split('.')[1]?.replace(/0+$/, '').length ?? 0;
    if (decimals > allowed) {
      issues.push({
        kind: 'precision',
        message: allowed === 0
          ? `${label} tam sayı olarak girilir; ${formatTR(value, decimals)} ${label} girildi.`
          : `${label} için en çok ${allowed} ondalık basamak kullanılır; ${formatTR(value, decimals)} girildi.`,
      });
    }
    const larger = LARGER_UNIT[known];
    if (larger && value.gte(larger.factor)) {
      const converted = value.div(larger.factor);
      issues.push({ kind: 'larger_unit', message: `${formatTR(value, decimals)} ${label} = ${formatTR(converted, 3).replace(/,?0+$/, '')} ${larger.unit}. Birim ${larger.unit} olmalıysa stok kartının birimini kontrol edin.` });
    }
  }
  if (value.gte(UNUSUAL_QUANTITY)) {
    issues.push({ kind: 'unusual', message: `Olağan dışı büyük miktar (${formatTR(value, 0)}${label ? ` ${label}` : ''}); basamakları kontrol edin.` });
  }
  return issues;
}
