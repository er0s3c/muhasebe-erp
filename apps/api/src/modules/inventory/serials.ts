import { and, eq, inArray, sql } from 'drizzle-orm';
import { normalizeSerial, type ListSerialsQuery, type SerialEventKind, type SerialLookupQuery } from '@erp/shared';
import type { Tx } from '../../db/client';
import { documentLineSerials, itemSerials, items, serialEvents } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { TR } from '../../db/search';
import type { DraftRow } from './planner';
import { uuidList } from './balances';

/**
 * Seri no takibi (X3). Seri hareketi her zaman bir stok belgesi satırına bağlıdır ve `insertDocument` içinde, stok hareketlerinden
 * ÖNCE yazılır; böylece stok defteri (postStockDocument yolu) tek yol kalır, seri sayısı = miktar kuralını `stock_movements_serial_guard`
 * tetikleyicisi denetler. Durum geçişi (çifte çıkış, yanlış depo…) `serial_events_guard` tetikleyicisindedir; burada yalnızca anlaşılır
 * hata iletisi için önden denetim yapılır.
 */
export interface SerialIntent {
  /** Satır no → seri no'lar (normalize edilmemiş olabilir). */
  byLine: Map<number, readonly string[]>;
  /** Giriş için tedarikçi, çıkış için müşteri; iade denetimi bunu kullanır. */
  partyId?: string | null;
  /** İade irsaliyesi/faturası: giriş belgesi 'return_in' (müşteriden geri), çıkış belgesi 'return_out' (tedarikçiye geri). */
  returnKind?: 'return_in' | 'return_out';
}
export type SerialPlan = { intent: SerialIntent } | { reverseOf: string };

interface DocLike {
  id: string;
  companyId: string;
  type: string;
  warehouseId: string;
  toWarehouseId: string | null;
}

const fail = (msg: string, code = 'SERIAL_INVALID', details?: unknown) => unprocessable(msg, code, details);

