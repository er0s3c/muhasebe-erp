import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateTime, toInstant } from './license';

describe('zaman damgası gösterimi Europe/Nicosia (UI-16)', () => {
  it('UTC gece yarısından sonraki işlem Kıbrıs tarihinde gösterilir', () => {
    // 20:03Z = 23:03 Lefkoşa (yaz saati, UTC+3) → aynı gün; 22:30Z = 01:30 ertesi gün
    expect(fmtDate('2026-10-02T20:03:56.615Z')).toBe('02.10.2026');
    expect(fmtDate('2026-10-02T22:30:00Z')).toBe('03.10.2026');
    expect(fmtDateTime('2026-10-02T22:30:00Z')).toBe('03.10.2026 01:30');
  });

  it('PostgreSQL metin biçimi de ayrıştırılır (Safari uyumu)', () => {
    expect(toInstant('2026-10-02 20:03:58.641+00').toISOString()).toBe('2026-10-02T20:03:58.641Z');
    expect(toInstant('2026-10-02 23:03:58+03:00').toISOString()).toBe('2026-10-02T20:03:58.000Z');
    expect(fmtDate('2026-10-02 22:30:00+00')).toBe('03.10.2026');
  });

  it('boş ve geçersiz değerler', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate('saçma')).toBe('saçma');
  });
});
