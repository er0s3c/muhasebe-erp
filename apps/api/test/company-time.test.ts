import { describe, expect, it } from 'vitest';
import { getCompanyTimeZone, todayIso } from '@erp/shared';
import { withCompanyTimeZone } from '../src/http/company-time';

describe('Paralel şirketlerin yerel saati', () => {
  it('async istekler ve iç içe işler kendi şirket saatlerini korur', async () => {
    const instant = new Date('2026-12-01T21:30:00.000Z');
    const results = await Promise.all(['Europe/Istanbul', 'Europe/Nicosia'].map((zone) =>
      withCompanyTimeZone(zone, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const before = todayIso(instant);
        await withCompanyTimeZone('UTC', async () => {
          await Promise.resolve();
          expect(getCompanyTimeZone()).toBe('UTC');
          expect(todayIso(instant)).toBe('2026-12-01');
        });
        return { zone: getCompanyTimeZone(), before, after: todayIso(instant) };
      }),
    ));
    expect(results).toEqual([
      { zone: 'Europe/Istanbul', before: '2026-12-02', after: '2026-12-02' },
      { zone: 'Europe/Nicosia', before: '2026-12-01', after: '2026-12-01' },
    ]);
  });
});
