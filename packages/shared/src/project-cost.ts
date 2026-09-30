import Decimal from 'decimal.js';
import { dec, roundMoney, sum, ZERO, type MoneyValue } from './money';

/**
 * Proje maliyeti: hesap sınıflandırması ve iş kalemi ölçütleri (API ve web aynı formülü kullanır).
 *
 * Gerçekleşen maliyet defterden türer: projeye/iş kalemine etiketlenmiş, kaydedilmiş satırların net borcu.
 * Sınıf 6 hem gelir (60, 61, 64) hem gider (62, 63, 65, 66) hesapları içerdiğinden maliyet/gelir ayrımı
 * hesap kodu ön ekiyle yapılır. Bu sınıflandırma varsayılandır ve mali müşavirce doğrulanmamıştır (LEGAL-NOTES).
 */

/** Projeye etiketlenebilen hesap türleri; bilanço (1–5) ve nazım (9) hesaplarına proje yapışmaz. */
export const PROJECT_TAGGABLE_ACCOUNT_TYPES = ['income', 'expense', 'cost'] as const;

/** Gelir tarafı (net alacak) hesap kodu ön ekleri: brüt satışlar, satış indirimleri/iadeleri, diğer faaliyet gelirleri. */
export const PROJECT_REVENUE_PREFIXES = ['60', '61', '64'] as const;

export type ProjectCostSide = 'cost' | 'revenue';

export function projectCostSide(accountCode: string): ProjectCostSide {
  return PROJECT_REVENUE_PREFIXES.some((p) => accountCode.startsWith(p)) ? 'revenue' : 'cost';
}

export interface LeafMetricsInput {
  /** Yürürlükteki bütçe (BAC). */
  budget: Decimal.Value;
  /** Gerçekleşen maliyet (AC): etiketli maliyet tarafı satırların net borcu. */
  actual: Decimal.Value;
  /** Son ilerleme yüzdesi; girilmemişse null. */
  percent: Decimal.Value | null;
  /** Elle tamamlanmaya kalan maliyet; girilmemişse null. */
  etcOverride: Decimal.Value | null;
}

export interface ProjectMetrics {
  budget: MoneyValue;
  actual: MoneyValue;
  /** Bütçeden kalan: BAC − AC (eksi = bütçe aşıldı). */
  remaining: MoneyValue;
  /** Harcama yüzdesi: AC / BAC × 100; bütçe yoksa null. */
  spentPct: MoneyValue | null;
  /** Tamamlanma yüzdesi (yaprakta girilen; üst düğümde bütçe ağırlıklı); ilerleme hiç girilmediyse null. */
  percent: MoneyValue | null;
  /** Kazanılmış değer: BAC × tamamlanma %. İlerleme girilmeyen iş kalemi 0 sayılır. */
  earnedValue: MoneyValue;
  hasProgress: boolean;
  /** Tamamlanmaya kalan maliyet. */
  etc: MoneyValue;
  /** Tamamlanma anındaki tahmini toplam maliyet: AC + ETC. */
  eac: MoneyValue;
  /** Tamamlanmada sapma: BAC − EAC (eksi = aşım). */
  variance: MoneyValue;
  /** Maliyet performans endeksi: EV / AC (yalnızca ilerlemesi girilmiş iş kalemlerinin AC'si); hesaplanamazsa null. */
  cpi: MoneyValue | null;
  /** CPI paydası: ilerlemesi girilmiş yapraklardaki AC toplamı. */
  actualTracked: MoneyValue;
}

const pct = (num: MoneyValue, den: MoneyValue, dp = 2): MoneyValue | null => (den.gt(0) ? roundMoney(num.div(den).times(100), dp) : null);

/**
 * Yaprak iş kalemi ölçütleri.
 *  - ETC: elle girilmişse o; yoksa ilerleme varsa kalan iş bütçe değerinde (BAC × (1 − p)); ilerleme yoksa kalan bütçe (max(BAC − AC, 0)).
 *  - EAC = AC + ETC; sapma = BAC − EAC; CPI = EV / AC.
 */
export function computeLeafMetrics(input: LeafMetricsInput): ProjectMetrics {
  const budget = roundMoney(input.budget);
  const actual = roundMoney(input.actual);
  const p = input.percent === null ? null : dec(input.percent);
  const hasProgress = p !== null;
  const earnedValue = hasProgress ? roundMoney(budget.times(p).div(100)) : ZERO;

  let etc: MoneyValue;
  if (input.etcOverride !== null) etc = roundMoney(input.etcOverride);
  else if (hasProgress) etc = roundMoney(budget.times(dec(100).minus(p)).div(100));
  else etc = budget.minus(actual).lt(0) ? ZERO : budget.minus(actual);
  etc = roundMoney(etc);

  const eac = roundMoney(actual.plus(etc));
  return {
    budget,
    actual,
    remaining: roundMoney(budget.minus(actual)),
    spentPct: pct(actual, budget),
    percent: hasProgress ? roundMoney(p) : null,
    earnedValue,
    hasProgress,
    etc,
    eac,
    variance: roundMoney(budget.minus(eac)),
    cpi: hasProgress && actual.gt(0) ? roundMoney(earnedValue.div(actual), 4) : null,
    actualTracked: hasProgress ? actual : ZERO,
  };
}

/** Üst düğüm / proje toplamı: toplanabilir ölçütler yaprakların toplamıdır, oranlar yeniden hesaplanır. */
export function combineMetrics(list: readonly ProjectMetrics[]): ProjectMetrics {
  const budget = sum(list.map((m) => m.budget));
  const actual = sum(list.map((m) => m.actual));
  const earnedValue = sum(list.map((m) => m.earnedValue));
  const etc = sum(list.map((m) => m.etc));
  const eac = sum(list.map((m) => m.eac));
  const actualTracked = sum(list.map((m) => m.actualTracked));
  const hasProgress = list.some((m) => m.hasProgress);
  return {
    budget,
    actual,
    remaining: roundMoney(budget.minus(actual)),
    spentPct: pct(actual, budget),
    percent: hasProgress ? pct(earnedValue, budget) : null,
    earnedValue,
    hasProgress,
    etc,
    eac,
    variance: roundMoney(budget.minus(eac)),
    cpi: hasProgress && actualTracked.gt(0) ? roundMoney(earnedValue.div(actualTracked), 4) : null,
    actualTracked,
  };
}
