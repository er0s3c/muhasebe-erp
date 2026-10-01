import { describe, expect, it } from 'vitest';
import { addMonthsIso, buildInstallmentPlan, generateUnitNumbers, planTotals } from './installment-plan';

describe('taksit planı', () => {
  it('ay sonu taşması son güne oturur ve yıl atlar', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsIso('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonthsIso('2026-03-31', 12)).toBe('2027-03-31');
  });

  it('peşinat + eşit taksit: kuruş farkı son taksitte, toplam bedele eşit', () => {
    const plan = buildInstallmentPlan({ price: '100000.00', downPayment: '20000', downDue: '2026-10-01', count: 7, intervalMonths: 1, firstDue: '2026-11-01' });
    expect(plan).toHaveLength(8);
    expect(plan[0]).toEqual({ kind: 'down_payment', dueDate: '2026-10-01', amount: '20000.00' });
    expect(plan[1]!.amount).toBe('11428.57');
    expect(plan[7]!.amount).toBe('11428.58'); // 80000 − 6 × 11428.57
    expect(planTotals(plan, '100000').ok).toBe(true);
    expect(plan[7]!.dueDate).toBe('2027-05-01');
  });

  it('peşinatsız ve peşinat = bedel', () => {
    expect(buildInstallmentPlan({ price: '1000', downPayment: '0', downDue: '2026-10-01', count: 3, intervalMonths: 2, firstDue: '2026-10-31' }).map((r) => r.dueDate)).toEqual(['2026-10-31', '2026-12-31', '2027-02-28']);
    expect(buildInstallmentPlan({ price: '1000', downPayment: '1000', downDue: '2026-10-01', count: 3, intervalMonths: 1, firstDue: '2026-11-01' })).toHaveLength(1);
    expect(() => buildInstallmentPlan({ price: '1000', downPayment: '1001', downDue: '2026-10-01', count: 1, intervalMonths: 1, firstDue: '2026-11-01' })).toThrow();
  });

  it('plan toplamı farkı ve toplu birim numaraları', () => {
    expect(planTotals([{ amount: '400.50' }, { amount: '599.00' }], '1000')).toEqual({ total: '999.50', diff: '0.50', ok: false });
    expect(generateUnitNumbers(1, 2, 3).map((u) => u.unitNo)).toEqual(['101', '102', '103', '201', '202', '203']);
  });
});
