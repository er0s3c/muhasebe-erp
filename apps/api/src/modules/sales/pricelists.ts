import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  dec,
  type AdjustPriceListInput,
  type CopyPriceListInput,
  type CreatePriceListInput,
  type ListPartyPricesQuery,
  type ListPriceListItemsQuery,
  type ListPriceListsQuery,
  type PartyPriceInput,
  type PartyPricingInput,
  type PriceListItemInput,
  type ResolvePriceQuery,
  type UpdatePriceListInput,
  type UpdatePriceListItemInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { TR } from '../../db/search';
import { items, parties, partyPrices, priceListItems, priceLists } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { resolvePrice } from './pricing';

/** Fiyat listeleri, liste fiyat satırları ve cari özel fiyatlar (X3). Çözümleme sırası `pricing.ts` / shared `price-resolution.ts` içindedir. */

async function requireList(tx: Tx, id: string) {
  const [row] = await tx.select().from(priceLists).where(eq(priceLists.id, id));
  if (!row) throw notFound('Fiyat listesi');
  return row;
}

export async function listPriceLists(tx: Tx, q: ListPriceListsQuery) {
  const conds = [];
  if (q.kind) conds.push(sql`l.kind = ${q.kind}`);
  if (q.active) conds.push(sql`l.is_active = ${q.active === 'true'}`);
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.code, l.name, l.kind, l.currency_code as "currencyCode", l.valid_from::text as "validFrom", l.valid_to::text as "validTo",
           l.is_active as "isActive", l.is_default as "isDefault", l.notes,
           (select count(*)::int from price_list_items x where x.price_list_id = l.id) as "itemCount",
           (select count(*)::int from parties p where p.sales_price_list_id = l.id or p.purchase_price_list_id = l.id) as "partyCount"
    from price_lists l ${where}
    order by l.kind, l.code`);
  return { lists: rows.rows };
}

export async function getPriceList(tx: Tx, id: string) {
  const l = await requireList(tx, id);
  const list = (await listPriceLists(tx, {})).lists.find((x) => x.id === id);
  return { list: list ?? l };
}

async function clearDefault(tx: Tx, kind: string, exceptId?: string) {
  await tx
    .update(priceLists)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(exceptId ? and(eq(priceLists.kind, kind), eq(priceLists.isDefault, true), ne(priceLists.id, exceptId)) : and(eq(priceLists.kind, kind), eq(priceLists.isDefault, true)));
}

export async function createPriceList(tx: Tx, companyId: string, input: CreatePriceListInput) {
  const [dup] = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.code, input.code));
  if (dup) throw conflict(`${input.code} kodlu fiyat listesi zaten var`, 'PRICE_LIST_CODE_TAKEN');
  if (input.isDefault) await clearDefault(tx, input.kind);
  const [row] = await tx
    .insert(priceLists)
    .values({
      companyId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      currencyCode: input.currency,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      isActive: input.isActive,
      isDefault: input.isDefault,
      notes: input.notes ?? null,
    })
    .returning();
  return row!;
}

export async function updatePriceList(tx: Tx, id: string, input: UpdatePriceListInput) {
  const cur = await requireList(tx, id);
  const from = input.validFrom === undefined ? cur.validFrom : input.validFrom;
  const to = input.validTo === undefined ? cur.validTo : input.validTo;
  if (from && to && to < from) throw unprocessable('Bitiş tarihi başlangıçtan önce olamaz', 'PRICE_LIST_DATES');
  if (input.isDefault) await clearDefault(tx, cur.kind, id);
  const values: Partial<typeof priceLists.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) values.name = input.name;
  if (input.currency !== undefined) values.currencyCode = input.currency;
  if (input.validFrom !== undefined) values.validFrom = input.validFrom;
  if (input.validTo !== undefined) values.validTo = input.validTo;
  if (input.isActive !== undefined) values.isActive = input.isActive;
  if (input.isDefault !== undefined) values.isDefault = input.isDefault;
  if (input.notes !== undefined) values.notes = input.notes;
  if (input.isActive === false && input.isDefault === undefined) values.isDefault = false;
  const [row] = await tx.update(priceLists).set(values).where(eq(priceLists.id, id)).returning();
  return row!;
}

export async function deletePriceList(tx: Tx, id: string) {
  await requireList(tx, id);
  const used = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from parties where sales_price_list_id = ${id} or purchase_price_list_id = ${id}`);
  if ((used.rows[0]?.n ?? 0) > 0) throw unprocessable('Cariye atanmış liste silinemez; pasifleştirin', 'PRICE_LIST_IN_USE');
  await tx.delete(priceListItems).where(eq(priceListItems.priceListId, id));
  await tx.delete(priceLists).where(eq(priceLists.id, id));
}