/** Belge satırlarına ait seri hareketlerini yazar (kartı seri takipli satırlar için); seri takipli değilse hiçbir şey yapmaz. */
export async function applySerials(
  tx: Tx,
  ctx: { companyId: string; userId: string },
  doc: DocLike,
  rows: readonly DraftRow[],
  plan: SerialPlan | undefined,
) {
  const qtyRows = rows.filter((r) => r.kind === 'qty');
  const itemIds = [...new Set(qtyRows.map((r) => r.itemId))];
  if (itemIds.length === 0) return;
  const tracked = new Set(
    (await tx.select({ id: items.id }).from(items).where(and(inArray(items.id, itemIds), eq(items.tracksSerial, true)))).map((r) => r.id),
  );

  if (plan && 'reverseOf' in plan) {
    if (tracked.size > 0) await reverseSerialEvents(tx, ctx, doc, plan.reverseOf);
    return;
  }
  const intent = plan?.intent;
  const lineItem = new Map(qtyRows.map((r) => [r.lineNo, r.itemId]));
  for (const [lineNo, list] of intent?.byLine ?? []) {
    if (list.length > 0 && !tracked.has(lineItem.get(lineNo) ?? '')) {
      throw fail(`Satır ${lineNo}: stok kartı seri takipli değil, seri no girilemez`, 'SERIAL_ITEM_NOT_TRACKED');
    }
  }
  if (tracked.size === 0) return;
  if (doc.type === 'count') {
    throw fail('Seri takipli kartın sayım farkı sayımla işlenemez; seri no\'lu giriş ya da fire belgesi girin', 'SERIAL_COUNT_UNSUPPORTED');
  }

  const events: ((typeof serialEvents.$inferInsert) & { key?: string })[] = [];
  const created: { itemId: string; serialNo: string; lineNo: number; warehouseId: string }[] = [];
  const existing = new Map<string, typeof itemSerials.$inferSelect>();
  const wanted: { row: DraftRow; list: string[] }[] = [];
  for (const r of qtyRows) {
    if (!tracked.has(r.itemId)) continue;
    if (doc.type === 'transfer' && r.qty.gt(0)) continue; // giriş satırı, çıkış satırıyla aynı hareketi paylaşır
    const need = r.qty.abs();
    if (!need.isInteger()) throw fail(`Satır ${r.lineNo}: seri takipli kartta miktar tam sayı olmalı`, 'SERIAL_QTY_NOT_WHOLE');
    const list = (intent?.byLine.get(r.lineNo) ?? []).map(normalizeSerial);
    if (list.length !== need.toNumber()) {
      throw fail(
        `Satır ${r.lineNo}: seri takipli kartta miktar (${need.toFixed(0)}) kadar seri no girilmeli (girilen: ${list.length})`,
        'SERIAL_COUNT_MISMATCH',
        { lineNo: r.lineNo, quantity: need.toFixed(0), serials: list.length },
      );
    }
    if (new Set(list).size !== list.length) throw fail(`Satır ${r.lineNo}: aynı seri no birden çok girilmiş`, 'SERIAL_DUPLICATE');
    wanted.push({ row: r, list });
  }
  if (wanted.length === 0) return;
  const allNos = new Set<string>();
  for (const w of wanted) {
    for (const s of w.list) {
      const key = `${w.row.itemId}|${s}`;
      if (allNos.has(key)) throw fail(`${s} seri no'su belgede birden çok satırda`, 'SERIAL_DUPLICATE');
      allNos.add(key);
    }
  }
  const found = await tx
    .select()
    .from(itemSerials)
    .where(
      and(
        inArray(itemSerials.itemId, [...new Set(wanted.map((w) => w.row.itemId))]),
        inArray(itemSerials.serialNo, [...new Set(wanted.flatMap((w) => w.list))]),
        sql`${itemSerials.status} <> 'void'`,
      ),
    );
  for (const f of found) existing.set(`${f.itemId}|${f.serialNo}`, f);

  const kindOf = (): SerialEventKind => {
    switch (doc.type) {
      case 'opening':
      case 'receipt':
        return intent?.returnKind === 'return_in' ? 'return_in' : 'receive';
      case 'issue':
        return intent?.returnKind === 'return_out' ? 'return_out' : 'issue';
      case 'waste':
        return 'scrap';
      default:
        return 'transfer';
    }
  };
  const event = kindOf();
  const STATUS_TEXT: Record<string, string> = { in_stock: 'depoda', issued: 'müşteriye çıkmış', returned: 'tedarikçiye iade edilmiş', scrapped: 'fire/hurda' };

  for (const w of wanted) {
    for (const s of w.list) {
      const ex = existing.get(`${w.row.itemId}|${s}`);
      const base = { companyId: ctx.companyId, itemId: w.row.itemId, stockDocumentId: doc.id, lineNo: w.row.lineNo, partyId: intent?.partyId ?? null, createdBy: ctx.userId };
      if (event === 'receive') {
        if (ex && ex.status !== 'returned') {
          throw fail(`${s} seri no'su zaten sicilde (${STATUS_TEXT[ex.status] ?? ex.status})`, 'SERIAL_EXISTS', { serialNo: s });
        }
        if (!ex) created.push({ itemId: w.row.itemId, serialNo: s, lineNo: w.row.lineNo, warehouseId: w.row.warehouseId });
        events.push({ ...base, key: ex ? undefined : `${w.row.itemId}|${s}`, serialId: ex?.id ?? '', event, fromStatus: ex ? 'returned' : 'pending', toStatus: 'in_stock', fromWarehouseId: null, toWarehouseId: w.row.warehouseId });
        continue;
      }
      if (!ex) throw fail(`${s} seri no'su sicilde yok`, 'SERIAL_NOT_FOUND', { serialNo: s });
      if (event === 'return_in') {
        if (ex.status !== 'issued') throw fail(`${s} seri no'su müşteriye çıkmış durumda değil (${STATUS_TEXT[ex.status] ?? ex.status}); iade alınamaz`, 'SERIAL_NOT_ISSUED', { serialNo: s });
        await assertSamePartyAsLast(tx, ex.id, 'issued', intent?.partyId, s);
        events.push({ ...base, serialId: ex.id, event, fromStatus: 'issued', toStatus: 'in_stock', fromWarehouseId: null, toWarehouseId: w.row.warehouseId });
        continue;
      }
      if (ex.status !== 'in_stock') {
        throw fail(`${s} seri no'su depoda değil (${STATUS_TEXT[ex.status] ?? ex.status}); tekrar çıkarılamaz`, 'SERIAL_NOT_IN_STOCK', { serialNo: s });
      }
      if (ex.warehouseId !== w.row.warehouseId) throw fail(`${s} seri no'su bu depoda değil`, 'SERIAL_WRONG_WAREHOUSE', { serialNo: s });
      if (event === 'return_out') await assertSamePartyAsLast(tx, ex.id, 'in_stock', intent?.partyId, s);
      const toStatus = event === 'issue' ? 'issued' : event === 'return_out' ? 'returned' : event === 'scrap' ? 'scrapped' : 'in_stock';
      events.push({
        ...base,
        serialId: ex.id,
        event,
        fromStatus: 'in_stock',
        toStatus,
        fromWarehouseId: ex.warehouseId,
        toWarehouseId: event === 'transfer' ? doc.toWarehouseId : null,
      });
    }
  }

  if (created.length > 0) {
    const ins = await tx
      .insert(itemSerials)
      .values(created.map((c) => ({ companyId: ctx.companyId, itemId: c.itemId, serialNo: c.serialNo, status: 'pending' })))
      .returning({ id: itemSerials.id, itemId: itemSerials.itemId, serialNo: itemSerials.serialNo });
    const byKey = new Map(ins.map((i) => [`${i.itemId}|${i.serialNo}`, i.id]));
    for (const e of events) if (e.key) e.serialId = byKey.get(e.key)!;
  }
  if (events.length > 0) await tx.insert(serialEvents).values(events.map(({ key: _k, ...e }) => e));
}

