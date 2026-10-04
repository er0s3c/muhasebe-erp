import { asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  SALES_DOC_PREFIX,
  calcInvoice,
  canTransition,
  dec,
  isoYear,
  orderFulfilment,
  partyKindFits,
  remainingDeliverable,
  remainingInvoiceable,
  deliveredNotInvoiced,
  todayIso,
  toDbAmount,
  type CreateSalesDocInput,
  type ListSalesDocsQuery,
  type MoneyValue,
  type PartyKind,
  type SalesDocKind,
  type SalesDocStatus,
  type UpdateSalesDocInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { trContains } from '../../db/search';
import { items, parties, salesOrderEvents, salesOrderLines, salesOrders } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { requireActiveWarehouse } from '../inventory/warehouses';
import { resolveVat } from '../invoices/service';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { resolvePrice } from './pricing';
import { orderLineUsage, zeroUsage } from './usage';

export interface SalesCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
}

const KIND_LABEL: Record<SalesDocKind, string> = { quote: 'Teklif', order: 'Sipariş' };

async function loadCustomer(tx: Tx, partyId: string) {
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
  if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
  if (!partyKindFits(party.kind as PartyKind, 'receivable')) {
    throw unprocessable(`${party.name} carisi müşteri değil; teklif/sipariş müşteri carisine düzenlenir`, 'PARTY_KIND_MISMATCH');
  }
  return party;
}

type DraftInput = Omit<CreateSalesDocInput, 'kind'> | UpdateSalesDocInput;

