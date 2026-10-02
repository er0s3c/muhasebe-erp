import { z } from 'zod';
import { dec } from '../money';
import { isoDate, moneyString, uuid } from './common';

const text = (max: number) => z.string().trim().max(max);
const positive = moneyString.refine((v) => dec(v).gt(0), 'Tutar sıfırdan büyük olmalı').refine((v) => dec(v).decimalPlaces() <= 2, 'En çok 2 ondalık basamak');

export const createAdvanceSchema = z.object({
  employeeId: uuid,
  date: isoDate,
  amount: positive,
  purpose: text(200).min(3, 'Amaç gerekli'),
  projectId: uuid.nullable().optional(),
  /** Avansın ödendiği kasa/banka hesabı (defter para biriminde olmalı). */
  treasuryAccountId: uuid,
});
export type CreateAdvanceInput = z.infer<typeof createAdvanceSchema>;

export const cancelAdvanceSchema = z.object({ reason: text(300).min(3, 'İptal nedeni gerekli'), date: isoDate.optional() });
export type CancelAdvanceInput = z.infer<typeof cancelAdvanceSchema>;

/** Personelden kasa/banka ile geri ödeme tahsilatı. */
export const repayAdvanceSchema = z.object({
  amount: positive,
  date: isoDate,
  treasuryAccountId: uuid,
  note: text(300).nullable().optional(),
});
export type RepayAdvanceInput = z.infer<typeof repayAdvanceSchema>;

/** Net maaş ödemesi (kasa/banka çıkışı); isteğe bağlı olarak onaylı bordroya bağlanır. */
export const salaryPaymentSchema = z.object({
  employeeId: uuid,
  date: isoDate,
  amount: positive,
  treasuryAccountId: uuid,
  payrollRunId: uuid.nullable().optional(),
  note: text(300).nullable().optional(),
});
export type SalaryPaymentInput = z.infer<typeof salaryPaymentSchema>;

/** Taslak bordroda bir personelin avans kesintileri (boş liste: kesintiyi kaldırır). */
export const setAdvanceDeductionsSchema = z.object({
  employeeId: uuid,
  deductions: z.array(z.object({ advanceId: uuid, amount: positive })).max(50),
});
export type SetAdvanceDeductionsInput = z.infer<typeof setAdvanceDeductionsSchema>;

const pct = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran')
  .refine((v) => dec(v).gt(0) && dec(v).lte(100), 'Oran 0 ile 100 arasında olmalı');

export const updateLedgerSettingsSchema = z.object({
  /** Boş (null): sınır yok. Yasal bir değer koda gömülü değildir; bu alan kullanıcı verisidir. */
  deductionCapPct: pct.nullable(),
  sourceNote: text(300).nullable().optional(),
});
export type UpdateLedgerSettingsInput = z.infer<typeof updateLedgerSettingsSchema>;
export const verifyLedgerSettingsSchema = z.object({ note: text(300).optional() });

export const employeeBalancesQuerySchema = z.object({ asOf: isoDate.optional(), query: text(80).optional() });
export const advanceListQuerySchema = z.object({
  status: z.enum(['open', 'partial', 'settled', 'cancelled', 'outstanding']).optional(),
  employeeId: uuid.optional(),
  asOf: isoDate.optional(),
});
export const employeeStatementQuerySchema = z.object({ from: isoDate, to: isoDate });
export const outstandingAdvancesQuerySchema = z.object({ employeeId: uuid.optional() });
