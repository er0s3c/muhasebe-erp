import { z } from 'zod';
import { documentTaxInputSchema } from '../document-tax-calc';
import { isoDate, uuid } from './common';

export const PARTY_TAX_STATUSES = [
  'unknown',
  'consumer',
  'business',
  'vat_registered',
  'withholding_agent',
  'nonresident',
] as const;
export const PARTY_TAX_STATUS_LABELS: Record<(typeof PARTY_TAX_STATUSES)[number], string> = {
  unknown: 'Henüz belirlenmedi',
  consumer: 'Nihai tüketici',
  business: 'İşletme',
  vat_registered: 'KDV mükellefi',
  withholding_agent: 'Tevkifat yapmakla yükümlü',
  nonresident: 'Yerleşik olmayan',
};
export const TAX_TREATMENTS = ['standard', 'zero', 'exempt'] as const;
export const TRANSACTION_TYPES = ['domestic', 'export', 'import', 'other'] as const;
const sourceUrl = z
  .url()
  .max(2000)
  .refine((value) => /^https?:\/\//i.test(value), 'Kaynak HTTP veya HTTPS adresi olmalı');
export const documentTaxRuleConfigSchema = documentTaxInputSchema
  .omit({
    jurisdiction: true,
    rulePackVersion: true,
    sourceRefs: true,
    netAmount: true,
    vatRatePct: true,
    vatAmount: true,
  })
  .extend({
    taxTreatment: z.enum(TAX_TREATMENTS),
    vatCode: z.string().trim().min(1).max(20).nullable(),
    exemptionCode: z.string().trim().min(1).max(40).nullable(),
    stampLiability: z.enum(['company', 'counterparty']).default('company'),
    stampScope: z.enum(['document', 'line']).default('document'),
  })
  .superRefine((value, ctx) => {
    if (value.taxTreatment === 'exempt' && (!value.exemptionCode || value.vatCode !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['exemptionCode'],
        message: 'İstisna için kod gerekli; KDV oranı seçilmez',
      });
    if (value.taxTreatment !== 'exempt' && (!value.vatCode || value.exemptionCode !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['vatCode'],
        message: 'Vergili veya sıfır oranlı işlem için KDV kodu seçilmeli',
      });
    if (value.taxTreatment !== 'standard' && value.vatWithholding !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['vatWithholding'],
        message: 'Sıfır oran ve istisnada KDV tevkifatı kullanılmaz',
      });
  });
export const createDocumentTaxRuleSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(3).max(160),
    jurisdiction: z.enum(['TR', 'KKTC']),
    validFrom: isoDate,
    validTo: isoDate.nullable().default(null),
    version: z.string().trim().min(1).max(100),
    productClass: z.string().trim().min(1).max(80),
    transactionType: z.enum(TRANSACTION_TYPES),
    partyTaxStatus: z.enum(PARTY_TAX_STATUSES.filter((status) => status !== 'unknown')),
    invoiceType: z.enum(['sales', 'purchase', 'expense']),
    config: documentTaxRuleConfigSchema,
    sourceRefs: z.array(sourceUrl).min(1).max(12),
    sourceNote: z.string().trim().min(3).max(2000),
  })
  .superRefine((value, ctx) => {
    if (value.validTo && value.validTo < value.validFrom)
      ctx.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'Bitiş tarihi başlangıçtan önce olamaz',
      });
    if (value.jurisdiction === 'KKTC' && value.config.vatWithholding)
      ctx.addIssue({
        code: 'custom',
        path: ['config', 'vatWithholding'],
        message: 'KDV tevkifatı Türkiye işlemidir',
      });
  });
export const documentTaxRuleQuerySchema = z.object({
  date: isoDate.optional(),
  invoiceType: z.enum(['sales', 'purchase', 'expense']).optional(),
  partyId: uuid.optional(),
});
export type CreateDocumentTaxRuleInput = z.infer<typeof createDocumentTaxRuleSchema>;
export type DocumentTaxRuleConfig = z.infer<typeof documentTaxRuleConfigSchema>;
export interface DocumentTaxRuleSnapshot extends CreateDocumentTaxRuleInput {
  id: string;
  verifiedAt: string;
  verifiedBy: string;
}
export interface InvoiceTaxTotalsSnapshot {
  engineVersion: 'document-tax-v1';
  vatWithheld: string;
  incomeWithheld: string;
  stamp: string;
  payableToSeller: string;
  vatWithheldBase: string | null;
  incomeWithheldBase: string | null;
  stampBase: string | null;
  payableToSellerBase: string | null;
}
