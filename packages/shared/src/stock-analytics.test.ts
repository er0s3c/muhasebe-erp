import { describe, expect, it } from 'vitest';
import {
  calculateStockAnalytics,
  reportRatio,
  stockAnalyticsQuerySchema,
  type StockAnalyticsInput,
} from './stock-analytics';
const q = { from: '2026-01-01', to: '2026-04-10', inactiveDays: 90 };
const row = (
  code: string,
  cost: string,
  extra: Partial<StockAnalyticsInput> = {},
): StockAnalyticsInput => ({
  itemId: code,
  code,
  name: code,
  unit: 'pcs',
  openingValue: '100',
  closingValue: '100',
  closingQty: '5',
  salesCost: cost,
  lastMovementDate: '2026-01-01',
  ...extra,
});
describe('Deterministik stok analizi', () => {
  it('ABC 80/95 sınırını ve birikimli payı kararlı hesaplar', () => {
    const result = calculateStockAnalytics(
      [row('D', '5'), row('C', '10'), row('B', '5'), row('A', '80')],
      q,
      'TRY',
    );
    expect(result.rows.map((r) => [r.code, r.abcClass, r.cumulativePct])).toEqual([
      ['A', 'A', '80.00'],
      ['C', 'B', '90.00'],
      ['B', 'B', '95.00'],
      ['D', 'C', '100.00'],
    ]);
    expect(result.totals.abcBasisCost).toBe('100.0000');
  });
  it('tek ürün %80 sınırını aşsa da A sınıfından başlar', () => {
    const result = calculateStockAnalytics([row('A', '99'), row('B', '1')], q, 'GBP');
    expect(result.rows.map((r) => r.abcClass)).toEqual(['A', 'C']);
  });
  it('sıfır ve negatif net maliyete ABC ya da devir üretmez', () => {
    const result = calculateStockAnalytics([row('A', '0'), row('B', '-10')], q, 'TRY');
    expect(result.totals.classifiedCount).toBe(0);
    expect(result.totals.turnover).toBeNull();
    expect(
      result.rows.every(
        (r) => r.abcClass === null && r.costSharePct === null && r.turnover === null,
      ),
    ).toBe(true);
  });
  it('devir döneme aittir; maliyet / ortalama stok ve stokta kalma gününü hesaplar', () => {
    const result = calculateStockAnalytics(
      [row('A', '400', { openingValue: '100', closingValue: '300' })],
      q,
      'TRY',
    );
    expect(result.periodDays).toBe(100);
    expect(result.rows[0]).toMatchObject({
      averageValue: '200.0000',
      turnover: '2.0000',
      holdingDays: '50.00',
    });
  });
  it('sıfır ortalama veya negatif bakiyeyi oranla gizlemez', () => {
    const result = calculateStockAnalytics(
      [
        row('A', '400', { openingValue: '0', closingValue: '0' }),
        row('B', '50', { openingValue: '-10', closingValue: '100' }),
      ],
      q,
      'TRY',
    );
    expect(result.rows.every((r) => r.turnover === null)).toBe(true);
    expect(result.totals.turnover).toBeNull();
  });
  it('yalnız pozitif dönem sonu miktarı ve bilinen son hareketle hareketsiz sayar', () => {
    const result = calculateStockAnalytics(
      [
        row('A', '0'),
        row('B', '0', { closingQty: '0' }),
        row('C', '0', { lastMovementDate: null }),
        row('D', '0', { lastMovementDate: '2026-04-09' }),
      ],
      q,
      'TRY',
    );
    expect(result.totals.inactiveCount).toBe(1);
    expect(result.rows.find((r) => r.code === 'A')).toMatchObject({
      daysInactive: 99,
      isInactive: true,
    });
    expect(result.totals.inactiveValue).toBe('100.0000');
  });
  it('eksik dayanak olan performans oranı null döner', () => {
    expect(reportRatio('0', '0', 100)).toBeNull();
    expect(reportRatio('20', '0', 100)).toBeNull();
    expect(reportRatio('0', '100', 100)).toBe('0.00');
    expect(reportRatio('25', '100', 100)).toBe('25.00');
  });
  it('ters ve aşırı geniş dönemi reddeder', () => {
    expect(stockAnalyticsQuerySchema.safeParse({ ...q, from: '2026-05-01' }).success).toBe(false);
    expect(stockAnalyticsQuerySchema.safeParse({ ...q, to: '2030-01-01' }).success).toBe(false);
  });
});
