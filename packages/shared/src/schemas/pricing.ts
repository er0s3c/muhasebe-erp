import { z } from 'zod';
import { currencyCode, isoDate, uuid } from './common';
import { positiveQuantity, quantityString, unitCostString } from './inventory';
import { SERIAL_MAX_LENGTH, SERIAL_STATUSES } from '../serial-calc';

// --- Fiyat listeleri (X3) ------------------------------------------------------

export const PRICE_KINDS = ['sales', 'purchase'] as const;
export const priceKind = z.enum(PRICE_KINDS);

const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran')
  .refine((v) => Number(v) <= 100, "Oran 100'ü aşamaz");
const signedPercent = z
  .string()
  .regex(/^-?\d{1,4}(\.\d{1,4})?$/, 'Geçersiz oran')
  .refine((v) => Number(v) > -100 && Number(v) <= 1000, 'Oran -100 ile 1000 arasında olmalı');

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v === '' || v === undefined ? null : v));

const listCode = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9ÇĞİÖŞÜçğıöşü._/-]+$/, 'Kod yalnızca harf, rakam ve . _ / - içerebilir');

const validity = (doc: { validFrom?: string | null; validTo?: string | null }, ctx: z.RefinementCtx) => {
  if (doc.validFrom && doc.validTo && doc.validTo < doc.validFrom) {
    ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Bitiş tarihi başlangıçtan önce olamaz' });
  }
};

export const createPriceListSchema = z
  .object({
    code: listCode,
    name: z.string().trim().min(2).max(120),
    kind: priceKind,
    currency: currencyCode,
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    notes: optionalText(500),
  })
  .superRefine(validity);
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;

export const updatePriceListSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    currency: currencyCode.optional(),
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
    isActive: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    notes: optionalText(500),
  })
  .superRefine(validity);
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const listPriceListsQuerySchema = z.object({
  kind: priceKind.optional(),
  active: z.enum(['true', 'false']).optional(),
});
export type ListPriceListsQuery = z.infer<typeof listPriceListsQuerySchema>;

export const priceListItemSchema = z
  .object({
    itemId: uuid,
    /** Miktar kademesi: bu miktar ve üstü için geçerli (0 = tüm miktarlar). */
    minQty: quantityString.default('0'),
    price: unitCostString,
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
  })
  .superRefine(validity);
export type PriceListItemInput = z.infer<typeof priceListItemSchema>;

export const updatePriceListItemSchema = z
  .object({
    minQty: quantityString.optional(),
    price: unitCostString.optional(),
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
  })
  .superRefine(validity);
export type UpdatePriceListItemInput = z.infer<typeof updatePriceListItemSchema>;

export const listPriceListItemsQuerySchema = z.object({
  query: z.string().trim().max(100).optional(),
  itemId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListPriceListItemsQuery = z.infer<typeof listPriceListItemsQuerySchema>;

/** Listeyi yeni bir listeye kopyalar; isteğe bağlı yüzde ayarı (+ zam, - indirim) ve yuvarlama. */
export const copyPriceListSchema = z.object({
  code: listCode,
  name: z.string().trim().min(2).max(120),
  adjustPct: signedPercent.optional(),
  decimals: z.number().int().min(0).max(6).default(2),
});
export type CopyPriceListInput = z.infer<typeof copyPriceListSchema>;

/** Listedeki tüm (ya da seçili) fiyatları yüzde oranında toplu günceller. */
export const adjustPriceListSchema = z.object({
  pct: signedPercent,
  decimals: z.number().int().min(0).max(6).default(2),
  itemIds: z.array(uuid).max(1000).optional(),
});
export type AdjustPriceListInput = z.infer<typeof adjustPriceListSchema>;

// --- Cari özel fiyat/iskonto -----------------------------------------------------

export const partyPriceSchema = z
  .object({
    partyId: uuid,
    itemId: uuid,
    kind: priceKind,
    currency: currencyCode.nullable().optional(),
    price: unitCostString.nullable().optional(),
    discountPct: percent.nullable().optional(),
    minQty: quantityString.default('0'),
    validFrom: isoDate.nullable().optional(),
    validTo: isoDate.nullable().optional(),
  })
  .superRefine((d, ctx) => {
    validity(d, ctx);
    const hasPrice = d.price !== null && d.price !== undefined;
    const hasDiscount = d.discountPct !== null && d.discountPct !== undefined;
    if (!hasPrice && !hasDiscount) ctx.addIssue({ code: 'custom', path: ['price'], message: 'Fiyat veya iskonto girilmeli' });
    if (hasPrice && !d.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'Fiyat için para birimi seçilmeli' });
  });
export type PartyPriceInput = z.infer<typeof partyPriceSchema>;

export const listPartyPricesQuerySchema = z.object({
  partyId: uuid.optional(),
  itemId: uuid.optional(),
  kind: priceKind.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListPartyPricesQuery = z.infer<typeof listPartyPricesQuerySchema>;

/** Carinin fiyat ayarları: atanan listeler ve genel iskontolar. */
export const partyPricingSchema = z.object({
  salesPriceListId: uuid.nullable().optional(),
  purchasePriceListId: uuid.nullable().optional(),
  salesDiscountPct: percent.optional(),
  purchaseDiscountPct: percent.optional(),
});
export type PartyPricingInput = z.infer<typeof partyPricingSchema>;

/** Satır girişinde fiyat önerisi: kalem seçilince arayüz bunu çağırır. */
export const resolvePriceQuerySchema = z.object({
  partyId: uuid,
  itemId: uuid,
  kind: priceKind,
  date: isoDate,
  currency: currencyCode,
  quantity: positiveQuantity.default('1'),
});
export type ResolvePriceQuery = z.infer<typeof resolvePriceQuerySchema>;

// --- Seri no (X3) --------------------------------------------------------------

export const serialNoSchema = z.string().trim().min(1).max(SERIAL_MAX_LENGTH);

export const listSerialsQuerySchema = z.object({
  itemId: uuid.optional(),
  warehouseId: uuid.optional(),
  status: z.enum(SERIAL_STATUSES).optional(),
  query: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListSerialsQuery = z.infer<typeof listSerialsQuerySchema>;

export const serialLookupQuerySchema = z.object({
  serialNo: serialNoSchema,
  itemId: uuid.optional(),
});
export type SerialLookupQuery = z.infer<typeof serialLookupQuerySchema>;
