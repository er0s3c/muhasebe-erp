import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  DELIVERY_EXTERNAL_NO_TYPES,
  DELIVERY_NOTE_TYPE_META,
  INVOICE_TYPE_META,
  dec,
  partyKindFits,
  toDbRate,
  type CreateDeliveryNoteInput,
  type DeliveryLineInput,
  type DeliveryNoteType,
  type ListDeliveryNotesQuery,
  type OpenDeliveryLinesQuery,
  type PartyKind,
  type UpdateDeliveryNoteInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { trContains } from '../../db/search';
import { deliveryNoteLines, deliveryNotes, items, parties, warehouses } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { requireActiveWarehouse } from '../inventory/warehouses';
import { invoicedTotals } from '../invoices/delivery-link';
import { checkOrderLinks } from '../sales/usage';
import { lineSerials, saveLineSerials } from '../inventory/serials';
import { checkReturnLinks, returnedTotals } from './returns';

export interface DeliveryCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
  reportingCurrency: string | null;
  allowNegativeStock: boolean;
}

export async function loadParty(tx: Tx, partyId: string, type: DeliveryNoteType) {
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
  if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
  const control = INVOICE_TYPE_META[DELIVERY_NOTE_TYPE_META[type].invoiceType].control;
  if (!partyKindFits(party.kind as PartyKind, control)) {
    throw unprocessable(
      `${party.name} carisi bu irsaliye türüyle uyumlu değil (${DELIVERY_NOTE_TYPE_META[type].partyKind === 'customer' ? 'müşteri' : 'tedarikçi'} olmalı)`,
      'PARTY_KIND_MISMATCH',
    );
  }
  return party;
}

/** Aynı tedarikçinin aynı irsaliyesi daha önce kaydedilmiş mi? (İptal edilen kayıt numarayı tutmaz.) */
export async function assertExternalNoFree(tx: Tx, partyId: string, externalNo: string, exceptId: string) {
  const [dup] = await tx
    .select({ id: deliveryNotes.id, noteNo: deliveryNotes.noteNo })
    .from(deliveryNotes)
    .where(
      and(
        eq(deliveryNotes.partyId, partyId),
        eq(deliveryNotes.externalNo, externalNo),
        sql`${deliveryNotes.status} = 'posted'`,
        sql`${deliveryNotes.id} <> ${exceptId}`,
      ),
    );
  if (dup) {
    throw conflict(`Bu cariden ${externalNo} numaralı irsaliye zaten kaydedilmiş (${dup.noteNo})`, 'EXTERNAL_NO_TAKEN');
  }
}

