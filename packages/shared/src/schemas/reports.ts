import { z } from 'zod';
import { isoDate } from './common';

// --- Dışa aktarma ------------------------------------------------------------

export const EXPORT_FORMATS = ['xlsx', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Sayfalı rapor uçları (ekranda) ve dışa aktarma (sayfasız) aynı süzgeç alanlarını paylaşır. */
const page = (max: number, dflt: number) => ({
  limit: z.coerce.number().int().min(1).max(max).default(dflt),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Defterler ---------------------------------------------------------------

/** Yevmiye defteri: kaydedilmiş fişlerin satırları, tarih + fiş no + satır no sırasıyla. */
export const journalBookQuerySchema = z.object({ from: isoDate, to: isoDate, ...page(1000, 500) });
export type JournalBookQuery = z.infer<typeof journalBookQuerySchema>;

/** Kebir (büyük defter): hareketi olan hesaplar; hesap sayfalıdır. `codePrefix` ile hesap grubu seçilir. */
export const generalLedgerQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  codePrefix: z
    .string()
    .trim()
    .max(20)
    .regex(/^[0-9A-Za-z.]*$/, 'Geçersiz hesap kodu öneki')
    .optional(),
  ...page(200, 20),
});
export type GeneralLedgerQuery = z.infer<typeof generalLedgerQuerySchema>;

// --- Satış / alış / kârlılık ---------------------------------------------------

export const SALES_REPORT_GROUPS = ['party', 'item', 'month', 'invoice'] as const;
export type SalesReportGroup = (typeof SALES_REPORT_GROUPS)[number];

/** Satış veya alış raporu (kaydedilmiş faturalar; iadeler düşülür, iptal ve taslak hariç). */
export const salesReportQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  groupBy: z.enum(SALES_REPORT_GROUPS).default('party'),
});
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;

/** Stok kartı bazında satış, maliyet, kâr ve marj. */
export const itemProfitQuerySchema = z.object({ from: isoDate, to: isoDate });
export type ItemProfitQuery = z.infer<typeof itemProfitQuerySchema>;

/** Gerçekleşen kambiyo (kur farkı) kârı/zararı. */
export const fxDifferencesQuerySchema = z.object({ from: isoDate, to: isoDate });
export type FxDifferencesQuery = z.infer<typeof fxDifferencesQuerySchema>;

/** Tam veri dışa aktarma: tarih süzgeci yalnızca yevmiye, fatura, irsaliye ve hareket sayfalarını daraltır. */
export const fullDataQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
export type FullDataQuery = z.infer<typeof fullDataQuerySchema>;
