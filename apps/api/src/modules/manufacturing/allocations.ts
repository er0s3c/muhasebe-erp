import { sql } from 'drizzle-orm';
import { dec } from '@erp/shared';
import type { Tx } from '../../db/client';
import type { DraftRow } from '../inventory/planner';
import { all, one, newId, fail, type LeatherCtx, type Row } from '../leather/common';
import { orderLineUsage } from '../sales/usage';
import { stockAvailability } from './availability';
import { createRecord } from './service';
import { command } from './commands';
import { queueInventoryChanges } from './channels';
import { lockLeatherCosts } from '../leather/common';

export async function releaseOrderAllocations(
  tx: Tx,
  ctx: { companyId: string; userId: string; baseCurrency: string },
  orderId: string,
  reason: string,
) {
  const company = await one(tx, sql`select sector from companies where id=${ctx.companyId}::uuid`);
  if (!['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'].includes(company.sector)) return;
  await lockLeatherCosts(tx, ctx.companyId);
  const affected = await all(
    tx,
    sql`update manufacturing_sales_allocations set status='released',quantity=0,reason=${reason},updated_at=now() where status='active' and sales_order_line_id in (select id from sales_order_lines where order_id=${orderId}::uuid) returning id,item_id`,
  );
  if (affected.length) {
    const stockCtx = { ...ctx, reportingCurrency: null, allowNegativeStock: false };
    await createRecord(
      tx,
      stockCtx,
      'command_event',
      { code: 'sales-cancel:' + orderId, orderId, reason, allocations: affected.map((a) => a.id) },
      'completed',
    );
    await queueInventoryChanges(
      tx,
      stockCtx,
      'sales-cancel:' + orderId,
      affected.map((a) => a.item_id),
    );
  }
}

export async function allocateSales(tx: Tx, ctx: LeatherCtx, input: Row & { requestKey: string }) {
  return command(tx, ctx, 'sales-allocation', input, async () => {
    const line = await one(
      tx,
      sql`select l.*,o.status,o.kind from sales_order_lines l join sales_orders o on o.id=l.order_id and o.company_id=l.company_id where l.id=${input.salesOrderLineId}::uuid for update of l`,
      'Sipariş satırı',
    );
    if (line.kind !== 'order' || line.status !== 'confirmed' || !line.item_id)
      throw fail('Onaylı stoklu sipariş satırı gerekli');
    await one(
      tx,
      sql`select id from warehouses where id=${input.warehouseId}::uuid and is_active`,
      'Depo',
    );
    const usage = (await orderLineUsage(tx, [line.id])).get(line.id)!;
    const remaining = dec(line.quantity).minus(usage.delivered).minus(usage.direct);
    const other = await one(
      tx,
      sql`select coalesce(sum(quantity),0)::text as qty from manufacturing_sales_allocations where sales_order_line_id=${line.id} and warehouse_id<>${input.warehouseId}::uuid and status='active'`,
    );
    if (dec(input.quantity).plus(other.qty).gt(remaining))
      throw fail('Tahsis siparişin açık miktarını aşamaz');
    const available = await stockAvailability(tx, line.item_id, input.warehouseId, undefined, [
      line.id,
    ]);
    if (dec(input.quantity).gt(available.available))
      throw fail('Serbest stok tahsis için yetersiz', 'MANUFACTURING_ATP_SHORTAGE');
    const record = await one(
      tx,
      sql`insert into manufacturing_sales_allocations(id,company_id,created_by,sales_order_line_id,item_id,warehouse_id,quantity,priority,reason) values(${newId()},${ctx.companyId},${ctx.userId},${line.id},${line.item_id},${input.warehouseId},${input.quantity},${input.priority},${input.reason}) on conflict(company_id,sales_order_line_id,warehouse_id) do update set quantity=excluded.quantity,priority=excluded.priority,reason=excluded.reason,status='active',updated_at=now() returning id,quantity,fulfilled_qty as "fulfilledQty",priority,reason`,
    );
    await queueInventoryChanges(tx, ctx, 'allocation:' + input.requestKey, [line.item_id]);
    return record;
  });
}
export async function sourceSalesLines(
  tx: Tx,
  header: { sourceType?: string | null; sourceId?: string | null },
) {
  if (!header.sourceId || !['invoice', 'delivery_note'].includes(header.sourceType ?? ''))
    return [];
  const table = header.sourceType === 'invoice' ? 'invoice_lines' : 'delivery_note_lines',
    owner = header.sourceType === 'invoice' ? 'invoice_id' : 'note_id';
  return all(
    tx,
    sql`select line_no,item_id,sales_order_line_id from ${sql.identifier(table)} where ${sql.identifier(owner)}=${header.sourceId}::uuid and sales_order_line_id is not null`,
  );
}
export async function settleSalesAllocations(
  tx: Tx,
  ctx: LeatherCtx,
  doc: Row,
  rows: readonly DraftRow[],
) {
  if (doc.reversalOfId) {
    const events = await all(
      tx,
      sql`select config from manufacturing_records where kind='command_event' and config->>'stockDocumentId'=${doc.reversalOfId}`,
    );
    for (const e of events)
      for (const part of e.config.allocations ?? []) {
        const a = await one(
          tx,
          sql`select a.*,o.status as order_status from manufacturing_sales_allocations a join sales_order_lines l on l.id=a.sales_order_line_id join sales_orders o on o.id=l.order_id where a.id=${part.id}::uuid for update of a`,
        );
        await tx.execute(
          sql`update manufacturing_sales_allocations set quantity=quantity+${part.quantity}::numeric,fulfilled_qty=greatest(0,fulfilled_qty-${part.quantity}::numeric),status=${a.order_status === 'confirmed' ? 'active' : 'released'} where id=${a.id}`,
        );
      }
    return;
  }
  const links = await sourceSalesLines(tx, doc),
    allocations = [];
  for (const row of rows.filter((r) => r.kind === 'qty' && r.qty.lt(0))) {
    const link = links.find((l) => l.line_no === row.lineNo && l.item_id === row.itemId);
    if (!link) continue;
    const found = await all(
      tx,
      sql`select * from manufacturing_sales_allocations where sales_order_line_id=${link.sales_order_line_id}::uuid and warehouse_id=${row.warehouseId}::uuid and status='active' for update`,
    );
    if (!found.length) continue;
    const a = found[0]!,
      take = dec(a.quantity).lt(row.qty.abs()) ? dec(a.quantity) : row.qty.abs();
    if (take.lte(0)) continue;
    await tx.execute(
      sql`update manufacturing_sales_allocations set quantity=quantity-${take.toFixed(4)}::numeric,fulfilled_qty=fulfilled_qty+${take.toFixed(4)}::numeric,updated_at=now() where id=${a.id}`,
    );
    allocations.push({ id: a.id, quantity: take.toFixed(4) });
  }
  if (allocations.length)
    await createRecord(
      tx,
      ctx,
      'command_event',
      { code: 'stock-allocation:' + doc.id, stockDocumentId: doc.id, allocations },
      'completed',
    );
}
