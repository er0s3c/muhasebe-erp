import { z } from 'zod';
import { isoDate, moneyString, uuid } from './common';
import { yearMonth } from './attendance';

/**
 * Bordro (Faz D3). Hiçbir yasal oran, vergi dilimi, asgari ücret ya da fazla mesai çarpanı kodda YOKTUR: bunlar yalnızca
 * tarihli, kaynak notlu, doğrulama alanlı `payroll_params` satırlarıdır ve satır "açık" işaretlenmedikçe hiçbir yasal
 * kesinti hesaplanmaz (LEGAL-NOTES §3, §13). Aşağıdaki liste yalnızca parametre ANAHTARLARINI ve birimlerini tanımlar.
 */
export const PAYROLL_PARAM_KEYS = [
  'days_per_month',
  'hours_per_day',
  'overtime_multiplier',
  'sick_leave_pay_pct',
  'annual_leave_pay_pct',
  'employee_social_pct',
  'income_tax_pct',
  'tax_base_deducts_social',
  'social_base_cap',
  'employer_social_pct',
  'employer_other_pct',
  'minimum_wage_monthly',
] as const;
export type PayrollParamKey = (typeof PAYROLL_PARAM_KEYS)[number];

export type PayrollParamUnit = 'percent' | 'multiplier' | 'amount' | 'count' | 'flag';
export type PayrollParamGroup = 'pay' | 'employee' | 'employer' | 'check';

export const PAYROLL_PARAM_META: Record<PayrollParamKey, { unit: PayrollParamUnit; group: PayrollParamGroup }> = {
  days_per_month: { unit: 'count', group: 'pay' },
  hours_per_day: { unit: 'count', group: 'pay' },
  overtime_multiplier: { unit: 'multiplier', group: 'pay' },
  sick_leave_pay_pct: { unit: 'percent', group: 'pay' },
  annual_leave_pay_pct: { unit: 'percent', group: 'pay' },
  employee_social_pct: { unit: 'percent', group: 'employee' },
  income_tax_pct: { unit: 'percent', group: 'employee' },
  tax_base_deducts_social: { unit: 'flag', group: 'employee' },
  social_base_cap: { unit: 'amount', group: 'employee' },
  employer_social_pct: { unit: 'percent', group: 'employer' },
  employer_other_pct: { unit: 'percent', group: 'employer' },
  minimum_wage_monthly: { unit: 'amount', group: 'check' },
};

/** Parametre değeri: en çok 13 tam, 6 ondalık basamak. */
export const paramValueString = z.string().regex(/^\d{1,13}(\.\d{1,6})?$/, 'Geçersiz değer');

/** Birime göre makul değer aralığı (yasal sınır değil; veri girişi hatası denetimi). */
export function paramValueError(key: PayrollParamKey, value: string): string | null {
  const v = Number(value);
  switch (PAYROLL_PARAM_META[key].unit) {
    case 'percent':
      return v <= 100 ? null : 'Yüzde 0 ile 100 arasında olmalı';
    case 'multiplier':
      return v > 0 && v <= 20 ? null : 'Çarpan 0 ile 20 arasında (0 hariç) olmalı';
    case 'flag':
      return v === 0 || v === 1 ? null : 'Bayrak 0 ya da 1 olmalı';
    case 'count':
      if (key === 'days_per_month') return v >= 1 && v <= 31 ? null : 'Gün sayısı 1 ile 31 arasında olmalı';
      return v > 0 && v <= 24 ? null : 'Saat 0 ile 24 arasında (0 hariç) olmalı';
    case 'amount':
      return v > 0 ? null : 'Tutar sıfırdan büyük olmalı';
  }
}

const text = (max: number) => z.string().trim().max(max);

