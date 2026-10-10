import { z } from 'zod';
import { currencyCode, isoDate, uuid, pageParams } from './common';
import { ROLES } from '../permissions';

// --- İnşaat parametreleri (tarihli, kaynak notlu, doğrulama alanlı) ---------------

/** vat_withholding_pct: KDV'nin tevkif edilen yüzdesi (ör. 4/10 → 40); varsayılan 0 = tevkifat yok. */
export const CONSTRUCTION_PARAM_KINDS = ['retention_pct', 'withholding_pct', 'advance_recoup_pct', 'vat_withholding_pct'] as const;
export type ConstructionParamKind = (typeof CONSTRUCTION_PARAM_KINDS)[number];

const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran')
  .refine((v) => Number(v) <= 100, 'Oran en çok %100 olabilir');

export const createConstructionParamSchema = z
  .object({
    kind: z.enum(CONSTRUCTION_PARAM_KINDS),
    value: percent,
    validFrom: isoDate,
    validTo: isoDate.nullable().optional(),
    sourceNote: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, { message: 'Bitiş tarihi başlangıçtan önce olamaz', path: ['validTo'] });
export type CreateConstructionParamInput = z.infer<typeof createConstructionParamSchema>;

export const verifyConstructionParamSchema = z.object({
  verifiedBy: z.string().trim().min(2).max(120),
  sourceNote: z.string().trim().max(500).optional(),
});

// --- Onay motoru ---------------------------------------------------------------------

export const APPROVAL_DOC_TYPES = ['progress_payment', 'employer_claim', 'purchase_request', 'variation_order', 'invoice', 'sales_quote', 'payment', 'expense'] as const;
export type ApprovalDocType = (typeof APPROVAL_DOC_TYPES)[number];

const approvalAmount = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Geçersiz tutar');

export const approvalStepInputSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    userId: uuid.optional(),
    label: z.string().trim().max(60).optional(),
  })
  .refine((s) => !!s.role !== !!s.userId, { message: 'Adım için rol veya kullanıcıdan yalnızca biri seçilmeli' });

export const createApprovalRuleSchema = z
  .object({
    docType: z.enum(APPROVAL_DOC_TYPES),
    projectId: uuid.nullable().optional(),
    minAmount: approvalAmount.default('0'),
    maxAmount: approvalAmount.nullable().optional(),
    separateRequester: z.boolean().default(true),
    steps: z.array(approvalStepInputSchema).min(1, 'En az bir onay adımı gerekir').max(8),
  })
  .refine((r) => r.maxAmount == null || Number(r.maxAmount) > Number(r.minAmount), {
    message: 'Üst sınır alt sınırdan büyük olmalı',
    path: ['maxAmount'],
  });
export type CreateApprovalRuleInput = z.infer<typeof createApprovalRuleSchema>;

export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

// --- Taşeron sözleşmesi ve BOQ ---------------------------------------------------------

export const CONTRACT_DIRECTIONS = ['payable', 'receivable'] as const;
export type ContractDirection = (typeof CONTRACT_DIRECTIONS)[number];

export const SUBCONTRACT_STATUSES = ['draft', 'active', 'completed', 'terminated'] as const;
export type SubcontractStatus = (typeof SUBCONTRACT_STATUSES)[number];

const optionalPercent = percent.optional();

