import { describe, it, expect } from 'vitest';
import { companyBudgetSchema, compareBudget } from './company-budgets';
describe('şirket bütçesi doğrulaması ve sapma', () => {
  const config = {
    title: '2026 planı',
    year: 2026,
    scope: 'company',
    lines: [
      {
        accountId: '00000000-0000-4000-8000-000000000001',
        kind: 'expense',
        amounts: Array(12).fill('100.00'),
      },
    ],
  };
  it('parasal hata fırlatmadan geçersiz, kapsam ve yinelenen hesap reddedilir', () => {
    expect(companyBudgetSchema.safeParse(config).success).toBe(true);
    for (const n of ['1,5', 'Infinity', 'NaN', '-1', '1e8', '1.001', ''])
      expect(
        companyBudgetSchema.safeParse({
          ...config,
          lines: [{ ...config.lines[0], amounts: Array(12).fill(n) }],
        }).success,
      ).toBe(false);
    expect(companyBudgetSchema.safeParse({ ...config, scope: 'department' }).success).toBe(false);
    expect(companyBudgetSchema.safeParse({ ...config, department: 'Saha' }).success).toBe(false);
    expect(
      companyBudgetSchema.safeParse({ ...config, lines: [...config.lines, ...config.lines] })
        .success,
    ).toBe(false);
  });
  it('gider aşımı olumsuz, gelir aşımı olumlu, sıfır planda oran yok; kuruş hassasiyeti', () => {
    expect(compareBudget('expense', 1, '100', '110.01')).toMatchObject({
      variance: '10.01',
      variancePct: '10.01',
      favorable: false,
    });
    expect(compareBudget('revenue', 1, '100', '110.01').favorable).toBe(true);
    expect(compareBudget('expense', 1, '0', '20')).toMatchObject({
      variance: '20.00',
      variancePct: null,
      favorable: false,
    });
    expect(compareBudget('expense', 1, '100', '-5')).toMatchObject({
      variance: '-105.00',
      favorable: true,
    });
  });
});
