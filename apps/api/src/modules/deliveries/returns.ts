import { sql } from 'drizzle-orm';
import { DELIVERY_NOTE_TYPE_META, dec, type DeliveryNoteType, type MoneyValue, type ReturnableLinesQuery } from '@erp/shared';
import type { Tx } from '../../db/client';
import { unprocessable } from '../../http/errors';
import { uuidList } from '../inventory/balances';

/**
 * İade irsaliyesi yardımcıları (X2). İade, orijinal irsaliye satırına bağlanabilir (isteğe bağlı ama doğrulanır):
 * toplam iade miktarı teslim edilen miktarı aşamaz. Değer iadesi (iade faturası) ayrıdır: kaydedilmiş iade irsaliyesi satırları
 * iade faturasına bağlanır; irsaliye yalnızca miktar/stok hareketidir, yevmiye yazmaz.
 */

export interface Returned {
  qty: MoneyValue;
  /** İade irsaliyelerinin stok defteri değeri (defter para birimi): kalan maliyetin hesabında kullanılır. */
  value: MoneyValue;
}

/** Orijinal irsaliye satırlarına kaydedilmiş (iptal edilmemiş) iade irsaliyelerinden dönen miktar ve değer. */
export async function returnedTotals(tx: Tx, origLineIds: readonly string[], exceptNoteId?: string) {
  const out = new Map<string, Returned>();
  if (origLineIds.length === 0) return out;
  const rows = await tx.execute<{ source_line_id: string; qty: string; value: string }>(sql`
    select l.source_line_id, sum(l.quantity) as qty, coalesce(sum(l.stock_value), 0) as value
    from delivery_note_lines l join delivery_notes n on n.id = l.note_id
    where n.status = 'posted' and l.source_line_id in (${uuidList(origLineIds)})
      ${exceptNoteId ? sql`and n.id <> ${exceptNoteId}` : sql``}
    group by l.source_line_id`);
  for (const r of rows.rows) out.set(r.source_line_id, { qty: dec(r.qty), value: dec(r.value) });
  return out;
}

interface OrigRow extends Record<string, unknown> {
  id: string;
  note_id: string;
  note_no: string | null;
  type: string;
  status: string;
  party_id: string;
  item_id: string;
  quantity: string;
  stock_value: string | null;
}

export interface ReturnLinkLine {
  lineNo: number;
  itemId: string;
  quantity: string;
  sourceLineId?: string | null;
}

export interface OrigLine {
  id: string;
  quantity: MoneyValue;
  stockValue: MoneyValue;
  noteNo: string | null;
  warehouseId?: string;
}

/**
 * İade irsaliyesinin orijinal bağını doğrular ve (varsa) satır bağlarını döndürür: orijinal kaydedilmiş, aynı cari, karşı türde;
 * bağlı satır orijinalin satırı ve aynı kart; toplam iade teslim edilenden fazla olamaz.
 */
