import { z } from 'zod';
import { isoDate, uuid, pageParams } from './common';
import { yearMonth } from './attendance';

/**
 * Sosyal güvenlik çıktıları (Faz D4). Hiçbir yasal değer, bordro tipi kodu, prim desteği oranı/koşulu ya da resmî bildirim
 * biçimi kodda YOKTUR: bordro tipi kodu serbest veridir; prim desteği kuralları kullanıcı girişi, tarihli, kaynak notlu,
 * doğrulama alanlı ve varsayılan KAPALIdır (LEGAL-NOTES §3, §14). Çıktı GENEL bir düzendir; resmî bildirim biçimi değildir.
 */
export const SOCIAL_DECLARATION_STATUSES = ['draft', 'finalized'] as const;
export type SocialDeclarationStatus = (typeof SOCIAL_DECLARATION_STATUSES)[number];

export const SUPPORT_TARGETS = ['employer', 'employee'] as const;
export type SupportTarget = (typeof SUPPORT_TARGETS)[number];
export const SUPPORT_MODES = ['percent_of_premium', 'fixed_amount'] as const;
export type SupportMode = (typeof SUPPORT_MODES)[number];

const text = (max: number) => z.string().trim().max(max);

/** Tarihli sosyal güvenlik profili: bordro tipi kodu serbest veridir; sigorta başlangıç/bitişi ve numara isteğe bağlıdır. */
export const createSocialProfileSchema = z
  .object({
    employeeId: uuid,
    effectiveFrom: isoDate,
    payrollTypeCode: text(40).nullable().optional(),
    insuranceStart: isoDate.nullable().optional(),
    insuranceEnd: isoDate.nullable().optional(),
    /** Sosyal güvenlik numarası (açık metin yalnızca istekte; saklanırken şifrelenir). */
    socialSecurityNo: z.string().trim().min(4, 'Numara çok kısa').max(40).nullable().optional(),
    note: text(300).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.insuranceStart && v.insuranceEnd && v.insuranceEnd < v.insuranceStart) ctx.addIssue({ code: 'custom', path: ['insuranceEnd'], message: 'Sigorta bitişi başlangıçtan önce olamaz' });
  });
export type CreateSocialProfileInput = z.infer<typeof createSocialProfileSchema>;
export const socialProfileListQuerySchema = z.object({ employeeId: uuid.optional() });
export const revealSocialNoSchema = z.object({ reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)') });

const ruleValue = z.string().regex(/^\d{1,13}(\.\d{1,6})?$/, 'Geçersiz değer');

export const createSupportRuleSchema = z
  .object({
    code: text(30).min(1, 'Kod gerekli'),
    name: text(120).min(1, 'Ad gerekli'),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().optional(),
    target: z.enum(SUPPORT_TARGETS),
    mode: z.enum(SUPPORT_MODES),
    value: ruleValue,
    sourceNote: text(500).nullable().optional(),
    /** Varsayılan KAPALI: satır açılana kadar hiçbir destek uygulanmaz. */
    enabled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'percent_of_premium' && Number(v.value) > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Yüzde 0 ile 100 arasında olmalı' });
    if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'Bitiş başlangıçtan önce olamaz' });
  });
export type CreateSupportRuleInput = z.infer<typeof createSupportRuleSchema>;
export const updateSupportRuleSchema = z
  .object({ enabled: z.boolean().optional(), sourceNote: text(500).nullable().optional(), effectiveTo: isoDate.nullable().optional(), name: text(120).min(1).optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Değişiklik yok' });
export const verifySupportRuleSchema = z.object({ note: text(500).nullable().optional() });

export const createEligibilitySchema = z
  .object({ employeeId: uuid, ruleCode: text(30).min(1), validFrom: isoDate, validTo: isoDate.nullable().optional(), note: text(300).nullable().optional() })
  .superRefine((v, ctx) => {
    if (v.validTo && v.validTo < v.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Bitiş başlangıçtan önce olamaz' });
  });
export type CreateEligibilityInput = z.infer<typeof createEligibilitySchema>;

export const buildDeclarationSchema = z.object({ month: yearMonth });
export const finalizeDeclarationSchema = z.object({ note: text(300).nullable().optional() });
export const reopenDeclarationSchema = z.object({ reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)') });
export const declarationListQuerySchema = z.object({ ...pageParams(), year: z.coerce.number().int().min(2000).max(2100).optional(), status: z.enum(SOCIAL_DECLARATION_STATUSES).optional() });
export const premiumSummaryQuerySchema = z.object({ from: yearMonth, to: yearMonth }).refine((v) => v.from <= v.to, { message: 'Başlangıç ayı bitişten sonra olamaz', path: ['to'] });
