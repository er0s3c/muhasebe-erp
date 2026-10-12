import { describe, expect, it } from 'vitest';
import { nextBusinessDay, obligationPeriods, obligationState } from './obligations';

describe('yükümlülük dönemleri', () => {
  it('hafta sonu sonraki iş gününe kayar; dönem anahtarı asıl tarihtir', () => {
    expect(nextBusinessDay('2026-02-28')).toBe('2026-03-02'); // cumartesi
    expect(nextBusinessDay('2026-03-01')).toBe('2026-03-02'); // pazar
    expect(nextBusinessDay('2026-03-02')).toBe('2026-03-02');
    const rule = { startDate: '2026-01-28', endDate: null, frequency: 'monthly' as const, interval: 1 };
    expect(obligationPeriods(rule, 'next_business_day', '2026-02-01', '2026-03-31')).toEqual([
      { periodDate: '2026-02-28', dueDate: '2026-03-02' },
      { periodDate: '2026-03-28', dueDate: '2026-03-30' },
    ]);
    expect(obligationPeriods(rule, 'none', '2026-02-01', '2026-03-31').map((p) => p.dueDate)).toEqual(['2026-02-28', '2026-03-28']);
  });
  it('bitiş tarihi ve durum', () => {
    const rule = { startDate: '2026-01-15', endDate: '2026-03-15', frequency: 'monthly' as const, interval: 1 };
    expect(obligationPeriods(rule, 'none', '2026-01-01', '2026-12-31').map((p) => p.periodDate)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(obligationState('2026-03-01', '2026-03-02', 5, null)).toBe('overdue');
    expect(obligationState('2026-03-05', '2026-03-02', 5, null)).toBe('due_soon');
    expect(obligationState('2026-03-20', '2026-03-02', 5, null)).toBe('upcoming');
    expect(obligationState('2026-03-01', '2026-03-02', 5, 'done')).toBe('done');
  });
});
