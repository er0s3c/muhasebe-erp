import { dec, roundMoney, type MoneyValue } from './money';

/**
 * İthalat maliyet dağıtımı (landed cost) saf hesapları. API (dağıtım, kayıt) ve web (önizleme) aynı fonksiyonları kullanır.
 * Hiçbir oran ya da vergi kuralı yoktur: gümrük vergisi, navlun vb. tutarları kullanıcı girer; buradaki her şey
 * girilen tutarlar üzerinde aritmetiktir (LEGAL-NOTES §3).
 */
export const LANDED_METHODS = ['value', 'quantity', 'weight', 'manual'] as const;
export type LandedMethod = (typeof LANDED_METHODS)[number];

export const LANDED_METHOD_LABELS: Record<LandedMethod, string> = {
  value: 'Değere göre',
  quantity: 'Miktara göre',
  weight: 'Ağırlığa göre',
  manual: 'Elle',
};

export const LANDED_COST_KINDS = ['freight', 'insurance', 'customs_duty', 'other_tax', 'brokerage', 'other'] as const;
export type LandedCostKind = (typeof LANDED_COST_KINDS)[number];

export const LANDED_COST_KIND_LABELS: Record<LandedCostKind, string> = {
  freight: 'Navlun',
  insurance: 'Sigorta',
  customs_duty: 'Gümrük vergisi',
  other_tax: 'Diğer vergi/harç',
  brokerage: 'Komisyon/gümrük müşavirliği',
  other: 'Diğer',
};

export const IMPORT_FILE_STATUSES = ['draft', 'allocated', 'posted', 'cancelled'] as const;
export type ImportFileStatus = (typeof IMPORT_FILE_STATUSES)[number];

export const IMPORT_FILE_STATUS_LABELS: Record<ImportFileStatus, string> = {
  draft: 'Taslak',
  allocated: 'Dağıtıldı',
  posted: 'Muhasebeleşti',
  cancelled: 'İptal',
};

/** Geçerli durum geçişleri (veritabanındaki `import_files_guard` ile birebir aynıdır). */
export const IMPORT_FILE_TRANSITIONS: Record<ImportFileStatus, readonly ImportFileStatus[]> = {
  draft: ['allocated', 'cancelled'],
  allocated: ['draft', 'posted', 'cancelled'],
  posted: ['cancelled'],
  cancelled: [],
};

export interface AllocLine {
  key: string;
  quantity: string;
  /** Şirket para biriminde mal değeri. */
  value: string;
  /** Satır toplam ağırlığı (kg gibi kullanıcı birimi); ağırlık yönteminde zorunlu. */
  weight?: string | null;
}

export class AllocationError extends Error {
  constructor(
    message: string,
    readonly code: 'ALLOC_NO_LINES' | 'ALLOC_BASIS_ZERO' | 'ALLOC_WEIGHT_MISSING' | 'ALLOC_MANUAL_MISMATCH' | 'ALLOC_NEGATIVE',
  ) {
    super(message);
  }
}

/**
 * Bir maliyet kaleminin (şirket para birimi tutarı) satırlara dağıtımı. Son pay değil, "payı olan son satır" kalanı alır:
 * diğer satırlar `round2(tutar × baz / Σbaz)`, kalan satır `tutar − Σdiğerleri`; toplam her zaman tutara eşittir ve
 * sonuç satır sırasına göre belirlidir. Elle yöntemde tutarlar toplamı tutara eşit olmalıdır.
 */
