import { eq, inArray, sql } from 'drizzle-orm';
import {
  dec,
  isoYear,
  toDbAmount,
  type CreateStockCountInput,
  type RecountStockCountInput,
  type UpdateStockCountInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { TR } from '../../db/search';
import { items, stockCountLines, stockCounts } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { nextDocumentNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { loadItemStates, loadWarehouseQty, lockItems } from './balances';
import { journalStockDocument } from './journal';
import { insertDocument, loadStockableItems, type StockCtx } from './documents';
import { StockPlanner } from './planner';
import { requireActiveWarehouse } from './warehouses';
import { lockLeatherCosts, traceStockDocument } from '../leather/costs';

const COUNT_NUMBER_KEY = 'CNT';

async function getCountRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id));
  if (!row) throw notFound('Sayım');
  return row;
}

async function getDraftRow(tx: Tx, id: string) {
  const row = await getCountRow(tx, id);
  if (row.status !== 'draft') {
    throw unprocessable('Kaydedilmiş sayım değiştirilemez', 'COUNT_NOT_DRAFT');
  }
  return row;
}

export async function createStockCount(tx: Tx, ctx: StockCtx, input: Omit<CreateStockCountInput, 'blind' | 'cycleLimit'> & { blind?: boolean; cycleLimit?: number }) {
  const warehouse = await requireActiveWarehouse(tx, input.warehouseId);
  const [count] = await tx
    .insert(stockCounts)
    .values({
      companyId: ctx.companyId,
      countDate: input.countDate,
      warehouseId: warehouse.id,
      description: input.description ?? null,
      blind: input.blind ?? false,
      recountTolerancePct: input.recountTolerancePct ?? null,
      createdBy: ctx.userId,
    })
    .returning();

  if (input.prefill === 'cycle') {
    // Döngüsel sayım: depoda bakiyesi olan kartlardan en uzun süredir sayılmamış olanlar, eşitlikte değeri yüksek olan önce
    const rows = await tx.execute<{ item_id: string }>(sql`
      select m.item_id
        from stock_movements m join items i on i.id = m.item_id
        left join lateral (
          select max(c.count_date) as last_count from stock_count_lines l join stock_counts c on c.id = l.count_id
           where l.item_id = m.item_id and c.warehouse_id = ${warehouse.id} and c.status = 'posted' and l.counted_qty is not null) lc on true
       where m.warehouse_id = ${warehouse.id} and i.is_active and i.kind = 'goods'
       group by m.item_id, lc.last_count
      having sum(m.qty) <> 0
       order by lc.last_count asc nulls first, abs(sum(m.value)) desc, m.item_id
       limit ${input.cycleLimit ?? 20}`);
    if (rows.rows.length > 0) {
      await tx.insert(stockCountLines).values(rows.rows.map((r) => ({ companyId: ctx.companyId, countId: count!.id, itemId: r.item_id })));
    }
  }

  if (input.prefill === 'in_stock') {
    const rows = await tx.execute<{ item_id: string }>(sql`
      select m.item_id from stock_movements m join items i on i.id = m.item_id
      where m.warehouse_id = ${warehouse.id} and i.is_active and i.kind = 'goods'
      group by m.item_id, i.name having sum(m.qty) <> 0
      order by i.name collate ${TR}`);
    if (rows.rows.length > 0) {
      await tx
        .insert(stockCountLines)
        .values(rows.rows.map((r) => ({ companyId: ctx.companyId, countId: count!.id, itemId: r.item_id })));
    }
  }
  return getStockCount(tx, count!.id);
}

interface CountLineRow extends Record<string, unknown> {
  item_id: string;
  item_code: string;
  item_name: string;
  unit: string;
  counted_qty: string | null;
  system_qty: string | null;
  diff_qty: string | null;
  live_qty: string;
  counted_by: string | null;
  recount_qty: string | null;
  recounted_by: string | null;
}

/** Fark toleransı aşıyor mu: sistem miktarının yüzdesi; sistem sıfırken her fark aşar. */
export function exceedsTolerance(system: string, counted: string, tolerancePct: string | null): boolean {
  if (tolerancePct === null) return false;
  const diff = dec(counted).minus(system).abs();
  if (diff.isZero()) return false;
  const base = dec(system).abs();
  return base.isZero() || diff.gt(base.times(tolerancePct).div(100));
}

