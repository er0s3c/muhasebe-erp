import { expect, it } from 'vitest';
import { processingQueue } from './manufacturing-queue';
const at = (time: string) => '2026-10-08T' + time + ':00Z';
it('kısmi kabuller FIFO miktar ağırlığıyla ölçülür; aynı oturum miktarı tekrar kullanılmaz', () => {
  const arrivals = [{ at: at('08:00'), quantity: 10 }, { at: at('08:30'), quantity: 5 }];
  const starts = [{ at: at('09:00'), quantity: 5 }, { at: at('10:00'), quantity: 7 }];
  const snapshot = JSON.stringify({ arrivals, starts });
  expect(processingQueue(arrivals, starts, Date.parse(at('10:00')))).toMatchObject({
    measuredQty: 12, averageMinutes: 90, unmeasuredQty: 3, averageOpenMinutes: 90,
  });
  expect(JSON.stringify({ arrivals, starts })).toBe(snapshot);
});
it('kabulden önce başlayan iş kanıt sayılmaz; eksik oturumda süre uydurulmaz', () => {
  expect(processingQueue([{ at: at('10:00'), quantity: 3 }], [{ at: at('09:00'), quantity: 4 }], Date.parse(at('10:30')))).toMatchObject({
    measuredQty: 0, averageMinutes: null, unmeasuredQty: 3, averageOpenMinutes: 30,
  });
  expect(processingQueue([], [], Date.parse(at('10:00'))).averageMinutes).toBeNull();
});