export async function checkReturnLinks(
  tx: Tx,
  type: DeliveryNoteType,
  partyId: string,
  returnOfId: string | null | undefined,
  lines: readonly ReturnLinkLine[],
  exceptNoteId?: string,
): Promise<Map<string, OrigLine>> {
  const meta = DELIVERY_NOTE_TYPE_META[type];
  const orig = new Map<string, OrigLine>();
  if (!meta.isReturn) return orig;
  if (!returnOfId) {
    if (lines.some((l) => l.sourceLineId)) throw unprocessable('Satır bağı için orijinal irsaliye seçilmeli', 'RETURN_ORIGINAL_REQUIRED');
    return orig;
  }
  const head = await tx.execute<{ id: string; note_no: string | null; type: string; status: string; party_id: string }>(sql`
    select id, note_no, type, status, party_id from delivery_notes where id = ${returnOfId}`);
  const o = head.rows[0];
  if (!o) throw unprocessable('Orijinal irsaliye bulunamadı', 'RETURN_ORIGINAL_NOT_FOUND');
  if (o.status !== 'posted') throw unprocessable('Orijinal irsaliye kaydedilmiş olmalı', 'RETURN_ORIGINAL_NOT_POSTED');
  if (o.type !== meta.returnOf) throw unprocessable('Orijinal irsaliye türü bu iadeyle uyuşmuyor', 'RETURN_ORIGINAL_TYPE');
  if (o.party_id !== partyId) throw unprocessable('İade, orijinal irsaliyenin carisine düzenlenmeli', 'RETURN_PARTY_MISMATCH');

  const linked = lines.filter((l) => l.sourceLineId);
  if (linked.length === 0) return orig;
  const ids = [...new Set(linked.map((l) => l.sourceLineId!))];
  const rows = await tx.execute<OrigRow>(sql`
    select dl.id, dl.note_id, n.note_no, n.type, n.status, n.party_id, dl.item_id, dl.quantity, dl.stock_value
    from delivery_note_lines dl join delivery_notes n on n.id = dl.note_id
    where dl.id in (${uuidList(ids)})`);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const returned = await returnedTotals(tx, ids, exceptNoteId);
  const inThis = new Map<string, MoneyValue>();
  for (const l of linked) {
    const s = byId.get(l.sourceLineId!);
    if (!s || s.note_id !== returnOfId) {
      throw unprocessable(`Satır ${l.lineNo}: bağlı satır orijinal irsaliyede yok`, 'RETURN_LINE_NOT_FOUND');
    }
    if (s.item_id !== l.itemId) {
      throw unprocessable(`Satır ${l.lineNo}: iade satırının kartı orijinal satırla aynı olmalı`, 'RETURN_ITEM_MISMATCH');
    }
    const remaining = dec(s.quantity).minus(returned.get(s.id)?.qty ?? 0).minus(inThis.get(s.id) ?? 0);
    if (dec(l.quantity).gt(remaining)) {
      throw unprocessable(
        `Satır ${l.lineNo}: iade miktarı (${dec(l.quantity).toFixed(4)}) iade edilebilir kalan miktarı (${(remaining.isNegative() ? dec(0) : remaining).toFixed(4)}) aşıyor`,
        'RETURN_QTY_EXCEEDED',
        { lineNo: l.lineNo, remaining: (remaining.isNegative() ? dec(0) : remaining).toFixed(4) },
      );
    }
    inThis.set(s.id, (inThis.get(s.id) ?? dec(0)).plus(l.quantity));
    orig.set(s.id, { id: s.id, quantity: dec(s.quantity), stockValue: dec(s.stock_value ?? 0), noteNo: s.note_no });
  }
  return orig;
}

/** İade edilebilecek orijinal irsaliye satırları: teslim edilen − önceki kaydedilmiş iadeler > 0. */
export async function returnableLines(tx: Tx, q: ReturnableLinesQuery) {
  const origType = DELIVERY_NOTE_TYPE_META[q.type].returnOf!;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select dl.id as "lineId", dl.line_no as "lineNo", n.id as "noteId", n.note_no as "noteNo", n.note_date::text as "noteDate",
           dl.item_id as "itemId", it.code as "itemCode", dl.description, dl.unit, dl.quantity,
           coalesce(r.qty, 0) as "returnedQty", dl.quantity - coalesce(r.qty, 0) as "returnableQty",
           coalesce(b.qty, 0) as "invoicedQty"
    from delivery_note_lines dl
    join delivery_notes n on n.id = dl.note_id
    join items it on it.id = dl.item_id
    left join (
      select rl.source_line_id, sum(rl.quantity) as qty
      from delivery_note_lines rl join delivery_notes rn on rn.id = rl.note_id and rn.status = 'posted'
      where rl.source_line_id is not null group by rl.source_line_id
    ) r on r.source_line_id = dl.id
    left join (
      select il.delivery_line_id, sum(il.quantity) as qty
      from invoice_lines il join invoices i on i.id = il.invoice_id and i.status = 'posted'
      where il.delivery_line_id is not null group by il.delivery_line_id
    ) b on b.delivery_line_id = dl.id
    where n.status = 'posted' and n.type = ${origType} and n.party_id = ${q.partyId}
      ${q.noteId ? sql`and n.id = ${q.noteId}` : sql``}
      and dl.quantity > coalesce(r.qty, 0)
    order by n.note_date desc, n.note_no desc, dl.line_no`);
  return { lines: rows.rows };
}
