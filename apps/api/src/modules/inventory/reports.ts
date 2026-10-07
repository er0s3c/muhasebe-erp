import { sql, type SQL } from 'drizzle-orm';
import { applyRate, dec, sum, toDbAmount, type StockStatusQuery } from '@erp/shared';
import type { Tx } from '../../db/client';
import { TR, trContains } from '../../db/search';
import { pendingDeliveries, type PendingDeliveries } from '../deliveries/reports';
import { findRate } from '../settings/rates';

interface StatusRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  unit: string;
  minLevel: string | null;
  categoryName: string | null;
  isActive: boolean;
  totalQty: string;
  totalValue: string;
  whQty: string;
}

/**
 * Stok durumu ve değerleme (`asOf` tarihi itibarıyla, hareket tarihine göre).
 * Depo süzgecinde değer = depo miktarı × ürünün ortalama maliyeti (depo bazında ayrı değer tutulmaz).
 * Süzgeçsiz istekte 150–157 hesaplarının defter bakiyesiyle mutabakat farkı da döner.
 */
export async function stockStatus(
  tx: Tx,
  ctx: { baseCurrency: string; reportingCurrency: string | null },
  q: StockStatusQuery,
) {
  const conds: SQL[] = [sql`i.kind = 'goods'`];
  if (q.categoryId) conds.push(sql`i.category_id = ${q.categoryId}`);
  if (q.query) conds.push(trContains(['i.name', 'i.code', "coalesce(i.barcode, '')"], q.query));
  const whFilter = q.warehouseId ? sql`filter (where warehouse_id = ${q.warehouseId})` : sql``;

  const rows = await tx.execute<StatusRow>(sql`
    select i.id, i.code, i.name, i.unit, i.min_level as "minLevel", c.name as "categoryName",
           i.is_active as "isActive",
           coalesce(b.total_qty, 0) as "totalQty", coalesce(b.total_value, 0) as "totalValue",
           coalesce(b.wh_qty, 0) as "whQty"
    from items i
    left join item_categories c on c.id = i.category_id
    left join (
      select item_id, sum(qty) as total_qty, sum(value) as total_value, coalesce(sum(qty) ${whFilter}, 0) as wh_qty
      from stock_movements where movement_date <= ${q.asOf}::date group by item_id
    ) b on b.item_id = i.id
    where ${sql.join(conds, sql` and `)}
    order by i.name collate ${TR}, i.code`);

  const all = rows.rows.map((r) => {
    const totalQty = dec(r.totalQty);
    const totalValue = dec(r.totalValue);
    const onHand = dec(r.whQty);
    const avgCost = totalQty.isZero() ? null : totalValue.div(totalQty);
    const value = q.warehouseId ? (avgCost ? onHand.times(avgCost).toDecimalPlaces(2) : dec(0)) : totalValue;
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      categoryName: r.categoryName,
      isActive: r.isActive,
      minLevel: r.minLevel,
      onHand,
      avgCost,
      value,
      // Kritik seviye şirket geneli miktara göre değerlendirilir
      isLow: r.minLevel !== null && totalQty.lte(r.minLevel),
    };
  });

  const includeZero = q.includeZero === 'true';
  const shown = all.filter((r) => {
    if (q.lowOnly === 'true' && !r.isLow) return false;
    if (includeZero || r.isLow) return true;
    return !r.onHand.isZero() || !r.value.isZero();
  });

  const totalValue = sum(shown.map((r) => r.value));
  let reportingValue: string | null = null;
  if (ctx.reportingCurrency && ctx.reportingCurrency !== ctx.baseCurrency) {
    const rate = await findRate(tx, ctx.baseCurrency, ctx.reportingCurrency, q.asOf, ctx.baseCurrency);
    if (rate) reportingValue = toDbAmount(applyRate(totalValue, rate));
  }

  let ledger: {
    accountsBalance: string;
    stockValue: string;
    difference: string;
    /** İrsaliyeler stok defterine girmiş, faturaya bağlanınca yevmiyeye girecek: beklenen fark. */
    pendingDeliveries: PendingDeliveries;
    /** Fark − bekleyen irsaliyeler: sıfırdan farklıysa gerçek bir mutabakat sorunu. */
    unexplained: string;
    workInProgress: string;
  } | null = null;
  if (!q.warehouseId && !q.categoryId && !q.query && q.lowOnly !== 'true') {
    const bal = await tx.execute<{ balance: string }>(sql`
      select coalesce(sum(l.debit_base - l.credit_base), 0) as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
      where e.entry_date <= ${q.asOf}::date and a.code ~ '^15[0-7]'`);
    const wip = await tx.execute<{value:string}>(sql`
      select (
        coalesce((select sum(case when to_key like 'wip:%' then value else 0 end - case when from_key like 'wip:%' then value else 0 end) from leather_cost_events where date<=${q.asOf}::date),0)
        +coalesce((select sum((d->>'amount')::numeric) from leather_cost_corrections c cross join lateral jsonb_array_elements(c.config->'destinations') d where c.date<=${q.asOf}::date and d->>'target' like 'wip:%'),0)
      )::text as value`);
    const workInProgress=dec(wip.rows[0]!.value);
    const accountsBalance = dec(bal.rows[0]!.balance).minus(workInProgress);
    const stockValue = sum(all.map((r) => r.value));
    const difference = stockValue.minus(accountsBalance);
    const pending = await pendingDeliveries(tx, q.asOf);
    ledger = {
      accountsBalance: toDbAmount(accountsBalance),
      stockValue: toDbAmount(stockValue),
      difference: toDbAmount(difference),
      pendingDeliveries: pending.raw,
      unexplained: toDbAmount(difference.minus(pending.total)),
      workInProgress: toDbAmount(workInProgress),
    };
  }

  return {
    asOf: q.asOf,
    baseCurrency: ctx.baseCurrency,
    rows: shown.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      categoryName: r.categoryName,
      isActive: r.isActive,
      minLevel: r.minLevel,
      onHand: toDbAmount(r.onHand),
      avgCost: r.avgCost ? r.avgCost.toFixed(4) : null,
      value: toDbAmount(r.value),
      isLow: r.isLow,
    })),
    totals: {
      itemCount: shown.length,
      lowCount: shown.filter((r) => r.isLow).length,
      value: toDbAmount(totalValue),
      reportingValue,
      reportingCurrency: ctx.reportingCurrency,
    },
    ledger,
  };
}

/** Genel bakış kartları: aktif stoklu kart sayısı, toplam stok değeri, kritik seviyedeki kart sayısı. */
export async function inventorySummary(tx: Tx, asOf: string) {
  const r = await tx.execute<{ items: number; value: string; low: number }>(sql`
    select count(*) filter (where i.is_active)::int as items,
           coalesce(sum(b.total_value), 0) as value,
           count(*) filter (where i.is_active and i.min_level is not null and coalesce(b.total_qty, 0) <= i.min_level)::int as low
    from items i
    left join (
      select item_id, sum(qty) as total_qty, sum(value) as total_value
      from stock_movements where movement_date <= ${asOf}::date group by item_id
    ) b on b.item_id = i.id
    where i.kind = 'goods'`);
  const row = r.rows[0]!;
  return { itemCount: row.items, stockValue: toDbAmount(dec(row.value)), lowCount: row.low };
}
