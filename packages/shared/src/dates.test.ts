import { describe, expect, it } from 'vitest';
import { todayIso } from './dates';
import { nowLocal } from './notifications';

describe('şirket ülkesine göre yerel gün', () => {
  it('kışın Türkiye ve KKTC gün sınırını birbirinden ayırır', () => {
    const instant = new Date('2026-01-15T21:30:00Z');
    expect(todayIso(instant, 'Europe/Istanbul')).toBe('2026-01-16');
    expect(todayIso(instant, 'Europe/Nicosia')).toBe('2026-01-15');
    expect(nowLocal(instant, 'Europe/Istanbul')).toEqual({ date: '2026-01-16', time: '00:30' });
    expect(nowLocal(instant, 'Europe/Nicosia')).toEqual({ date: '2026-01-15', time: '23:30' });
  });

  it('KKTC yaz saati geçişini uygular', () => {
    expect(nowLocal(new Date('2026-03-29T00:59:00Z'), 'Europe/Nicosia').time).toBe('02:59');
    expect(nowLocal(new Date('2026-03-29T01:00:00Z'), 'Europe/Nicosia').time).toBe('04:00');
  });
});
