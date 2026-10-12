import { z } from 'zod';
import { currencyCode, moneyString, uuid } from './schemas/common';
import { dec, decCheck } from './money';
import { addDaysIso } from './dates';
import { occurrenceDate, recurrenceSchema } from './recurring';

/**
 * Düzenli mali yükümlülük takvimi (öneri 57): vergi, SGK, maaş, kira, kredi, sigorta gibi tekrar eden ödemeler. Her dönem
 * tamamlandı ya da atlandı olarak işaretlenir; tutarı olan açık dönemler nakit projeksiyonuna çıkış olarak girer.
 * Hafta sonuna denk gelen tarih isteğe bağlı olarak sonraki iş gününe kayar (resmî tatiller kapsanmaz).
 */
export const OBLIGATION_CATEGORIES = ['tax', 'social_security', 'payroll', 'rent', 'loan', 'insurance', 'utility', 'other'] as const;
export type ObligationCategory = (typeof OBLIGATION_CATEGORIES)[number];
export const OBLIGATION_CATEGORY_LABELS: Record<ObligationCategory, string> = {
  tax: 'Vergi ve beyanname',
  social_security: 'SGK primi',
  payroll: 'Maaş ödemesi',
  rent: 'Kira',
  loan: 'Kredi taksiti',
  insurance: 'Sigorta',
  utility: 'Abonelik ve fatura',
  other: 'Diğer',
};
export const obligationSchema = z.object({
  title: z.string().trim().min(2).max(160),
  category: z.enum(OBLIGATION_CATEGORIES),
  recurrence: recurrenceSchema,
  weekendRule: z.enum(['none', 'next_business_day']).default('next_business_day'),
  amount: moneyString.refine(decCheck((v) => v.gt(0) && v.decimalPlaces() <= 2), 'Tutar pozitif olmalı').nullable().default(null),
  currency: currencyCode.default('TRY'),
  amountKind: z.enum(['fixed', 'estimated']).default('estimated'),
  leadDays: z.number().int().min(0).max(60).default(5),
  responsibleUserId: uuid.nullable().default(null),
  notes: z.string().trim().max(1000).default(''),
});
export type ObligationInput = z.infer<typeof obligationSchema>;
export const obligationUpdateSchema = z.object({ config: obligationSchema, version: z.number().int().positive() });
export const obligationCompletionSchema = z.object({
  periodDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['done', 'skipped']).default('done'),
  paidAmount: moneyString.refine(decCheck((v) => v.gte(0)), 'Tutar negatif olamaz').nullable().default(null),
  note: z.string().trim().max(300).default(''),
});
export const obligationCalendarQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((v) => v.to >= v.from, { message: 'Bitiş başlangıçtan önce olamaz', path: ['to'] })
  .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= 400 * 86_400_000, { message: 'En çok 400 günlük aralık', path: ['to'] });

/** Cumartesi/pazar → pazartesi. */
export function nextBusinessDay(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 6 ? addDaysIso(date, 2) : day === 0 ? addDaysIso(date, 1) : date;
}

/**
 * Aralıktaki dönemler: `periodDate` kuralın ürettiği asıl tarih (tamamlama anahtarı), `dueDate` hafta sonu kaydırmalı ödeme
 * günü. Aralık `dueDate` üzerinden süzülür; en çok 1000 dönem.
 */
export function obligationPeriods(
  rule: z.infer<typeof recurrenceSchema>,
  weekendRule: 'none' | 'next_business_day',
  from: string,
  to: string,
) {
  const out: { periodDate: string; dueDate: string }[] = [];
  for (let i = 0; i < 5000 && out.length < 1000; i++) {
    const periodDate = occurrenceDate(rule, i);
    if (rule.endDate && periodDate > rule.endDate) break;
    const dueDate = weekendRule === 'next_business_day' ? nextBusinessDay(periodDate) : periodDate;
    if (periodDate > to && dueDate > to) break;
    if (dueDate >= from && dueDate <= to) out.push({ periodDate, dueDate });
  }
  return out;
}

export type ObligationState = 'done' | 'skipped' | 'overdue' | 'due_soon' | 'upcoming';
export function obligationState(dueDate: string, today: string, leadDays: number, completion: 'done' | 'skipped' | null): ObligationState {
  if (completion) return completion;
  if (dueDate < today) return 'overdue';
  return dueDate <= addDaysIso(today, leadDays) ? 'due_soon' : 'upcoming';
}
export const sumAmounts = (values: (string | null)[]) => values.reduce((s, v) => (v ? s.plus(v) : s), dec(0)).toFixed(2);
