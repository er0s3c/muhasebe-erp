import { z } from 'zod';
import { currencyCode, isoDate, moneyString, rateString, uuid } from './common';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense', 'cost', 'memo'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Tekdüzen sınıf rakamından hesap türü. */
export function accountTypeForCode(code: string): AccountType {
  switch (code[0]) {
    case '1':
    case '2':
      return 'asset';
    case '3':
    case '4':
      return 'liability';
    case '5':
      return 'equity';
    case '6':
      return 'income';
    case '7':
      return 'cost';
    case '9':
      return 'memo';
    default:
      return 'expense';
  }
}

/** Hesap kodu: 1-3 haneli ana kod, ardından noktalı alt kodlar (örn. 120.001). */
export const accountCode = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.[0-9A-Za-z]{1,8})*$/, 'Geçersiz hesap kodu');

export const createAccountSchema = z.object({
  code: accountCode,
  name: z.string().trim().min(2).max(160),
  /** Doluysa hesap yalnızca bu para biriminde hareket görür (dövizli hesap). */
  currencyCode: currencyCode.nullable().optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const journalLineSchema = z
  .object({
    accountId: uuid,
    description: z.string().trim().max(300).optional(),
    currency: currencyCode,
    debit: moneyString.default('0'),
    credit: moneyString.default('0'),
    /** Verilmezse işlem tarihindeki kayıtlı kur kullanılır. */
    fxRate: rateString.optional(),
    /** Cari kontrol hesabında (120, 320…) zorunlu; diğer hesaplarda yasak. */
    partyId: uuid.optional(),
    /** Yalnızca cari satırlarda; yaşlandırma vadeye göre yapılır, yoksa fiş tarihi. */
    dueDate: isoDate.optional(),
    /** Proje boyutu (yalnızca gelir/gider/maliyet hesaplarında; `construction.projects` modülü açıkken). */
    projectId: uuid.optional(),
    /** Proje içindeki yaprak iş kalemi; projesiz verilemez. */
    wbsId: uuid.optional(),
    /** Maliyet kodu (malzeme, işçilik, taşeron…); projesiz verilemez. */
    costCodeId: uuid.optional(),
  })
  .refine(
    (l) => (Number(l.debit) > 0) !== (Number(l.credit) > 0),
    { message: 'Satırda borç veya alacaktan yalnızca biri sıfırdan büyük olmalı' },
  )
  .refine((l) => !l.wbsId || !!l.projectId, { message: 'İş kalemi için proje seçilmeli', path: ['wbsId'] })
  .refine((l) => !l.costCodeId || !!l.projectId, { message: 'Maliyet kodu için proje seçilmeli', path: ['costCodeId'] });
export type JournalLineInput = z.infer<typeof journalLineSchema>;

export const createJournalSchema = z.object({
  entryDate: isoDate,
  description: z.string().trim().min(1).max(300),
  lines: z.array(journalLineSchema).min(2).max(500),
  /** true ise taslak oluşturulmaz, doğrudan kaydedilir. */
  post: z.boolean().default(false),
});
export type CreateJournalInput = z.infer<typeof createJournalSchema>;

export const reverseJournalSchema = z.object({
  entryDate: isoDate.optional(),
  description: z.string().trim().max(300).optional(),
});
export type ReverseJournalInput = z.infer<typeof reverseJournalSchema>;

export const trialBalanceQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  currency: z.enum(['base', 'reporting']).default('base'),
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export const accountLedgerQuerySchema = z.object({
  accountId: uuid,
  from: isoDate,
  to: isoDate,
});
export type AccountLedgerQuery = z.infer<typeof accountLedgerQuerySchema>;
