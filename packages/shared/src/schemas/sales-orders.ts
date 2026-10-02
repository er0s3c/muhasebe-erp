import { z } from 'zod';
import { currencyCode, isoDate, uuid } from './common';
import { percentString } from './invoices';
import { ITEM_UNITS, positiveQuantity, unitCostString } from './inventory';
import { BATCH_GROUPINGS, SALES_DOC_KINDS, SALES_DOC_STATUSES } from '../sales-order-calc';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

// --- Teklif / sipariş ----------------------------------------------------------

export const salesOrderLineSchema = z.object({
  /** Boşsa serbest metin satırı (hizmet, işçilik…). */
  itemId: uuid.nullable().optional(),
  /** Boşsa kartın adı kullanılır (kartsız satırda zorunlu). */
  description: optionalText(300),
  quantity: positiveQuantity,
  unit: z.enum(ITEM_UNITS).nullable().optional(),
  /** Belge para biriminde birim fiyat; boşsa kartın satış fiyatı (fiyat listesi kancası, X3). */
  unitPrice: unitCostString.optional(),
  discountPct: percentString.default('0'),
  vatCode: z.string().trim().max(20).nullable().optional(),
});
export type SalesOrderLineInput = z.infer<typeof salesOrderLineSchema>;

const salesDocBase = z.object({
  partyId: uuid,
  docDate: isoDate,
  /** Teklifin geçerlilik tarihi. */
  validUntil: isoDate.nullable().optional(),
  /** Siparişte sözlenen teslim tarihi. */
  deliveryDate: isoDate.nullable().optional(),
  /** Boşsa carinin para birimi. */
  currency: currencyCode.optional(),
  vatIncluded: z.boolean().default(false),
  /** Teslimatın çıkacağı depo; boşsa varsayılan depo. */
  warehouseId: uuid.nullable().optional(),
  /** Çıktıda görünen koşullar/açıklama. */
  notes: optionalText(1000),
  lines: z.array(salesOrderLineSchema).min(1, 'En az bir satır gerekli').max(300),
});

export const createSalesDocSchema = salesDocBase.extend({ kind: z.enum(SALES_DOC_KINDS) });
export type CreateSalesDocInput = z.infer<typeof createSalesDocSchema>;
export const updateSalesDocSchema = salesDocBase;
export type UpdateSalesDocInput = z.infer<typeof updateSalesDocSchema>;

export const listSalesDocsQuerySchema = z.object({
  kind: z.enum(SALES_DOC_KINDS).optional(),
  status: z.enum(SALES_DOC_STATUSES).optional(),
  partyId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  query: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListSalesDocsQuery = z.infer<typeof listSalesDocsQuerySchema>;

export const salesDocActionSchema = z.object({
  /** İptal/ret/kapatma gerekçesi. */
  reason: z.string().trim().max(300).optional(),
});
export type SalesDocActionInput = z.infer<typeof salesDocActionSchema>;

/** Siparişten irsaliye taslağı: satır başına miktar verilmezse kalan teslim edilebilir miktar. */
export const orderToDeliverySchema = z.object({
  noteDate: isoDate.optional(),
  warehouseId: uuid.nullable().optional(),
  lines: z.array(z.object({ lineId: uuid, quantity: positiveQuantity })).max(300).optional(),
});
export type OrderToDeliveryInput = z.infer<typeof orderToDeliverySchema>;

/** Siparişten fatura taslağı: teslim edilip faturalanmamış irsaliye satırları + kalan hizmet satırları. */
export const orderToInvoiceSchema = z.object({
  invoiceDate: isoDate.optional(),
  /** true: hiç teslim edilmemiş mal satırları da faturaya (stok faturada hareket eder) alınır. */
  includeUndelivered: z.boolean().default(false),
});
export type OrderToInvoiceInput = z.infer<typeof orderToInvoiceSchema>;

// --- Toplu faturalama -----------------------------------------------------------

export const batchPreviewQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  partyId: uuid.optional(),
  grouping: z.enum(['party', 'note']).default('party'),
});
export type BatchPreviewQuery = z.infer<typeof batchPreviewQuerySchema>;

export const batchRunSchema = z.object({
  /** Faturalanacak (kaydedilmiş, kalan miktarı olan) satış irsaliyeleri; cari başına gruplanır. */
  noteIds: z.array(uuid).min(1, 'En az bir irsaliye seçin').max(500),
  invoiceDate: isoDate,
  /** `party`: cari başına tek fatura; `note`: irsaliye başına bir fatura. */
  grouping: z.enum(['party', 'note']).default('party'),
  /** true: faturalar hemen kaydedilir (yevmiye); false: taslak bırakılır (invoices.post gerekmez). */
  post: z.boolean().default(true),
});
export type BatchRunInput = z.infer<typeof batchRunSchema>;
export { BATCH_GROUPINGS };
