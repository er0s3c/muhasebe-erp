import { sql } from 'drizzle-orm';
import { dec, todayIso, type ListReturnInspectionsQuery, type MoneyValue, type ReturnDecisionInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { returnDecisions } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { uuidList, whKey } from '../inventory/balances';
import { postStockDocument } from '../inventory/documents';
import type { DeliveryCtx } from './service';

/**
 * İade kabulünden son karara iş akışı (öneri 52). Kalite kararı istenen satış iadesinde dönen miktar, karar verilene kadar
 * "kalite bekleyen" sayılır: satış irsaliyesiyle bu miktara dokunulamaz, üretim/kanal kullanılabilirliğinden düşülür.
 * Karar parça parça verilir: `restock` satışa açar, `scrap` fire stok belgesiyle stoktan düşer.
 */

/** Kalite bekleyen iade miktarı (kart|depo anahtarıyla). */
export async function pendingReturnHolds(tx: Tx, itemIds: readonly string[], warehouseIds: readonly string[]) {
  const out = new Map<string, MoneyValue>();
  if (itemIds.length === 0 || warehouseIds.length === 0) return out;
  const rows = await tx.execute<{ item_id: string; warehouse_id: string; qty: string }>(sql`
    select l.item_id, n.warehouse_id, sum(l.quantity - coalesce(d.qty, 0))::text as qty
      from delivery_note_lines l
      join delivery_notes n on n.id = l.note_id and n.status = 'posted' and n.inspection_required
      left join (select note_line_id, sum(quantity) as qty from return_decisions group by note_line_id) d on d.note_line_id = l.id
     where l.item_id in (${uuidList(itemIds)}) and n.warehouse_id in (${uuidList(warehouseIds)})
     group by l.item_id, n.warehouse_id
    having sum(l.quantity - coalesce(d.qty, 0)) > 0`);
  for (const r of rows.rows) out.set(whKey(r.item_id, r.warehouse_id), dec(r.qty));
  return out;
}

/**
 * Satış irsaliyesi kalite bekleyen miktara dokunamaz: depodaki miktar − bu irsaliyenin çıkışı, bekleyen iadeden az kalırsa reddedilir.
 */
export async function assertNoHeldIssue(
  tx: Tx,
  warehouseId: string,
  lines: readonly { itemId: string; quantity: string; description: string | null }[],
  whQty: ReadonlyMap<string, MoneyValue>,
) {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const holds = await pendingReturnHolds(tx, itemIds, [warehouseId]);
  if (holds.size === 0) return;
  for (const itemId of itemIds) {
    const hold = holds.get(whKey(itemId, warehouseId));
    if (!hold) continue;
    const out = lines.filter((l) => l.itemId === itemId).reduce<MoneyValue>((s, l) => s.plus(l.quantity), dec(0));
    const after = (whQty.get(whKey(itemId, warehouseId)) ?? dec(0)).minus(out);
    if (after.lt(hold)) {
      const label = lines.find((l) => l.itemId === itemId)?.description ?? 'Kart';
      throw unprocessable(
        `${label}: ${hold.toFixed(4)} birim iade kalite kararı bekliyor; satılabilir miktar yetersiz`,
        'RETURN_INSPECTION_HOLD',
      );
    }
  }
}

interface InspectionRow extends Record<string, unknown> {
  line_id: string;
  note_id: string;
  note_no: string | null;
  note_date: string;
  party_name: string;
  warehouse_name: string;
  item_id: string;
  item_code: string;
  description: string | null;
  quantity: string;
  decided: string;
}

/** Kalite kararı istenen iade satırları, bekleyen miktar ve verilmiş kararlarla. */
export async function listReturnInspections(tx: Tx, q: ListReturnInspectionsQuery) {
  const rows = await tx.execute<InspectionRow>(sql`
    select l.id as line_id, n.id as note_id, n.note_no, n.note_date::text as note_date, p.name as party_name, w.name as warehouse_name,
           l.item_id, it.code as item_code, l.description, l.quantity::text as quantity, coalesce(d.qty, 0)::text as decided
      from delivery_note_lines l
      join delivery_notes n on n.id = l.note_id and n.status = 'posted' and n.inspection_required
      join parties p on p.id = n.party_id
      join warehouses w on w.id = n.warehouse_id
      join items it on it.id = l.item_id
      left join (select note_line_id, sum(quantity) as qty from return_decisions group by note_line_id) d on d.note_line_id = l.id
     where true
       ${q.noteId ? sql`and n.id = ${q.noteId}` : sql``}
       ${q.status === 'pending' ? sql`and l.quantity > coalesce(d.qty, 0)` : q.status === 'decided' ? sql`and l.quantity <= coalesce(d.qty, 0)` : sql``}
     order by n.note_date, n.note_no, l.line_no
     limit 500`);
  const lineIds = rows.rows.map((r) => r.line_id);
  const decisions = lineIds.length
    ? (
        await tx.execute<{ id: string; note_line_id: string; decision: string; reason: string; quantity: string; note: string | null; stock_document_id: string | null; doc_no: string | null; decided_at: string; decided_by_name: string | null }>(sql`
          select r.id, r.note_line_id, r.decision, r.reason, r.quantity::text as quantity, r.note, r.stock_document_id, sd.doc_no,
                 r.decided_at::text as decided_at, u.full_name as decided_by_name
            from return_decisions r
            left join stock_documents sd on sd.id = r.stock_document_id
            left join users u on u.id = r.decided_by
           where r.note_line_id in (${uuidList(lineIds)})
           order by r.decided_at, r.id`)
      ).rows
    : [];
  return {
    lines: rows.rows.map((r) => ({
      lineId: r.line_id,
      noteId: r.note_id,
      noteNo: r.note_no,
      noteDate: r.note_date,
      partyName: r.party_name,
      warehouseName: r.warehouse_name,
      itemId: r.item_id,
      itemCode: r.item_code,
      description: r.description,
      quantity: dec(r.quantity).toFixed(4),
      decided: dec(r.decided).toFixed(4),
      pending: dec(r.quantity).minus(r.decided).toFixed(4),
      decisions: decisions
        .filter((d) => d.note_line_id === r.line_id)
        .map((d) => ({
          id: d.id,
          decision: d.decision,
          reason: d.reason,
          quantity: dec(d.quantity).toFixed(4),
          note: d.note,
          stockDocumentId: d.stock_document_id,
          stockDocumentNo: d.doc_no,
          decidedAt: d.decided_at,
          decidedByName: d.decided_by_name,
        })),
    })),
  };
}

/** İade satırının bir kısmına (ya da tümüne) son kararı verir; hurdada fire stok belgesi kesilir. */
export async function decideReturn(tx: Tx, ctx: DeliveryCtx, input: ReturnDecisionInput) {
  const head = await tx.execute<{ id: string; note_id: string; note_no: string | null; status: string; type: string; inspection_required: boolean; warehouse_id: string; item_id: string; quantity: string }>(sql`
    select l.id, n.id as note_id, n.note_no, n.status, n.type, n.inspection_required, n.warehouse_id, l.item_id, l.quantity::text as quantity
      from delivery_note_lines l join delivery_notes n on n.id = l.note_id
     where l.id = ${input.noteLineId}
       for update of l`);
  const line = head.rows[0];
  if (!line) throw notFound('İade satırı');
  if (line.type !== 'sales_return' || line.status !== 'posted' || !line.inspection_required) {
    throw unprocessable('Kalite kararı yalnız kaydedilmiş, kalite kararı istenen satış iadesine verilir', 'RETURN_INSPECTION_NOT_REQUIRED');
  }
  const decided = await tx.execute<{ qty: string }>(sql`select coalesce(sum(quantity), 0)::text as qty from return_decisions where note_line_id = ${line.id}`);
  const pending = dec(line.quantity).minus(decided.rows[0]!.qty);
  const qty = dec(input.quantity);
  if (qty.gt(pending)) {
    throw unprocessable(`Karar miktarı bekleyen miktarı (${pending.toFixed(4)}) aşamaz`, 'RETURN_DECISION_EXCEEDS');
  }

  let stockDocumentId: string | null = null;
  if (input.decision === 'scrap') {
    const doc = await postStockDocument(tx, ctx, {
      type: 'waste',
      docDate: input.date ?? todayIso(),
      warehouseId: line.warehouse_id,
      description: `İade hurda kararı: ${line.note_no ?? ''}`.trim().slice(0, 200),
      lines: [{ itemId: line.item_id, quantity: qty.toFixed(4) }],
    });
    stockDocumentId = doc.document.id;
  }
  const [row] = await tx
    .insert(returnDecisions)
    .values({
      companyId: ctx.companyId,
      noteLineId: line.id,
      decision: input.decision,
      reason: input.reason,
      quantity: qty.toFixed(4),
      note: input.note ?? null,
      stockDocumentId,
      decidedBy: ctx.userId,
    })
    .returning({ id: returnDecisions.id });
  return { decisionId: row!.id, stockDocumentId, ...(await listReturnInspections(tx, { status: 'all', noteId: line.note_id })) };
}

/** Kalite kararı verilmiş iade irsaliyesi iptal edilemez (hurda belgesi ve satışa açılan miktar geri alınamaz). */
export async function assertNoReturnDecisions(tx: Tx, noteId: string) {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from return_decisions r join delivery_note_lines l on l.id = r.note_line_id where l.note_id = ${noteId}`);
  if ((r.rows[0]?.n ?? 0) > 0) {
    throw unprocessable('Bu iade irsaliyesi için kalite kararı verilmiş; iptal edilemez', 'RETURN_DECIDED');
  }
}
