import { eq, sql } from 'drizzle-orm';
import type { CreateItemCategoryInput, UpdateItemCategoryInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { itemCategories, items } from '../../db/schema';
import { TR } from '../../db/search';
import { conflict, notFound, unprocessable } from '../../http/errors';

export async function listCategories(tx: Tx) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.is_active as "isActive",
           (select count(*)::int from items i where i.category_id = c.id) as "itemCount"
    from item_categories c order by c.name collate ${TR}`);
  return { categories: rows.rows };
}

async function getRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(itemCategories).where(eq(itemCategories.id, id));
  if (!row) throw notFound('Kategori');
  return row;
}

export async function createCategory(tx: Tx, companyId: string, input: CreateItemCategoryInput) {
  const [dup] = await tx.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.name, input.name));
  if (dup) throw conflict(`"${input.name}" kategorisi zaten var`, 'CATEGORY_NAME_TAKEN');
  const [row] = await tx.insert(itemCategories).values({ companyId, name: input.name }).returning();
  return row!;
}

export async function updateCategory(tx: Tx, id: string, input: UpdateItemCategoryInput) {
  const current = await getRow(tx, id);
  if (input.name !== undefined && input.name !== current.name) {
    const [dup] = await tx.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.name, input.name));
    if (dup) throw conflict(`"${input.name}" kategorisi zaten var`, 'CATEGORY_NAME_TAKEN');
  }
  const values: Partial<typeof itemCategories.$inferInsert> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.isActive !== undefined) values.isActive = input.isActive;
  if (Object.keys(values).length === 0) return current;
  const [row] = await tx.update(itemCategories).set(values).where(eq(itemCategories.id, id)).returning();
  return row!;
}

export async function deleteCategory(tx: Tx, id: string) {
  await getRow(tx, id);
  const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(items).where(eq(items.categoryId, id));
  if (used && used.n > 0) {
    throw unprocessable('Kartı olan kategori silinemez; pasifleştirin', 'CATEGORY_IN_USE');
  }
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(itemCategories).where(eq(itemCategories.id, id)).returning({ id: itemCategories.id });
  if (deleted.length === 0) throw notFound('Kategori');
}

export async function requireCategory(tx: Tx, id: string) {
  const [row] = await tx.select().from(itemCategories).where(eq(itemCategories.id, id));
  if (!row) throw unprocessable('Kategori bulunamadı', 'CATEGORY_NOT_FOUND');
  return row;
}