/** Satırları doğrular ve saklanacak biçime getirir: yalnızca aktif, stoklu mal kartları. */
async function prepareLines(tx: Tx, type: DeliveryNoteType, lines: readonly DeliveryLineInput[], baseCurrency: string) {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const rows = await tx.select().from(items).where(inArray(items.id, itemIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return lines.map((l, i) => {
    const label = `Satır ${i + 1}`;
    const item = byId.get(l.itemId);
    if (!item) throw unprocessable(`${label}: stok kartı bulunamadı`, 'ITEM_NOT_FOUND');
    if (item.kind !== 'goods') {
      throw unprocessable(`${label}: ${item.code} hizmet kalemidir; irsaliye yalnızca stoklu mal kartlarıyla düzenlenir`, 'ITEM_NOT_STOCKED');
    }
    if (!item.isActive) throw unprocessable(`${label}: ${item.code} ${item.name} kartı pasif`, 'ITEM_INACTIVE');
    const costGiven = l.unitCost !== undefined || l.currency !== undefined || l.fxRate !== undefined;
    if (type !== 'purchase' && costGiven) {
      throw unprocessable(`${label}: bu irsaliye türünde maliyet girilmez; stok defteri maliyeti kullanılır`, 'DELIVERY_COST_NOT_ALLOWED');
    }
    if (type === 'purchase' && l.unitCost === undefined && (l.currency !== undefined || l.fxRate !== undefined)) {
      throw unprocessable(`${label}: para birimi/kur için birim maliyet de girilmeli`, 'DELIVERY_COST_INCOMPLETE');
    }
    const priced = type === 'purchase' && l.unitCost !== undefined;
    const currency = priced ? (l.currency ?? baseCurrency) : null;
    return {
      lineNo: i + 1,
      itemId: item.id,
      description: l.description ?? item.name,
      quantity: dec(l.quantity).toFixed(4),
      unit: l.unit ?? item.unit,
      unitCost: priced ? dec(l.unitCost!).toFixed(6) : null,
      currencyCode: currency,
      fxRate: priced && currency !== baseCurrency && l.fxRate ? toDbRate(l.fxRate) : null,
      sourceLineId: l.sourceLineId ?? null,
      salesOrderLineId: l.salesOrderLineId ?? null,
    };
  });
}

type DraftInput = Omit<CreateDeliveryNoteInput, 'type' | 'post'> | Omit<UpdateDeliveryNoteInput, 'post'>;

async function writeDraft(tx: Tx, ctx: DeliveryCtx, type: DeliveryNoteType, input: DraftInput, id?: string) {
  const party = await loadParty(tx, input.partyId, type);
  if (!DELIVERY_EXTERNAL_NO_TYPES.includes(type) && input.externalNo) {
    throw unprocessable('Dış numara yalnızca alış ve alış iade irsaliyesinde girilir', 'EXTERNAL_NO_NOT_ALLOWED');
  }
  const isReturn = DELIVERY_NOTE_TYPE_META[type].isReturn;
  if (input.returnOfId && !isReturn) {
    throw unprocessable('Orijinal irsaliye yalnızca iade irsaliyesinde seçilir', 'RETURN_NOT_ALLOWED');
  }
  if (!isReturn && input.lines.some((l) => l.sourceLineId)) {
    throw unprocessable('Satır bağı yalnızca iade irsaliyesinde kullanılır', 'RETURN_NOT_ALLOWED');
  }
  if (type !== 'sales' && input.lines.some((l) => l.salesOrderLineId)) {
    throw unprocessable('Sipariş bağı yalnızca satış irsaliyesinde kullanılır', 'SO_LINK_TYPE');
  }
  const lines = await prepareLines(tx, type, input.lines, ctx.baseCurrency);
  await checkReturnLinks(tx, type, party.id, input.returnOfId, lines.map((l) => ({ lineNo: l.lineNo, itemId: l.itemId, quantity: l.quantity, sourceLineId: l.sourceLineId })), id);
  await checkOrderLinks(tx, 'delivery', party.id, lines.map((l) => ({ lineNo: l.lineNo, itemId: l.itemId, quantity: l.quantity, salesOrderLineId: l.salesOrderLineId })));
  const warehouseId = input.warehouseId ?? (await defaultWarehouseId(tx));
  await requireActiveWarehouse(tx, warehouseId, 'Depo');

  const header = {
    noteDate: input.noteDate,
    externalNo: input.externalNo ?? null,
    returnOfId: input.returnOfId ?? null,
    partyId: party.id,
    warehouseId,
    vehiclePlate: input.vehiclePlate ?? null,
    driverName: input.driverName ?? null,
    description: input.description ?? null,
    updatedAt: new Date(),
  };

  let noteId = id;
  if (noteId) {
    await tx.update(deliveryNotes).set(header).where(eq(deliveryNotes.id, noteId));
    await tx.delete(deliveryNoteLines).where(eq(deliveryNoteLines.noteId, noteId));
  } else {
    const [row] = await tx
      .insert(deliveryNotes)
      .values({ ...header, companyId: ctx.companyId, type, createdBy: ctx.userId })
      .returning({ id: deliveryNotes.id });
    noteId = row!.id;
  }
  const inserted = await tx
    .insert(deliveryNoteLines)
    .values(lines.map((l) => ({ ...l, companyId: ctx.companyId, noteId: noteId! })))
    .returning({ id: deliveryNoteLines.id, lineNo: deliveryNoteLines.lineNo });
  const serialsByLine = new Map<string, readonly string[]>();
  for (const r of inserted) {
    const list = input.lines[r.lineNo - 1]?.serials;
    if (list && list.length > 0) serialsByLine.set(r.id, list);
  }
  await saveLineSerials(tx, ctx.companyId, 'delivery', serialsByLine);
  return noteId;
}

async function defaultWarehouseId(tx: Tx): Promise<string> {
  const [w] = await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.isDefault, true));
  if (!w) throw unprocessable('Varsayılan depo tanımlı değil', 'WAREHOUSE_REQUIRED');
  return w.id;
}

