import { z } from 'zod';
import { LANDED_COST_KINDS, LANDED_METHODS } from '../landed-cost';
import { dec } from '../money';
import { currencyCode, isoDate, moneyString, rateString, uuid } from './common';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const positive = moneyString.refine((v) => dec(v).gt(0), 'Tutar sıfırdan büyük olmalı');

// --- İthalat dosyası (Faz X4) --------------------------------------------------------------------------------------

export const importLineInputSchema = z.object({
  /** invoice: kayıtlı alış faturası satırı (stoklu, irsaliyesiz); delivery: kayıtlı alış irsaliyesi satırı. */
  sourceKind: z.enum(['invoice', 'delivery']),
  sourceLineId: uuid,
  /** Satır toplam ağırlığı (kullanıcı birimi, örn. kg); yalnızca ağırlığa göre dağıtımda gerekir. */
  weight: moneyString.nullable().optional(),
});

export const importCostLineInputSchema = z.object({
  kind: z.enum(LANDED_COST_KINDS),
  description: text(200).min(1, 'Açıklama gerekli'),
  /** Ödenen taraf (gümrük idaresi, nakliyeci, sigortacı…); isteğe bağlı. */
  partyId: uuid.nullable().optional(),
  /** Bağlı gider/alış faturası (kayıtlı); isteğe bağlı. */
  invoiceId: uuid.nullable().optional(),
  /** Boşsa şirket para birimi. */
  currencyCode: currencyCode.optional(),
  amount: positive,
  /** Yabancı para biriminde şirket para birimine kur (verilmezse hesap tarihindeki kayıtlı kur kullanılır). */
  fxRate: rateString.nullable().optional(),
  /** Boşsa dosyanın varsayılan yöntemi. */
  method: z.enum(LANDED_METHODS).optional(),
  /** Alacak hesabı (gideri ilk yazdığınız hesap); boşsa hesap eşlemesindeki aktarım hesabı. */
  creditAccountId: uuid.nullable().optional(),
  reference: optText(100),
});
export type ImportCostLineInput = z.infer<typeof importCostLineInputSchema>;

export const saveImportFileSchema = z
  .object({
    name: text(120).min(1, 'Dosya adı gerekli'),
    /** Beyanname/dosya numarası (metin referansı). */
    reference: optText(100),
    description: optText(500),
    method: z.enum(LANDED_METHODS).default('value'),
    fileDate: isoDate,
    lines: z.array(importLineInputSchema).max(500).default([]),
    costLines: z.array(importCostLineInputSchema).max(100).default([]),
  })
  .superRefine((v, ctx) => {
    const keys = v.lines.map((l) => `${l.sourceKind}:${l.sourceLineId}`);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Aynı kaynak satır iki kez eklenemez' });
  });
export type SaveImportFileInput = z.infer<typeof saveImportFileSchema>;

/** Elle dağıtım: maliyet kalemi sıra no → (mal satırı sıra no → tutar). */
export const allocateImportSchema = z.object({
  manual: z.record(z.string(), z.record(z.string(), moneyString)).optional(),
});
export type AllocateImportInput = z.infer<typeof allocateImportSchema>;

export const postImportSchema = z.object({ date: isoDate.optional() });
export const cancelImportSchema = z.object({ reason: text(300).min(1, 'İptal nedeni gerekli'), date: isoDate.optional() });
export type CancelImportInput = z.infer<typeof cancelImportSchema>;

