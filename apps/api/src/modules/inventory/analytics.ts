import { sql } from 'drizzle-orm';
import {
  calculateStockAnalytics,
  type StockAnalyticsInput,
  type StockAnalyticsQuery,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { itemProfitability } from '../invoices/analytics';

export async function stockAnalytics(tx: Tx, baseCurrency: string, q: StockAnalyticsQuery) {
  const balances = await tx.execute<
    Omit<StockAnalyticsInput, 'salesCost'> & Record<string, unknown>
  >(sql`
    select i.id as "itemId", i.code, i.name, i.unit,
      coalesce(b.opening_value,0)::text as "openingValue",
      coalesce(b.closing_value,0)::text as "closingValue",
      coalesce(b.closing_qty,0)::text as "closingQty", b.last_movement::text as "lastMovementDate"
    from items i left join (
      select m.item_id,
        sum(m.value) filter(where m.movement_date < ${q.from}::date) as opening_value,
        sum(m.value) as closing_value, sum(m.qty) as closing_qty,
        max(m.movement_date) filter(where m.kind='qty' and d.type<>'transfer') as last_movement
      from stock_movements m join stock_documents d on d.id=m.document_id
      where m.movement_date<=${q.to}::date group by m.item_id
    ) b on b.item_id=i.id where i.kind='goods' order by i.code`);
  const sales = await itemProfitability(tx, q);
  const costs = new Map(sales.rows.filter((r) => r.itemId).map((r) => [r.itemId, r.cost]));
  return calculateStockAnalytics(
    balances.rows.map((r) => ({ ...r, salesCost: costs.get(r.itemId) ?? '0' })),
    q,
    baseCurrency,
  );
}