/** İade: seri, son çıkış/giriş hareketindeki cariye ait olmalı. */
async function assertSamePartyAsLast(tx: Tx, serialId: string, afterStatus: string, partyId: string | null | undefined, serialNo: string) {
  if (!partyId) return;
  const [last] = await tx
    .select({ partyId: serialEvents.partyId })
    .from(serialEvents)
    .where(and(eq(serialEvents.serialId, serialId), eq(serialEvents.toStatus, afterStatus), sql`${serialEvents.event} <> 'reversal'`))
    .orderBy(sql`${serialEvents.seq} desc`)
    .limit(1);
  if (last?.partyId && last.partyId !== partyId) {
    throw fail(`${serialNo} seri no'su bu cariyle işlem görmemiş (iade başka cariye ait)`, 'SERIAL_PARTY_MISMATCH', { serialNo });
  }
}

/** Ters stok belgesi: orijinal belgenin seri hareketlerinin tam tersi yazılır (durum eski haline döner). */
async function reverseSerialEvents(tx: Tx, ctx: { companyId: string; userId: string }, doc: DocLike, originalDocId: string) {
  const orig = await tx
    .select()
    .from(serialEvents)
    .where(and(eq(serialEvents.stockDocumentId, originalDocId), sql`${serialEvents.event} <> 'reversal'`))
    .orderBy(sql`${serialEvents.seq} desc`);
  if (orig.length === 0) return;
  const serials = await tx.select().from(itemSerials).where(inArray(itemSerials.id, orig.map((o) => o.serialId)));
  const byId = new Map(serials.map((s) => [s.id, s]));
  for (const o of orig) {
    const s = byId.get(o.serialId)!;
    if (s.status !== o.toStatus || (s.warehouseId ?? null) !== (o.toWarehouseId ?? null)) {
      throw fail(`${s.serialNo} seri no'su bu belgeden sonra hareket görmüş; ters kayıt yapılamaz`, 'SERIAL_STATE_CHANGED', { serialNo: s.serialNo });
    }
  }
  await tx.insert(serialEvents).values(
    orig.map((o) => ({
      companyId: ctx.companyId,
      serialId: o.serialId,
      itemId: o.itemId,
      event: 'reversal',
      fromStatus: o.toStatus,
      toStatus: o.fromStatus === 'pending' ? 'void' : o.fromStatus,
      fromWarehouseId: o.toWarehouseId,
      toWarehouseId: o.fromWarehouseId,
      stockDocumentId: doc.id,
      lineNo: o.lineNo,
      partyId: o.partyId,
      reversalOfId: o.id,
      createdBy: ctx.userId,
    })),
  );
}

// --- Taslak satır seri no'ları ----------------------------------------------------

type LineKind = 'delivery' | 'invoice';

/** Taslak satırlara girilen seri no'ları yazar (satır id → liste). Boş liste olan satıra hiçbir şey yazılmaz. */
export async function saveLineSerials(tx: Tx, companyId: string, kind: LineKind, byLineId: Map<string, readonly string[]>) {
  const values: (typeof documentLineSerials.$inferInsert)[] = [];
  for (const [lineId, list] of byLineId) {
    const seen = new Set<string>();
    for (const raw of list) {
      const s = normalizeSerial(raw);
      if (!s) continue;
      if (seen.has(s)) throw fail(`${s} seri no'su aynı satırda birden çok girilmiş`, 'SERIAL_DUPLICATE');
      seen.add(s);
      values.push({ companyId, serialNo: s, ...(kind === 'delivery' ? { deliveryLineId: lineId } : { invoiceLineId: lineId }) });
    }
  }
  if (values.length > 0) await tx.insert(documentLineSerials).values(values);
}

/** Satır id → seri no'lar. */
export async function lineSerials(tx: Tx, kind: LineKind, lineIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (lineIds.length === 0) return out;
  const col = kind === 'delivery' ? documentLineSerials.deliveryLineId : documentLineSerials.invoiceLineId;
  const rows = await tx
    .select({ lineId: col, serialNo: documentLineSerials.serialNo })
    .from(documentLineSerials)
    .where(inArray(col, [...lineIds]))
    .orderBy(documentLineSerials.createdAt, documentLineSerials.serialNo);
  for (const r of rows) out.set(r.lineId!, [...(out.get(r.lineId!) ?? []), r.serialNo]);
  return out;
}