/** Satırları doğrular, fiyat/KDV kancalarını uygular ve tutarlarını hesaplar (belge para biriminde). */
async function prepareLines(tx: Tx, input: DraftInput, currency: string) {
  const itemIds = [...new Set(input.lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  const itemRows = itemIds.length ? await tx.select().from(items).where(inArray(items.id, itemIds)) : [];
  const byId = new Map(itemRows.map((r) => [r.id, r]));
  const vatCodes = input.lines.flatMap((l) => {
    const item = l.itemId ? byId.get(l.itemId) : undefined;
    const code = l.vatCode ?? item?.vatCode ?? null;
    return code ? [code] : [];
  });
  const rates = await resolveVat(tx, vatCodes, input.docDate);

  const prepared = [];
  for (const [i, l] of input.lines.entries()) {
    const label = `Satır ${i + 1}`;
    const item = l.itemId ? byId.get(l.itemId) : undefined;
    if (l.itemId && !item) throw unprocessable(`${label}: stok kartı bulunamadı`, 'ITEM_NOT_FOUND');
    if (item && !item.isActive) throw unprocessable(`${label}: ${item.code} ${item.name} kartı pasif`, 'ITEM_INACTIVE');
    const description = l.description ?? item?.name;
    if (!description) throw unprocessable(`${label}: açıklama ya da stok kartı gerekli`, 'DESCRIPTION_REQUIRED');
    let unitPrice = l.unitPrice;
    let discountPct = l.discountPct;
    if (unitPrice === undefined || discountPct === undefined) {
      const res = item
        ? await resolvePrice(tx, {
            kind: 'sales',
            item: { id: item.id, salePrice: item.salePrice, saleCurrency: item.saleCurrency, purchasePrice: item.purchasePrice, purchaseCurrency: item.purchaseCurrency },
            partyId: input.partyId,
            date: input.docDate,
            currency,
            quantity: l.quantity,
          })
        : null;
      if (unitPrice === undefined) {
        if (!res || res.unitPrice === null) {
          throw unprocessable(
            `${label}: birim fiyat girilmeli (${item ? `${item.code} için ${currency} cinsinden fiyat bulunamadı` : 'kartsız satır'})`,
            'SO_PRICE_REQUIRED',
          );
        }
        unitPrice = res.unitPrice;
      }
      // İskonto girilmemişse çözümlenen iskonto (cari kalem/genel iskonto) uygulanır
      discountPct ??= res?.discountPct;
    }
    const vatCode = l.vatCode ?? item?.vatCode ?? null;
    if (vatCode && !rates.has(vatCode)) throw unprocessable(`${label}: ${vatCode} KDV kodu ${input.docDate} tarihinde geçerli değil`, 'VAT_CODE_INVALID');
    prepared.push({
      lineNo: i + 1,
      itemId: item?.id ?? null,
      description: description.slice(0, 300),
      quantity: dec(l.quantity).toFixed(4),
      unit: l.unit ?? item?.unit ?? null,
      unitPrice: dec(unitPrice).toFixed(6),
      discountPct: dec(discountPct ?? '0').toFixed(4),
      vatCode,
      vatRate: vatCode ? rates.get(vatCode)! : '0.0000',
    });
  }
  const totals = calcInvoice(
    prepared.map((p) => ({ quantity: p.quantity, unitPrice: p.unitPrice, discountPct: p.discountPct, vatRate: p.vatRate })),
    input.vatIncluded,
  );
  return { lines: prepared.map((p, i) => ({ ...p, ...totals.lines[i]! })), totals };
}

async function writeDoc(tx: Tx, ctx: SalesCtx, kind: SalesDocKind, input: DraftInput, id?: string, extra: { quoteId?: string; quoteLineIds?: (string | null)[] } = {}) {
  const party = await loadCustomer(tx, input.partyId);
  const currency = input.currency ?? party.currencyCode;
  if (kind === 'quote' && input.validUntil && input.validUntil < input.docDate) {
    throw unprocessable('Geçerlilik tarihi teklif tarihinden önce olamaz', 'VALID_UNTIL_BEFORE_DATE');
  }
  if (input.warehouseId) await requireActiveWarehouse(tx, input.warehouseId, 'Depo');
  const { lines, totals } = await prepareLines(tx, input, currency);

  const header = {
    partyId: party.id,
    docDate: input.docDate,
    validUntil: kind === 'quote' ? (input.validUntil ?? null) : null,
    deliveryDate: kind === 'order' ? (input.deliveryDate ?? null) : null,
    currencyCode: currency,
    vatIncluded: input.vatIncluded,
    warehouseId: input.warehouseId ?? null,
    notes: input.notes ?? null,
    netTotal: toDbAmount(totals.net),
    vatTotal: toDbAmount(totals.vat),
    grossTotal: toDbAmount(totals.gross),
    updatedAt: new Date(),
  };
  let docId = id;
  if (docId) {
    await tx.update(salesOrders).set(header).where(eq(salesOrders.id, docId));
    await tx.delete(salesOrderLines).where(eq(salesOrderLines.orderId, docId));
  } else {
    const [row] = await tx
      .insert(salesOrders)
      .values({ ...header, companyId: ctx.companyId, kind, quoteId: extra.quoteId ?? null, createdBy: ctx.userId })
      .returning({ id: salesOrders.id });
    docId = row!.id;
  }
  await tx.insert(salesOrderLines).values(
    lines.map((l, i) => ({
      companyId: ctx.companyId,
      orderId: docId!,
      lineNo: l.lineNo,
      itemId: l.itemId,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      vatCode: l.vatCode,
      vatRate: l.vatRate,
      net: toDbAmount(l.net),
      vat: toDbAmount(l.vat),
      gross: toDbAmount(l.gross),
      quoteLineId: extra.quoteLineIds?.[i] ?? null,
    })),
  );
  return docId;
}

export const createSalesDoc = (tx: Tx, ctx: SalesCtx, input: CreateSalesDocInput) => writeDoc(tx, ctx, input.kind, input);

export async function lockDoc(tx: Tx, id: string) {
  const [row] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for('update');
  if (!row) throw notFound('Teklif/sipariş');
  return row;
}

export async function updateSalesDoc(tx: Tx, ctx: SalesCtx, id: string, input: UpdateSalesDocInput) {
  const row = await lockDoc(tx, id);
  if (row.status !== 'draft') throw unprocessable('Yalnızca taslak düzenlenebilir', 'SO_NOT_DRAFT');
  await writeDoc(tx, ctx, row.kind as SalesDocKind, input, id);
  return id;
}

export async function deleteSalesDoc(tx: Tx, id: string) {
  const row = await lockDoc(tx, id);
  if (row.status !== 'draft' || row.docNo) throw unprocessable('Yalnızca numarasız taslak silinebilir; diğerleri iptal edilir', 'SO_NOT_DRAFT');
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(salesOrders).where(eq(salesOrders.id, id)).returning({ id: salesOrders.id });
  if (deleted.length === 0) throw notFound('Satış belgesi');
}

/**
 * Durum geçişi: geçiş tablosu doğrulanır, olay (geçmiş) kaydı yazılır, başlık güncellenir. Taslaktan çıkışta numara verilir
 * (bir kez; geri alınıp yeniden gönderilen teklif numarasını korur). Veritabanı tetikleyicisi aynı kuralları ayrıca uygular.
 */
export async function transitionSalesDoc(tx: Tx, ctx: SalesCtx, id: string, to: SalesDocStatus, reason?: string) {
  const doc = await lockDoc(tx, id);
  const kind = doc.kind as SalesDocKind;
  if (!canTransition(kind, doc.status as SalesDocStatus, to)) {
    throw unprocessable(`${KIND_LABEL[kind]} "${doc.status}" durumundan "${to}" durumuna geçirilemez`, 'SO_INVALID_TRANSITION');
  }
  if (to === 'cancelled' && !reason) throw unprocessable('İptal gerekçesi gerekli', 'SO_REASON_REQUIRED');
  if (kind === 'quote' && to === 'accepted' && doc.validUntil && doc.validUntil < todayIso()) {
    throw unprocessable('Geçerlilik tarihi geçmiş teklif kabul edilemez; yeni teklif hazırlayın', 'QUOTE_EXPIRED');
  }
  if (to === 'cancelled' && kind === 'order' && doc.status === 'confirmed') {
    const lineIds = (await tx.select({ id: salesOrderLines.id }).from(salesOrderLines).where(eq(salesOrderLines.orderId, id))).map((l) => l.id);
    const usage = await orderLineUsage(tx, lineIds);
    if ([...usage.values()].some((u) => u.delivered.gt(0) || u.invoiced.gt(0))) {
      throw unprocessable('Teslim edilmiş ya da faturalanmış sipariş iptal edilemez; kapatın', 'SO_HAS_FULFILMENT');
    }
  }
  let docNo = doc.docNo;
  if (doc.status === 'draft' && to !== 'cancelled' && !docNo) {
    const year = isoYear(doc.docDate);
    docNo = formatDocumentNumber(SALES_DOC_PREFIX[kind], year, await nextNumber(tx, ctx.companyId, `SALES:${kind}`, year));
  }
  await tx.insert(salesOrderEvents).values({
    companyId: ctx.companyId,
    orderId: id,
    fromStatus: doc.status,
    toStatus: to,
    reason: reason ?? null,
    createdBy: ctx.userId,
  });
  await tx.update(salesOrders).set({ status: to, docNo, updatedAt: new Date() }).where(eq(salesOrders.id, id));
}

/** Kabul edilmiş teklifi siparişe dönüştürür: yeni taslak sipariş (satırlar kopyalanır, kaynak teklif satırına bağlanır); teklif "dönüştürüldü" olur. */
export async function convertQuote(tx: Tx, ctx: SalesCtx, quoteId: string) {
  const quote = await lockDoc(tx, quoteId);
  if (quote.kind !== 'quote') throw unprocessable('Yalnızca teklif siparişe dönüştürülür', 'SO_NOT_QUOTE');
  if (quote.status !== 'accepted') throw unprocessable('Yalnızca kabul edilmiş teklif siparişe dönüştürülür', 'SO_QUOTE_NOT_ACCEPTED');
  const qLines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, quoteId)).orderBy(asc(salesOrderLines.lineNo));
  const orderId = await writeDoc(
    tx,
    ctx,
    'order',
    {
      partyId: quote.partyId,
      docDate: todayIso(),
      currency: quote.currencyCode as 'TRY' | 'GBP' | 'EUR' | 'USD',
      vatIncluded: quote.vatIncluded,
      warehouseId: quote.warehouseId,
      notes: quote.notes ?? undefined,
      lines: qLines.map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit as never,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        vatCode: l.vatCode,
      })),
    },
    undefined,
    { quoteId, quoteLineIds: qLines.map((l) => l.id) },
  );
  await transitionSalesDoc(tx, ctx, quoteId, 'converted');
  return orderId;
}

