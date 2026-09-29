import { z } from 'zod';
import { currencyCode, isoDate, rateString } from './common';

export const upsertRateSchema = z.object({
  rateDate: isoDate,
  /** 1 birim `currencyCode` = `buy`/`sell` birim `quoteCode` */
  currencyCode,
  quoteCode: currencyCode,
  buy: rateString,
  sell: rateString.optional(),
  source: z.string().trim().max(60).default('manual'),
});
export type UpsertRateInput = z.infer<typeof upsertRateSchema>;

export const createTaxRateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_.-]+$/, 'Kod yalnızca harf, rakam, . _ - içerebilir'),
  name: z.string().trim().min(2).max(80),
  /** Yüzde olarak, örn. "16" */
  rate: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran')
    .refine((v) => Number(v) <= 100, 'Oran en çok %100 olabilir'),
  validFrom: isoDate,
  validTo: isoDate.nullable().optional(),
  sourceNote: z.string().trim().max(500).optional(),
});
export type CreateTaxRateInput = z.infer<typeof createTaxRateSchema>;

export const verifyTaxRateSchema = z.object({
  verifiedBy: z.string().trim().min(2).max(120),
  sourceNote: z.string().trim().max(500).optional(),
});
export type VerifyTaxRateInput = z.infer<typeof verifyTaxRateSchema>;

export const CUSTOM_CODE_SCOPES = ['account', 'transaction', 'party', 'item'] as const;
export const createCustomCodeSchema = z.object({
  scope: z.enum(CUSTOM_CODE_SCOPES),
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(100),
});
export type CreateCustomCodeInput = z.infer<typeof createCustomCodeSchema>;
