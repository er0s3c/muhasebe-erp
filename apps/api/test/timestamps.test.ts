import { describe, expect, it } from 'vitest';
import { isoTimestamps, pgTimestampToIso } from '../src/http/timestamps';

describe('yanıt zaman damgaları (ham SQL → ISO 8601)', () => {
  it('PostgreSQL timestamptz metni ISO 8601 UTC olur; diğer metinler değişmez', () => {
    expect(pgTimestampToIso('2026-10-04 05:25:12.446371+00')).toBe('2026-10-04T05:25:12.446Z');
    expect(pgTimestampToIso('2026-10-04 08:25:12+03')).toBe('2026-10-04T05:25:12.000Z');
    expect(pgTimestampToIso('2026-10-04 10:55:12.5+05:30')).toBe('2026-10-04T05:25:12.500Z');
    for (const v of ['2026-10-04', '2026-10-04 05:25:12', 'Not: 2026-10-04 05:25:12+00', '12.50']) expect(pgTimestampToIso(v)).toBeNull();
  });

  it('iç içe nesne ve dizilerde dönüştürür; kaynak nesneyi değiştirmez, değişiklik yoksa aynı nesneyi döndürür', () => {
    const src = { a: [{ at: '2026-01-02 03:04:05+00', n: 1 }], b: 'metin', d: new Date(0) };
    const out = isoTimestamps(src) as typeof src;
    expect(out.a[0]!.at).toBe('2026-01-02T03:04:05.000Z');
    expect(src.a[0]!.at).toBe('2026-01-02 03:04:05+00');
    expect(out.d).toBe(src.d);
    const same = { x: 'y', list: [1, 2] };
    expect(isoTimestamps(same)).toBe(same);
  });
});