// --- Okuma -------------------------------------------------------------------

interface LineOut extends Record<string, unknown> {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemCode: string | null;
  isGoods: boolean;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  discountPct: string;
  vatCode: string | null;
  vatRate: string;
  net: string;
  vat: string;
  gross: string;
}

const LINE_SELECT = sql`
  select l.id, l.order_id as "orderId", l.line_no as "lineNo", l.item_id as "itemId", it.code as "itemCode",
         coalesce(it.kind = 'goods', false) as "isGoods", l.description, l.quantity, l.unit,
         l.unit_price as "unitPrice", l.discount_pct as "discountPct", l.vat_code as "vatCode", l.vat_rate as "vatRate",
         l.net, l.vat, l.gross
  from sales_order_lines l left join items it on it.id = l.item_id`;

/** Teslim sayılan miktar: irsaliyeli teslim + stoğu faturada hareket eden doğrudan faturalama. */
const effectiveDelivered = (u: ReturnType<typeof zeroUsage> | undefined) => (u ? u.delivered.plus(u.direct) : dec(0));

function lineConsumption(l: LineOut, u = zeroUsage()) {
  const c = { quantity: l.quantity, isGoods: l.isGoods, delivered: u.delivered, invoiced: u.invoiced, directInvoiced: u.direct };
  return {
    delivered: u.delivered.toFixed(4),
    invoiced: u.invoiced.toFixed(4),
    remainingDeliverable: remainingDeliverable(c).toFixed(4),
    remainingInvoiceable: remainingInvoiceable(c).toFixed(4),
    deliveredNotInvoiced: l.isGoods ? deliveredNotInvoiced(c).toFixed(4) : '0.0000',
  };
}

