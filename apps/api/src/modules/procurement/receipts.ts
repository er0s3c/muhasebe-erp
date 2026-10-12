import { eq, inArray, sql } from 'drizzle-orm';
import { dec, isoYear, toDbAmount, todayIso, type CreateReceiptInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies, items, poReceiptLines, poReceipts, purchaseOrderLines } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { cancelDeliveryNote, postDeliveryNote } from '../deliveries/posting';
import { createDeliveryDraft, type DeliveryCtx } from '../deliveries/service';
import { nextDocumentNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { getOrder, lockOrder } from './orders';
import type { ProcurementCtx } from './requests';

async function deliveryCtx(tx: Tx, ctx: ProcurementCtx): Promise<DeliveryCtx> {
  const [c] = await tx.select({ base: companies.baseCurrency, rep: companies.reportingCurrency, neg: companies.allowNegativeStock }).from(companies).where(sql`${companies.id} = app_company_id()`);
  return { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: c!.base, reportingCurrency: c!.rep, allowNegativeStock: c!.neg };
}

/**
 * Mal kabul: verilmiş siparişe karşı teslim alınan miktar. Kalan miktarı aşamaz (kilit altında doğrulanır).
 * Stoklu (mal kartlı) satırlar için tedarikçi irsaliye numarasıyla bir **alış irsaliyesi** üretilir ve kaydedilir
 * (stok girişi mevcut irsaliye akışıyla, sipariş fiyatı birim maliyet olarak); stoksuz satırlar yalnızca miktar olarak işlenir.
 */
export async function createReceipt(tx: Tx, ctx: ProcurementCtx, orderId: string, input: CreateReceiptInput) {
  const order = await lockOrder(tx, orderId);
  if (order.status !== 'issued') throw unprocessable('Mal kabul yalnızca verilmiş siparişe girilir', 'ORDER_NOT_ISSUED');
  const orderLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.orderId, orderId));
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  // Satır kilitleri (id sırasıyla) ve kalan miktar denetimi
  const ids = input.lines.map((l) => l.orderLineId).sort();
  for (const lid of ids) await tx.execute(sql`select 1 from purchase_order_lines where id = ${lid} for update`);
  const recv = await tx.execute<{ lineId: string; qty: string }>(sql`
    select rl.order_line_id as "lineId", sum(rl.quantity)::text as qty
      from po_receipt_lines rl join po_receipts r on r.id = rl.receipt_id
     where r.status = 'posted' and rl.order_line_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) group by rl.order_line_id`);
  const received = new Map(recv.rows.map((r) => [r.lineId, dec(r.qty)]));
  for (const l of input.lines) {
    const ol = byId.get(l.orderLineId);
    if (!ol) throw unprocessable('Satır siparişe ait değil', 'RECEIPT_LINE_UNKNOWN');
    const remaining = dec(ol.quantity).minus(received.get(l.orderLineId) ?? 0);
    if (dec(l.quantity).gt(remaining)) throw unprocessable(`${ol.description}: kabul miktarı kalan miktarı (${remaining.toFixed(4)}) aşamaz`, 'RECEIPT_OVER_ORDER');
  }

  await requireOpenPeriod(tx, input.receiptDate);
  // Stoklu satırlar → alış irsaliyesi
  const itemIds = [...new Set(input.lines.map((l) => byId.get(l.orderLineId)!.itemId).filter((v): v is string => !!v))];
  const goodsKinds = itemIds.length ? await tx.select({ id: items.id, kind: items.kind }).from(items).where(inArray(items.id, itemIds)) : [];
  const stockIds = new Set(goodsKinds.filter((i) => i.kind === 'goods').map((i) => i.id));
  const stockLines = input.lines.filter((l) => {
    const it = byId.get(l.orderLineId)!.itemId;
    return it && stockIds.has(it);
  });

  let deliveryNoteId: string | null = null;
  if (stockLines.length > 0) {
    if (!input.externalNo) throw unprocessable('Stoklu satır için tedarikçi irsaliye numarası gerekli', 'RECEIPT_EXTERNAL_NO_REQUIRED');
    const dctx = await deliveryCtx(tx, ctx);
    const draft = await createDeliveryDraft(tx, dctx, {
      type: 'purchase',
      partyId: order.partyId,
      noteDate: input.receiptDate,
      externalNo: input.externalNo,
      warehouseId: input.warehouseId ?? null,
      description: `Sipariş ${order.code} mal kabulü`,
      post: false,
      lines: stockLines.map((l) => {
        const ol = byId.get(l.orderLineId)!;
        return { itemId: ol.itemId!, description: ol.description, quantity: dec(l.quantity).toFixed(4), unitCost: dec(ol.unitPrice).toFixed(6), currency: order.currencyCode as 'TRY' | 'GBP' | 'EUR' | 'USD' };
      }),
    } as never);
    const noteId = draft as unknown as string;
    await postDeliveryNote(tx, dctx, noteId);
    deliveryNoteId = noteId;
  }

  const year = isoYear(input.receiptDate);
  const receiptNo = await nextDocumentNumber(tx, ctx.companyId, 'PO_RECEIPT', year, 'MK');
  const [receipt] = await tx
    .insert(poReceipts)
    .values({ companyId: ctx.companyId, orderId, receiptNo, receiptDate: input.receiptDate, deliveryNoteId, note: input.note ?? null, createdBy: ctx.userId })
    .returning();
  await tx.insert(poReceiptLines).values(input.lines.map((l) => ({ companyId: ctx.companyId, receiptId: receipt!.id, orderLineId: l.orderLineId, quantity: toDbAmount(dec(l.quantity)) })));
  return getOrder(tx, orderId);
}

export async function cancelReceipt(tx: Tx, ctx: ProcurementCtx, receiptId: string, reason: string, date?: string) {
  const [r] = await tx.select().from(poReceipts).where(eq(poReceipts.id, receiptId)).for('update');
  if (!r) throw notFound('Mal kabul');
  if (r.status !== 'posted') throw unprocessable('Mal kabul zaten iptal edilmiş', 'RECEIPT_ALREADY_CANCELLED');
  if (r.deliveryNoteId) {
    const dctx = await deliveryCtx(tx, ctx);
    await cancelDeliveryNote(tx, dctx, r.deliveryNoteId, { reason, date: date ?? todayIso() });
  }
  await tx.update(poReceipts).set({ status: 'cancelled', cancelReason: reason, cancelledAt: new Date() }).where(eq(poReceipts.id, receiptId));
  return getOrder(tx, r.orderId);
}
