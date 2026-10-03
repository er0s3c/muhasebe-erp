import { z } from 'zod';
import { currencyCode, isoDate, uuid, pageParams } from './common';

/**
 * Yabancı işçi belge ve teminat takibi (Faz D5). Hiçbir yasal süre, ücret, teminat tutarı ya da makam bilgisi kodda YOKTUR:
 * belge türleri kullanıcı kataloğudur; uyarı günü ve teminat tutarı tarihli, kaynak notlu, doğrulama alanlı, varsayılan KAPALI
 * kullanıcı parametresidir (LEGAL-NOTES §3, §14).
 */
export const FOREIGN_DOC_STATUSES = ['valid', 'expiring', 'expired', 'revoked'] as const;
export type ForeignDocStatus = (typeof FOREIGN_DOC_STATUSES)[number];
export const GUARANTEE_STATUSES = ['held', 'refunded', 'forfeited'] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];
export const FOREIGN_PARAM_KEYS = ['guarantee_amount', 'expiry_warning_days'] as const;
export type ForeignParamKey = (typeof FOREIGN_PARAM_KEYS)[number];

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const reason = text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)');

export const createDocTypeSchema = z.object({ code: text(30).min(1, 'Kod gerekli'), name: text(120).min(1, 'Ad gerekli') });
export const updateDocTypeSchema = z
  .object({ name: text(120).min(1).optional(), active: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.active !== undefined, { message: 'Değişiklik yok' });

export const createForeignDocSchema = z
  .object({
    employeeId: uuid,
    typeId: uuid,
    /** Belge numarası (açık metin yalnızca istekte; saklanırken şifrelenir). */
    documentNo: z.string().trim().min(3, 'Numara çok kısa').max(60).nullable().optional(),
    issuingAuthority: optText(200),
    issueDate: isoDate.nullable().optional(),
    expiryDate: isoDate.nullable().optional(),
    referenceNote: optText(300),
    note: optText(500),
  })
  .superRefine((v, ctx) => {
    if (v.issueDate && v.expiryDate && v.expiryDate < v.issueDate) ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: 'Son kullanma tarihi veriliş tarihinden önce olamaz' });
  });
export type CreateForeignDocInput = z.infer<typeof createForeignDocSchema>;

export const updateForeignDocSchema = z
  .object({ issuingAuthority: optText(200), referenceNote: optText(300), note: optText(500) })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Değişiklik yok' });

export const renewForeignDocSchema = z
  .object({
    issueDate: isoDate.nullable().optional(),
    expiryDate: isoDate,
    documentNo: z.string().trim().min(3, 'Numara çok kısa').max(60).nullable().optional(),
    note: optText(300),
  })
  .superRefine((v, ctx) => {
    if (v.issueDate && v.expiryDate < v.issueDate) ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: 'Son kullanma tarihi veriliş tarihinden önce olamaz' });
  });
export const revokeForeignDocSchema = z.object({ reason });
export const revealForeignDocNoSchema = z.object({ reason });

export const foreignDocListQuerySchema = z.object({
  ...pageParams(),
  employeeId: uuid.optional(),
  typeId: uuid.optional(),
  status: z.enum(FOREIGN_DOC_STATUSES).optional(),
  /** Yalnızca bu kadar gün içinde (bugünden itibaren) dolacak ya da dolmuş belgeler. */
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  nationality: z.string().trim().max(80).optional(),
  q: z.string().trim().max(100).optional(),
  /** Değerlendirme günü (varsayılan: bugün, şirket saat dilimi); testler ve geçmiş/gelecek dökümler için. */
  asOf: isoDate.optional(),
});
export type ForeignDocListQuery = z.infer<typeof foreignDocListQuerySchema>;

const paramValue = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Geçersiz değer');
export const createForeignParamSchema = z
  .object({
    key: z.enum(FOREIGN_PARAM_KEYS),
    value: paramValue,
    currency: currencyCode.nullable().optional(),
    effectiveFrom: isoDate,
    sourceNote: optText(500),
    /** Varsayılan KAPALI: satır açılana kadar hiçbir hesap/kayıt bu değeri kullanmaz. */
    enabled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.key === 'guarantee_amount') {
      if (!v.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'Teminat tutarı için para birimi gerekli' });
      if (Number(v.value) <= 0) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Tutar sıfırdan büyük olmalı' });
    } else {
      if (v.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'Bu parametrede para birimi olmaz' });
      if (!/^\d{1,4}$/.test(v.value) || Number(v.value) > 3650) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Gün sayısı 0 ile 3650 arasında tam sayı olmalı' });
    }
  });
export type CreateForeignParamInput = z.infer<typeof createForeignParamSchema>;
export const updateForeignParamSchema = z
  .object({ enabled: z.boolean().optional(), sourceNote: optText(500) })
  .refine((v) => v.enabled !== undefined || v.sourceNote !== undefined, { message: 'Değişiklik yok' });
export const verifyForeignParamSchema = z.object({ note: optText(500) });

/** Tutar kayıt tarihinde geçerli kullanıcı parametresinden gelir; istekte tutar alınmaz. */
export const createGuaranteeSchema = z.object({
  employeeId: uuid,
  docId: uuid.nullable().optional(),
  depositedDate: isoDate,
  depositReference: optText(120),
});
export type CreateGuaranteeInput = z.infer<typeof createGuaranteeSchema>;
export const resolveGuaranteeSchema = z.object({ status: z.enum(['refunded', 'forfeited']), resolvedDate: isoDate, note: optText(300) });
export const guaranteeListQuerySchema = z.object({
  ...pageParams(),
  employeeId: uuid.optional(),
  projectId: uuid.optional(),
  status: z.enum(GUARANTEE_STATUSES).optional(),
});
