import { desc, eq, sql } from 'drizzle-orm';
import {
  dec,
  roundMoney,
  todayIso,
  toDbAmount,
  type CreatePurchaseOrderInput,
  type UpdatePurchaseOrderInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { parties, projects, purchaseOrderLines, purchaseOrders, purchaseRequests, taxRates } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { nextNumber } from '../settings/numbering';
import { validateLineRefs, type ProcurementCtx } from './requests';

export const formatOrderCode = (n: number) => `SIP-${String(n).padStart(4, '0')}`;

export async function lockOrder(tx: Tx, id: string) {
  const [row] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for('update');
  if (!row) throw notFound('Sipariş');
  return row;
}

async function vatRateFor(tx: Tx, vatCode: string | null | undefined, date: string): Promise<string> {
  if (!vatCode) return '0';
  const rows = await tx.select().from(taxRates).where(eq(taxRates.code, vatCode)).orderBy(desc(taxRates.validFrom));
  const hit = rows.find((r) => r.validFrom <= date && (!r.validTo || r.validTo >= date));
  if (!hit) throw unprocessable(`${vatCode} KDV kodu ${date} tarihinde geçerli değil`, 'VAT_CODE_NOT_FOUND');
  return dec(hit.rate).toFixed(4);
}

async function writeLines(tx: Tx, companyId: string, orderId: string, projectId: string, lines: CreatePurchaseOrderInput['lines']) {
  await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.orderId, orderId));
  await tx.insert(purchaseOrderLines).values(
    lines.map((l, i) => ({
      companyId,
      orderId,
      projectId,
      lineNo: i + 1,
      requestLineId: l.requestLineId ?? null,
      itemId: l.itemId ?? null,
      description: l.description,
      unit: l.unit,
      quantity: toDbAmount(dec(l.quantity)),
      unitPrice: toDbAmount(dec(l.unitPrice)),
      wbsId: l.wbsId ?? null,
    })),
  );
}

export async function createOrder(tx: Tx, ctx: ProcurementCtx, input: CreatePurchaseOrderInput & { offerId?: string | null }) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
  if (!project) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
  if (project.status === 'completed' || project.status === 'cancelled') throw unprocessable('Kapalı projeye sipariş açılamaz', 'PROJECT_CLOSED');
  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw unprocessable('Tedarikçi bulunamadı', 'PARTY_NOT_FOUND');
  if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
  if (party.kind === 'customer') throw unprocessable('Sipariş tedarikçi türünde bir cariye verilir', 'PARTY_KIND_MISMATCH');
  await validateLineRefs(tx, input.projectId, input.lines);
  if (input.requestId) {
    const [rq] = await tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, input.requestId));
    if (!rq || !['approved', 'ordered'].includes(rq.status) || rq.projectId !== input.projectId) {
      throw unprocessable('Sipariş yalnızca aynı projenin onaylı talebinden oluşturulur', 'REQUEST_NOT_APPROVED');
    }
  }
  const code = formatOrderCode(await nextNumber(tx, ctx.companyId, 'PURCHASE_ORDER', 0));
  const [row] = await tx
    .insert(purchaseOrders)
    .values({
      companyId: ctx.companyId,
      code,
      projectId: input.projectId,
      partyId: input.partyId,
      requestId: input.requestId ?? null,
      offerId: input.offerId ?? null,
      currencyCode: input.currencyCode,
      vatCode: input.vatCode ?? null,
      paymentDays: input.paymentDays,
      deliveryLocation: input.deliveryLocation ?? null,
      note: input.note ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  await writeLines(tx, ctx.companyId, row!.id, input.projectId, input.lines);
  if (input.requestId) await tx.update(purchaseRequests).set({ status: 'ordered' }).where(sql`${purchaseRequests.id} = ${input.requestId} and ${purchaseRequests.status} = 'approved'`);
  return getOrder(tx, row!.id);
}

export async function updateOrder(tx: Tx, ctx: ProcurementCtx, id: string, input: UpdatePurchaseOrderInput) {
  const o = await lockOrder(tx, id);
  if (o.status !== 'draft') throw unprocessable('Yalnızca taslak sipariş düzenlenir', 'ORDER_NOT_DRAFT');
  if (input.partyId !== o.partyId) throw unprocessable('Siparişin tedarikçisi değiştirilemez; yeni sipariş açın', 'ORDER_PARTY_LOCKED');
  await validateLineRefs(tx, o.projectId, input.lines);
  await writeLines(tx, ctx.companyId, id, o.projectId, input.lines);
  await tx
    .update(purchaseOrders)
    .set({ currencyCode: input.currencyCode, vatCode: input.vatCode ?? null, paymentDays: input.paymentDays, deliveryLocation: input.deliveryLocation ?? null, note: input.note ?? null })
    .where(eq(purchaseOrders.id, id));
  return getOrder(tx, id);
}

export async function deleteOrder(tx: Tx, id: string) {
  const o = await lockOrder(tx, id);
  if (o.status !== 'draft') throw unprocessable('Yalnızca taslak sipariş silinir', 'ORDER_NOT_DRAFT');
  await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, id));
  await releaseRequest(tx, o.requestId);
}