// --- Sorgular -----------------------------------------------------------------------

export async function listSerials(tx: Tx, q: ListSerialsQuery) {
  const conds = [sql`s.status <> 'void'`, sql`s.status <> 'pending'`];
  if (q.itemId) conds.push(sql`s.item_id = ${q.itemId}`);
  if (q.warehouseId) conds.push(sql`s.warehouse_id = ${q.warehouseId}`);
  if (q.status) conds.push(sql`s.status = ${q.status}`);
  if (q.query) conds.push(sql`s.serial_no like ${'%' + normalizeSerial(q.query).replace(/[%_\\]/g, '\\$&') + '%'}`);
  const where = sql`where ${sql.join(conds, sql` and `)}`;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.serial_no as "serialNo", s.status, s.item_id as "itemId", i.code as "itemCode", i.name as "itemName",
           s.warehouse_id as "warehouseId", w.name as "warehouseName", s.updated_at as "updatedAt"
    from item_serials s
    join items i on i.id = s.item_id
    left join warehouses w on w.id = s.warehouse_id
    ${where}
    order by i.name collate ${TR}, s.serial_no
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from item_serials s ${where}`);
  return { serials: rows.rows, total: total.rows[0]?.n ?? 0 };
}

/** Seri no sorgula: sicil kaydı(ları) ve tam geçmiş (tedarikçiden müşteriye). */
export async function lookupSerial(tx: Tx, q: SerialLookupQuery) {
  const no = normalizeSerial(q.serialNo);
  const regs = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.serial_no as "serialNo", s.status, s.item_id as "itemId", i.code as "itemCode", i.name as "itemName",
           s.warehouse_id as "warehouseId", w.name as "warehouseName"
    from item_serials s join items i on i.id = s.item_id left join warehouses w on w.id = s.warehouse_id
    where s.serial_no = ${no} and s.status <> 'pending' ${q.itemId ? sql`and s.item_id = ${q.itemId}` : sql``}
    order by s.created_at desc`);
  if (regs.rows.length === 0) throw notFound('Seri no');
  const out = [];
  for (const reg of regs.rows) {
    const history = await tx.execute<Record<string, unknown>>(sql`
      select e.id, e.seq, e.event, e.from_status as "fromStatus", e.to_status as "toStatus", e.line_no as "lineNo",
             e.created_at as "createdAt", d.id as "stockDocumentId", d.doc_no as "stockDocumentNo", d.doc_date::text as "docDate",
             fw.name as "fromWarehouse", tw.name as "toWarehouse", p.id as "partyId", p.code as "partyCode", p.name as "partyName",
             d.source_type as "sourceType", d.source_id as "sourceId",
             coalesce(inv.invoice_no, dn.note_no) as "sourceNo", e.reversal_of_id as "reversalOfId"
      from serial_events e
      join stock_documents d on d.id = e.stock_document_id
      left join warehouses fw on fw.id = e.from_warehouse_id
      left join warehouses tw on tw.id = e.to_warehouse_id
      left join parties p on p.id = e.party_id
      left join invoices inv on d.source_type = 'invoice' and inv.id = d.source_id
      left join delivery_notes dn on d.source_type = 'delivery_note' and dn.id = d.source_id
      where e.serial_id = ${reg.id}
      order by e.seq`);
    const rowsH = history.rows as { event: string; partyName: string | null; reversalOfId: string | null; id: string }[];
    const reversed = new Set(rowsH.filter((h) => h.reversalOfId).map((h) => h.reversalOfId));
    const live = rowsH.filter((h) => h.event !== 'reversal' && !reversed.has(h.id));
    const supplier = [...live].reverse().find((h) => h.event === 'receive')?.partyName ?? null;
    const customer = [...live].reverse().find((h) => h.event === 'issue')?.partyName ?? null;
    out.push({ ...reg, supplier, customer, history: history.rows });
  }
  return { serials: out };
}

/** Stok durumu raporu için: kart × depo seri sayıları (depoda). */
export async function serialCounts(tx: Tx, itemIds: readonly string[]) {
  if (itemIds.length === 0) return new Map<string, number>();
  const rows = await tx.execute<{ item_id: string; n: number }>(sql`
    select item_id, count(*)::int as n from item_serials where status = 'in_stock' and item_id in (${uuidList(itemIds)}) group by item_id`);
  return new Map(rows.rows.map((r) => [r.item_id, r.n]));
}