export const listImportFilesQuerySchema = z.object({
  status: z.enum(['draft', 'allocated', 'posted', 'cancelled']).optional(),
  q: text(80).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListImportFilesQuery = z.infer<typeof listImportFilesQuerySchema>;

export const listImportSourcesQuerySchema = z.object({
  q: text(80).optional(),
  kind: z.enum(['invoice', 'delivery']).optional(),
  partyId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListImportSourcesQuery = z.infer<typeof listImportSourcesQuerySchema>;

export const importFileReportQuerySchema = z.object({ id: uuid });

// --- Gider kartları ve gider fişi (Faz X4) ----------------------------------------------------------------------------

const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran')
  .refine((v) => dec(v).lte(100), 'Oran 100\'ü aşamaz');

export const createExpenseCardSchema = z.object({
  code: text(20).min(1, 'Kod gerekli'),
  name: text(120).min(1, 'Ad gerekli'),
  accountId: uuid,
  /** Varsayılan KDV kodu (tax_rates.code); oran gider tarihinde çözülür. */
  taxCode: optText(20),
  /** Varsayılan stopaj yüzdesi: kullanıcı verisidir, doğrulanmamıştır. */
  withholdingRate: percent.nullable().optional(),
  projectId: uuid.nullable().optional(),
  wbsId: uuid.nullable().optional(),
  costCodeId: uuid.nullable().optional(),
  notes: optText(300),
});
export type CreateExpenseCardInput = z.infer<typeof createExpenseCardSchema>;

export const updateExpenseCardSchema = createExpenseCardSchema.partial().extend({ isActive: z.boolean().optional() });
export type UpdateExpenseCardInput = z.infer<typeof updateExpenseCardSchema>;

export const EXPENSE_PAYMENT_KINDS = ['treasury', 'party'] as const;

/**
 * Hızlı gider girişi. `net` KDV hariç tutardır; KDV kodu/stopaj/proje alanları gönderilmezse kartın varsayılanı kullanılır,
 * açıkça `null` gönderilirse uygulanmaz.
 */
export const createExpenseEntrySchema = z
  .object({
    entryDate: isoDate,
    cardId: uuid,
    description: text(300).min(1, 'Açıklama gerekli'),
    paymentKind: z.enum(EXPENSE_PAYMENT_KINDS),
    treasuryAccountId: uuid.nullable().optional(),
    partyId: uuid.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    net: positive,
    taxCode: optText(20),
    withholdingRate: percent.nullable().optional(),
    /** Belge/fiş numarası ya da ek dosya referansı (metin). */
    documentRef: optText(200),
    projectId: uuid.nullable().optional(),
    wbsId: uuid.nullable().optional(),
    costCodeId: uuid.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.paymentKind === 'treasury' && !v.treasuryAccountId) issue('treasuryAccountId', 'Kasa/banka hesabı seçin');
    if (v.paymentKind === 'party' && !v.partyId) issue('partyId', 'Cari seçin');
    if (v.paymentKind === 'party' && v.treasuryAccountId) issue('treasuryAccountId', 'Cari ödemede kasa/banka hesabı seçilmez');
    if (v.dueDate && v.dueDate < v.entryDate) issue('dueDate', 'Vade gider tarihinden önce olamaz');
  });
export type CreateExpenseEntryInput = z.infer<typeof createExpenseEntrySchema>;

export const cancelExpenseEntrySchema = z.object({ reason: text(300).min(1, 'İptal nedeni gerekli'), date: isoDate.optional() });
export type CancelExpenseEntryInput = z.infer<typeof cancelExpenseEntrySchema>;

export const listExpenseEntriesQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  cardId: uuid.optional(),
  partyId: uuid.optional(),
  projectId: uuid.optional(),
  status: z.enum(['posted', 'cancelled']).optional(),
  q: text(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListExpenseEntriesQuery = z.infer<typeof listExpenseEntriesQuerySchema>;

export const expenseReportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    cardId: uuid.optional(),
    projectId: uuid.optional(),
    partyId: uuid.optional(),
    /** "En yüksek giderler" listesinin uzunluğu. */
    top: z.coerce.number().int().min(1).max(100).default(10),
  })
  .refine((v) => v.to >= v.from, { message: 'Bitiş tarihi başlangıçtan önce olamaz', path: ['to'] });
export type ExpenseReportQuery = z.infer<typeof expenseReportQuerySchema>;
