import { z } from 'zod';
import { dec, sum, toDbAmount } from './money';
import { isoDate } from './schemas/common';

const range = { from: isoDate, to: isoDate };
const validRange = (q: { from: string; to: string }) =>
  q.to >= q.from && Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000;
export const stockAnalyticsQuerySchema = z
  .object({
    ...range,
    inactiveDays: z.coerce.number().int().min(1).max(3650).default(90),
  })
  .refine(validRange, 'Rapor aralığı en fazla 367 gün olmalı.');
export const supplierPerformanceQuerySchema = z
  .object(range)
  .refine(validRange, 'Rapor aralığı en fazla 367 gün olmalı.');
export type StockAnalyticsQuery = z.infer<typeof stockAnalyticsQuerySchema>;
export type SupplierPerformanceQuery = z.infer<typeof supplierPerformanceQuerySchema>;
export interface StockAnalyticsInput {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  openingValue: string;
  closingValue: string;
  closingQty: string;
  salesCost: string;
  lastMovementDate: string | null;
}
export interface StockAnalyticsRow extends StockAnalyticsInput {
  abcClass: 'A' | 'B' | 'C' | null;
  costSharePct: string | null;
  cumulativePct: string | null;
  averageValue: string;
  turnover: string | null;
  holdingDays: string | null;
  daysInactive: number | null;
  isInactive: boolean;
}
export interface StockAnalyticsData extends StockAnalyticsQuery {
  baseCurrency: string;
  periodDays: number;
  rows: StockAnalyticsRow[];
  totals: {
    itemCount: number;
    classifiedCount: number;
    inactiveCount: number;
    openingValue: string;
    closingValue: string;
    salesCost: string;
    abcBasisCost: string;
    inactiveValue: string;
    turnover: string | null;
  };
}
export const reportRatio = (numerator: string, denominator: string, scale = 1) =>
  dec(denominator).gt(0) ? dec(numerator).div(denominator).times(scale).toFixed(2) : null;

/** ABC is ranked by positive net invoiced sales cost; the item crossing a boundary stays in its group. */
export function calculateStockAnalytics(
  input: StockAnalyticsInput[],
  q: StockAnalyticsQuery,
  baseCurrency: string,
): StockAnalyticsData {
  const periodDays = Math.round((Date.parse(q.to) - Date.parse(q.from)) / 86400000) + 1;
  const basis = sum(input.filter((r) => dec(r.salesCost).gt(0)).map((r) => r.salesCost));
  let cumulative = dec(0);
  const sorted = [...input].sort(
    (a, b) => dec(b.salesCost).comparedTo(a.salesCost) || a.code.localeCompare(b.code, 'tr'),
  );
  const rows: StockAnalyticsRow[] = sorted.map((r) => {
    const cost = dec(r.salesCost),
      opening = dec(r.openingValue),
      closing = dec(r.closingValue);
    const average = opening.plus(closing).div(2);
    const eligible = cost.gt(0) && basis.gt(0);
    const previousPct = basis.gt(0) ? cumulative.div(basis).times(100) : dec(0);
    if (eligible) cumulative = cumulative.plus(cost);
    const daysInactive = r.lastMovementDate
      ? Math.max(0, Math.round((Date.parse(q.to) - Date.parse(r.lastMovementDate)) / 86400000))
      : null;
    const turnover =
      cost.gt(0) && average.gt(0) && opening.gte(0) && closing.gte(0) ? cost.div(average) : null;
    return {
      ...r,
      abcClass: eligible ? (previousPct.lt(80) ? 'A' : previousPct.lt(95) ? 'B' : 'C') : null,
      costSharePct: eligible ? cost.div(basis).times(100).toFixed(2) : null,
      cumulativePct: eligible ? cumulative.div(basis).times(100).toFixed(2) : null,
      averageValue: toDbAmount(average),
      turnover: turnover?.toFixed(4) ?? null,
      holdingDays: turnover ? dec(periodDays).div(turnover).toFixed(2) : null,
      daysInactive,
      isInactive:
        dec(r.closingQty).gt(0) && daysInactive !== null && daysInactive >= q.inactiveDays,
    };
  });
  const opening = sum(rows.map((r) => r.openingValue)),
    closing = sum(rows.map((r) => r.closingValue)),
    cost = sum(rows.map((r) => r.salesCost));
  const average = opening.plus(closing).div(2);
  return {
    ...q,
    baseCurrency,
    periodDays,
    rows,
    totals: {
      itemCount: rows.length,
      classifiedCount: rows.filter((r) => r.abcClass).length,
      inactiveCount: rows.filter((r) => r.isInactive).length,
      openingValue: toDbAmount(opening),
      closingValue: toDbAmount(closing),
      salesCost: toDbAmount(cost),
      abcBasisCost: toDbAmount(basis),
      inactiveValue: toDbAmount(sum(rows.filter((r) => r.isInactive).map((r) => r.closingValue))),
      turnover:
        cost.gt(0) &&
        average.gt(0) &&
        rows.every((r) => dec(r.openingValue).gte(0) && dec(r.closingValue).gte(0))
          ? cost.div(average).toFixed(4)
          : null,
    },
  };
}
export interface SupplierPerformanceRow {
  partyId: string;
  code: string;
  name: string;
  currency: string;
  orderCount: number;
  orderedAmount: string;
  receivedAmount: string;
  fulfilmentPct: string | null;
  receiptCount: number;
  averageLeadDays: string | null;
  purchaseAmount: string;
  returnAmount: string;
  returnPct: string | null;
  priceExpectedAmount: string;
  priceActualAmount: string;
  priceComparedLines: number;
  priceVariancePct: string | null;
}
export interface SupplierPerformanceData extends SupplierPerformanceQuery {
  timeZone: string;
  rows: SupplierPerformanceRow[];
}
