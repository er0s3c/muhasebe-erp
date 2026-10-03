import { sql } from 'drizzle-orm';
import { dec, todayIso, type CreateDeliveryNoteInput, type CreateInvoiceInput, type MoneyValue, type OrderToDeliveryInput, type OrderToInvoiceInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { AppError, unprocessable } from '../../http/errors';
import { createDeliveryDraft, type DeliveryCtx } from '../deliveries/service';
import { uuidList } from '../inventory/balances';
import { createInvoiceDraft, type InvoiceCtx } from '../invoices/service';
import { lockDoc, orderLinesWithUsage } from './orders';

/**
 * Aynı siparişten kaydedilmemiş (taslak) bir belge zaten varsa yenisi açılmaz (API-11): tekrarlanan tıklama/istek ikinci bir taslak
 * üretip aynı kalan miktarı iki kez önermesin. Sipariş satırı kilitli olduğundan eşzamanlı istekler de sıraya girer.
 */
async function assertNoOpenDraft(tx: Tx, orderId: string, kind: 'delivery' | 'invoice') {
  const r =
    kind === 'delivery'
      ? await tx.execute<{ id: string }>(sql`
          select n.id from delivery_notes n
          where n.status = 'draft' and exists (
            select 1 from delivery_note_lines l join sales_order_lines s on s.id = l.sales_order_line_id
             where l.note_id = n.id and s.order_id = ${orderId})
          limit 1`)
      : await tx.execute<{ id: string }>(sql`
          select i.id from invoices i
          where i.status = 'draft' and exists (
            select 1 from invoice_lines l join sales_order_lines s on s.id = l.sales_order_line_id
             where l.invoice_id = i.id and s.order_id = ${orderId})
          limit 1`);
  const id = r.rows[0]?.id;
  if (id) {
    throw kind === 'delivery'
      ? new AppError(409, 'SO_DRAFT_EXISTS', 'Bu siparişten açılmış, henüz kaydedilmemiş bir irsaliye taslağı var; önce onu kaydedin ya da silin', { noteId: id })
      : new AppError(409, 'SO_DRAFT_EXISTS', 'Bu siparişten açılmış, henüz kaydedilmemiş bir fatura taslağı var; önce onu kaydedin ya da silin', { invoiceId: id });
  }
}

/**
 * Siparişten irsaliye TASLAĞI: satış irsaliyesi satırları sipariş satırına bağlanır (karşılanan miktar oradan türer). Verilmeyen
 * satırlarda kalan teslim edilebilir miktar kullanılır. İrsaliyeyi kaydetmek (stok çıkışı) ayrı ve irsaliye yetkisine bağlıdır.
 */
export async function orderToDelivery(tx: Tx, ctx: DeliveryCtx, orderId: string, input: OrderToDeliveryInput) {
  const order = await lockDoc(tx, orderId);
  if (order.kind !== 'order') throw unprocessable('Yalnızca siparişten irsaliye düzenlenir', 'SO_NOT_ORDER');
  if (order.status !== 'confirmed') throw unprocessable('Yalnızca onaylı siparişten irsaliye düzenlenir', 'SO_NOT_CONFIRMED');
  await assertNoOpenDraft(tx, orderId, 'delivery');
  const rows = await orderLinesWithUsage(tx, orderId);
  const asked = new Map((input.lines ?? []).map((l) => [l.lineId, dec(l.quantity)]));
  for (const id of asked.keys()) {
    if (!rows.some((r) => r.line.id === id)) throw unprocessable('Seçilen satır bu siparişte yok', 'SO_LINE_NOT_FOUND');
  }
  const lines: CreateDeliveryNoteInput['lines'] = [];
  for (const { line, usage } of rows) {
    if (!line.isGoods || !line.itemId) {
      if (asked.has(line.id)) throw unprocessable(`${line.description}: hizmet/serbest satır teslim edilmez; faturalanır`, 'SO_LINE_NOT_GOODS');
      continue;
    }
    const remaining = dec(line.quantity).minus(usage.delivered).minus(usage.direct);
    const qty: MoneyValue = asked.get(line.id) ?? (remaining.isPositive() ? remaining : dec(0));
    if (qty.lte(0)) continue;
    lines.push({
      itemId: line.itemId,
      description: line.description,
      quantity: qty.toFixed(4),
      unit: line.unit as never,
      salesOrderLineId: line.id,
    });
  }
  if (lines.length === 0) throw unprocessable('Teslim edilecek kalan miktar yok', 'SO_NOTHING_TO_DELIVER');
  return createDeliveryDraft(tx, ctx, {
    type: 'sales',
    partyId: order.partyId,
    noteDate: input.noteDate ?? todayIso(),
    warehouseId: input.warehouseId ?? order.warehouseId,
    description: `Sipariş ${order.docNo}`,
    lines,
    post: false,
  });
}

interface DeliveredRow extends Record<string, unknown> {
  id: string;
  sales_order_line_id: string;
  remaining: string;
}

/**
 * Siparişten fatura TASLAĞI: teslim edilmiş ama faturalanmamış irsaliye satırları (irsaliyeye bağlı, stok tekrar hareket etmez)
 * sipariş fiyatıyla, hizmet/serbest satırların kalanı doğrudan; isteğe bağlı olarak hiç teslim edilmemiş mal satırları (stok
 * faturada hareket eder). Fiyat/iskonto/KDV siparişten gelir; fatura para birimi siparişinkidir.
 */
export async function orderToInvoice(tx: Tx, ctx: InvoiceCtx, orderId: string, input: OrderToInvoiceInput) {
  const order = await lockDoc(tx, orderId);
  if (order.kind !== 'order') throw unprocessable('Yalnızca siparişten fatura düzenlenir', 'SO_NOT_ORDER');
  if (order.status !== 'confirmed' && order.status !== 'closed') throw unprocessable('Yalnızca onaylı ya da kapalı siparişten fatura düzenlenir', 'SO_NOT_CONFIRMED');
  await assertNoOpenDraft(tx, orderId, 'invoice');
  const rows = await orderLinesWithUsage(tx, orderId);
  const lineIds = rows.map((r) => r.line.id);

  const delivered = await tx.execute<DeliveredRow>(sql`
    select dl.id, dl.sales_order_line_id, dl.quantity - coalesce(b.qty, 0) as remaining
    from delivery_note_lines dl
    join delivery_notes n on n.id = dl.note_id and n.status = 'posted'
    left join (
      select il.delivery_line_id, sum(il.quantity) as qty
      from invoice_lines il join invoices i on i.id = il.invoice_id and i.status = 'posted'
      where il.delivery_line_id is not null group by il.delivery_line_id
    ) b on b.delivery_line_id = dl.id
    where dl.sales_order_line_id in (${uuidList(lineIds)}) and dl.quantity > coalesce(b.qty, 0)
    order by n.note_date, n.note_no, dl.line_no`);

  const lines: CreateInvoiceInput['lines'] = [];
  for (const { line, usage } of rows) {
    let budget = dec(line.quantity).minus(usage.invoiced);
    if (budget.lte(0)) continue;
    const base = {
      itemId: line.itemId,
      description: line.description,
      unit: line.unit as never,
      unitPrice: dec(line.unitPrice).toFixed(6),
      discountPct: dec(line.discountPct).toFixed(4),
      vatCode: line.vatCode,
      salesOrderLineId: line.id,
    };
    if (line.isGoods) {
      for (const d of delivered.rows.filter((r) => r.sales_order_line_id === line.id)) {
        const qty = dec(d.remaining).lt(budget) ? dec(d.remaining) : budget;
        if (qty.lte(0)) break;
        lines.push({ ...base, quantity: qty.toFixed(4), deliveryLineId: d.id });
        budget = budget.minus(qty);
      }
      if (input.includeUndelivered) {
        const free = dec(line.quantity).minus(usage.delivered).minus(usage.direct);
        const qty = free.lt(budget) ? free : budget;
        if (qty.gt(0)) lines.push({ ...base, quantity: qty.toFixed(4) });
      }
    } else {
      lines.push({ ...base, quantity: budget.toFixed(4) });
    }
  }
  if (lines.length === 0) throw unprocessable('Faturalanacak kalan miktar yok (teslim edilmiş mal ya da hizmet satırı bulunamadı)', 'SO_NOTHING_TO_INVOICE');
  return createInvoiceDraft(tx, ctx, {
    type: 'sales',
    partyId: order.partyId,
    invoiceDate: input.invoiceDate ?? todayIso(),
    currency: order.currencyCode as 'TRY' | 'GBP' | 'EUR' | 'USD',
    vatIncluded: order.vatIncluded,
    warehouseId: order.warehouseId,
    description: `Sipariş ${order.docNo}`,
    lines,
    post: false,
  });
}