export function allocateAmount(
  total: string,
  method: LandedMethod,
  lines: readonly AllocLine[],
  manual?: Readonly<Record<string, string>>,
): MoneyValue[] {
  const amount = dec(total);
  if (amount.isNegative()) throw new AllocationError('Tutar eksi olamaz', 'ALLOC_NEGATIVE');
  if (lines.length === 0) throw new AllocationError('Dağıtılacak satır yok', 'ALLOC_NO_LINES');

  if (method === 'manual') {
    const out = lines.map((l) => dec(manual?.[l.key] ?? 0));
    if (out.some((a) => a.isNegative())) throw new AllocationError('Elle dağıtım tutarı eksi olamaz', 'ALLOC_NEGATIVE');
    const diff = out.reduce((s, a) => s.plus(a), dec(0)).minus(amount);
    if (!diff.isZero()) {
      throw new AllocationError(`Elle dağıtılan tutarlar toplamı ${amount.toFixed(2)} olmalı (fark ${diff.toFixed(2)})`, 'ALLOC_MANUAL_MISMATCH');
    }
    return out.map((a) => roundMoney(a));
  }

  const basis = lines.map((l) => {
    if (method === 'value') return dec(l.value);
    if (method === 'quantity') return dec(l.quantity);
    if (l.weight === null || l.weight === undefined || dec(l.weight).lte(0)) {
      throw new AllocationError('Ağırlığa göre dağıtım için tüm satırlarda ağırlık girilmeli', 'ALLOC_WEIGHT_MISSING');
    }
    return dec(l.weight);
  });
  const basisTotal = basis.reduce((s, b) => s.plus(b), dec(0));
  if (basisTotal.lte(0)) throw new AllocationError('Dağıtım tabanı (değer/miktar) sıfır; başka bir yöntem seçin', 'ALLOC_BASIS_ZERO');

  let last = -1;
  basis.forEach((b, i) => {
    if (b.gt(0)) last = i;
  });
  const out = basis.map((b) => (b.gt(0) ? roundMoney(amount.times(b).div(basisTotal)) : dec(0)));
  const others = out.reduce((s, a, i) => (i === last ? s : s.plus(a)), dec(0));
  out[last] = amount.minus(others);
  return out;
}

/** Satır başına tüm maliyet kalemlerinin toplamı (kalem × satır matrisi → satır toplamları). */
export function sumByLine(matrix: readonly (readonly MoneyValue[])[], lineCount: number): MoneyValue[] {
  const out = Array.from({ length: lineCount }, () => dec(0));
  for (const row of matrix) row.forEach((a, i) => (out[i] = out[i]!.plus(a)));
  return out;
}

/** Yabancı para tutarının şirket para birimi karşılığı: tutar × kur, 2 basamak (kur kullanıcı girişidir). */
export function toBaseAmount(amount: string, rate: string | null | undefined): MoneyValue {
  return roundMoney(dec(amount).times(rate ? dec(rate) : 1));
}

/** Yardımcı: yüzde hesabı da yalnızca girilen tutar üzerinde aritmetiktir (oran kullanıcı verisidir). */
export function percentOf(base: string, pct: string): MoneyValue {
  return roundMoney(dec(base).times(dec(pct)).div(100));
}

export interface LandedUnitCost {
  /** İthalat maliyeti öncesi birim maliyet (mal değeri / miktar). */
  before: MoneyValue | null;
  /** İthalat maliyetleri eklenmiş birim maliyet. */
  after: MoneyValue | null;
}

export function landedUnitCost(quantity: string, value: string, allocated: string): LandedUnitCost {
  const q = dec(quantity);
  if (q.isZero()) return { before: null, after: null };
  return { before: dec(value).div(q), after: dec(value).plus(allocated).div(q) };
}

/**
 * Kayıt anında bir satırın payının stok maliyetine mi (eldeki miktar kadar), satılan mal maliyetine mi (artık stokta
 * olmayan miktar) gideceği. `onHand` kartın eldeki miktarından bu kayıtta önceki satırların kullandığı düşülmüş havuzdur.
 * Elde kalan miktar payı stokta kalır; son pay kalanın tamamını alır (kuruş artığı olmaz).
 */
export function splitStockCogs(allocated: MoneyValue, qty: MoneyValue, onHand: MoneyValue): { toStock: MoneyValue; toCogs: MoneyValue; usable: MoneyValue } {
  const usable = onHand.lte(0) ? dec(0) : qty.lt(onHand) ? qty : onHand;
  if (allocated.isZero() || usable.isZero()) return { toStock: dec(0), toCogs: allocated, usable };
  const toStock = usable.eq(qty) ? allocated : roundMoney(allocated.times(usable).div(qty));
  return { toStock, toCogs: allocated.minus(toStock), usable };
}