export async function getSalesDoc(tx: Tx, id: string) {
  const head = await tx.execute<Record<string, unknown>>(sql`
    select o.id, o.kind, o.status, o.doc_no as "docNo", o.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
           o.doc_date::text as "docDate", o.valid_until::text as "validUntil", o.delivery_date::text as "deliveryDate",
           o.currency_code as "currencyCode", o.vat_included as "vatIncluded", o.warehouse_id as "warehouseId", w.name as "warehouseName",
           o.notes, o.quote_id as "quoteId", q.doc_no as "quoteNo",
           o.net_total as "netTotal", o.vat_total as "vatTotal", o.gross_total as "grossTotal", o.created_at as "createdAt",
           (select so.id from sales_orders so where so.quote_id = o.id limit 1) as "orderId",
           (select so.doc_no from sales_orders so where so.quote_id = o.id limit 1) as "orderNo"
    from sales_orders o
    join parties p on p.id = o.party_id
    left join warehouses w on w.id = o.warehouse_id
    left join sales_orders q on q.id = o.quote_id
    where o.id = ${id}`);
  const doc = head.rows[0];
  if (!doc) throw notFound('Teklif/sipariş');
  const lines = (await tx.execute<LineOut>(sql`${LINE_SELECT} where l.order_id = ${id} order by l.line_no`)).rows;
  const isOrder = doc.kind === 'order';
  const usage = isOrder ? await orderLineUsage(tx, lines.map((l) => l.id)) : new Map();

  const events = await tx.execute<Record<string, unknown>>(sql`
    select e.from_status as "fromStatus", e.to_status as "toStatus", e.reason, e.created_at as "createdAt", u.full_name as "userName"
    from sales_order_events e left join users u on u.id = e.created_by
    where e.order_id = ${id} order by e.created_at, e.id`);

  let notes: Record<string, unknown>[] = [];
  let invoices: Record<string, unknown>[] = [];
  if (isOrder) {
    notes = (
      await tx.execute<Record<string, unknown>>(sql`
        select distinct n.id, n.note_no as "noteNo", n.status, n.note_date::text as "noteDate"
        from delivery_note_lines dl join delivery_notes n on n.id = dl.note_id
        join sales_order_lines ol on ol.id = dl.sales_order_line_id
        where ol.order_id = ${id} order by "noteDate", "noteNo"`)
    ).rows;
    invoices = (
      await tx.execute<Record<string, unknown>>(sql`
        select distinct i.id, i.invoice_no as "invoiceNo", i.status, i.invoice_date::text as "invoiceDate"
        from invoice_lines il join invoices i on i.id = il.invoice_id
        join sales_order_lines ol on ol.id = il.sales_order_line_id
        where ol.order_id = ${id} order by "invoiceDate", "invoiceNo"`)
    ).rows;
  }
  const outLines = lines.map((l) => ({ ...l, ...(isOrder ? lineConsumption(l, usage.get(l.id)) : {}) }));
  const fulfilment = isOrder
    ? orderFulfilment(lines.map((l) => ({ quantity: l.quantity, isGoods: l.isGoods, delivered: effectiveDelivered(usage.get(l.id)), invoiced: usage.get(l.id)?.invoiced ?? dec(0) })))
    : null;
  return {
    doc: { ...doc, expired: doc.kind === 'quote' && doc.status === 'sent' && !!doc.validUntil && String(doc.validUntil) < todayIso(), fulfilment },
    lines: outLines,
    events: events.rows,
    notes,
    invoices,
  };
}

