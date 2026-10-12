import { describe, expect, it } from 'vitest';
import {
  finiteManufacturingSchedule,
  frozenWindowViolations,
  manufacturingResourceRulesSchema,
  setupMinutesFor,
  setupRuleFromConfig,
  type ScheduledOperation,
} from './manufacturing';

/** F7: sıraya bağlı hazırlık (63), takım/aparat kapasitesi (64), yakın dönem plan koruması (66). */
describe('üretim çizelgeleme kuralları', () => {
  const shift = [{ resourceId: 'm', start: '2026-10-07T08:00:00Z', end: '2026-10-07T18:00:00Z', available: true }];
  const job = (key: string, extra: Record<string, unknown> = {}) => ({ orderId: 'o-' + key, operationKey: key, resourceId: 'm', minutes: 60, priority: 0, ...extra });

  it('hazırlık matrisi: aynı aile 0, tanımlı geçiş, varsayılan', () => {
    const rule = setupRuleFromConfig(manufacturingResourceRulesSchema.parse({ defaultSetupMinutes: 20, setupMatrix: [{ from: 'açık', to: 'koyu', minutes: 15 }, { from: 'koyu', to: 'açık', minutes: 45 }] }));
    expect(setupMinutesFor(rule, 'açık', 'açık')).toBe(0);
    expect(setupMinutesFor(rule, 'açık', 'koyu')).toBe(15);
    expect(setupMinutesFor(rule, 'koyu', 'açık')).toBe(45);
    expect(setupMinutesFor(rule, undefined, 'açık')).toBe(20);
    expect(setupMinutesFor(rule, 'açık', undefined)).toBe(0);
    expect(() => manufacturingResourceRulesSchema.parse({ setupMatrix: [{ from: 'a', to: 'b', minutes: 1 }, { from: 'a', to: 'b', minutes: 2 }] })).toThrow();
  });

  it('sıraya bağlı hazırlık plana eklenir; aile değişmezse eklenmez', () => {
    const rules = { setup: { m: setupRuleFromConfig({ defaultSetupMinutes: 30, setupMatrix: [{ from: 'açık', to: 'koyu', minutes: 15 }] }) } };
    const p = finiteManufacturingSchedule(
      [job('a', { priority: 3, setupFamily: 'açık' }), job('b', { priority: 2, setupFamily: 'açık' }), job('c', { priority: 1, setupFamily: 'koyu' })],
      shift,
      '2026-10-07T08:00:00Z',
      'forward',
      {},
      [],
      rules,
    );
    // İlk iş: önceki yok → varsayılan 30; ikinci aynı aile → 0; üçüncü açık→koyu 15
    expect(p.map((o) => [o.operationKey, o.setupMinutes ?? 0, o.start, o.end])).toEqual([
      ['a', 30, '2026-10-07T08:00:00.000Z', '2026-10-07T09:30:00.000Z'],
      ['b', 0, '2026-10-07T09:30:00.000Z', '2026-10-07T10:30:00.000Z'],
      ['c', 15, '2026-10-07T10:30:00.000Z', '2026-10-07T11:45:00.000Z'],
    ]);
  });

  it('takım/aparat: eş takım sayısı kadar paralel iş; bakımdaki takım kullanılamaz', () => {
    const calendars = [...shift, { resourceId: 'n', start: '2026-10-07T08:00:00Z', end: '2026-10-07T18:00:00Z', available: true }];
    const twoMachines = [job('a', { toolIds: ['kalıp'] }), job('b', { resourceId: 'n', toolIds: ['kalıp'] })];
    // Tek kalıp: ikinci makine kalıbı bekler
    let p = finiteManufacturingSchedule(twoMachines, calendars, '2026-10-07T08:00:00Z', 'forward');
    expect(p.map((o) => o.start)).toEqual(['2026-10-07T08:00:00.000Z', '2026-10-07T09:00:00.000Z']);
    // İki eş kalıp: paralel
    p = finiteManufacturingSchedule(twoMachines, calendars, '2026-10-07T08:00:00Z', 'forward', { kalıp: 2 });
    expect(p.map((o) => o.start)).toEqual(['2026-10-07T08:00:00.000Z', '2026-10-07T08:00:00.000Z']);
    // Kalıp 08:00–10:00 bakımda
    p = finiteManufacturingSchedule([job('a', { toolIds: ['kalıp'] })], [...calendars, { resourceId: 'kalıp', start: '2026-10-07T08:00:00Z', end: '2026-10-07T10:00:00Z', available: false }], '2026-10-07T08:00:00Z', 'forward');
    expect(p[0]!.start).toBe('2026-10-07T10:00:00.000Z');
  });

  it('dondurma penceresi: pencere içindeki taşıma, çıkarma ve ekleme yakalanır', () => {
    const op = (key: string, start: string, end: string): ScheduledOperation => ({ orderId: 'o', operationKey: key, resourceId: 'm', start, end, minutes: 60, priority: 0 });
    const now = Date.parse('2026-10-07T08:00:00Z');
    const prev = [op('a', '2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z'), op('b', '2026-10-07T11:00:00Z', '2026-10-07T12:00:00Z'), op('z', '2026-10-09T09:00:00Z', '2026-10-09T10:00:00Z')];
    const next = [op('a', '2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z'), op('c', '2026-10-07T12:00:00Z', '2026-10-07T13:00:00Z'), op('z', '2026-10-10T09:00:00Z', '2026-10-10T10:00:00Z')];
    expect(frozenWindowViolations(prev, next, now, 0)).toEqual([]);
    expect(frozenWindowViolations(prev, next, now, 8)).toEqual([
      { orderId: 'o', operationKey: 'b', change: 'removed', previousStart: '2026-10-07T11:00:00Z' },
      { orderId: 'o', operationKey: 'c', change: 'added', start: '2026-10-07T12:00:00Z' },
    ]);
  });
});
