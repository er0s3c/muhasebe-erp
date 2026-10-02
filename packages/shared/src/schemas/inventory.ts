import { z } from 'zod';
import { dec } from '../money';
import { currencyCode, isoDate, rateString, uuid } from './common';

export const ITEM_KINDS = ['goods', 'service'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Ürün birimleri (kod olarak saklanır, etiket arayüzde çevrilir). Birim dönüşümü sonraki sürümde. */
export const ITEM_UNITS = [
  'adet',
  'kg',
  'g',
  'ton',
  'm',
  'm2',
  'm3',
  'lt',
  'paket',
  'koli',
  'cuval',
  'takim',
  'rulo',
  'saat',
  'gun',
] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

/** Birim kodu → Türkçe etiket (dışa aktarma ve içe aktarma eşlemesi; arayüz çevirisiyle aynı metinler). */
export const ITEM_UNIT_LABELS: Record<ItemUnit, string> = {
  adet: 'adet',
  kg: 'kg',
  g: 'g',
  ton: 'ton',
  m: 'm',
  m2: 'm²',
  m3: 'm³',
  lt: 'lt',
  paket: 'paket',
  koli: 'koli',
  cuval: 'çuval',
  takim: 'takım',
  rulo: 'rulo',
  saat: 'saat',
  gun: 'gün',
};

/** Kullanıcının girebileceği stok belge türleri; `count` yalnızca sayım işlenince oluşur. */
export const USER_STOCK_DOC_TYPES = ['opening', 'receipt', 'issue', 'waste', 'transfer'] as const;
export const STOCK_DOC_TYPES = [...USER_STOCK_DOC_TYPES, 'count'] as const;
export type StockDocType = (typeof STOCK_DOC_TYPES)[number];

/** Giriş yönlü (maliyet girilen) belge türleri. */
export const INBOUND_DOC_TYPES: readonly StockDocType[] = ['opening', 'receipt'];

/** Miktar: en çok 15 tam, 4 ondalık basamak; eksi değer yok, sıfır olabilir. */
export const quantityString = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz miktar');
export const positiveQuantity = quantityString.refine((v) => dec(v).gt(0), 'Miktar sıfırdan büyük olmalı');

/** Birim maliyet/fiyat: en çok 6 ondalık basamak. */
export const unitCostString = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/, 'Geçersiz birim maliyet');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const code = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9ÇĞİÖŞÜçğıöşü._/-]+$/, 'Kod yalnızca harf, rakam ve . _ / - içerebilir');

// --- Kategori ---------------------------------------------------------------

export const createItemCategorySchema = z.object({ name: z.string().trim().min(2).max(80) });
export type CreateItemCategoryInput = z.infer<typeof createItemCategorySchema>;

export const updateItemCategorySchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateItemCategoryInput = z.infer<typeof updateItemCategorySchema>;

// --- Depo -------------------------------------------------------------------

export const createWarehouseSchema = z.object({
  /** Boşsa D-001 biçiminde otomatik verilir. */
  code: code(12).optional(),
  name: z.string().trim().min(2).max(80),
  isDefault: z.boolean().default(false),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
  /** Yalnızca true gönderilebilir; varsayılan depo başka bir depoyu varsayılan yaparak değişir. */
  isDefault: z.literal(true).optional(),
});
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

// --- Stok kartı -------------------------------------------------------------

export const createItemSchema = z.object({
  /** Boşsa ST-000001 biçiminde otomatik verilir. */
  code: code(30).optional(),
  name: z.string().trim().min(2).max(160),
  kind: z.enum(ITEM_KINDS).default('goods'),
  unit: z.enum(ITEM_UNITS).default('adet'),
  categoryId: uuid.nullable().optional(),
  barcode: optionalText(40),
  /** Şirketin KDV oranı kodu (Ayarlar > KDV oranları). */
  vatCode: optionalText(20),
  purchasePrice: unitCostString.optional(),
  purchaseCurrency: currencyCode.default('TRY'),
  salePrice: unitCostString.optional(),
  saleCurrency: currencyCode.default('TRY'),
  /** Kritik stok seviyesi: eldeki miktar bu değere eşit veya altına düşünce uyarılır. */
  minLevel: quantityString.optional(),
  notes: optionalText(1000),
  /** Seri no takibi (X3): giriş/çıkışta miktar kadar seri no girilir; yalnızca mal kartında. */
  tracksSerial: z.boolean().optional(),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  unit: z.enum(ITEM_UNITS).optional(),
  categoryId: uuid.nullable().optional(),
  barcode: clearableText(40),
  vatCode: clearableText(20),
  purchasePrice: unitCostString.nullable().optional(),
  purchaseCurrency: currencyCode.optional(),
  salePrice: unitCostString.nullable().optional(),
  saleCurrency: currencyCode.optional(),
  minLevel: quantityString.nullable().optional(),
  notes: clearableText(1000),
  isActive: z.boolean().optional(),
  tracksSerial: z.boolean().optional(),
});
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const listItemsQuerySchema = z.object({
  query: z.string().trim().max(100).optional(),
  categoryId: uuid.optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  active: z.enum(['true', 'false']).optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  barcode: z.string().trim().max(40).optional(),
  warehouseId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

export const itemMovementsQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  warehouseId: uuid.optional(),
});
export type ItemMovementsQuery = z.infer<typeof itemMovementsQuerySchema>;