export async function createDeliveryDraft(tx: Tx, ctx: DeliveryCtx, input: CreateDeliveryNoteInput) {
  return writeDraft(tx, ctx, input.type, input);
}

async function getDraftRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(deliveryNotes).where(eq(deliveryNotes.id, id));
  if (!row) throw notFound('İrsaliye');
  if (row.status !== 'draft') throw unprocessable('Yalnızca taslak irsaliye düzenlenebilir', 'DELIVERY_NOT_DRAFT');
  return row;
}

export async function updateDeliveryDraft(tx: Tx, ctx: DeliveryCtx, id: string, input: UpdateDeliveryNoteInput) {
  const row = await getDraftRow(tx, id);
  await writeDraft(tx, ctx, row.type as DeliveryNoteType, input, id);
  return id;
}

export async function deleteDeliveryDraft(tx: Tx, id: string) {
  await getDraftRow(tx, id);
  await tx.delete(deliveryNotes).where(eq(deliveryNotes.id, id));
}

// --- Okuma -------------------------------------------------------------------

interface HeadRow extends Record<string, unknown> {
  id: string;
  type: DeliveryNoteType;
  status: string;
  noteNo: string | null;
  externalNo: string | null;
  returnOfId: string | null;
  returnOfNo: string | null;
  noteDate: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  warehouseId: string;
  warehouseName: string;
  vehiclePlate: string | null;
  driverName: string | null;
  description: string | null;
  stockDocumentId: string | null;
  stockDocumentNo: string | null;
  postedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  cancelStockDocumentId: string | null;
  cancelStockDocumentNo: string | null;
  createdAt: Date;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  description: string;
  quantity: string;
  unit: string | null;
  unitCost: string | null;
  currencyCode: string | null;
  fxRate: string | null;
  stockValue: string | null;
  adjustValue: string | null;
  sourceLineId: string | null;
  salesOrderLineId: string | null;
  salesOrderNo: string | null;
  salesOrderId: string | null;
}

