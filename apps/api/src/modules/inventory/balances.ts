import { sql, type SQL } from 'drizzle-orm';
import { dec, formatTR, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import type { ItemState } from './costing';

/** Eksi sıfır ("-0.0000") üretmeden işaret değiştirir. */
export const neg = (d: MoneyValue): MoneyValue => (d.isZero() ? dec(0) : d.neg());

/** Miktarı Türkçe biçimde gösterir, gereksiz sondaki sıfırları atar (12,5 / 3). */
export function fmtQty(value: MoneyValue): string {
  return formatTR(value, 4).replace(/,?0+$/, '');
}

/** `in (a, b, c)` için güvenli uuid listesi. */
export const uuidList = (ids: readonly string[]): SQL => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);

/**
 * Ürünlerin eldeki miktar/değeri (tüm depolar) ve son alış maliyeti. Bakiye ayrı bir tabloda
 * tutulmaz: `stock_movements` toplamıdır. Ürün satırı kilitlendikten sonra çağrılmalıdır.
 */
export async function loadItemStates(tx: Tx, itemIds: readonly string[]): Promise<Map<string, ItemState>> {
  const states = new Map<string, ItemState>();
  for (const id of itemIds) states.set(id, { qty: dec(0), value: dec(0), lastCost: null });
  if (itemIds.length === 0) return states;

  const totals = await tx.execute<{ item_id: string; qty: string; value: string }>(sql`
    select item_id, sum(qty) as qty, sum(value) as value
    from stock_movements where item_id in (${uuidList(itemIds)}) group by item_id`);
  for (const r of totals.rows) {
    const s = states.get(r.item_id)!;
    s.qty = dec(r.qty);
    s.value = dec(r.value);
  }

  // Son alış/devir birim maliyeti (şirket para biriminde): eksi/sıfır bakiyede yedek referans
  const last = await tx.execute<{ item_id: string; cost: string }>(sql`
    select distinct on (m.item_id) m.item_id, m.value / m.qty as cost
    from stock_movements m join stock_documents d on d.id = m.document_id
    where m.item_id in (${uuidList(itemIds)}) and m.kind = 'qty' and m.qty > 0 and m.value > 0
      and d.type in ('receipt', 'opening')
    order by m.item_id, m.seq desc`);
  for (const r of last.rows) states.get(r.item_id)!.lastCost = dec(r.cost);
  return states;
}

export const whKey = (itemId: string, warehouseId: string) => `${itemId}|${warehouseId}`;

/** Ürün × depo eldeki miktarları (belge işlenirken yetersiz stok denetimi için). */
export async function loadWarehouseQty(
  tx: Tx,
  itemIds: readonly string[],
  warehouseIds: readonly string[],
): Promise<Map<string, MoneyValue>> {
  const map = new Map<string, MoneyValue>();
  for (const i of itemIds) for (const w of warehouseIds) map.set(whKey(i, w), dec(0));
  if (itemIds.length === 0 || warehouseIds.length === 0) return map;
  const rows = await tx.execute<{ item_id: string; warehouse_id: string; qty: string }>(sql`
    select item_id, warehouse_id, sum(qty) as qty from stock_movements
    where item_id in (${uuidList(itemIds)}) and warehouse_id in (${uuidList(warehouseIds)})
    group by item_id, warehouse_id`);
  for (const r of rows.rows) map.set(whKey(r.item_id, r.warehouse_id), dec(r.qty));
  return map;
}

/** İşlenecek ürünlerin satırlarını id sırasıyla kilitler (kilit sırası: ürünler, sonra numara). */
export async function lockItems(tx: Tx, itemIds: readonly string[]): Promise<void> {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return;
  await tx.execute(sql`select id from items where id in (${uuidList(ids)}) order by id for update`);
}