interface CountHead extends Record<string, unknown> {
  id: string;
  countNo: string | null;
  countDate: string;
  status: 'draft' | 'posted';
  description: string | null;
  blind: boolean;
  recountTolerancePct: string | null;
  warehouseId: string;
  warehouseName: string;
  documentId: string | null;
  documentNo: string | null;
  documentReversedById: string | null;
  postedAt: Date | null;
  createdAt: Date;
}

/**
 * Sayım ayrıntısı. Kör sayımda (öneri 45) `reveal` olmayan kullanıcı taslakta sistem miktarını, farkı ve yeniden sayım
 * gereğini görmez; yalnız kendi girdiği miktarları görür.
 */
export async function getStockCount(tx: Tx, id: string, opts: { reveal: boolean } = { reveal: true }) {
  const head = await tx.execute<CountHead>(sql`
    select c.id, c.count_no as "countNo", c.count_date::text as "countDate", c.status, c.description,
           c.blind, c.recount_tolerance_pct::text as "recountTolerancePct",
           c.warehouse_id as "warehouseId", w.name as "warehouseName",
           c.document_id as "documentId", d.doc_no as "documentNo", d.reversed_by_id as "documentReversedById",
           c.posted_at as "postedAt", c.created_at as "createdAt"
    from stock_counts c
    join warehouses w on w.id = c.warehouse_id
    left join stock_documents d on d.id = c.document_id
    where c.id = ${id}`);
  const count = head.rows[0];
  if (!count) throw notFound('Sayım');

  const rows = await tx.execute<CountLineRow>(sql`
    select l.item_id, i.code as item_code, i.name as item_name, i.unit, l.counted_qty, l.system_qty, l.diff_qty,
           l.counted_by, l.recount_qty, l.recounted_by,
           coalesce((select sum(m.qty) from stock_movements m
                     where m.item_id = l.item_id and m.warehouse_id = ${count.warehouseId}), 0) as live_qty
    from stock_count_lines l join items i on i.id = l.item_id
    where l.count_id = ${id}
    order by i.name collate ${TR}, i.code`);

  const posted = count.status === 'posted';
  const hidden = count.blind && !posted && !opts.reveal;
  let counted = 0;
  let surplus = 0;
  let shortage = 0;
  const lines = rows.rows.map((r) => {
    // Taslakta sistem miktarı canlı okunur; işlenince sayım anındaki değer saklanır
    const systemQty = posted ? r.system_qty : r.live_qty;
    const effective = r.recount_qty ?? r.counted_qty;
    const diff =
      posted || effective === null ? r.diff_qty : toDbAmount(dec(effective).minus(r.live_qty));
    const recountRequired = !posted && r.counted_qty !== null && r.recount_qty === null && exceedsTolerance(r.live_qty, r.counted_qty, count.recountTolerancePct);
    if (r.counted_qty !== null) counted += 1;
    if (diff !== null && dec(diff).gt(0)) surplus += 1;
    if (diff !== null && dec(diff).lt(0)) shortage += 1;
    return {
      itemId: r.item_id,
      itemCode: r.item_code,
      itemName: r.item_name,
      unit: r.unit,
      countedQty: r.counted_qty,
      countedBy: r.counted_by,
      recountQty: hidden ? null : r.recount_qty,
      recountedBy: hidden ? null : r.recounted_by,
      recountRequired: hidden ? null : recountRequired,
      systemQty: hidden ? null : systemQty,
      diffQty: hidden ? null : diff,
    };
  });
  return {
    count,
    lines,
    summary: {
      lines: lines.length, counted, uncounted: lines.length - counted,
      surplus: hidden ? null : surplus, shortage: hidden ? null : shortage,
      recountRequired: hidden ? null : lines.filter((l) => l.recountRequired).length,
    },
  };
}

