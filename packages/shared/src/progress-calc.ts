import { dec, roundMoney, type MoneyValue } from './money';

/**
 * Taşeron hakedişi hesabı. API (kaydetme) ve web (önizleme) aynı fonksiyonu kullanır.
 *
 * brüt        = Σ satır (bu dönem miktar × birim fiyat), satır başına 2 basamağa yuvarlanır
 * teminat     = brüt × teminat %
 * avans       = min(brüt × avans mahsup %, kalan avans bakiyesi)
 * stopaj      = brüt × stopaj %
 * KDV         = brüt × KDV oranı
 * net         = brüt + KDV − teminat − avans − stopaj − diğer kesintiler
 *
 * Yüzde tabanlarının (KDV hariç/dahil) KKTC'de doğruluğu mali müşavirce teyit edilmemiştir (LEGAL-NOTES §12).
 */
export interface ProgressCalcInput {
  lines: readonly { thisQty: string; unitPrice: string }[];
  /** Yüzde değerleri (ör. "5"). */
  vatRate: string;
  retentionPct: string;
  advancePct: string;
  withholdingPct: string;
  /** Verilen − mahsup edilen avans (hakediş para biriminde, ≥ 0). */
  advanceBalance: string;
  deductions: readonly string[];
}

export interface ProgressCalcResult {
  lineAmounts: MoneyValue[];
  gross: MoneyValue;
  vat: MoneyValue;
  retention: MoneyValue;
  advance: MoneyValue;
  withholding: MoneyValue;
  otherDeductions: MoneyValue;
  net: MoneyValue;
}

const pct = (base: MoneyValue, p: string) => roundMoney(base.times(dec(p)).div(100));

export function computeProgress(i: ProgressCalcInput): ProgressCalcResult {
  const lineAmounts = i.lines.map((l) => roundMoney(dec(l.thisQty).times(l.unitPrice)));
  const gross = lineAmounts.reduce((s, a) => s.plus(a), dec(0));
  const retention = pct(gross, i.retentionPct);
  const advanceWanted = pct(gross, i.advancePct);
  const balance = dec(i.advanceBalance).lt(0) ? dec(0) : dec(i.advanceBalance);
  const advance = advanceWanted.lt(balance) ? advanceWanted : balance;
  const withholding = pct(gross, i.withholdingPct);
  const vat = pct(gross, i.vatRate);
  const otherDeductions = i.deductions.reduce((s, d) => s.plus(roundMoney(d)), dec(0));
  const net = gross.plus(vat).minus(retention).minus(advance).minus(withholding).minus(otherDeductions);
  return { lineAmounts, gross, vat, retention, advance, withholding, otherDeductions, net };
}

/**
 * Tutarı ağırlıklarla orantılı dağıtır (en büyük kalan yöntemi): parçalar toplamı tam olarak `total`'dır, kuruş artığı kalmaz.
 * Ağırlıkların toplamı 0 ise ilk parçaya yazılır.
 */
export function allocateProportional(total: Parameters<typeof roundMoney>[0], weights: readonly string[]): MoneyValue[] {
  const t = roundMoney(total);
  if (weights.length === 0) return [];
  const w = weights.map((x) => dec(x));
  const sum = w.reduce((s, x) => s.plus(x), dec(0));
  if (sum.isZero()) return weights.map((_, i) => (i === 0 ? t : dec(0)));
  const exact = w.map((x) => t.times(x).div(sum));
  const floors = exact.map((e) => e.toDecimalPlaces(2, 1)); // 1 = ROUND_DOWN
  let rest = t.minus(floors.reduce((s, f) => s.plus(f), dec(0)));
  const order = exact
    .map((e, idx) => ({ idx, frac: e.minus(floors[idx]!) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.idx - b.idx);
  const out = [...floors];
  for (const { idx } of order) {
    if (rest.lte(0)) break;
    out[idx] = out[idx]!.plus('0.01');
    rest = rest.minus('0.01');
  }
  return out;
}
