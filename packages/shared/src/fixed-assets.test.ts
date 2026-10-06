import { describe, it, expect } from 'vitest';
import { depreciationForMonth, fixedAssetSchema } from './fixed-assets';
import { dec } from './money';
describe('demirbaş amortisman hesabı', () => {
  it('dönem dışını ayırır, kuruş farkını dağıtır ve kalıntı değerin altına düşmez', () => {
    const a = { cost: '1000', salvage: '100', startMonth: '2025-12', usefulMonths: 7 };
    const months = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
    const entries = months.map((m) => depreciationForMonth(a, m)!);
    expect(entries.reduce((s, e) => s.plus(e.amount), dec(0)).toFixed(2)).toBe('900.00');
    expect(entries[0].amount).toBe('128.57');
    expect(entries.at(-1)!.plannedBookValue).toBe('100.00');
    expect(depreciationForMonth(a, '2025-11')).toBeNull();
    expect(depreciationForMonth(a, '2026-07')).toBeNull();
  });
  it('eksi kalıntı, edinimden önce başlangıç ve eş hesapları reddeder', () => {
    const id = '00000000-0000-4000-8000-000000000001',
      id2 = '00000000-0000-4000-8000-000000000002';
    const a = {
      code: 'ek-01',
      name: 'Ekskavatör',
      cost: '100',
      salvage: '10',
      startMonth: '2026-01',
      acquisitionDate: '2026-01-01',
      usefulMonths: 12,
      expenseAccountId: id,
      accumulatedAccountId: id2,
    };
    expect(fixedAssetSchema.parse(a).code).toBe('EK-01');
    for (const change of [
      { salvage: '-1' },
      { salvage: '100' },
      { startMonth: '2025-12' },
      { accumulatedAccountId: id },
      { cost: '1.001' },
    ])
      expect(fixedAssetSchema.safeParse({ ...a, ...change }).success).toBe(false);
  });
});
