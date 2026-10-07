import { describe, expect, it } from 'vitest';
import { explodeManufacturingNeed, finiteManufacturingSchedule } from './manufacturing';
import { MANUFACTURING_ACCESS_PROFILES } from './manufacturing-profiles';
import { ACCESS_AREA_KEYS, effectivePermissions } from './module-access';
import { resolveEnabledModules } from './module-registry';

describe('ortak üretim motoru', () => {
  it('500 talep ve 120 stok için 380 üretim, çok seviyeli net ihtiyaç', () => {
    const needs = explodeManufacturingNeed(
      'fg',
      '500',
      [
        { itemId: 'fg', materials: [{ itemId: 'semi', quantity: '2' }] },
        { itemId: 'semi', materials: [{ itemId: 'raw', quantity: '3' }] },
      ],
      { fg: '120', semi: '100', raw: '80' },
    );
    expect(needs.map((n) => n.net)).toEqual(['380.0000', '660.0000', '1900.0000']);
  });
  it('aynı hammaddenin stok bakiyesi ayrı reçete dallarında tekrar kullanılmaz', () => {
    const n = explodeManufacturingNeed(
      'fg',
      '10',
      [
        {
          itemId: 'fg',
          materials: [
            { itemId: 'a', quantity: '1' },
            { itemId: 'b', quantity: '1' },
          ],
        },
        { itemId: 'a', materials: [{ itemId: 'raw', quantity: '1' }] },
        { itemId: 'b', materials: [{ itemId: 'raw', quantity: '1' }] },
      ],
      { raw: '12' },
    );
    expect(n.filter((x) => x.itemId === 'raw').map((x) => x.net)).toEqual(['0.0000', '8.0000']);
  });
  it('reçete döngüsünü reddeder', () =>
    expect(() =>
      explodeManufacturingNeed(
        'a',
        '1',
        [
          { itemId: 'a', materials: [{ itemId: 'b', quantity: '1' }] },
          { itemId: 'b', materials: [{ itemId: 'a', quantity: '1' }] },
        ],
        {},
      ),
    ).toThrow('döngüsü'));
  const calendars = [
    {
      resourceId: 'r',
      start: '2026-10-07T08:00:00Z',
      end: '2026-10-07T18:00:00Z',
      available: true,
    },
    {
      resourceId: 'r',
      start: '2026-10-07T09:00:00Z',
      end: '2026-10-07T10:00:00Z',
      available: false,
    },
  ];
  const jobs = [
    { orderId: 'o', operationKey: 'a', resourceId: 'r', minutes: 90, priority: 50 },
    {
      orderId: 'o',
      operationKey: 'b',
      resourceId: 'r',
      minutes: 30,
      priority: 50,
      predecessor: 'a',
    },
  ];
  it('bakımı atlar ve operasyon bağımlılığını korur', () => {
    const p = finiteManufacturingSchedule(jobs, calendars, '2026-10-07T08:00:00Z', 'forward');
    expect(p[0]!.start).toBe('2026-10-07T08:00:00.000Z');
    expect(p[0]!.segments).toHaveLength(2);
    expect(p[0]!.end).toBe('2026-10-07T10:30:00.000Z');
    expect(p[1]!.start).toBe(p[0]!.end);
  });
  it('uzun iş vardiyalar arasında bölünür; gece kapasite yaratılmaz', () => {
    const p = finiteManufacturingSchedule(
      [{ ...jobs[0]!, minutes: 180 }],
      [
        {
          resourceId: 'r',
          start: '2026-10-07T08:00:00Z',
          end: '2026-10-07T10:00:00Z',
          available: true,
        },
        {
          resourceId: 'r',
          start: '2026-10-08T08:00:00Z',
          end: '2026-10-08T10:00:00Z',
          available: true,
        },
      ],
      '2026-10-07T08:00:00Z',
      'forward',
    );
    expect(p[0]!.segments).toHaveLength(2);
    expect(p[0]!.end).toBe('2026-10-08T09:00:00.000Z');
  });
  it('teslimden geri sonlu kapasiteyle planlar', () => {
    const p = finiteManufacturingSchedule(jobs, calendars, '2026-10-07T18:00:00Z', 'backward');
    expect(p[0]!.operationKey).toBe('b');
    expect(p[1]!.end).toBe(p[0]!.start);
  });
  it('yayımlanmış plan kaynak kapasitesini tüketir', () => {
    const first = finiteManufacturingSchedule(
      [jobs[0]!],
      calendars,
      '2026-10-07T10:00:00Z',
      'forward',
    );
    const second = finiteManufacturingSchedule(
      [{ ...jobs[0]!, orderId: 'other' }],
      calendars,
      '2026-10-07T10:00:00Z',
      'forward',
      {},
      first,
    );
    expect(second[0]!.start).toBe(first[0]!.end);
  });
  it('yalnız onaylı profiller görünür; kasiyer finans erişimi alamaz', () => {
    const p = MANUFACTURING_ACCESS_PROFILES.find((p) => p.key === 'kasiyer')!;
    const overrides = Object.fromEntries(ACCESS_AREA_KEYS.map((k) => [k, p.levels[k] ?? 'none']));
    const perms = effectivePermissions(p.role, overrides);
    expect(perms.has('pos.sell')).toBe(true);
    expect(perms.has('ledger.read')).toBe(false);
    expect(perms.has('treasury.post')).toBe(false);
    expect(perms.has('pos.approve')).toBe(false);
  });
  it('iki üretim sektörü aynı genel modülleri kullanır, inşaat kullanmaz', () => {
    for (const s of ['MANUFACTURING_WHOLESALE', 'LEATHER_FASHION'] as const)
      expect(resolveEnabledModules(s).has('manufacturing.production')).toBe(true);
    expect(resolveEnabledModules('CONSTRUCTION').has('manufacturing.production')).toBe(false);
    expect(resolveEnabledModules('MANUFACTURING_WHOLESALE').has('leather.materials')).toBe(false);
  });
});
