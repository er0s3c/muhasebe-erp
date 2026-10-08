export interface DurationSample {
  minutes: number;
  goodQty: number;
  date: string;
}
export interface DurationEstimate {
  minutesPerUnit: number | null;
  minutes: number | null;
  lowerMinutes: number | null;
  upperMinutes: number | null;
  source: 'actual' | 'blended' | 'standard' | 'no_data';
  confidence: 'low' | 'medium' | 'high';
  sampleCount: number;
  excludedCount: number;
  remainingQty: number;
}
const quantile = (sorted: readonly number[], p: number) => {
  const index = (sorted.length - 1) * p,
    lower = Math.floor(index);
  return sorted[lower]! + (sorted[Math.ceil(index)]! - sorted[lower]!) * (index - lower);
};
/** Compare only samples from the same product revision, operation and selected resource. */
export function estimateProductionDuration(
  samples: readonly DurationSample[],
  standard: number,
  remainingQty: number,
  asOf: string,
): DurationEstimate {
  const now = Date.parse(asOf + 'T23:59:59Z');
  const valid = samples.filter(
    (s) =>
      Number.isFinite(s.minutes) &&
      s.minutes > 0 &&
      Number.isFinite(s.goodQty) &&
      s.goodQty > 0 &&
      Date.parse(s.date) <= now &&
      now - Date.parse(s.date) <= 90 * 86400000,
  );
  const rates = valid.map((s) => s.minutes / s.goodQty).sort((a, b) => a - b);
  const median = rates.length ? quantile(rates, 0.5) : 0;
  const deviation = rates.length
    ? quantile(
        rates.map((r) => Math.abs(r - median)).sort((a, b) => a - b),
        0.5,
      )
    : 0;
  const accepted = valid.filter(
    (s) =>
      rates.length < 4 ||
      Math.abs(s.minutes / s.goodQty - median) <= Math.max(4 * deviation, median * 0.75),
  );
  const weights = accepted.map(
    (s) => Math.sqrt(s.goodQty) * Math.pow(0.5, (now - Date.parse(s.date)) / 86400000 / 30),
  );
  const total = weights.reduce((sum, w) => sum + w, 0);
  const actual =
    total > 0
      ? accepted.reduce((sum, s, i) => sum + (s.minutes / s.goodQty) * weights[i]!, 0) / total
      : null;
  const hasStandard = Number.isFinite(standard) && standard > 0;
  const blend = Math.min(1, accepted.length / 3);
  const unit =
    actual === null
      ? hasStandard
        ? standard
        : null
      : hasStandard && blend < 1
        ? actual * blend + standard * (1 - blend)
        : actual;
  const source =
    unit === null
      ? 'no_data'
      : actual === null
        ? 'standard'
        : hasStandard && blend < 1
          ? 'blended'
          : 'actual';
  const acceptedRates = accepted.map((s) => s.minutes / s.goodQty).sort((a, b) => a - b);
  const spread =
    acceptedRates.length > 1 ? quantile(acceptedRates, 0.9) - quantile(acceptedRates, 0.1) : 0;
  const confidence =
    accepted.length >= 8 && actual !== null && spread / actual < 0.5
      ? 'high'
      : accepted.length >= 3
        ? 'medium'
        : 'low';
  const qty = Number.isFinite(remainingQty) ? Math.max(0, remainingQty) : 0;
  const lower =
    unit === null
      ? null
      : Math.min(unit, acceptedRates.length ? quantile(acceptedRates, 0.1) : unit);
  const upper =
    unit === null
      ? null
      : Math.max(unit, acceptedRates.length ? quantile(acceptedRates, 0.9) : unit);
  return {
    minutesPerUnit: unit,
    minutes: unit === null ? null : Math.ceil(unit * qty),
    lowerMinutes: lower === null ? null : Math.ceil(lower * qty),
    upperMinutes: upper === null ? null : Math.ceil(upper * qty),
    source,
    confidence,
    sampleCount: accepted.length,
    excludedCount: valid.length - accepted.length,
    remainingQty: qty,
  };
}

/** One fully settled invoice is one observation; partial payments do not count repeatedly. */
export function estimatePaymentDelay(
  samples: readonly { dueDate: string; paidDate: string }[],
  mode: 'history' | 'conservative',
  asOf: string,
) {
  const now = Date.parse(asOf + 'T23:59:59Z');
  const delays = samples
    .filter(
      (s) =>
        Date.parse(s.paidDate) <= now &&
        now - Date.parse(s.paidDate) <= 180 * 86400000 &&
        Date.parse(s.paidDate) >= Date.parse(s.dueDate) - 180 * 86400000,
    )
    .map((s) =>
      Math.max(
        0,
        Math.min(120, Math.round((Date.parse(s.paidDate) - Date.parse(s.dueDate)) / 86400000)),
      ),
    )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    delayDays: delays.length >= 3 ? Math.ceil(quantile(delays, mode === 'history' ? 0.5 : 0.8)) : 0,
    sampleCount: delays.length,
    confidence:
      delays.length >= 10
        ? ('high' as const)
        : delays.length >= 3
          ? ('medium' as const)
          : ('low' as const),
    source: delays.length >= 3 ? ('payment_history' as const) : ('due' as const),
  };
}