/** Talebin açık/verilmiş siparişi kalmadıysa talep yeniden "onaylı" olur. */
async function releaseRequest(tx: Tx, requestId: string | null) {
  if (!requestId) return;
  const live = await tx.execute(sql`select 1 from purchase_orders where request_id = ${requestId} and status in ('draft', 'issued', 'closed') limit 1`);
  if (live.rows.length === 0) await tx.update(purchaseRequests).set({ status: 'approved' }).where(sql`${purchaseRequests.id} = ${requestId} and ${purchaseRequests.status} = 'ordered'`);
}

/** Siparişi verir: KDV oranı bu tarihte sabitlenir; her satırın iş kalemi (taahhüdün yazıldığı yer) zorunludur. */
export async function issueOrder(tx: Tx, id: string) {
  const o = await lockOrder(tx, id);
  if (o.status !== 'draft') throw unprocessable('Yalnızca taslak sipariş verilir', 'ORDER_NOT_DRAFT');
  const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.orderId, id));
  if (lines.length === 0) throw unprocessable('Satırsız sipariş verilemez', 'ORDER_EMPTY');
  if (lines.some((l) => !l.wbsId)) throw unprocessable('Siparişin her satırında iş kalemi seçilmeli (taahhüt iş kalemine yazılır)', 'ORDER_WBS_REQUIRED');
  const vatRate = await vatRateFor(tx, o.vatCode, todayIso());
  await tx.update(purchaseOrders).set({ status: 'issued', issuedAt: new Date(), vatRate }).where(eq(purchaseOrders.id, id));
  return getOrder(tx, id);
}

export async function cancelOrder(tx: Tx, id: string, reason: string) {
  const o = await lockOrder(tx, id);
  if (o.status !== 'draft' && o.status !== 'issued') throw unprocessable('Bu durumdaki sipariş iptal edilemez', 'ORDER_CANNOT_CANCEL');
  await tx.update(purchaseOrders).set({ status: 'cancelled', cancelReason: reason }).where(eq(purchaseOrders.id, id));
  await releaseRequest(tx, o.requestId);
  return getOrder(tx, id);
}

/** Kısmen teslim alınmış siparişi kapatır: kalan miktar taahhütten düşer. */
export async function closeOrder(tx: Tx, id: string) {
  const o = await lockOrder(tx, id);
  if (o.status !== 'issued') throw unprocessable('Yalnızca verilmiş sipariş kapatılır', 'ORDER_NOT_ISSUED');
  await tx.update(purchaseOrders).set({ status: 'closed' }).where(eq(purchaseOrders.id, id));
  return getOrder(tx, id);
}