export async function listStockCounts(tx: Tx, q: { status?: 'draft' | 'posted'; limit: number; offset: number }) {
  const where = q.status ? sql`where c.status = ${q.status}` : sql``;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.count_no as "countNo", c.count_date::text as "countDate", c.status, c.description,
           w.name as "warehouseName", c.document_id as "documentId",
           (select count(*)::int from stock_count_lines l where l.count_id = c.id) as "lineCount",
           (select count(*)::int from stock_count_lines l where l.count_id = c.id and l.counted_qty is not null) as "countedCount"
    from stock_counts c join warehouses w on w.id = c.warehouse_id
    ${where}
    order by c.count_date desc, c.created_at desc
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from stock_counts c ${where}`);
  return { counts: rows.rows, total: total.rows[0]?.n ?? 0 };
}

export async function updateStockCount(tx: Tx, ctx: StockCtx, id: string, input: UpdateStockCountInput) {
  await getDraftRow(tx, id);
  const values: Partial<typeof stockCounts.$inferInsert> = { updatedAt: new Date() };
  if (input.countDate !== undefined) values.countDate = input.countDate;
  if (input.description !== undefined) values.description = input.description;
  await tx.update(stockCounts).set(values).where(eq(stockCounts.id, id));

  if (input.lines) {
    const ids = input.lines.map((l) => l.itemId);
    if (new Set(ids).size !== ids.length) {
      throw unprocessable('Aynı kart sayımda birden çok kez yer alamaz', 'COUNT_DUPLICATE_ITEM');
    }
    if (ids.length > 0) {
      const found = await tx.select({ id: items.id, kind: items.kind, code: items.code }).from(items).where(inArray(items.id, ids));
      if (found.length !== ids.length) throw unprocessable('Stok kartı bulunamadı', 'ITEM_NOT_FOUND');
      const service = found.find((f) => f.kind !== 'goods');
      if (service) throw unprocessable(`${service.code} hizmet kalemidir, sayılamaz`, 'ITEM_NOT_STOCKED');
    }
    // Değişmeyen satırın ilk sayımı girenini ve yeniden sayımını korur; miktar değişirse sayımı giren bu kullanıcı olur
    const previous = new Map((await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, id))).map((l) => [l.itemId, l]));
    await tx.delete(stockCountLines).where(eq(stockCountLines.countId, id));
    if (ids.length > 0) {
      await tx.insert(stockCountLines).values(
        input.lines.map((l) => {
          const old = previous.get(l.itemId);
          const same = !!old && (old.countedQty === null ? l.countedQty === null : l.countedQty !== null && dec(old.countedQty).eq(l.countedQty));
          return {
            companyId: ctx.companyId,
            countId: id,
            itemId: l.itemId,
            countedQty: l.countedQty,
            countedBy: same ? old!.countedBy : l.countedQty === null ? null : ctx.userId,
            recountQty: same ? old!.recountQty : null,
            recountedBy: same ? old!.recountedBy : null,
          };
        }),
      );
    }
  }
  return getStockCount(tx, id);
}

/** Bağımsız yeniden sayım (öneri 45): yalnız sayılmış satıra, ilk sayımı girenden farklı kullanıcı girer. */
export async function recountStockCount(tx: Tx, ctx: StockCtx, id: string, input: RecountStockCountInput) {
  await getDraftRow(tx, id);
  const lines = new Map((await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, id))).map((l) => [l.itemId, l]));
  for (const r of input.lines) {
    const line = lines.get(r.itemId);
    if (!line || line.countedQty === null) throw unprocessable('Yeniden sayım yalnız sayılmış satıra girilir', 'COUNT_RECOUNT_NOT_COUNTED');
    if (line.countedBy === ctx.userId) throw unprocessable('Yeniden sayımı ilk sayımı girenden farklı biri yapmalı', 'COUNT_RECOUNT_SAME_USER');
    await tx.update(stockCountLines).set({ recountQty: r.recountQty, recountedBy: ctx.userId }).where(eq(stockCountLines.id, line.id));
  }
  return getStockCount(tx, id);
}

export async function deleteStockCount(tx: Tx, id: string) {
  await getDraftRow(tx, id);
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(stockCounts).where(eq(stockCounts.id, id)).returning({ id: stockCounts.id });
  if (deleted.length === 0) throw notFound('Sayım');
}

/**
 * Sayımı işler: fark = sayılan − işleme anındaki depo bakiyesi. Fazla ortalama maliyetle giriş,
 * eksik çıkış olur; tek `count` belgesi üretilir. Sayılmamış (boş) satırlar dikkate alınmaz.
 */
export async function postStockCount(tx: Tx, ctx: StockCtx, id: string) {
  await lockLeatherCosts(tx, ctx.companyId);
  const count = await getDraftRow(tx, id);
  const warehouse = await requireActiveWarehouse(tx, count.warehouseId);
  const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, id));
  const counted = lines.filter((l) => l.countedQty !== null);
  if (counted.length === 0) {
    throw unprocessable('Sayılmış satır yok; en az bir kartın sayım miktarını girin', 'COUNT_EMPTY');
  }

  const itemIds = counted.map((l) => l.itemId);
  const plannerItems = await loadStockableItems(tx, itemIds);
  const period = await requireOpenPeriod(tx, count.countDate);

  await lockItems(tx, itemIds);
  const states = await loadItemStates(tx, itemIds);
  const whQty = await loadWarehouseQty(tx, itemIds, [warehouse.id]);
  const planner = new StockPlanner(states, whQty, {
    allowNegative: ctx.allowNegativeStock,
    items: plannerItems,
    warehouseNames: new Map([[warehouse.id, warehouse.name]]),
  });

  // Tolerans aşan fark bağımsız yeniden sayım olmadan işlenmez (öneri 45); yeniden sayım varsa o miktar esas alınır
  const tolerance = (await tx.select({ t: stockCounts.recountTolerancePct }).from(stockCounts).where(eq(stockCounts.id, id)))[0]?.t ?? null;
  const missing = counted.filter((l) => l.recountQty === null && exceedsTolerance(planner.available(l.itemId, warehouse.id).toString(), l.countedQty!, tolerance));
  if (missing.length > 0) {
    const codes = missing.map((l) => plannerItems.get(l.itemId)!.code);
    throw unprocessable(`Tolerans dışı farkı olan ${missing.length} kart için bağımsız yeniden sayım gerekli: ${codes.slice(0, 5).join(', ')}`, 'COUNT_RECOUNT_REQUIRED', { items: codes });
  }
  const diffs = new Map<string, { system: string; diff: string }>();
  for (const [i, line] of counted.entries()) {
    const system = planner.available(line.itemId, warehouse.id);
    const diff = dec(line.recountQty ?? line.countedQty!).minus(system);
    diffs.set(line.itemId, { system: toDbAmount(system), diff: toDbAmount(diff) });
    if (diff.gt(0)) planner.surplus(i + 1, line.itemId, warehouse.id, diff);
    else if (diff.lt(0)) planner.issue(i + 1, line.itemId, warehouse.id, diff.abs());
  }

  const doc =
    planner.rows.length > 0
      ? await insertDocument(
          tx,
          ctx,
          period.id,
          {
            docDate: count.countDate,
            type: 'count',
            warehouseId: warehouse.id,
            description: count.description ?? `Sayım: ${warehouse.name}`,
          },
          planner.rows,
        )
      : null;
  if (doc) {
    await journalStockDocument(tx, ctx, doc, planner.rows);
    await traceStockDocument(tx, ctx, doc, planner.rows);
  }

  for (const line of counted) {
    const d = diffs.get(line.itemId)!;
    await tx
      .update(stockCountLines)
      .set({ systemQty: d.system, diffQty: d.diff })
      .where(eq(stockCountLines.id, line.id));
  }

  const year = isoYear(count.countDate);
  const countNo = await nextDocumentNumber(tx, ctx.companyId, COUNT_NUMBER_KEY, year, 'SY');
  await tx
    .update(stockCounts)
    .set({
      countNo,
      status: 'posted',
      documentId: doc?.id ?? null,
      postedAt: new Date(),
      postedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .where(eq(stockCounts.id, id));

  const result = await getStockCount(tx, id);
  return {
    ...result,
    warnings: {
      /** Fazla çıkan ama maliyeti bilinmeyen (0) kartlar: alış maliyeti girilene kadar değersiz kalır. */
      zeroCostItems: [...planner.zeroCostItems].map((itemId) => plannerItems.get(itemId)!.code),
    },
  };
}