export const createSubcontractSchema = z
  .object({
    /** payable: taşeron sözleşmesi; receivable: işveren sözleşmesi (contract projesi + işveren cari). */
    direction: z.enum(CONTRACT_DIRECTIONS).default('payable'),
    projectId: uuid,
    partyId: uuid,
    title: z.string().trim().min(1).max(200),
    currencyCode,
    startDate: isoDate.nullable().optional(),
    endDate: isoDate.nullable().optional(),
    paymentDays: z.number().int().min(0).max(365).default(30),
    /** Verilmezse sözleşme tarihinde geçerli inşaat parametresinden kopyalanır (yoksa 0). */
    retentionPct: optionalPercent,
    advanceRecoupPct: optionalPercent,
    withholdingPct: optionalPercent,
    /** KDV'nin tevkif edilen yüzdesi; verilmezse parametreden (yoksa 0 = tevkifat yok). */
    vatWithholdingPct: optionalPercent,
    penaltyNote: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { message: 'Bitiş tarihi başlangıçtan önce olamaz', path: ['endDate'] });
export type CreateSubcontractInput = z.infer<typeof createSubcontractSchema>;

export const updateSubcontractSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    startDate: isoDate.nullable(),
    endDate: isoDate.nullable(),
    paymentDays: z.number().int().min(0).max(365),
    retentionPct: percent,
    advanceRecoupPct: percent,
    withholdingPct: percent,
    vatWithholdingPct: percent,
    penaltyNote: z.string().trim().max(1000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'En az bir alan verilmeli');
export type UpdateSubcontractInput = z.infer<typeof updateSubcontractSchema>;

export const subcontractStatusSchema = z.object({ status: z.enum(['completed', 'terminated']) });

export const subcontractListQuerySchema = z.object({
  direction: z.enum(CONTRACT_DIRECTIONS).optional(),
  projectId: uuid.optional(),
  partyId: uuid.optional(),
  status: z.enum(SUBCONTRACT_STATUSES).optional(),
});

// --- Değişiklik emri (variation order) ---------------------------------------------------

export const VARIATION_REASONS = ['client_request', 'design_change', 'site_condition', 'omission_error', 'other'] as const;
export type VariationReason = (typeof VARIATION_REASONS)[number];
export const VARIATION_STATUSES = ['draft', 'submitted', 'awaiting_client', 'applied', 'rejected', 'cancelled'] as const;
export type VariationStatus = (typeof VARIATION_STATUSES)[number];

const variationHeader = {
  title: z.string().trim().min(2).max(200),
  reason: z.enum(VARIATION_REASONS),
  description: z.string().trim().max(2000).nullable().optional(),
  /** Süre uzatımı (gün); sözleşme bitiş tarihine eklenir. */
  timeExtensionDays: z.coerce.number().int().min(0).max(3650).default(0),
};
export const createVariationSchema = z.object(variationHeader);
export type CreateVariationInput = z.infer<typeof createVariationSchema>;
// Varsayılansız: gönderilmeyen alan değişmez (partial + default süreyi sıfırlardı)
export const updateVariationSchema = z.object({ ...variationHeader, timeExtensionDays: z.coerce.number().int().min(0).max(3650) }).partial();
export type UpdateVariationInput = z.infer<typeof updateVariationSchema>;
export const clientAcceptVariationSchema = z.object({
  acceptedAt: isoDate,
  reference: z.string().trim().min(1, 'İşverenin yazı/referans numarası gerekli').max(120),
});
export type ClientAcceptVariationInput = z.infer<typeof clientAcceptVariationSchema>;
export const clientRejectVariationSchema = z.object({ note: z.string().trim().min(3).max(500) });
export const variationListQuerySchema = z.object({
  ...pageParams(),
  subcontractId: uuid.optional(),
  projectId: uuid.optional(),
  direction: z.enum(CONTRACT_DIRECTIONS).optional(),
  status: z.enum(VARIATION_STATUSES).optional(),
});

export const createRevisionSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  copyFromCurrent: z.boolean().default(true),
});
export type CreateRevisionInput = z.infer<typeof createRevisionSchema>;

const boqQuantity = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz miktar').refine((v) => Number(v) > 0, 'Miktar sıfırdan büyük olmalı');
const boqPrice = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz birim fiyat');

export const boqLineSchema = z.object({
  /** Mevcut satırı revizyonlar arasında izlemek için; yeni satırda verilmez. */
  lineKey: uuid.optional(),
  itemNo: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().min(1).max(300),
  unit: z.string().trim().min(1).max(20),
  quantity: boqQuantity,
  unitPrice: boqPrice,
  wbsId: uuid,
  costCodeId: uuid.nullable().optional(),
});
export type BoqLineInput = z.infer<typeof boqLineSchema>;