export async function getOrder(tx: Tx, id: string) {
  const head = await tx.execute<Record<string, unknown>>(sql`
    select o.id, o.code, o.status, o.project_id as "projectId", p.code as "projectCode", p.name as "projectName",
           o.party_id as "partyId", pa.name as "partyName", o.request_id as "requestId", rq.code as "requestCode",
           o.currency_code as "currencyCode", o.vat_code as "vatCode", o.vat_rate::text as "vatRate", o.payment_days as "paymentDays",
           o.delivery_location as "deliveryLocation", o.note, o.cancel_reason as "cancelReason", o.issued_at as "issuedAt", o.created_at as "createdAt"
      from purchase_orders o
      join projects p on p.id = o.project_id
      join parties pa on pa.id = o.party_id
      left join purchase_requests rq on rq.id = o.request_id
     where o.id = ${id}`);
  const order = head.rows[0];
  if (!order) throw notFound('Sipariş');
  const lines = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.line_no as "lineNo", l.item_id as "itemId", i.code as "itemCode", i.kind as "itemKind", l.description, l.unit,
           l.quantity::text as quantity, l.unit_price::text as "unitPrice", round(l.quantity * l.unit_price, 2)::text as amount,
           l.wbs_id as "wbsId", w.code as "wbsCode",
           coalesce((select sum(rl.quantity) from po_receipt_lines rl join po_receipts r on r.id = rl.receipt_id
                      where rl.order_line_id = l.id and r.status = 'posted'), 0)::numeric(19,4)::text as "receivedQty"
      from purchase_order_lines l
      left join items i on i.id = l.item_id
      left join project_wbs w on w.id = l.wbs_id
     where l.order_id = ${id} order by l.line_no`);
  const net = lines.rows.reduce((s, l) => s.plus(String(l.amount)), dec(0));
  const vat = roundMoney(net.times(String(order.vatRate)).div(100));
  const receipts = await tx.execute<Record<string, unknown>>(sql`
    select r.id, r.receipt_no as "receiptNo", r.receipt_date::text as "receiptDate", r.status, r.note, r.delivery_note_id as "deliveryNoteId",
           r.cancel_reason as "cancelReason"
      from po_receipts r where r.order_id = ${id} order by r.created_at desc`);
  const ordered = lines.rows.reduce((s, l) => s.plus(String(l.quantity)), dec(0));
  const received = lines.rows.reduce((s, l) => s.plus(String(l.receivedQty)), dec(0));
  return {
    order: {
      ...order,
      net: net.toFixed(2),
      vat: vat.toFixed(2),
      gross: net.plus(vat).toFixed(2),
      receiptState: received.isZero() ? 'none' : received.gte(ordered) ? 'complete' : 'partial',
    },
    lines: lines.rows.map((l) => ({ ...l, remainingQty: dec(String(l.quantity)).minus(String(l.receivedQty)).toFixed(4) })),
    receipts: receipts.rows,
  };
}

export async function listOrders(tx: Tx, q: { projectId?: string; partyId?: string; status?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select o.id, o.code, o.status, o.project_id as "projectId", p.code as "projectCode", o.party_id as "partyId", pa.name as "partyName",
           o.currency_code as "currencyCode", o.created_at as "createdAt",
           coalesce((select sum(round(l.quantity * l.unit_price, 2)) from purchase_order_lines l where l.order_id = o.id), 0)::text as net,
           coalesce((select sum(l.quantity) from purchase_order_lines l where l.order_id = o.id), 0)::numeric(19,4)::text as "orderedQty",
           coalesce((select sum(rl.quantity) from po_receipt_lines rl join po_receipts r on r.id = rl.receipt_id
                      join purchase_order_lines l on l.id = rl.order_line_id
                     where l.order_id = o.id and r.status = 'posted'), 0)::numeric(19,4)::text as "receivedQty"
      from purchase_orders o
      join projects p on p.id = o.project_id
      join parties pa on pa.id = o.party_id
     where (${q.projectId ?? null}::uuid is null or o.project_id = ${q.projectId ?? null}::uuid)
       and (${q.partyId ?? null}::uuid is null or o.party_id = ${q.partyId ?? null}::uuid)
       and (${q.status ?? null}::text is null or o.status = ${q.status ?? null}::text)
     order by o.code desc`);
  return { orders: rows.rows };
}