// --- Liste satırları -------------------------------------------------------------

export async function listPriceListItems(tx: Tx, listId: string, q: ListPriceListItemsQuery) {
  await requireList(tx, listId);
  const conds = [sql`x.price_list_id = ${listId}`];
  if (q.itemId) conds.push(sql`x.item_id = ${q.itemId}`);
  if (q.query) {
    const like = `%${q.query.replace(/[%_\\]/g, '\\$&')}%`;
    conds.push(sql`(i.code ilike ${like} or i.name ilike ${like})`);
  }
  const where = sql`where ${sql.join(conds, sql` and `)}`;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select x.id, x.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.unit, x.min_qty as "minQty", x.price,
           x.valid_from::text as "validFrom", x.valid_to::text as "validTo"
    from price_list_items x join items i on i.id = x.item_id
    ${where}
    order by i.name collate ${TR}, x.min_qty, x.valid_from nulls first
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from price_list_items x join items i on i.id = x.item_id ${where}`);
  return { items: rows.rows, total: total.rows[0]?.n ?? 0 };
}

async function requireItem(tx: Tx, id: string) {
  const [it] = await tx.select({ id: items.id, isActive: items.isActive, code: items.code }).from(items).where(eq(items.id, id));
  if (!it) throw unprocessable('Stok kartı bulunamadı', 'ITEM_NOT_FOUND');
  return it;
}

export async function addPriceListItem(tx: Tx, companyId: string, listId: string, input: PriceListItemInput) {
  await requireList(tx, listId);
  await requireItem(tx, input.itemId);
  const [row] = await tx
    .insert(priceListItems)
    .values({
      companyId,
      priceListId: listId,
      itemId: input.itemId,
      minQty: dec(input.minQty).toFixed(4),
      price: dec(input.price).toFixed(6),
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
    })
    .returning();
  await touchList(tx, listId);
  return row!;
}

async function touchList(tx: Tx, listId: string) {
  await tx.update(priceLists).set({ updatedAt: new Date() }).where(eq(priceLists.id, listId));
}

export async function updatePriceListItem(tx: Tx, listId: string, rowId: string, input: UpdatePriceListItemInput) {
  const [cur] = await tx.select().from(priceListItems).where(and(eq(priceListItems.id, rowId), eq(priceListItems.priceListId, listId)));
  if (!cur) throw notFound('Fiyat satırı');
  const values: Partial<typeof priceListItems.$inferInsert> = { updatedAt: new Date() };
  if (input.minQty !== undefined) values.minQty = dec(input.minQty).toFixed(4);
  if (input.price !== undefined) values.price = dec(input.price).toFixed(6);
  if (input.validFrom !== undefined) values.validFrom = input.validFrom;
  if (input.validTo !== undefined) values.validTo = input.validTo;
  const from = values.validFrom === undefined ? cur.validFrom : values.validFrom;
  const to = values.validTo === undefined ? cur.validTo : values.validTo;
  if (from && to && to < from) throw unprocessable('Bitiş tarihi başlangıçtan önce olamaz', 'PRICE_LIST_DATES');
  const [row] = await tx.update(priceListItems).set(values).where(eq(priceListItems.id, rowId)).returning();
  await touchList(tx, listId);
  return row!;
}

export async function deletePriceListItem(tx: Tx, listId: string, rowId: string) {
  const res = await tx.delete(priceListItems).where(and(eq(priceListItems.id, rowId), eq(priceListItems.priceListId, listId))).returning({ id: priceListItems.id });
  if (res.length === 0) throw notFound('Fiyat satırı');
  await touchList(tx, listId);
}

/** Toplu giriş (yapıştırma/CSV): stok kodu + kademe + fiyat; aynı kalem/kademe/başlangıç varsa günceller. Bilinmeyen kodlar raporlanır. */
export async function bulkUpsertPriceListItems(
  tx: Tx,
  companyId: string,
  listId: string,
  rows: readonly { itemCode: string; minQty?: string; price: string; validFrom?: string | null; validTo?: string | null }[],
) {
  await requireList(tx, listId);
  const codes = [...new Set(rows.map((r) => r.itemCode))];
  const found = codes.length ? await tx.select({ id: items.id, code: items.code }).from(items).where(inArray(items.code, codes)) : [];
  const byCode = new Map(found.map((i) => [i.code, i.id]));
  let created = 0;
  let updated = 0;
  const unknown: string[] = [];
  for (const r of rows) {
    const itemId = byCode.get(r.itemCode);
    if (!itemId) {
      if (!unknown.includes(r.itemCode)) unknown.push(r.itemCode);
      continue;
    }
    const minQty = dec(r.minQty ?? '0').toFixed(4);
    const existing = await tx.execute<{ id: string }>(sql`
      select id from price_list_items
      where price_list_id = ${listId} and item_id = ${itemId} and min_qty = ${minQty}::numeric
        and coalesce(valid_from, '0001-01-01'::date) = coalesce(${r.validFrom ?? null}::date, '0001-01-01'::date)`);
    if (existing.rows[0]) {
      await tx.update(priceListItems).set({ price: dec(r.price).toFixed(6), validTo: r.validTo ?? null, updatedAt: new Date() }).where(eq(priceListItems.id, existing.rows[0].id));
      updated++;
    } else {
      await tx.insert(priceListItems).values({ companyId, priceListId: listId, itemId, minQty, price: dec(r.price).toFixed(6), validFrom: r.validFrom ?? null, validTo: r.validTo ?? null });
      created++;
    }
  }
  await touchList(tx, listId);
  return { created, updated, unknown };
}

/** Listeyi yeni bir listeye kopyalar (aynı tür ve para birimi); isteğe bağlı yüzde ayarı ve yuvarlama. */
export async function copyPriceList(tx: Tx, companyId: string, sourceId: string, input: CopyPriceListInput) {
  const src = await requireList(tx, sourceId);
  const created = await createPriceList(tx, companyId, {
    code: input.code,
    name: input.name,
    kind: src.kind as 'sales' | 'purchase',
    currency: src.currencyCode as 'TRY' | 'GBP' | 'EUR' | 'USD',
    validFrom: src.validFrom,
    validTo: src.validTo,
    isActive: true,
    isDefault: false,
    notes: src.notes,
  });
  const factor = dec(1).plus(dec(input.adjustPct ?? '0').div(100)).toFixed(10);
  await tx.execute(sql`
    insert into price_list_items (id, company_id, price_list_id, item_id, min_qty, price, valid_from, valid_to)
    select gen_random_uuid(), company_id, ${created.id}, item_id, min_qty,
           round(price * ${factor}::numeric, ${input.decimals}), valid_from, valid_to
    from price_list_items where price_list_id = ${sourceId}`);
  return created;
}

/** Listedeki (ya da seçili kalemlerin) fiyatlarını yüzde oranında günceller. */
export async function adjustPriceList(tx: Tx, listId: string, input: AdjustPriceListInput) {
  await requireList(tx, listId);
  const factor = dec(1).plus(dec(input.pct).div(100)).toFixed(10);
  const itemFilter = input.itemIds?.length ? sql`and item_id in (${sql.join(input.itemIds.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const res = await tx.execute(sql`
    update price_list_items set price = round(price * ${factor}::numeric, ${input.decimals}), updated_at = now()
    where price_list_id = ${listId} ${itemFilter}`);
  await touchList(tx, listId);
  return { updated: res.rowCount ?? 0 };
}

// --- Cari özel fiyatlar -------------------------------------------------------------

export async function listPartyPrices(tx: Tx, q: ListPartyPricesQuery) {
  const conds = [sql`true`];
  if (q.partyId) conds.push(sql`x.party_id = ${q.partyId}`);
  if (q.itemId) conds.push(sql`x.item_id = ${q.itemId}`);
  if (q.kind) conds.push(sql`x.kind = ${q.kind}`);
  const where = sql`where ${sql.join(conds, sql` and `)}`;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select x.id, x.party_id as "partyId", p.code as "partyCode", p.name as "partyName", x.item_id as "itemId", i.code as "itemCode", i.name as "itemName",
           x.kind, x.currency_code as "currencyCode", x.price, x.discount_pct as "discountPct", x.min_qty as "minQty",
           x.valid_from::text as "validFrom", x.valid_to::text as "validTo"
    from party_prices x join parties p on p.id = x.party_id join items i on i.id = x.item_id
    ${where}
    order by p.name collate ${TR}, i.name collate ${TR}, x.min_qty
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from party_prices x ${where}`);
  return { prices: rows.rows, total: total.rows[0]?.n ?? 0 };
}

export async function addPartyPrice(tx: Tx, companyId: string, input: PartyPriceInput) {
  const [p] = await tx.select({ id: parties.id }).from(parties).where(eq(parties.id, input.partyId));
  if (!p) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
  await requireItem(tx, input.itemId);
  const [row] = await tx
    .insert(partyPrices)
    .values({
      companyId,
      partyId: input.partyId,
      itemId: input.itemId,
      kind: input.kind,
      currencyCode: input.price != null ? (input.currency ?? null) : null,
      price: input.price != null ? dec(input.price).toFixed(6) : null,
      discountPct: input.discountPct != null ? dec(input.discountPct).toFixed(4) : null,
      minQty: dec(input.minQty).toFixed(4),
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
    })
    .returning();
  return row!;
}

export async function updatePartyPrice(tx: Tx, id: string, input: PartyPriceInput) {
  const [cur] = await tx.select().from(partyPrices).where(eq(partyPrices.id, id));
  if (!cur) throw notFound('Cari özel fiyat');
  const [row] = await tx
    .update(partyPrices)
    .set({
      partyId: input.partyId,
      itemId: input.itemId,
      kind: input.kind,
      currencyCode: input.price != null ? (input.currency ?? null) : null,
      price: input.price != null ? dec(input.price).toFixed(6) : null,
      discountPct: input.discountPct != null ? dec(input.discountPct).toFixed(4) : null,
      minQty: dec(input.minQty).toFixed(4),
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      updatedAt: new Date(),
    })
    .where(eq(partyPrices.id, id))
    .returning();
  return row!;
}

export async function deletePartyPrice(tx: Tx, id: string) {
  const res = await tx.delete(partyPrices).where(eq(partyPrices.id, id)).returning({ id: partyPrices.id });
  if (res.length === 0) throw notFound('Cari özel fiyat');
}

export async function getPartyPricing(tx: Tx, partyId: string) {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!p) throw notFound('Cari');
  return {
    partyId: p.id,
    salesPriceListId: p.salesPriceListId,
    purchasePriceListId: p.purchasePriceListId,
    salesDiscountPct: p.salesDiscountPct,
    purchaseDiscountPct: p.purchaseDiscountPct,
  };
}

export async function setPartyPricing(tx: Tx, partyId: string, input: PartyPricingInput) {
  await getPartyPricing(tx, partyId);
  const values: Partial<typeof parties.$inferInsert> = {};
  if (input.salesPriceListId !== undefined) values.salesPriceListId = input.salesPriceListId;
  if (input.purchasePriceListId !== undefined) values.purchasePriceListId = input.purchasePriceListId;
  if (input.salesDiscountPct !== undefined) values.salesDiscountPct = dec(input.salesDiscountPct).toFixed(4);
  if (input.purchaseDiscountPct !== undefined) values.purchaseDiscountPct = dec(input.purchaseDiscountPct).toFixed(4);
  if (Object.keys(values).length > 0) await tx.update(parties).set(values).where(eq(parties.id, partyId));
  return getPartyPricing(tx, partyId);
}

// --- Satır girişi için fiyat önerisi ---------------------------------------------------

export async function suggestPrice(tx: Tx, q: ResolvePriceQuery) {
  const [item] = await tx.select().from(items).where(eq(items.id, q.itemId));
  if (!item) throw unprocessable('Stok kartı bulunamadı', 'ITEM_NOT_FOUND');
  return resolvePrice(tx, {
    kind: q.kind,
    item: {
      id: item.id,
      salePrice: item.salePrice,
      saleCurrency: item.saleCurrency,
      purchasePrice: item.purchasePrice,
      purchaseCurrency: item.purchaseCurrency,
    },
    partyId: q.partyId,
    date: q.date,
    currency: q.currency,
    quantity: q.quantity,
  });
}