// --- Stok belgesi -----------------------------------------------------------

export const stockLineSchema = z.object({
  itemId: uuid,
  quantity: positiveQuantity,
  /** Yalnızca giriş/devir satırlarında: `currency` cinsinden birim maliyet (0 olabilir). */
  unitCost: unitCostString.optional(),
  currency: currencyCode.optional(),
  /** Verilmezse hareket tarihindeki kayıtlı kur kullanılır. */
  fxRate: rateString.optional(),
  note: optionalText(200),
  /** Proje boyutu (inşaat): yalnızca sarf (`issue`) ve fire (`waste`) satırlarında; tüketim/fire maliyeti projeye yazılır. */
  projectId: uuid.optional(),
  /** Projenin yaprak iş kalemi; projesiz verilemez. */
  wbsId: uuid.optional(),
  /** Seri takipli kartta: miktar kadar seri no (giriş, çıkış, fire, transfer). */
  serials: z.array(z.string().trim().min(1).max(60)).max(1000).optional(),
});
export type StockLineInput = z.infer<typeof stockLineSchema>;

export const createStockDocumentSchema = z
  .object({
    type: z.enum(USER_STOCK_DOC_TYPES),
    docDate: isoDate,
    warehouseId: uuid,
    /** Yalnızca transferde: hedef depo. */
    toWarehouseId: uuid.optional(),
    description: optionalText(200),
    lines: z.array(stockLineSchema).min(1).max(200),
  })
  .superRefine((doc, ctx) => {
    const inbound = INBOUND_DOC_TYPES.includes(doc.type);
    if (doc.type === 'transfer') {
      if (!doc.toWarehouseId) {
        ctx.addIssue({ code: 'custom', path: ['toWarehouseId'], message: 'Transferde hedef depo seçilmeli' });
      } else if (doc.toWarehouseId === doc.warehouseId) {
        ctx.addIssue({ code: 'custom', path: ['toWarehouseId'], message: 'Kaynak ve hedef depo aynı olamaz' });
      }
    } else if (doc.toWarehouseId) {
      ctx.addIssue({ code: 'custom', path: ['toWarehouseId'], message: 'Hedef depo yalnızca transferde kullanılır' });
    }
    doc.lines.forEach((line, i) => {
      if (line.wbsId && !line.projectId) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'wbsId'], message: 'İş kalemi için proje seçilmeli' });
      }
      if (line.projectId && doc.type !== 'issue' && doc.type !== 'waste') {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'projectId'], message: 'Proje yalnızca malzeme sarfı ve fire satırlarında kullanılır' });
      }
      if (inbound && line.unitCost === undefined) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'unitCost'], message: 'Birim maliyet girilmeli' });
      }
      if (!inbound && (line.unitCost !== undefined || line.currency !== undefined || line.fxRate !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'unitCost'],
          message: 'Çıkış, fire ve transferde maliyet girilmez; ortalama maliyet kullanılır',
        });
      }
    });
  });
export type CreateStockDocumentInput = z.infer<typeof createStockDocumentSchema>;

export const reverseStockDocumentSchema = z.object({
  docDate: isoDate.optional(),
  description: optionalText(200),
});
export type ReverseStockDocumentInput = z.infer<typeof reverseStockDocumentSchema>;

export const listStockDocumentsQuerySchema = z.object({
  type: z.enum(STOCK_DOC_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  itemId: uuid.optional(),
  warehouseId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListStockDocumentsQuery = z.infer<typeof listStockDocumentsQuerySchema>;

// --- Sayım ------------------------------------------------------------------

export const createStockCountSchema = z.object({
  warehouseId: uuid,
  countDate: isoDate,
  description: optionalText(200),
  /** 'in_stock': depoda bakiyesi olan kartlarla doldur; 'empty': boş başla. */
  prefill: z.enum(['in_stock', 'empty']).default('in_stock'),
});
export type CreateStockCountInput = z.infer<typeof createStockCountSchema>;

export const updateStockCountSchema = z.object({
  countDate: isoDate.optional(),
  description: clearableText(200),
  /** Verilirse taslağın satırlarının tamamı bu liste ile değişir; `countedQty` null = henüz sayılmadı. */
  lines: z
    .array(z.object({ itemId: uuid, countedQty: quantityString.nullable() }))
    .max(2000)
    .optional(),
});
export type UpdateStockCountInput = z.infer<typeof updateStockCountSchema>;

export const listStockCountsQuerySchema = z.object({
  status: z.enum(['draft', 'posted']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Raporlar ---------------------------------------------------------------

export const stockStatusQuerySchema = z.object({
  asOf: isoDate,
  warehouseId: uuid.optional(),
  categoryId: uuid.optional(),
  query: z.string().trim().max(100).optional(),
  lowOnly: z.enum(['true', 'false']).optional(),
  includeZero: z.enum(['true', 'false']).optional(),
});
export type StockStatusQuery = z.infer<typeof stockStatusQuerySchema>;

export const idParam = z.object({ id: uuid });
