import { z } from 'zod';
import { currencyCode, isoDate, uuid } from './common';

// --- Satın alma talebi ---------------------------------------------------------------------------

export const PURCHASE_REQUEST_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'ordered', 'cancelled'] as const;
export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];

const qty = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz miktar').refine((v) => Number(v) > 0, 'Miktar sıfırdan büyük olmalı');
const price = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz fiyat');

export const requestLineSchema = z.object({
  /** Stok kartı (mal); boşsa serbest satır (hizmet, stoksuz malzeme). */
  itemId: uuid.nullable().optional(),
  description: z.string().trim().min(1).max(300),
  unit: z.string().trim().min(1).max(20),
  quantity: qty,
  /** Tahmini birim fiyat (defter para biriminde); onay tutarını belirler. */
  estUnitPrice: price.nullable().optional(),
  /** Maliyetin yazılacağı yaprak iş kalemi (proje içinde). */
  wbsId: uuid.nullable().optional(),
});
export type RequestLineInput = z.infer<typeof requestLineSchema>;

const requestBody = {
  title: z.string().trim().min(2).max(200),
  needDate: isoDate.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(requestLineSchema).min(1, 'En az bir satır gerekli').max(300),
};
export const createPurchaseRequestSchema = z.object({ projectId: uuid, ...requestBody });
export type CreatePurchaseRequestInput = z.infer<typeof createPurchaseRequestSchema>;
export const updatePurchaseRequestSchema = z.object(requestBody);
export type UpdatePurchaseRequestInput = z.infer<typeof updatePurchaseRequestSchema>;

export const purchaseRequestListQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(PURCHASE_REQUEST_STATUSES).optional(),
});

// --- RFQ ve teklifler ---------------------------------------------------------------------------------

export const createRfqSchema = z.object({
  requestId: uuid,
  dueDate: isoDate.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type CreateRfqInput = z.infer<typeof createRfqSchema>;

export const upsertOfferSchema = z.object({
  partyId: uuid,
  currencyCode,
  deliveryDays: z.number().int().min(0).max(730).nullable().optional(),
  /** 0 = peşin. */
  paymentDays: z.number().int().min(0).max(365).default(0),
  note: z.string().trim().max(500).nullable().optional(),
  /** Teklif edilen satırlar; talep satırı başına birim fiyat (eksik satır = teklif verilmedi). */
  lines: z
    .array(z.object({ requestLineId: uuid, unitPrice: price }))
    .min(1, 'En az bir satır fiyatlanmalı')
    .refine((l) => new Set(l.map((x) => x.requestLineId)).size === l.length, 'Aynı satır birden çok kez fiyatlanamaz'),
});
export type UpsertOfferInput = z.infer<typeof upsertOfferSchema>;

export const awardRfqSchema = z.object({ offerId: uuid });

// --- Sipariş --------------------------------------------------------------------------------------------

export const PURCHASE_ORDER_STATUSES = ['draft', 'issued', 'closed', 'cancelled'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const orderLineSchema = z.object({
  requestLineId: uuid.nullable().optional(),
  itemId: uuid.nullable().optional(),
  description: z.string().trim().min(1).max(300),
  unit: z.string().trim().min(1).max(20),
  quantity: qty,
  unitPrice: price,
  wbsId: uuid.nullable().optional(),
});
export type OrderLineInput = z.infer<typeof orderLineSchema>;

const orderBody = {
  partyId: uuid,
  currencyCode,
  /** KDV kodu (tax_rates); boşsa KDV yok. */
  vatCode: z.string().trim().max(20).nullable().optional(),
  paymentDays: z.number().int().min(0).max(365).default(30),
  deliveryLocation: z.string().trim().max(300).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(orderLineSchema).min(1, 'En az bir satır gerekli').max(300),
};
export const createPurchaseOrderSchema = z.object({
  projectId: uuid,
  /** Onaylı talepten oluşturulurken. */
  requestId: uuid.nullable().optional(),
  ...orderBody,
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export const updatePurchaseOrderSchema = z.object(orderBody);
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

export const purchaseOrderListQuerySchema = z.object({
  projectId: uuid.optional(),
  partyId: uuid.optional(),
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
});

export const cancelOrderSchema = z.object({ reason: z.string().trim().min(3, 'İptal nedeni gerekli').max(300) });

// --- Mal kabul -------------------------------------------------------------------------------------------

export const createReceiptSchema = z.object({
  receiptDate: isoDate,
  /** Tedarikçinin irsaliye numarası: stoklu satır varsa zorunlu (alış irsaliyesi oluşur). */
  externalNo: z.string().trim().max(40).nullable().optional(),
  /** Stoklu satırların gireceği depo; boşsa varsayılan depo. */
  warehouseId: uuid.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z
    .array(z.object({ orderLineId: uuid, quantity: qty }))
    .min(1, 'En az bir satır gerekli')
    .refine((l) => new Set(l.map((x) => x.orderLineId)).size === l.length, 'Aynı satır birden çok kez girilemez'),
});
export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;

export const cancelReceiptSchema = z.object({
  reason: z.string().trim().min(3, 'İptal nedeni gerekli').max(300),
  date: isoDate.optional(),
});
