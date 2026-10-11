import { describe, expect, it } from 'vitest';
import { levelCrews, readinessStatus } from './construction-workflows';

/** F9: iş cephesi hazırlık durumu (84) ve ekip dengeleme önerisi (87). */
describe('inşaat program kararları', () => {
  it('hazırlık durumu eksik kısıtları sayar', () => {
    expect(readinessStatus(null)).toEqual({ status: 'unknown', missing: [] });
    expect(readinessStatus({ drawingReady: true, materialReady: false, crewReady: true, approvalReady: false })).toEqual({ status: 'blocked', missing: ['material', 'approval'] });
    expect(readinessStatus({ drawingReady: true, materialReady: true, crewReady: true, approvalReady: true })).toEqual({ status: 'ready', missing: [] });
  });

  it('aşım günündeki bollu iş bolluğu kadar kaydırılır; kritik iş yerinde kalır', () => {
    const acts = [
      // 2026-10-12 Pazartesi
      { id: 'a', title: 'Kalıp A', computedStart: '2026-10-12', computedEnd: '2026-10-13', slack: 0, crew: 'Kalıpçı', crewSize: 4, progress: 0 },
      { id: 'b', title: 'Kalıp B', computedStart: '2026-10-12', computedEnd: '2026-10-13', slack: 5, crew: 'Kalıpçı', crewSize: 4, progress: 0 },
      { id: 'c', title: 'Demir', computedStart: '2026-10-12', computedEnd: '2026-10-12', slack: 3, crew: 'Demirci', crewSize: 2, progress: 0 },
    ];
    const r = levelCrews(acts, [{ name: 'Kalıpçı', size: 6 }, { name: 'Demirci', size: 4 }]);
    expect(r.before.find((x) => x.crew === 'Kalıpçı')!.overloadDays.map((d) => d.day)).toEqual(['2026-10-12', '2026-10-13']);
    expect(r.after.every((x) => x.overloadDays.length === 0)).toBe(true);
    expect(r.shifts).toEqual([{ id: 'b', title: 'Kalıp B', crew: 'Kalıpçı', shiftDays: 2, from: '2026-10-12', to: '2026-10-14', slack: 5 }]);
  });

  it('bolluk yetmezse aşım raporda kalır', () => {
    const r = levelCrews(
      [
        { id: 'a', title: 'A', computedStart: '2026-10-12', computedEnd: '2026-10-12', slack: 0, crew: 'X', crewSize: 5, progress: 0 },
        { id: 'b', title: 'B', computedStart: '2026-10-12', computedEnd: '2026-10-12', slack: 0, crew: 'X', crewSize: 5, progress: 0 },
      ],
      [{ name: 'X', size: 6 }],
    );
    expect(r.after[0]!.overloadDays).toEqual([{ day: '2026-10-12', demand: 10 }]);
    expect(r.shifts).toEqual([]);
  });
});
