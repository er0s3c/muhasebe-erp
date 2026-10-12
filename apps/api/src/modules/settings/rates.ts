import { and, desc, eq, gte, lte } from 'drizzle-orm';
import {
  dec,
  toDbRate,
  oppositeFxRateType,
  FX_PURPOSE_RATE_TYPES,
  type MoneyValue,
  type FxRateType,
  type FxPurpose,
  type FxRateLookup,
  type FxRateLeg,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { exchangeRates } from '../../db/schema';
import { unprocessable } from '../../http/errors';

export const MAX_RATE_AGE_DAYS = 10;
function minusDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
const rateFields = {
  forex_buy: 'buy',
  forex_sell: 'sell',
  effective_buy: 'effectiveBuy',
  effective_sell: 'effectiveSell',
} as const;
type RateOptions = { rateType?: FxRateType; purpose?: FxPurpose; legacyInverse?: boolean };
type RatePath = { value: MoneyValue; legs: FxRateLeg[]; method: 'direct' | 'inverse' };
async function directOrInverse(
  tx: Tx,
  from: string,
  to: string,
  date: string,
  type: FxRateType,
  legacyInverse = false,
): Promise<RatePath | null> {
  const since = minusDays(date, MAX_RATE_AGE_DAYS);
  const get = async (currency: string, quote: string) => {
    const [row] = await tx
      .select()
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.currencyCode, currency),
          eq(exchangeRates.quoteCode, quote),
          lte(exchangeRates.rateDate, date),
          gte(exchangeRates.rateDate, since),
        ),
      )
      .orderBy(desc(exchangeRates.rateDate))
      .limit(1);
    return row;
  };
  const leg = (
    r: typeof exchangeRates.$inferSelect,
    rateType: FxRateType,
    inverted: boolean,
    value: string,
  ): FxRateLeg => ({
    currencyCode: r.currencyCode,
    quoteCode: r.quoteCode,
    rateDate: r.rateDate,
    source: r.source,
    provider: r.provider,
    sourceUrl: r.sourceUrl,
    rateType,
    inverted,
    value,
  });
  const direct = await get(from, to),
    directValue = direct?.[rateFields[type]];
  if (direct && directValue && dec(directValue).gt(0))
    return {
      value: dec(directValue),
      legs: [leg(direct, type, false, directValue)],
      method: 'direct',
    };
  const inverseType = legacyInverse ? type : oppositeFxRateType(type);
  const inverse = await get(to, from),
    inverseValue = inverse?.[rateFields[inverseType]];
  if (inverse && inverseValue && dec(inverseValue).gt(0))
    return {
      value: dec(1).div(inverseValue),
      legs: [leg(inverse, inverseType, true, inverseValue)],
      method: 'inverse',
    };
  return null;
}
/** Explicit types invert the opposite side of a bid/ask pair; legacy callers retain inverse-buy. */
export async function lookupRate(
  tx: Tx,
  from: string,
  to: string,
  date: string,
  via: string,
  options: RateOptions = {},
): Promise<FxRateLookup> {
  const type =
    options.rateType ?? (options.purpose ? FX_PURPOSE_RATE_TYPES[options.purpose] : 'forex_buy');
  const base = { from, to, date, rateType: type, purpose: options.purpose ?? null };
  if (from === to)
    return {
      ...base,
      rate: '1.00000000',
      rateDate: date,
      source: null,
      provider: null,
      sourceUrl: null,
      method: 'identity',
      legs: [],
    };
  let path: {
    value: MoneyValue;
    legs: FxRateLeg[];
    method: 'direct' | 'inverse' | 'cross';
  } | null = await directOrInverse(tx, from, to, date, type, options.legacyInverse);
  if (!path)
    for (const pivot of new Set([via, 'TRY'])) {
      if (from === pivot || to === pivot) continue;
      const first = await directOrInverse(tx, from, pivot, date, type, options.legacyInverse);
      const second = await directOrInverse(tx, pivot, to, date, type, options.legacyInverse);
      if (first && second) {
        path = {
          value: first.value.times(second.value),
          legs: [...first.legs, ...second.legs],
          method: 'cross',
        };
        break;
      }
    }
  if (!path)
    return {
      ...base,
      rate: null,
      rateDate: null,
      source: null,
      provider: null,
      sourceUrl: null,
      method: 'missing',
      legs: [],
    };
  const providers = new Set(path.legs.map((l) => l.provider)),
    urls = new Set(path.legs.map((l) => l.sourceUrl));
  return {
    ...base,
    rate: toDbRate(path.value),
    rateDate: path.legs.map((l) => l.rateDate).sort()[0]!,
    source: [...new Set(path.legs.map((l) => l.source))].join(' / '),
    provider: providers.size === 1 ? path.legs[0]!.provider : 'mixed',
    sourceUrl: urls.size === 1 ? path.legs[0]!.sourceUrl : null,
    method: path.method,
    legs: path.legs,
  };
}
/** Backwards-compatible default: forex buy with the historic inverse-buy convention. */
export async function findRate(
  tx: Tx,
  from: string,
  to: string,
  date: string,
  via: string,
  options?: RateOptions,
): Promise<MoneyValue | null> {
  const result = await lookupRate(tx, from, to, date, via, options ?? { legacyInverse: true });
  if (!result.rate) return null;
  // Keep full Decimal precision for existing accounting callers; only the HTTP metadata is rounded.
  return result.legs.reduce(
    (value, leg) => value.times(leg.inverted ? dec(1).div(leg.value) : dec(leg.value)),
    dec(1),
  );
}
export async function requireRate(
  tx: Tx,
  from: string,
  to: string,
  date: string,
  via: string,
  options?: RateOptions,
): Promise<MoneyValue> {
  const rate = await findRate(tx, from, to, date, via, options);
  if (!rate)
    throw unprocessable(
      `${from}/${to} kuru bulunamadı (${date} ve önceki ${MAX_RATE_AGE_DAYS} gün). Önce kur girin.`,
      'FX_RATE_MISSING',
      { from, to, date, rateType: options?.rateType ?? 'forex_buy' },
    );
  return rate;
}
