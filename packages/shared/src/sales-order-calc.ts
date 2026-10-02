import { dec, type MoneyValue } from './money';

/**
 * Satış teklifi/siparişi saf kuralları (X2): durum geçiş tablosu, karşılanma (teslim/fatura) türetimi ve
 * toplu faturalama gruplaması. Veritabanı tetikleyicisi (sales_orders_guard) geçiş tablosunu birebir aynı biçimde uygular.
 */

export const SALES_DOC_KINDS = ['quote', 'order'] as const;
export type SalesDocKind = (typeof SALES_DOC_KINDS)[number];

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'converted', 'cancelled'] as const;
export const ORDER_STATUSES = ['draft', 'confirmed', 'closed', 'cancelled'] as const;
export const SALES_DOC_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'converted', 'confirmed', 'closed', 'cancelled'] as const;
export type SalesDocStatus = (typeof SALES_DOC_STATUSES)[number];

/** Geçerli durum geçişleri (tür → durum → izinli sonraki durumlar). Yapılandırılamaz. */
export const SALES_TRANSITIONS: Record<SalesDocKind, Partial<Record<SalesDocStatus, readonly SalesDocStatus[]>>> = {
  quote: {
    draft: ['sent', 'cancelled'],
    sent: ['accepted', 'rejected', 'cancelled', 'draft'],
    accepted: ['converted', 'cancelled'],
  },
  order: {
    draft: ['confirmed', 'cancelled'],
    confirmed: ['closed', 'cancelled'],
  },
};

export const canTransition = (kind: SalesDocKind, from: SalesDocStatus, to: SalesDocStatus): boolean =>
  SALES_TRANSITIONS[kind][from]?.includes(to) ?? false;

/** Numara öneki (TKL-2026-000001 / SSP-2026-000001). */
export const SALES_DOC_PREFIX: Record<SalesDocKind, string> = { quote: 'TKL', order: 'SSP' };

export type FulfilmentState = 'none' | 'partial' | 'full';

export interface FulfilmentLine {
  quantity: string | MoneyValue;
  /** Stoklu (mal) satır mı? Hizmet/serbest satır teslim edilmez. */
  isGoods: boolean;
  /** Teslim edilen miktar: kaydedilmiş satış irsaliyeleri + stoğu faturada hareket eden (doğrudan faturalanan) miktar. */
  delivered: string | MoneyValue;
  /** Kaydedilmiş satış faturalarından faturalanan miktar (irsaliyeli + doğrudan). */
  invoiced: string | MoneyValue;
}

export interface Fulfilment {
  /** Yalnızca mal satırları üzerinden; mal satırı yoksa null. */
  delivery: FulfilmentState | null;
  invoicing: FulfilmentState;
}

const stateOf = (done: MoneyValue, anyLine: boolean, allFull: boolean): FulfilmentState =>
  !anyLine || done.isZero() ? 'none' : allFull ? 'full' : 'partial';

/** Sipariş karşılanma durumu: satır bazında tamamlanma (miktar karşılaştırması), toplam miktar değil. */
export function orderFulfilment(lines: readonly FulfilmentLine[]): Fulfilment {
  const goods = lines.filter((l) => l.isGoods);
  const delivered = goods.reduce((s, l) => s.plus(l.delivered), dec(0));
  const invoiced = lines.reduce((s, l) => s.plus(l.invoiced), dec(0));
  return {
    delivery: goods.length === 0 ? null : stateOf(delivered, true, goods.every((l) => dec(l.delivered).gte(l.quantity))),
    invoicing: stateOf(invoiced, lines.length > 0, lines.length > 0 && lines.every((l) => dec(l.invoiced).gte(l.quantity))),
  };
}

export interface ConsumptionInput {
  quantity: string | MoneyValue;
  isGoods: boolean;
  delivered: string | MoneyValue;
  /** Faturalanan miktar. */
  invoiced: string | MoneyValue;
  /** Faturalananın irsaliyesiz (stoğu faturada hareket eden) kısmı. */
  directInvoiced: string | MoneyValue;
}

/** Hâlâ teslim edilebilecek miktar: sipariş − teslim − doğrudan faturalanan (hizmet satırında 0). */
export function remainingDeliverable(l: ConsumptionInput): MoneyValue {
  if (!l.isGoods) return dec(0);
  const r = dec(l.quantity).minus(l.delivered).minus(l.directInvoiced);
  return r.isNegative() ? dec(0) : r;
}

/** Hâlâ faturalanabilecek miktar: sipariş − faturalanan. */
export function remainingInvoiceable(l: ConsumptionInput): MoneyValue {
  const r = dec(l.quantity).minus(l.invoiced);
  return r.isNegative() ? dec(0) : r;
}

/** Teslim (irsaliyeli) ama faturalanmamış miktar: teslim − (faturalananın irsaliyeli kısmı). */
export function deliveredNotInvoiced(l: Pick<ConsumptionInput, 'delivered' | 'invoiced' | 'directInvoiced'>): MoneyValue {
  const r = dec(l.delivered).minus(dec(l.invoiced).minus(l.directInvoiced));
  return r.isNegative() ? dec(0) : r;
}

// --- Toplu faturalama gruplaması ------------------------------------------------

export type BatchGrouping = 'party' | 'note';
export const BATCH_GROUPINGS: readonly BatchGrouping[] = ['party', 'note'];

export interface BatchCandidate {
  partyId: string;
  noteId: string;
  noteDate: string;
  noteNo: string | null;
  lineId: string;
  /** Aynı faturada birleşemeyen özellikler (para birimi, KDV dahil/hariç): farklı olanlar ayrı faturalara bölünür. */
  variant?: string;
}

export interface BatchGroup<T extends BatchCandidate> {
  /** Fatura anahtarı: cari ya da cari+irsaliye. */
  key: string;
  partyId: string;
  noteIds: string[];
  lines: T[];
}

/**
 * Seçili irsaliye satırlarını faturalara böler: `party` = cari başına tek fatura (tüm irsaliyeler tek faturada),
 * `note` = irsaliye başına bir fatura. Sıra: cari sırası ilk görülme, irsaliye tarihi, irsaliye no, satır sırası (girdi sırası korunur).
 * Para birimi/KDV biçimi farklı satırlar (`variant`) ayrı faturalara bölünür.
 * Fatura satırı irsaliye satırıyla bire bir bağlı olduğundan satırlar birleştirilmez.
 */
export function groupBatchLines<T extends BatchCandidate>(rows: readonly T[], grouping: BatchGrouping): BatchGroup<T>[] {
  const sorted = [...rows].sort((a, b) =>
    a.noteDate === b.noteDate ? (a.noteNo ?? '').localeCompare(b.noteNo ?? '') : a.noteDate < b.noteDate ? -1 : 1,
  );
  const out = new Map<string, BatchGroup<T>>();
  for (const r of sorted) {
    const base = grouping === 'party' ? r.partyId : `${r.partyId}|${r.noteId}`;
    const key = r.variant ? `${base}|${r.variant}` : base;
    const g = out.get(key) ?? { key, partyId: r.partyId, noteIds: [], lines: [] };
    if (!g.noteIds.includes(r.noteId)) g.noteIds.push(r.noteId);
    g.lines.push(r);
    out.set(key, g);
  }
  // Cari başına kümelenmiş çıktı (aynı cari ardışık)
  const parties: string[] = [];
  for (const g of out.values()) if (!parties.includes(g.partyId)) parties.push(g.partyId);
  return [...out.values()].sort((a, b) => parties.indexOf(a.partyId) - parties.indexOf(b.partyId));
}
