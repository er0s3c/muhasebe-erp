import { z } from 'zod';
import { currencyCode, isoDate, moneyString, uuid } from './common';

export const PARTY_KINDS = ['customer', 'supplier', 'both'] as const;
/**
 * Cari türü. 'employee' (Faz X5): personel carisi; yalnızca personel kartından açılır, müşteri/tedarikçi cari hesabında
 * kullanılamaz (`partyKindFits` hep false), kullanıcı cari formunda seçilmez.
 */
export type PartyKind = (typeof PARTY_KINDS)[number] | 'employee';

/** Cari kontrol hesabı türü: alacak tarafı (müşteri) ya da borç tarafı (tedarikçi). */
export const PARTY_CONTROL_TYPES = ['receivable', 'payable'] as const;
export type PartyControlType = (typeof PARTY_CONTROL_TYPES)[number];

/** Cari türü, kontrol hesabı türüyle uyumlu mu? */
export function partyKindFits(kind: PartyKind, control: PartyControlType): boolean {
  return kind === 'both' || (control === 'receivable' ? kind === 'customer' : kind === 'supplier');
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

export const createPartySchema = z.object({
  /** Boşsa CR-000001 biçiminde otomatik verilir. */
  code: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9ÇĞİÖŞÜçğıöşü._/-]+$/, 'Kod yalnızca harf, rakam ve . _ / - içerebilir')
    .optional(),
  name: z.string().trim().min(2).max(160),
  kind: z.enum(PARTY_KINDS).default('customer'),
  taxNumber: optionalText(40),
  taxOffice: optionalText(120),
  phone: optionalText(40),
  email: z
    .union([z.literal(''), z.email().max(254)])
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  address: optionalText(300),
  currencyCode: currencyCode.default('TRY'),
  creditLimit: moneyString.optional(),
  paymentTermDays: z.number().int().min(0).max(365).default(0),
  notes: optionalText(1000),
});
export type CreatePartyInput = z.infer<typeof createPartySchema>;

/** Güncellemede boş metin (veya null) alanı temizler; alan hiç gönderilmezse dokunulmaz. */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

export const updatePartySchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  kind: z.enum(PARTY_KINDS).optional(),
  taxNumber: clearableText(40),
  taxOffice: clearableText(120),
  phone: clearableText(40),
  email: z
    .union([z.literal(''), z.email().max(254)])
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
  address: clearableText(300),
  notes: clearableText(1000),
  currencyCode: currencyCode.optional(),
  creditLimit: moneyString.nullable().optional(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
  isActive: z.boolean().optional(),
});
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;

export const listPartiesQuerySchema = z.object({
  query: z.string().trim().max(100).optional(),
  kind: z.enum(PARTY_KINDS).optional(),
  active: z.enum(['true', 'false']).optional(),
  hasBalance: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;

export const partyStatementQuerySchema = z.object({ from: isoDate, to: isoDate });
export type PartyStatementQuery = z.infer<typeof partyStatementQuerySchema>;

export const agingQuerySchema = z.object({
  type: z.enum(PARTY_CONTROL_TYPES).default('receivable'),
  asOf: isoDate,
});
export type AgingQuery = z.infer<typeof agingQuerySchema>;

export const openItemsQuerySchema = z.object({
  type: z.enum(PARTY_CONTROL_TYPES).optional(),
  asOf: isoDate,
});
export type OpenItemsQuery = z.infer<typeof openItemsQuerySchema>;

export const partyIdParam = z.object({ id: uuid });