export const createPayrollParamSchema = z
  .object({
    key: z.enum(PAYROLL_PARAM_KEYS),
    value: paramValueString,
    effectiveFrom: isoDate,
    sourceNote: text(500).nullable().optional(),
    /** Yerini aldığı önceki satır (isteğe bağlı; aynı anahtar). */
    supersedesId: uuid.nullable().optional(),
    /** Varsayılan KAPALI: satır açılana kadar hiçbir hesap yapılmaz. */
    enabled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const err = paramValueError(v.key, v.value);
    if (err) ctx.addIssue({ code: 'custom', path: ['value'], message: err });
  });
export type CreatePayrollParamInput = z.infer<typeof createPayrollParamSchema>;

export const updatePayrollParamSchema = z
  .object({ enabled: z.boolean().optional(), sourceNote: text(500).nullable().optional() })
  .refine((v) => v.enabled !== undefined || v.sourceNote !== undefined, { message: 'Değişiklik yok' });
export const verifyPayrollParamSchema = z.object({ note: text(500).nullable().optional() });

export const PAY_BASES = ['monthly', 'daily', 'hourly'] as const;
export type PayBasis = (typeof PAY_BASES)[number];

export const createPayTermSchema = z.object({
  employeeId: uuid,
  effectiveFrom: isoDate,
  payBasis: z.enum(PAY_BASES),
  amount: moneyString.refine((v) => Number(v) > 0, 'Ücret sıfırdan büyük olmalı'),
  note: text(300).nullable().optional(),
});
export type CreatePayTermInput = z.infer<typeof createPayTermSchema>;

export const PAYROLL_ITEM_KINDS = ['earning', 'deduction'] as const;
export type PayrollItemKind = (typeof PAYROLL_ITEM_KINDS)[number];
export const PAYROLL_LIABILITIES = ['tax', 'social', 'other'] as const;
export type PayrollLiability = (typeof PAYROLL_LIABILITIES)[number];

/**
 * Ek ödeme / kesinti kalemi. Vergiye/prime esas olup olmadığı kullanıcının girdiği VERİDİR (yasal varsayılan yok);
 * kesintinin yükümlülük hesabı (vergi/sosyal güvenlik/diğer) yevmiyede hangi borç hesabına gideceğini seçer.
 */
export const createPayrollItemSchema = z.object({
  code: text(30).min(1, 'Kod gerekli'),
  name: text(100).min(1, 'Ad gerekli'),
  kind: z.enum(PAYROLL_ITEM_KINDS),
  affectsSocialBase: z.boolean().default(false),
  affectsTaxBase: z.boolean().default(false),
  liability: z.enum(PAYROLL_LIABILITIES).default('other'),
});
export type CreatePayrollItemInput = z.infer<typeof createPayrollItemSchema>;
export const updatePayrollItemSchema = z
  .object({ name: text(100).min(1), affectsSocialBase: z.boolean(), affectsTaxBase: z.boolean(), liability: z.enum(PAYROLL_LIABILITIES), isActive: z.boolean() })
  .partial();

export const createPayrollRunSchema = z.object({ month: yearMonth, description: text(300).nullable().optional() });
export const payrollRunListQuerySchema = z.object({ status: z.enum(['draft', 'approved', 'paid', 'cancelled']).optional(), year: z.coerce.number().int().min(2000).max(2100).optional() });

export const payrollAdjustmentSchema = z.object({ employeeId: uuid, itemId: uuid, amount: moneyString, note: text(200).nullable().optional() });
export type PayrollAdjustmentInput = z.infer<typeof payrollAdjustmentSchema>;

export const payPayrollRunSchema = z.object({ paidAt: isoDate, note: text(300).nullable().optional() });
export const unpayPayrollRunSchema = z.object({ reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)') });
export const cancelPayrollRunSchema = z.object({ reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)'), entryDate: isoDate.optional() });
export const payrollCostQuerySchema = z.object({ from: yearMonth, to: yearMonth }).refine((v) => v.from <= v.to, { message: 'Başlangıç ayı bitişten sonra olamaz', path: ['to'] });
export const payrollMonthQuerySchema = z.object({ month: yearMonth });
