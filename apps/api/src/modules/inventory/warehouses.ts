import { and, eq, ne, sql } from 'drizzle-orm';
import type { CreateWarehouseInput, UpdateWarehouseInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { stockCounts, stockDocuments, warehouses } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { nextNumber } from '../settings/numbering';

async function generateCode(tx: Tx, companyId: string): Promise<string> {
  const n = await nextNumber(tx, companyId, 'WAREHOUSE', 0);
  return `D-${String(n).padStart(3, '0')}`;
}

/** Depolar; miktarlar `stock_movements` toplamından. */
export async function listWarehouses(tx: Tx) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select w.id, w.code, w.name, w.is_default as "isDefault", w.is_active as "isActive",
           coalesce(b.items, 0)::int as "itemCount"
    from warehouses w
    left join (
      select warehouse_id, count(*) filter (where q <> 0) as items
      from (select warehouse_id, item_id, sum(qty) as q from stock_movements group by warehouse_id, item_id) t
      group by warehouse_id
    ) b on b.warehouse_id = w.id
    order by w.is_default desc, w.name`);
  return { warehouses: rows.rows };
}

export async function getWarehouseRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(warehouses).where(eq(warehouses.id, id));
  if (!row) throw notFound('Depo');
  return row;
}

export async function createWarehouse(tx: Tx, companyId: string, input: CreateWarehouseInput) {
  const code = input.code ?? (await generateCode(tx, companyId));
  const [dup] = await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.code, code));
  if (dup) throw conflict(`${code} kodlu depo zaten var`, 'WAREHOUSE_CODE_TAKEN');

  const [existingDefault] = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.isDefault, true));
  // İlk depo otomatik varsayılan olur; sonradan istenirse eskisi bırakılır
  const makeDefault = input.isDefault || !existingDefault;
  if (makeDefault && existingDefault) {
    await tx.update(warehouses).set({ isDefault: false }).where(eq(warehouses.id, existingDefault.id));
  }
  const [row] = await tx
    .insert(warehouses)
    .values({ companyId, code, name: input.name, isDefault: makeDefault })
    .returning();
  return row!;
}

export async function updateWarehouse(tx: Tx, id: string, input: UpdateWarehouseInput) {
  const current = await getWarehouseRow(tx, id);
  if (input.isActive === false && current.isDefault) {
    throw unprocessable('Varsayılan depo pasifleştirilemez; önce başka bir depoyu varsayılan yapın', 'WAREHOUSE_IS_DEFAULT');
  }
  if (input.isActive === false) {
    const stock = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from (
        select 1 from stock_movements where warehouse_id = ${id} group by item_id having sum(qty) <> 0
      ) t`);
    if ((stock.rows[0]?.n ?? 0) > 0) {
      throw unprocessable('Depoda stok varken pasifleştirilemez; önce boşaltın veya transfer edin', 'WAREHOUSE_HAS_STOCK');
    }
  }
  if (input.isDefault) {
    if (!current.isActive) throw unprocessable('Pasif depo varsayılan yapılamaz', 'WAREHOUSE_INACTIVE');
    await tx
      .update(warehouses)
      .set({ isDefault: false })
      .where(and(eq(warehouses.isDefault, true), ne(warehouses.id, id)));
  }
  const values: Partial<typeof warehouses.$inferInsert> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.isActive !== undefined) values.isActive = input.isActive;
  if (input.isDefault) values.isDefault = true;
  if (Object.keys(values).length === 0) return current;
  const [row] = await tx.update(warehouses).set(values).where(eq(warehouses.id, id)).returning();
  return row!;
}

export async function deleteWarehouse(tx: Tx, id: string) {
  // Satır kilitlenir: eşzamanlı silmeler sıraya girer, ikincisi 404 alır (API-11)
  const [current] = await tx.select().from(warehouses).where(eq(warehouses.id, id)).for('update');
  if (!current) throw notFound('Depo');
  if (current.isDefault) throw unprocessable('Varsayılan depo silinemez', 'WAREHOUSE_IS_DEFAULT');
  const [docs] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(stockDocuments)
    .where(sql`${stockDocuments.warehouseId} = ${id} or ${stockDocuments.toWarehouseId} = ${id}`);
  const [counts] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(stockCounts)
    .where(eq(stockCounts.warehouseId, id));
  if ((docs?.n ?? 0) > 0 || (counts?.n ?? 0) > 0) {
    throw unprocessable('Hareketi olan depo silinemez; pasifleştirin', 'WAREHOUSE_HAS_MOVEMENTS');
  }
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(warehouses).where(eq(warehouses.id, id)).returning({ id: warehouses.id });
  if (deleted.length === 0) throw notFound('Depo');
}

export async function requireActiveWarehouse(tx: Tx, id: string, label = 'Depo') {
  const [row] = await tx.select().from(warehouses).where(eq(warehouses.id, id));
  if (!row) throw unprocessable(`${label} bulunamadı`, 'WAREHOUSE_NOT_FOUND');
  if (!row.isActive) throw unprocessable(`${label} pasif: ${row.name}`, 'WAREHOUSE_INACTIVE');
  return row;
}