export const putBoqLinesSchema = z.object({
  lines: z
    .array(boqLineSchema)
    .max(2000)
    .refine((l) => new Set(l.map((x) => x.lineKey).filter(Boolean)).size === l.filter((x) => x.lineKey).length, 'Aynı satır anahtarı birden çok kez girilemez'),
});
export type PutBoqLinesInput = z.infer<typeof putBoqLinesSchema>;

// --- Hakediş (verilen) ---------------------------------------------------------------------

export const PROGRESS_STATUSES = ['draft', 'submitted', 'posted', 'cancelled'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

const nonNegativeQty = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz miktar');
const positiveAmount = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Geçersiz tutar').refine((v) => Number(v) > 0, 'Tutar sıfırdan büyük olmalı');

const progressBody = {
  periodEnd: isoDate,
  /** KDV kodu (tax_rates); boşsa KDV yok. */
  vatCode: z.string().trim().max(20).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  /** Her BOQ satırı için KÜMÜLATİF miktar (önceki hakedişlerdeki dahil). */
  lines: z
    .array(z.object({ lineKey: uuid, cumulativeQty: nonNegativeQty }))
    .min(1, 'En az bir satır girilmeli')
    .max(2000)
    .refine((l) => new Set(l.map((x) => x.lineKey)).size === l.length, 'Aynı BOQ satırı birden çok kez girilemez'),
  deductions: z.array(z.object({ description: z.string().trim().min(1).max(200), amount: positiveAmount })).max(50).default([]),
  /** Taşerona verilen malzeme bedelinin bu hakedişteki mahsubu (0 = yok); bakiyeyi aşamaz. İşveren hakedişinde 0 olmalı. */
  materialRecoup: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Geçersiz tutar').optional(),
};

export const createProgressPaymentSchema = z.object({ subcontractId: uuid, ...progressBody });
export type CreateProgressPaymentInput = z.infer<typeof createProgressPaymentSchema>;

export const updateProgressPaymentSchema = z.object(progressBody);
export type UpdateProgressPaymentInput = z.infer<typeof updateProgressPaymentSchema>;

export const progressPaymentListQuerySchema = z.object({
  ...pageParams(),
  direction: z.enum(CONTRACT_DIRECTIONS).optional(),
  subcontractId: uuid.optional(),
  projectId: uuid.optional(),
  status: z.enum(PROGRESS_STATUSES).optional(),
});

export const cancelProgressPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'İptal nedeni gerekli').max(300),
  /** Ters kayıt tarihi; boşsa bugün. */
  entryDate: isoDate.optional(),
});
export type CancelProgressPaymentInput = z.infer<typeof cancelProgressPaymentSchema>;

export const giveAdvanceSchema = z.object({
  /** Ödemeyi yapacak kasa/banka hesabı; para birimi sözleşmeyle aynı olmalı. */
  accountId: uuid,
  date: isoDate,
  amount: positiveAmount,
  note: z.string().trim().max(300).optional(),
});
export type GiveAdvanceInput = z.infer<typeof giveAdvanceSchema>;

/** Taşerona malzeme verme: sözleşmenin projesine etiketli stok sarfı; bedel stok çıkış maliyetidir. */
export const giveMaterialSchema = z.object({
  date: isoDate,
  warehouseId: uuid,
  note: z.string().trim().max(300).optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        quantity: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz miktar').refine((v) => Number(v) > 0, 'Miktar sıfırdan büyük olmalı'),
        /** Sözleşmenin projesinin yaprak iş kalemi. */
        wbsId: uuid,
      }),
    )
    .min(1, 'En az bir kalem girilmeli')
    .max(100),
});
export type GiveMaterialInput = z.infer<typeof giveMaterialSchema>;

export const releaseRetentionSchema = z.object({
  date: isoDate,
  amount: positiveAmount,
  note: z.string().trim().max(300).optional(),
});
export type ReleaseRetentionInput = z.infer<typeof releaseRetentionSchema>;
