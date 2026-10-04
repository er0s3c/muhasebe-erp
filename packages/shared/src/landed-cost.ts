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
    readonly code: 'ALLOC_NO_LINES' | 'ALLOC_BASIS_ZERO' | 'ALLOC_WEIGHT_MISSING' | 'ALLOC_MANUAL_MISMATCH' | 'ALLOC_MANUAL_PRECISION' | 'ALLOC_NEGATIVE',
  ) {
    super(message);
  }
}

/**
 * Bir maliyet kaleminin (şirket para birimi tutarı) satırlara dağıtımı: en büyük kalan yöntemi (ACC-9). Her satır önce
 * `tutar × baz / Σbaz` değerinin aşağı yuvarlanmış kuruşunu alır; kalan kuruşlar en büyük küsurlu satırlara birer birer
 * dağıtılır. Hiçbir pay eksi olamaz, tabanı sıfır satır pay almaz, toplam her zaman tutara eşittir ve sonuç satır sırasına
 * göre belirlidir. Elle yöntemde tutarlar en çok 2 ondalık olmalı ve toplamı tam tutara eşit olmalıdır.
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
    // Yuvarlanmış paylar toplamı tutardan sapmasın: kuruştan küçük basamak kabul edilmez
    if (out.some((a) => a.decimalPlaces() > 2)) {
      throw new AllocationError('Elle dağıtım tutarları en çok 2 ondalık basamak olabilir', 'ALLOC_MANUAL_PRECISION');
    }
    const diff = out.reduce((s, a) => s.plus(a), dec(0)).minus(amount);
    if (!diff.isZero()) {
      throw new AllocationError(`Elle dağıtılan tutarlar toplamı ${amount.toFixed(2)} olmalı (fark ${diff.toFixed(2)})`, 'ALLOC_MANUAL_MISMATCH');
    }
    return out;
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

  // En büyük kalan: aşağı yuvarlanmış kuruşlar + kalan kuruşlar en büyük küsura (eşitlikte SONRAKİ satıra; önceki "son satır
  // kalanı alır" davranışıyla aynı sonucu verir). Tabanı sıfır/eksi satır pay almaz.
  const t = roundMoney(amount);
  const w = basis.map((b) => (b.gt(0) ? b : dec(0)));
  const wTotal = w.reduce((a, b) => a.plus(b), dec(0));
  const exact = w.map((b) => t.times(b).div(wTotal));
  const out = exact.map((e) => e.toDecimalPlaces(2, 1)); // 1 = ROUND_DOWN
  let cents = t.minus(out.reduce((a, b) => a.plus(b), dec(0)));
  const order = exact
    .map((e, idx) => ({ idx, frac: e.minus(out[idx]!) }))
    .filter((x) => x.frac.gt(0))
    .sort((a, b) => b.frac.comparedTo(a.frac) || b.idx - a.idx);
  for (const { idx } of order) {
    if (cents.lte(0)) break;
    out[idx] = out[idx]!.plus('0.01');
    cents = cents.minus('0.01');
  }
  // Tutar kuruştan küçük basamak taşıyorsa (defter tutarı 4 basamak) artık en büyük paya eklenir: toplam tam tutardır
  const rest = amount.minus(roundMoney(amount));
  if (!rest.isZero()) {
    let max = 0;
    out.forEach((a, i) => {
      if (a.gt(out[max]!)) max = i;
    });
    out[max] = out[max]!.plus(rest);
  }
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