export interface SalesDocListRow extends Record<string, unknown> {
  id: string;
  kind: SalesDocKind;
  status: SalesDocStatus;
  docNo: string | null;
  docDate: string;
  validUntil: string | null;
  deliveryDate: string | null;
  partyId: string;
  partyCode: string;
  partyName: string;
  currencyCode: string;
  grossTotal: string;
  quoteId: string | null;
}

export async function listSalesDocs(tx: Tx, q: ListSalesDocsQuery) {
  const conds: SQL[] = [];
  if (q.kind) conds.push(sql`o.kind = ${q.kind}`);
  if (q.status) conds.push(sql`o.status = ${q.status}`);
  if (q.partyId) conds.push(sql`o.party_id = ${q.partyId}`);
  if (q.from) conds.push(sql`o.doc_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`o.doc_date <= ${q.to}::date`);
  if (q.query) conds.push(trContains(["coalesce(o.doc_no, '')", 'p.name', 'p.code'], q.query));
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const rows = await tx.execute<SalesDocListRow>(sql`
    select o.id, o.kind, o.status, o.doc_no as "docNo", o.doc_date::text as "docDate", o.valid_until::text as "validUntil",
           o.delivery_date::text as "deliveryDate", o.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
           o.currency_code as "currencyCode", o.gross_total as "grossTotal", o.quote_id as "quoteId"
    from sales_orders o join parties p on p.id = o.party_id
    ${where}
    order by o.doc_date desc, o.doc_no desc nulls first, o.created_at desc
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from sales_orders o join parties p on p.id = o.party_id ${where}`);

  // Siparişlerin türetilmiş karşılanma durumu (sayfadaki siparişler için tek sorgu)
  const orderIds = rows.rows.filter((r) => r.kind === 'order').map((r) => r.id);
  const fulfil = new Map<string, ReturnType<typeof orderFulfilment>>();
  if (orderIds.length > 0) {
    const lines = (await tx.execute<LineOut & { orderId: string }>(sql`${LINE_SELECT} where l.order_id in (${sql.join(orderIds.map((i) => sql`${i}::uuid`), sql`, `)})`)).rows;
    const usage = await orderLineUsage(tx, lines.map((l) => l.id));
    for (const id of orderIds) {
      fulfil.set(
        id,
        orderFulfilment(
          lines.filter((l) => l.orderId === id).map((l) => ({ quantity: l.quantity, isGoods: l.isGoods, delivered: effectiveDelivered(usage.get(l.id)), invoiced: usage.get(l.id)?.invoiced ?? dec(0) })),
        ),
      );
    }
  }
  return {
    docs: rows.rows.map((r) => ({
      ...r,
      expired: r.kind === 'quote' && r.status === 'sent' && !!r.validUntil && r.validUntil < todayIso(),
      fulfilment: fulfil.get(r.id) ?? null,
    })),
    total: total.rows[0]?.n ?? 0,
  };
}

/** Karşılanma için satır başına kalan miktarlar (irsaliye/fatura dönüşümü kullanır). */
export async function orderLinesWithUsage(tx: Tx, orderId: string) {
  const lines = (await tx.execute<LineOut>(sql`${LINE_SELECT} where l.order_id = ${orderId} order by l.line_no`)).rows;
  const usage = await orderLineUsage(tx, lines.map((l) => l.id));
  return lines.map((l) => ({ line: l, usage: usage.get(l.id)! }));
}

export type { MoneyValue };
