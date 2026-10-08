import { expect, it } from 'vitest';
import { netCapacityMinutes, scheduledLoadMinutes } from './manufacturing-capacity';
it('bitişsiz arıza rapor aralığı boyunca kapasiteyi kapatır; tamamlanınca kalan vardiya açılır', () => {
  const shift = {
    resourceId: 'A',
    start: '2026-10-07T08:00:00Z',
    end: '2026-10-07T18:00:00Z',
    available: true,
  };
  const fault = { resourceId: 'A', start: '2026-10-07T09:00:00Z', end: null, available: false };
  expect(netCapacityMinutes([shift, fault], 'A', shift.start, shift.end)).toBe(60);
  expect(
    netCapacityMinutes(
      [shift, { ...fault, end: '2026-10-07T10:00:00Z' }],
      'A',
      shift.start,
      shift.end,
    ),
  ).toBe(540);
});
it('overlapping shifts and absence reduce net capacity once; load counts working segments', () => {
  const c = (start: string, end: string, available = true) => ({
    resourceId: 'A',
    start: '2026-10-07T' + start + ':00Z',
    end: '2026-10-07T' + end + ':00Z',
    available,
  });
  expect(
    netCapacityMinutes(
      [
        c('08:00', '16:00'),
        c('12:00', '18:00'),
        c('14:00', '15:00', false),
        c('14:30', '15:30', false),
      ],
      'A',
      c('08:00', '18:00').start,
      c('08:00', '18:00').end,
    ),
  ).toBe(510);
  expect(
    scheduledLoadMinutes(
      [
        {
          orderId: 'O',
          operationKey: 'K',
          resourceId: 'A',
          start: c('08:00', '18:00').start,
          end: c('08:00', '18:00').end,
          minutes: 120,
          priority: 50,
          segments: [c('08:00', '09:00'), c('17:00', '18:00')],
        },
      ],
      'A',
      c('08:00', '18:00').start,
      c('08:00', '18:00').end,
    ),
  ).toBe(120);
});
