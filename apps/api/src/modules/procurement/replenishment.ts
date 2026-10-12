import { sql } from 'drizzle-orm';
import { dec, toDbAmount, type BranchContext } from '@erp/shared';
import type { Tx } from '../../db/client';
import { forbidden } from '../../http/errors';

export function requireCompanyStockScope(branch: BranchContext) {
  if (branch.mode !== 'all' || branch.selection !== 'all')
    throw forbidden('Minimum ve hedef stok şirket toplamına aittir. Bu öneri için tüm şubelere erişim ve Tüm şubeler görünümü gerekli.', 'BRANCH_SCOPE_INSUFFICIENT');
}

/** Eldeki stok + teslim alınmamış sipariş + henüz siparişe dönüşmemiş talep. Tutarlar karıştırılmaz. */
export async function replenishmentSuggestions(tx: Tx, baseCurrency: string) {
  const result = await tx.execute<{ itemId: string; code: string; name: string; unit: string; minLevel: string; targetLevel: string | null; onHand: string; onOrder: string; requested: string; purchasePrice: string | null; purchaseCurrency: string }>(sql`
    with received as (
      select rl.order_line_id,sum(rl.quantity) as qty from po_receipt_lines rl
      join po_receipts r on r.id=rl.receipt_id where r.status='posted' group by rl.order_line_id
    ), orders as (
      select l.item_id,sum(greatest(l.quantity-coalesce(r.qty,0),0)) as qty
      from purchase_order_lines l join purchase_orders o on o.id=l.order_id
      left join received r on r.order_line_id=l.id where o.status in ('draft','issued') group by l.item_id
    ), request_orders as (
      select l.request_line_id,sum(l.quantity) as qty from purchase_order_lines l
      join purchase_orders o on o.id=l.order_id where o.status<>'cancelled' and l.request_line_id is not null group by l.request_line_id
    ), requested as (
      select l.item_id,sum(greatest(l.quantity-coalesce(o.qty,0),0)) as qty
      from purchase_request_lines l join purchase_requests r on r.id=l.request_id
      left join request_orders o on o.request_line_id=l.id
      where r.status in ('draft','submitted','approved','ordered') group by l.item_id
    ), stock as (select item_id,sum(qty) as qty from stock_movements group by item_id)
    select i.id as "itemId",i.code,i.name,i.unit,i.min_level::text as "minLevel",i.target_level::text as "targetLevel",
      coalesce(s.qty,0)::text as "onHand",coalesce(o.qty,0)::text as "onOrder",coalesce(r.qty,0)::text as requested,
      i.purchase_price::text as "purchasePrice",i.purchase_currency as "purchaseCurrency"
    from items i left join stock s on s.item_id=i.id left join orders o on o.item_id=i.id left join requested r on r.item_id=i.id
    where i.is_active and i.kind='goods' and i.min_level is not null and coalesce(s.qty,0)<=i.min_level
    order by i.code`);
  return { baseCurrency, rows: result.rows.map(row => {
    const available = dec(row.onHand).plus(row.onOrder).plus(row.requested);
    const required = row.targetLevel === null ? null : dec(row.targetLevel).minus(available);
    return { ...row, onHand: toDbAmount(row.onHand), onOrder: toDbAmount(row.onOrder), requested: toDbAmount(row.requested),
      projected: toDbAmount(available), suggested: required === null ? null : toDbAmount(required.isPositive() ? required : dec(0)),
      estimateUnitPrice: row.purchaseCurrency === baseCurrency && row.purchasePrice !== null ? dec(row.purchasePrice).toFixed(4) : null };
  }) };
}