export async function getDeliveryNote(tx: Tx, id: string) {
  const head = await tx.execute<HeadRow>(sql`
    select n.id, n.type, n.status, n.note_no as "noteNo", n.external_no as "externalNo",
           n.return_of_id as "returnOfId", ro.note_no as "returnOfNo",
           n.note_date::text as "noteDate", n.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
           n.warehouse_id as "warehouseId", w.name as "warehouseName",
           n.vehicle_plate as "vehiclePlate", n.driver_name as "driverName", n.description,
           n.stock_document_id as "stockDocumentId", sd.doc_no as "stockDocumentNo",
           n.posted_at as "postedAt", n.cancelled_at as "cancelledAt", n.cancel_reason as "cancelReason",
           n.cancel_stock_document_id as "cancelStockDocumentId", csd.doc_no as "cancelStockDocumentNo",
           n.created_at as "createdAt"
    from delivery_notes n
    join parties p on p.id = n.party_id
    join warehouses w on w.id = n.warehouse_id
    left join delivery_notes ro on ro.id = n.return_of_id
    left join stock_documents sd on sd.id = n.stock_document_id
    left join stock_documents csd on csd.id = n.cancel_stock_document_id
    where n.id = ${id}`);
  const note = head.rows[0];
  if (!note) throw notFound('İrsaliye');

  const lines = await tx.execute<LineRow>(sql`
    select l.id, l.line_no as "lineNo", l.item_id as "itemId", it.code as "itemCode", l.description, l.quantity, l.unit,
           l.unit_cost as "unitCost", l.currency_code as "currencyCode", l.fx_rate as "fxRate",
           l.stock_value as "stockValue", l.adjust_value as "adjustValue",
           l.source_line_id as "sourceLineId", l.sales_order_line_id as "salesOrderLineId",
           so.doc_no as "salesOrderNo", so.id as "salesOrderId"
    from delivery_note_lines l join items it on it.id = l.item_id
    left join sales_order_lines sol on sol.id = l.sales_order_line_id
    left join sales_orders so on so.id = sol.order_id
    where l.note_id = ${id}
    order by l.line_no`);

  const serialMap = await lineSerials(tx, 'delivery', lines.rows.map((l) => l.id));
  const totals = await invoicedTotals(tx, lines.rows.map((l) => l.id));
  // Orijinal (satış/alış) irsaliyede satır başına iade edilen ve iade edilebilir miktar
  const isOriginal = !DELIVERY_NOTE_TYPE_META[note.type].isReturn;
  const returned = isOriginal && note.status === 'posted' ? await returnedTotals(tx, lines.rows.map((l) => l.id)) : new Map();
  const returns = isOriginal
    ? (
        await tx.execute<{ id: string; noteNo: string | null; status: string }>(sql`
          select id, note_no as "noteNo", status from delivery_notes where return_of_id = ${id} order by created_at`)
      ).rows
    : [];
  let qtyTotal = dec(0);
  let invoicedQty = dec(0);
  const outLines = lines.rows.map((l) => {
    const inv = totals.get(l.id);
    const q = dec(l.quantity);
    qtyTotal = qtyTotal.plus(q);
    invoicedQty = invoicedQty.plus(inv?.qty ?? 0);
    return {
      ...l,
      serials: serialMap.get(l.id) ?? [],
      invoicedQty: (inv?.qty ?? dec(0)).toFixed(4),
      remainingQty: q.minus(inv?.qty ?? 0).toFixed(4),
      returnedQty: isOriginal && note.status === 'posted' ? (returned.get(l.id)?.qty ?? dec(0)).toFixed(4) : null,
      returnableQty: isOriginal && note.status === 'posted' ? q.minus(returned.get(l.id)?.qty ?? 0).toFixed(4) : null,
    };
  });

  // Bu irsaliyeden faturalanan (kaydedilmiş/iptal) faturalar
  const invoices = await tx.execute<{ id: string; invoiceNo: string | null; status: string; type: string }>(sql`
    select distinct i.id, i.invoice_no as "invoiceNo", i.status, i.type, i.invoice_date
    from invoice_lines il
    join invoices i on i.id = il.invoice_id
    join delivery_note_lines dl on dl.id = il.delivery_line_id
    where dl.note_id = ${id} and i.status <> 'draft'
    order by i.invoice_date, i.invoice_no`);

  const invoicing =
    note.status !== 'posted' ? null : invoicedQty.isZero() ? 'open' : invoicedQty.gte(qtyTotal) ? 'invoiced' : 'partial';
  return {
    note: { ...note, invoicing },
    lines: outLines,
    invoices: invoices.rows.map((r) => ({ id: r.id, invoiceNo: r.invoiceNo, status: r.status, type: r.type })),
    returns,
  };
}

/** Faturalanmış miktar ve kalan değer toplamları (irsaliye başına) — liste ve rapor ortak kullanır. */
const NOTE_AGG = sql`
  left join (
    select note_id, count(*) as line_count, sum(quantity) as qty,
           sum(coalesce(stock_value, 0) + coalesce(adjust_value, 0)) as value
    from delivery_note_lines group by note_id
  ) t on t.note_id = n.id
  left join (
    select dl.note_id, sum(il.quantity) as qty,
           sum(coalesce(il.delivery_value, 0) + coalesce(il.delivery_adjust, 0)) as value
    from invoice_lines il
    join invoices i on i.id = il.invoice_id and i.status = 'posted'
    join delivery_note_lines dl on dl.id = il.delivery_line_id
    group by dl.note_id
  ) b on b.note_id = n.id`;

