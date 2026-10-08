import { describe, expect, it } from 'vitest';
import { estimateProductionDuration, estimatePaymentDelay } from './forecasting';

describe('veri kaynaklı tahminler', () => {
  const date = '2026-10-07';
  it('süre verisi yoksa uydurulmuş süre vermez', () => {
    expect(estimateProductionDuration([], 0, 20, date)).toMatchObject({
      source: 'no_data',
      minutes: null,
      sampleCount: 0,
    });
  });
  it('az gerçekleşmede standartla harmanlar, operasyonun kalan adedini kullanır', () => {
    expect(
      estimateProductionDuration([{ date, minutes: 60, goodQty: 10 }], 3, 5, date),
    ).toMatchObject({ source: 'blended', minutes: 20, confidence: 'low', remainingQty: 5 });
  });
  it('tek uç değer üretim tahminini yüz kat büyütmez', () => {
    const result = estimateProductionDuration(
      [30, 30, 30, 3000].map((minutes) => ({ date, minutes, goodQty: 10 })),
      2,
      10,
      date,
    );
    expect(result).toMatchObject({
      source: 'actual',
      minutes: 30,
      excludedCount: 1,
      sampleCount: 3,
      lowerMinutes: 30,
      upperMinutes: 30,
    });
  });
  it('eski, gelecek tarihli ve iyi adetsiz kayıtları öğrenmeye almaz', () => {
    const result = estimateProductionDuration(
      [
        { date: '2026-01-01', minutes: 100, goodQty: 1 },
        { date: '2026-10-08', minutes: 100, goodQty: 1 },
        { date, minutes: 100, goodQty: 0 },
      ],
      2,
      10,
      date,
    );
    expect(result).toMatchObject({ source: 'standard', minutes: 20, sampleCount: 0 });
  });
  it('yakın tarihli veri daha fazla ağırlık alır; tutarlı sekiz örnek yüksek güven sağlar', () => {
    const recent = estimateProductionDuration(
      [
        { date, minutes: 20, goodQty: 10 },
        { date: '2026-08-08', minutes: 60, goodQty: 10 },
      ],
      0,
      10,
      date,
    );
    expect(recent.minutesPerUnit).toBeLessThan(4);
    expect(
      estimateProductionDuration(
        Array.from({ length: 8 }, () => ({ date, minutes: 30, goodQty: 10 })),
        2,
        10,
        date,
      ).confidence,
    ).toBe('high');
  });
  it('üç ödeme olmadan cari tahsilat davranışı varsaymaz', () => {
    expect(
      estimatePaymentDelay([{ dueDate: '2026-09-01', paidDate: '2026-09-11' }], 'history', date),
    ).toMatchObject({ source: 'due', delayDays: 0, sampleCount: 1 });
  });
  it('ihtiyatlı gecikme medyanı aşar, ödenen faturayı bir kez sayar', () => {
    const samples = [2, 10, 30].map((delay) => ({
      dueDate: '2026-09-01',
      paidDate: `2026-09-${String(1 + delay).padStart(2, '0')}`,
    }));
    samples[2] = { dueDate: '2026-08-01', paidDate: '2026-08-31' };
    expect(estimatePaymentDelay(samples, 'history', date)).toMatchObject({
      source: 'payment_history',
      delayDays: 10,
      sampleCount: 3,
    });
    expect(estimatePaymentDelay(samples, 'conservative', date).delayDays).toBe(22);
  });
});
