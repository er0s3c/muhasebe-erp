import { eq, sql, type SQL } from 'drizzle-orm';
import {
  dec,
  toDbAmount,
  type CreateItemInput,
  type ItemMovementsQuery,
  type ListItemsQuery,
  type UpdateItemInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { TR, trContains } from '../../db/search';
import { items, taxRates } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { nextNumber } from '../settings/numbering';
import { requireCategory } from './categories';

async function generateCode(tx: Tx, companyId: string): Promise<string> {
  const n = await nextNumber(tx, companyId, 'ITEM', 0);
  return `ST-${String(n).padStart(6, '0')}`;
}

async function assertVatCode(tx: Tx, vatCode: string | null | undefined) {
  if (!vatCode) return;
  const [row] = await tx.select({ id: taxRates.id }).from(taxRates).where(eq(taxRates.code, vatCode)).limit(1);
  if (!row) throw unprocessable(`${vatCode} kodlu KDV oranı tanımlı değil`, 'VAT_CODE_UNKNOWN');
}

async function assertBarcodeFree(tx: Tx, barcode: string | null | undefined, exceptId?: string) {
  if (!barcode) return;
  const [dup] = await tx.select({ id: items.id }).from(items).where(eq(items.barcode, barcode));
  if (dup && dup.id !== exceptId) throw conflict(`${barcode} barkodu başka bir kartta kayıtlı`, 'BARCODE_TAKEN');
}

export async function createItem(tx: Tx, companyId: string, input: CreateItemInput) {
  const code = input.code ?? (await generateCode(tx, companyId));
  const [dup] = await tx.select({ id: items.id }).from(items).where(eq(items.code, code));
  if (dup) throw conflict(`${code} kodlu stok kartı zaten var`, 'ITEM_CODE_TAKEN');
  await assertBarcodeFree(tx, input.barcode);
  await assertVatCode(tx, input.vatCode);
  if (input.categoryId) await requireCategory(tx, input.categoryId);

  const [row] = await tx
    .insert(items)
    .values({
      companyId,
      code,
      name: input.name,
      kind: input.kind,
      unit: input.unit,
      categoryId: input.categoryId ?? null,
      barcode: input.barcode ?? null,
      vatCode: input.vatCode ?? null,
      purchasePrice: input.purchasePrice ?? null,
      purchaseCurrency: input.purchaseCurrency,
      salePrice: input.salePrice ?? null,
      saleCurrency: input.saleCurrency,
      minLevel: input.minLevel ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return row!;
}

async function getItemRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(items).where(eq(items.id, id));
  if (!row) throw notFound('Stok kartı');
  return row;
}

async function hasMovements(tx: Tx, id: string): Promise<boolean> {
  const r = await tx.execute<{ n: number }>(sql`
    select (select count(*) from stock_movements where item_id = ${id})
         + (select count(*) from stock_count_lines where item_id = ${id}) as n`);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

export async function updateItem(tx: Tx, id: string, input: UpdateItemInput) {
  const current = await getItemRow(tx, id);
  if (input.kind && input.kind !== current.kind && (await hasMovements(tx, id))) {
    throw unprocessable('Hareketi olan kartın türü değiştirilemez', 'ITEM_KIND_IN_USE');
  }
  if (input.barcode !== undefined) await assertBarcodeFree(tx, input.barcode, id);
  if (input.vatCode !== undefined) await assertVatCode(tx, input.vatCode);
  if (input.categoryId) await requireCategory(tx, input.categoryId);

  const values: Partial<typeof items.$inferInsert> = {};
  for (const key of [
    'name', 'kind', 'unit', 'categoryId', 'barcode', 'vatCode', 'purchasePrice', 'purchaseCurrency',
    'salePrice', 'saleCurrency', 'minLevel', 'notes', 'isActive',
  ] as const) {
    if (input[key] !== undefined) (values as Record<string, unknown>)[key] = input[key];
  }
  if (Object.keys(values).length === 0) return current;
  const [row] = await tx.update(items).set(values).where(eq(items.id, id)).returning();
  return row!;
}

export async function deleteItem(tx: Tx, id: string) {
  await getItemRow(tx, id);
  if (await hasMovements(tx, id)) {
    throw unprocessable('Hareketi olan stok kartı silinemez; pasifleştirin', 'ITEM_HAS_MOVEMENTS');
  }
  await tx.delete(items).where(eq(items.id, id));
}

interface Balance extends Record<string, unknown> {
  qty: string;
  value: string;
}

/** Eldeki miktar/değer ve ortalama maliyet (şirket para biriminde). */
export async function getItem(tx: Tx, id: string) {
  const item = await getItemRow(tx, id);
  const cat = item.categoryId
    ? await tx.execute<{ name: string }>(sql`select name from item_categories where id = ${item.categoryId}`)
    : null;
  const total = await tx.execute<Balance>(sql`
    select coalesce(sum(qty), 0) as qty, coalesce(sum(value), 0) as value from stock_movements where item_id = ${id}`);
  const t = total.rows[0]!;
  const qty = dec(t.qty);
  const value = dec(t.value);
  const avgCost = qty.isZero() ? null : value.div(qty).toFixed(4);

  const byWh = await tx.execute<Record<string, unknown>>(sql`
    select w.id as "warehouseId", w.code, w.name, w.is_active as "isActive", coalesce(sum(m.qty), 0) as qty
    from warehouses w left join stock_movements m on m.warehouse_id = w.id and m.item_id = ${id}
    group by w.id
    having w.is_active or coalesce(sum(m.qty), 0) <> 0
    order by w.is_default desc, w.name`);

  return {
    item: { ...item, categoryName: cat?.rows[0]?.name ?? null },
    stock: {
      qty: toDbAmount(qty),
      value: toDbAmount(value),
      avgCost,
      isLow: item.kind === 'goods' && item.minLevel !== null && qty.lte(item.minLevel),
      byWarehouse: byWh.rows,
    },
  };
}

interface ListRow extends Record<string, unknown> {
  onHand: string;
  totalQty: string;
  totalValue: string;
  value: string;
}

export async function listItems(tx: Tx, q: ListItemsQuery) {
  const conds: SQL[] = [];
  if (q.query) {
    conds.push(trContains(['i.name', 'i.code', "coalesce(i.barcode, '')"], q.query));
  }
  if (q.barcode) conds.push(sql`i.barcode = ${q.barcode}`);
  if (q.categoryId) conds.push(sql`i.category_id = ${q.categoryId}`);
  if (q.kind) conds.push(sql`i.kind = ${q.kind}`);
  if (q.active) conds.push(sql`i.is_active = ${q.active === 'true'}`);
  if (q.lowStock === 'true') {
    conds.push(sql`(i.kind = 'goods' and i.min_level is not null and coalesce(b.total_qty, 0) <= i.min_level)`);
  }
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;

  const whFilter = q.warehouseId ? sql`filter (where warehouse_id = ${q.warehouseId})` : sql``;
  // Depo süzgeci varsa değer = depo miktarı × ürünün ortalama maliyeti (depo bazında değer tutulmaz)
  const valueExpr = q.warehouseId
    ? sql`case when coalesce(b.total_qty, 0) <> 0 then round(coalesce(b.wh_qty, 0) * b.total_value / b.total_qty, 2) else 0 end`
    : sql`coalesce(b.total_value, 0)`;

  const from = sql`
    from items i
    left join item_categories c on c.id = i.category_id
    left join (
      select item_id, sum(qty) as total_qty, sum(value) as total_value, coalesce(sum(qty) ${whFilter}, 0) as wh_qty
      from stock_movements group by item_id
    ) b on b.item_id = i.id
    ${where}`;

  const rows = await tx.execute<ListRow>(sql`
    select i.id, i.code, i.name, i.kind, i.unit, i.barcode, i.is_active as "isActive",
           i.min_level as "minLevel", i.category_id as "categoryId", c.name as "categoryName",
           i.purchase_price as "purchasePrice", i.purchase_currency as "purchaseCurrency",
           i.sale_price as "salePrice", i.sale_currency as "saleCurrency",
           coalesce(b.wh_qty, 0) as "onHand", coalesce(b.total_qty, 0) as "totalQty",
           coalesce(b.total_value, 0) as "totalValue", ${valueExpr} as value,
           (i.kind = 'goods' and i.min_level is not null and coalesce(b.total_qty, 0) <= i.min_level) as "isLow"
    ${from}
    order by i.name collate ${TR}, i.code
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n ${from}`);

  return {
    items: rows.rows.map(({ totalQty, totalValue, ...r }) => ({
      ...r,
      avgCost: dec(totalQty).isZero() ? null : dec(totalValue).div(totalQty).toFixed(4),
    })),
    total: total.rows[0]?.n ?? 0,
  };
}

interface StatementRow extends Record<string, unknown> {
  movement_date: string;
  doc_id: string;
  doc_no: string;
  doc_type: string;
  description: string | null;
  reversal_of_id: string | null;
  kind: 'qty' | 'cost_adjust';
  warehouse_name: string;
  qty: string;
  value: string;
}

/** Stok kartı ekstresi: dönem başı bakiye ve yürüyen miktar/değer (depo süzgecinde yalnızca miktar). */
export async function itemStatement(tx: Tx, id: string, q: ItemMovementsQuery) {
  const item = await getItemRow(tx, id);
  const whCond = q.warehouseId ? sql`and m.warehouse_id = ${q.warehouseId}` : sql``;

  const opening = await tx.execute<Balance>(sql`
    select coalesce(sum(m.qty), 0) as qty, coalesce(sum(m.value), 0) as value
    from stock_movements m where m.item_id = ${id} and m.movement_date < ${q.from}::date ${whCond}`);
  const rows = await tx.execute<StatementRow>(sql`
    select m.movement_date::text as movement_date, d.id as doc_id, d.doc_no, d.type as doc_type, d.description,
           d.reversal_of_id, m.kind, w.name as warehouse_name, m.qty, m.value
    from stock_movements m
    join stock_documents d on d.id = m.document_id
    join warehouses w on w.id = m.warehouse_id
    where m.item_id = ${id} and m.movement_date between ${q.from}::date and ${q.to}::date ${whCond}
    order by m.movement_date, m.seq`);

  const open = opening.rows[0]!;
  let runQty = dec(open.qty);
  let runValue = dec(open.value);
  const lines = rows.rows.map((r) => {
    runQty = runQty.plus(r.qty);
    runValue = runValue.plus(r.value);
    return {
      date: r.movement_date,
      documentId: r.doc_id,
      docNo: r.doc_no,
      type: r.doc_type,
      kind: r.kind,
      isReversal: r.reversal_of_id !== null,
      description: r.description,
      warehouseName: r.warehouse_name,
      qty: r.qty,
      value: r.value,
      balanceQty: toDbAmount(runQty),
      balanceValue: q.warehouseId ? null : toDbAmount(runValue),
    };
  });

  return {
    item: { id: item.id, code: item.code, name: item.name, unit: item.unit },
    from: q.from,
    to: q.to,
    openingQty: toDbAmount(dec(open.qty)),
    openingValue: q.warehouseId ? null : toDbAmount(dec(open.value)),
    lines,
    closingQty: toDbAmount(runQty),
    closingValue: q.warehouseId ? null : toDbAmount(runValue),
  };
}
