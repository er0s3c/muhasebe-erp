import { z } from 'zod';
import { dec, tryDec } from './money';

const amount = z
  .string()
  .max(18)
  .refine(
    (v) => /^\d{1,15}(\.\d{1,2})?$/.test(v) && (tryDec(v)?.gte(0) ?? false),
    'Tutar sıfır veya pozitif, en fazla 15 tam ve iki ondalık basamaklı olmalı.',
  );
export const companyBudgetSchema = z
  .object({
    title: z.string().trim().min(2).max(150),
    year: z.number().int().min(1900).max(2100),
    scope: z.enum(['company', 'department']),
    department: z.string().trim().max(100).default(''),
    projectIds: z.array(z.uuid()).max(100).default([]),
    notes: z.string().trim().max(2000).default(''),
    lines: z
      .array(
        z.object({
          accountId: z.uuid(),
          kind: z.enum(['expense', 'revenue']),
          amounts: z.array(amount).length(12),
        }),
      )
      .min(1)
      .max(150),
  })
  .superRefine((v, c) => {
    if (v.scope === 'department' && !v.department)
      c.addIssue({ code: 'custom', path: ['department'], message: 'Departman adı gerekli.' });
    if (v.scope === 'company' && (v.department || v.projectIds.length))
      c.addIssue({
        code: 'custom',
        message: 'Şirket bütçesi departman veya proje süzgeci kullanmaz.',
      });
    if (new Set(v.lines.map((l) => l.accountId)).size !== v.lines.length)
      c.addIssue({
        code: 'custom',
        path: ['lines'],
        message: 'Aynı hesap bir bütçede yalnızca bir kez kullanılabilir.',
      });
    if (new Set(v.projectIds).size !== v.projectIds.length)
      c.addIssue({ code: 'custom', path: ['projectIds'], message: 'Projeler yinelenemez.' });
  });
export type CompanyBudgetInput = z.infer<typeof companyBudgetSchema>;
export type CompanyBudget = {
  id: string;
  seriesId: string;
  revision: number;
  version: number;
  status: 'draft' | 'approved' | 'superseded';
  config: CompanyBudgetInput;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approverName: string | null;
};
export type BudgetComparison = {
  month: number;
  planned: string;
  actual: string;
  variance: string;
  variancePct: string | null;
  favorable: boolean;
};
/** Expense overspend is unfavorable; revenue underperformance is unfavorable. Zero budget has no percentage. */
export function compareBudget(
  kind: 'expense' | 'revenue',
  month: number,
  planned: string,
  actual: string,
): BudgetComparison {
  const p = dec(planned),
    a = dec(actual),
    variance = a.minus(p);
  return {
    month,
    planned: p.toFixed(2),
    actual: a.toFixed(2),
    variance: variance.toFixed(2),
    variancePct: p.isZero() ? null : variance.div(p).mul(100).toFixed(2),
    favorable: kind === 'expense' ? variance.lte(0) : variance.gte(0),
  };
}
export type CompanyBudgetReport = {
  budget: CompanyBudget;
  currency: string;
  asOf: string;
  lines: {
    accountId: string;
    code: string;
    name: string;
    kind: 'expense' | 'revenue';
    months: BudgetComparison[];
    total: BudgetComparison;
  }[];
  totals: {
    expense: BudgetComparison;
    revenue: BudgetComparison;
    net: { planned: string; actual: string; variance: string };
  };
  months: {
    month: number;
    expensePlanned: string;
    expenseActual: string;
    revenuePlanned: string;
    revenueActual: string;
  }[];
  coverage: {
    projectNames: string[];
    unbudgetedAccountCount: number;
    unbudgetedAccounts: { code: string; name: string; netDebit: string }[];
    departmentMethod: 'accounts' | 'projects' | null;
  };
};