export async function listDeliveryNotes(tx: Tx, q: ListDeliveryNotesQuery) {
  const conds: SQL[] = [];
  if (q.type) conds.push(sql`n.type = ${q.type}`);
  if (q.status) conds.push(sql`n.status = ${q.status}`);
  if (q.partyId) conds.push(sql`n.party_id = ${q.partyId}`);
  if (q.from) conds.push(sql`n.note_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`n.note_date <= ${q.to}::date`);
  if (q.query) conds.push(trContains(["coalesce(n.note_no, '')", "coalesce(n.external_no, '')", 'p.name', 'p.code'], q.query));
  if (q.invoicing) {
    conds.push(sql`n.status = 'posted'`);
    conds.push(
      q.invoicing === 'open'
        ? sql`coalesce(b.qty, 0) = 0`
        : q.invoicing === 'invoiced'
          ? sql`coalesce(b.qty, 0) >= t.qty`
          : sql`coalesce(b.qty, 0) > 0 and coalesce(b.qty, 0) < t.qty`,
    );
  }
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const from = sql`
    from delivery_notes n
    join parties p on p.id = n.party_id
    join warehouses w on w.id = n.warehouse_id
    ${NOTE_AGG}`;

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select n.id, n.type, n.status, n.note_no as "noteNo", n.external_no as "externalNo",
           n.note_date::text as "noteDate", n.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
           w.name as "warehouseName", n.vehicle_plate as "vehiclePlate", n.description,
           coalesce(t.line_count, 0)::int as "lineCount", coalesce(t.qty, 0) as "totalQty",
           coalesce(b.qty, 0) as "invoicedQty",
           case when n.status <> 'posted' then null
                when coalesce(b.qty, 0) = 0 then 'open'
                when coalesce(b.qty, 0) >= t.qty then 'invoiced'
                else 'partial' end as invoicing,
           case when n.status = 'posted' then coalesce(t.value, 0) - coalesce(b.value, 0) end as "pendingValue"
    ${from}
    ${where}
    order by n.note_date desc, n.note_no desc nulls first, n.created_at desc
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n ${from} ${where}`);
  return { notes: rows.rows, total: total.rows[0]?.n ?? 0 };
}

/** Faturaya eklenebilecek, kalan miktarı olan irsaliye satırları (aynı cari ve tür). */
export async function openDeliveryLines(tx: Tx, q: OpenDeliveryLinesQuery) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select dl.id as "lineId", dl.line_no as "lineNo", n.id as "noteId", n.note_no as "noteNo",
           n.note_date::text as "noteDate", n.external_no as "externalNo", n.warehouse_id as "warehouseId",
           dl.item_id as "itemId", it.code as "itemCode", dl.description, dl.unit, dl.quantity,
           dl.unit_cost as "unitCost", dl.currency_code as "currencyCode",
           coalesce(b.qty, 0) as "invoicedQty", dl.quantity - coalesce(b.qty, 0) as "remainingQty"
    from delivery_note_lines dl
    join delivery_notes n on n.id = dl.note_id
    join items it on it.id = dl.item_id
    left join (
      select il.delivery_line_id, sum(il.quantity) as qty
      from invoice_lines il join invoices i on i.id = il.invoice_id and i.status = 'posted'
      where il.delivery_line_id is not null
      group by il.delivery_line_id
    ) b on b.delivery_line_id = dl.id
    where n.status = 'posted' and n.type = ${q.type} and n.party_id = ${q.partyId}
      and dl.quantity > coalesce(b.qty, 0)
    order by n.note_date, n.note_no, dl.line_no`);
  return { lines: rows.rows };
}

/** Bekleyen (faturalanmamış) irsaliyelerin sayısı ve kalan değeri: liste başlığı ve genel bakış. */
export async function deliverySummary(tx: Tx) {
  const rows = await tx.execute<{ type: 'sales' | 'purchase'; notes: number; value: string }>(sql`
    select n.type,
           count(distinct n.id) filter (where dl.quantity > coalesce(b.qty, 0))::int as notes,
           coalesce(sum(coalesce(dl.stock_value, 0) + coalesce(dl.adjust_value, 0) - coalesce(b.value, 0)), 0) as value
    from delivery_notes n
    join delivery_note_lines dl on dl.note_id = n.id
    left join (
      select il.delivery_line_id, sum(il.quantity) as qty,
             sum(coalesce(il.delivery_value, 0) + coalesce(il.delivery_adjust, 0)) as value
      from invoice_lines il join invoices i on i.id = il.invoice_id and i.status = 'posted'
      where il.delivery_line_id is not null
      group by il.delivery_line_id
    ) b on b.delivery_line_id = dl.id
    where n.status = 'posted'
    group by n.type`);
  const by = (t: 'sales' | 'purchase') => rows.rows.find((r) => r.type === t);
  return {
    sales: { openCount: by('sales')?.notes ?? 0, openValue: (by('sales')?.value ?? '0') },
    purchases: { openCount: by('purchase')?.notes ?? 0, openValue: (by('purchase')?.value ?? '0') },
  };
}

export const orderedLines = (tx: Tx, noteId: string) =>
  tx.select().from(deliveryNoteLines).where(eq(deliveryNoteLines.noteId, noteId)).orderBy(asc(deliveryNoteLines.lineNo));
