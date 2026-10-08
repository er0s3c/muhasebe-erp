import { sql } from 'drizzle-orm';
import { dec } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, one } from '../leather/common';

/** Physical quantity and independent commitments; never creates a valuation pool. */
export async function stockAvailability(
  tx: Tx,
  itemId: string,
  warehouseId: string,
  exceptOrderId?: string,
  ownSalesLines: readonly string[] = [],
) {
  const physical = await one(
    tx,
    sql`select coalesce(sum(qty),0)::text as qty from stock_movements where item_id=${itemId}::uuid and warehouse_id=${warehouseId}::uuid`,
  );
  const blocked = await one(
    tx,
    sql`with pieces as (
    select coalesce(d.id,l.id)::text as source,sum(p.remaining_area-case when p.status in ('available','second') then least(p.remaining_area,p.usable_area) else 0 end) as hold
    from leather_pieces p join leather_lots l on l.id=p.lot_id and l.company_id=p.company_id
    left join stock_documents d on d.source_type='delivery_note' and d.source_id=l.delivery_note_id and d.company_id=l.company_id and d.reversal_of_id is null
    where p.item_id=${itemId}::uuid and p.warehouse_id=${warehouseId}::uuid group by coalesce(d.id,l.id)
  ), lots as (
    select coalesce(source_document_id,id)::text as source,sum(case when status in ('quarantine','blocked','damaged') then coalesce(config->>'remainingQty',config->>'quantity')::numeric when config ? 'releasedQty' then greatest(0,coalesce(config->>'remainingQty',config->>'quantity')::numeric-(config->>'releasedQty')::numeric) else 0 end) as hold
    from manufacturing_records where kind='lot' and item_id=${itemId}::uuid and warehouse_id=${warehouseId}::uuid group by coalesce(source_document_id,id)
  ) select coalesce(sum(greatest(coalesce(pieces.hold,0),coalesce(lots.hold,0))),0)::text as qty from pieces full join lots using(source)`,
  );
  const reserved = await one(
    tx,
    sql`select coalesce(sum(case when r.piece_id is null then r.quantity-r.consumed_qty when p.status in ('available','second') then least(r.quantity-r.consumed_qty,p.remaining_area,p.usable_area) else 0 end),0)::text as qty from leather_reservations r left join leather_pieces p on p.id=r.piece_id and p.company_id=r.company_id where r.item_id=${itemId}::uuid and r.warehouse_id=${warehouseId}::uuid and r.status='reserved' ${exceptOrderId ? sql`and r.order_id<>${exceptOrderId}::uuid` : sql``}`,
  );
  const allocations = await all(
    tx,
    sql`select a.sales_order_line_id,a.quantity::text from manufacturing_sales_allocations a join sales_order_lines l on l.id=a.sales_order_line_id and l.company_id=a.company_id join sales_orders o on o.id=l.order_id and o.company_id=l.company_id where a.item_id=${itemId}::uuid and a.warehouse_id=${warehouseId}::uuid and a.status='active' and o.status='confirmed'`,
  );
  const sales = allocations
    .filter((a) => !ownSalesLines.includes(a.sales_order_line_id))
    .reduce<ReturnType<typeof dec>>((s, a) => s.plus(a.quantity), dec(0));
  // Acceptance is counted once per source receipt, even if both hide and WMS trace exist.
  const quality = dec(blocked.qty);
  const free = dec(physical.qty).minus(quality).minus(reserved.qty).minus(sales);
  return {
    physical: physical.qty,
    qualityHold: quality.toFixed(4),
    productionReserved: reserved.qty,
    salesAllocated: sales.toFixed(4),
    available: (free.gt(0) ? free : dec(0)).toFixed(4),
  };
}
