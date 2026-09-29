import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  INBOUND_DOC_TYPES,
  dec,
  isoYear,
  roundMoney,
  todayIso,
  toDbAmount,
  toDbRate,
  type CreateStockDocumentInput,
  type ListStockDocumentsQuery,
  type MoneyValue,
  type ReverseStockDocumentInput,
  type StockDocType,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { items, journalEntries, stockDocuments, stockMovements } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { reverseJournalEntry } from '../ledger/journal';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { requireRate } from '../settings/rates';
import { loadItemStates, loadWarehouseQty, lockItems, neg, uuidList } from './balances';
import { journalStockDocument, ledgerCtxOf } from './journal';
import { StockPlanner, type DraftRow, type PlannerItem } from './planner';
import { requireActiveWarehouse } from './warehouses';

export interface StockCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
  reportingCurrency: string | null;
  allowNegativeStock: boolean;
}

export const STOCK_NUMBER_KEY = 'STK';
const DOC_PREFIX = 'SH';

/** Satırlardaki kartları doğrular: var olmalı, stok tutan ve aktif olmalı. */
export async function loadStockableItems(tx: Tx, itemIds: readonly string[]): Promise<Map<string, PlannerItem>> {
  const rows = itemIds.length ? await tx.select().from(items).where(inArray(items.id, [...itemIds])) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, PlannerItem>();
  for (const id of itemIds) {
    const it = byId.get(id);
    if (!it) throw unprocessable('Stok kartı bulunamadı', 'ITEM_NOT_FOUND', { itemId: id });
    if (it.kind !== 'goods') {
      throw unprocessable(`${it.code} hizmet kalemidir, stok hareketi görmez`, 'ITEM_NOT_STOCKED');
    }
    if (!it.isActive) throw unprocessable(`${it.code} ${it.name} kartı pasif`, 'ITEM_INACTIVE');
    out.set(id, { code: it.code, name: it.name, unit: it.unit });
  }
  return out;
}

interface Header {
  docDate: string;
  type: StockDocType;
  warehouseId: string;
  toWarehouseId?: string | null;
  description?: string | null;
  reversalOfId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
}

/** Belge başlığını boşluksuz numarayla ve satırlarıyla yazar. Ürünler önceden kilitlenmiş olmalı. */
export async function insertDocument(tx: Tx, ctx: StockCtx, periodId: string, header: Header, rows: DraftRow[]) {
  const year = isoYear(header.docDate);
  const seq = await nextNumber(tx, ctx.companyId, STOCK_NUMBER_KEY, year);
  const [doc] = await tx
    .insert(stockDocuments)
    .values({
      companyId: ctx.companyId,
      docNo: formatDocumentNumber(DOC_PREFIX, year, seq),
      docDate: header.docDate,
      periodId,
      type: header.type,
      warehouseId: header.warehouseId,
      toWarehouseId: header.toWarehouseId ?? null,
      description: header.description ?? null,
      reversalOfId: header.reversalOfId ?? null,
      sourceType: header.sourceType ?? null,
      sourceId: header.sourceId ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  if (rows.length > 0) {
    await tx.insert(stockMovements).values(
      rows.map((r) => ({
        companyId: ctx.companyId,
        documentId: doc!.id,
        lineNo: r.lineNo,
        kind: r.kind,
        itemId: r.itemId,
        warehouseId: r.warehouseId,
        movementDate: header.docDate,
        qty: toDbAmount(r.qty),
        value: toDbAmount(r.value),
        currencyCode: r.currencyCode ?? null,
        unitCost: r.unitCost ?? null,
        fxRate: r.fxRate ?? null,
      })),
    );
  }
  return doc!;
}

export async function postStockDocument(tx: Tx, ctx: StockCtx, input: CreateStockDocumentInput) {
  const warehouse = await requireActiveWarehouse(tx, input.warehouseId, input.type === 'transfer' ? 'Kaynak depo' : 'Depo');
  const toWarehouse = input.toWarehouseId ? await requireActiveWarehouse(tx, input.toWarehouseId, 'Hedef depo') : null;

  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const plannerItems = await loadStockableItems(tx, itemIds);
  const period = await requireOpenPeriod(tx, input.docDate);

  await lockItems(tx, itemIds);
  const states = await loadItemStates(tx, itemIds);
  const whIds = [warehouse.id, ...(toWarehouse ? [toWarehouse.id] : [])];
  const whQty = await loadWarehouseQty(tx, itemIds, whIds);
  const planner = new StockPlanner(states, whQty, {
    allowNegative: ctx.allowNegativeStock,
    items: plannerItems,
    warehouseNames: new Map([warehouse, ...(toWarehouse ? [toWarehouse] : [])].map((w) => [w.id, w.name])),
  });

  const rateCache = new Map<string, MoneyValue>();
  for (const [i, line] of input.lines.entries()) {
    const lineNo = i + 1;
    const qty = dec(line.quantity);
    if (INBOUND_DOC_TYPES.includes(input.type)) {
      const currency = line.currency ?? ctx.baseCurrency;
      let fx: MoneyValue;
      if (currency === ctx.baseCurrency) {
        fx = dec(1);
      } else if (line.fxRate) {
        fx = dec(line.fxRate);
        if (fx.lte(0)) throw unprocessable(`Satır ${lineNo}: kur sıfırdan büyük olmalı`, 'FX_RATE_INVALID');
      } else {
        let cached = rateCache.get(currency);
        if (!cached) {
          cached = await requireRate(tx, currency, ctx.baseCurrency, input.docDate, ctx.baseCurrency);
          rateCache.set(currency, cached);
        }
        fx = cached;
      }
      const unitCost = dec(line.unitCost!);
      // Değer tek seferde yuvarlanır: miktar × birim maliyet × kur
      const valueBase = roundMoney(qty.times(unitCost).times(fx));
      planner.receipt(lineNo, line.itemId, warehouse.id, qty, valueBase, {
        currencyCode: currency,
        unitCost: unitCost.toFixed(6),
        fxRate: toDbRate(fx),
      });
    } else if (input.type === 'transfer') {
      planner.transfer(lineNo, line.itemId, warehouse.id, toWarehouse!.id, qty);
    } else {
      planner.issue(lineNo, line.itemId, warehouse.id, qty);
    }
  }

  const doc = await insertDocument(
    tx,
    ctx,
    period.id,
    {
      docDate: input.docDate,
      type: input.type,
      warehouseId: warehouse.id,
      toWarehouseId: toWarehouse?.id,
      description: input.description,
    },
    planner.rows,
  );
  // Elle girilen belgenin muhasebe kaydı (fatura kaynaklı belgeler kendi yevmiyesini faturadan alır)
  await journalStockDocument(tx, ctx, doc, planner.rows);
  return getStockDocument(tx, doc.id);
}

/**
 * Ters belge: tüm satırların işareti çevrilir (orijinal değerlerle). Yalnızca ilgili ürünlerde
 * bu belgeden sonra hareket yoksa yapılır; böylece durum tam olarak eski haline döner.
 */
export async function reverseStockDocument(
  tx: Tx,
  ctx: StockCtx,
  id: string,
  opts: ReverseStockDocumentInput,
  /** Faturanın iptali gibi kaynak belgenin kendi akışı: kaynak korumasını ve yevmiye tersini kaynak yürütür. */
  fromSource = false,
) {
  const [original] = await tx.select().from(stockDocuments).where(eq(stockDocuments.id, id));
  if (!original) throw notFound('Stok belgesi');
  if (original.sourceType && !fromSource) {
    throw unprocessable(
      'Bu stok belgesi bir faturadan veya irsaliyeden oluştu; ters kaydı ilgili belgeden (fatura/irsaliye iptali) yapın',
      'STOCK_DOC_HAS_SOURCE',
      { sourceType: original.sourceType },
    );
  }
  if (original.reversedById) {
    throw unprocessable('Bu stok belgesi zaten ters çevrilmiş', 'STOCK_DOC_ALREADY_REVERSED');
  }
  if (original.reversalOfId) {
    throw unprocessable('Ters belge tekrar ters çevrilemez; yeni bir hareket girin', 'STOCK_DOC_IS_REVERSAL');
  }

  const docDate = opts.docDate ?? todayIso();
  const period = await requireOpenPeriod(tx, docDate);

  const originalRows = await tx
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.documentId, id))
    .orderBy(stockMovements.seq);
  const itemIds = [...new Set(originalRows.map((r) => r.itemId))];
  await lockItems(tx, itemIds);

  // Sonradan hareket sayılmayanlar: bu belgeden sonra girilip yine bu belgeden sonra tümüyle ters
  // çevrilmiş belge çiftleri. Çift, ürünün durumunu (miktar, değer) olduğu gibi bıraktığı için
  // bu belgenin ters kaydı yine tam geri alma sağlar (örn. sondan başa doğru fatura iptali).
  const later = await tx.execute<{ code: string }>(sql`
    select i.code from stock_movements m
    join items i on i.id = m.item_id
    join stock_documents d on d.id = m.document_id
    where m.item_id in (${uuidList(itemIds)}) and m.document_id <> ${id}
      and m.seq > (select max(x.seq) from stock_movements x where x.document_id = ${id} and x.item_id = m.item_id)
      and not exists (
        select 1 from stock_documents p
        where p.id in (d.reversal_of_id, d.reversed_by_id)
          and (select min(y.seq) from stock_movements y where y.document_id = p.id and y.item_id = m.item_id)
              > (select max(x.seq) from stock_movements x where x.document_id = ${id} and x.item_id = m.item_id)
      )
    limit 1`);
  if (later.rows.length > 0) {
    throw unprocessable(
      `${later.rows[0]!.code} kartında bu belgeden sonra hareket var; ters belge yerine düzeltme hareketi girin`,
      'STOCK_DOC_HAS_LATER_MOVEMENTS',
    );
  }

  const rows: DraftRow[] = originalRows.map((r) => ({
    lineNo: r.lineNo,
    kind: r.kind as DraftRow['kind'],
    itemId: r.itemId,
    warehouseId: r.warehouseId,
    qty: neg(dec(r.qty)),
    value: neg(dec(r.value)),
    currencyCode: r.currencyCode,
    unitCost: r.unitCost,
    fxRate: r.fxRate,
  }));
  const reversal = await insertDocument(
    tx,
    ctx,
    period.id,
    {
      docDate,
      type: original.type as StockDocType,
      warehouseId: original.warehouseId,
      toWarehouseId: original.toWarehouseId,
      description: opts.description ?? `Ters kayıt: ${original.docNo}`,
      reversalOfId: original.id,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
    },
    rows,
  );
  await tx.update(stockDocuments).set({ reversedById: reversal.id }).where(eq(stockDocuments.id, id));

  if (!fromSource) {
    // Belgenin yevmiyesi varsa aynı tarihte ters kaydı yazılır (M6 öncesi belgelerin yevmiyesi yoktur)
    const [je] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.sourceType, 'stock_document'),
          eq(journalEntries.sourceId, id),
          isNull(journalEntries.reversalOfId),
        ),
      );
    if (je) {
      await reverseJournalEntry(tx, ledgerCtxOf(ctx), je.id, {
        entryDate: docDate,
        description: `Ters kayıt: ${original.docNo}`,
        source: { type: 'stock_document', id: reversal.id },
      });
    }
  }
  return getStockDocument(tx, reversal.id);
}

interface LineRow extends Record<string, unknown> {
  line_no: number;
  kind: 'qty' | 'cost_adjust';
  item_id: string;
  item_code: string;
  item_name: string;
  unit: string;
  warehouse_id: string;
  warehouse_name: string;
  qty: string;
  value: string;
  currency_code: string | null;
  unit_cost: string | null;
  fx_rate: string | null;
}

interface DocHead extends Record<string, unknown> {
  id: string;
  docNo: string;
  docDate: string;
  type: StockDocType;
  description: string | null;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  toWarehouseId: string | null;
  toWarehouseName: string | null;
  reversalOfId: string | null;
  reversalOfNo: string | null;
  reversedById: string | null;
  reversedByNo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date;
  countId: string | null;
}

export async function getStockDocument(tx: Tx, id: string) {
  const head = await tx.execute<DocHead>(sql`
    select d.id, d.doc_no as "docNo", d.doc_date::text as "docDate", d.type, d.description,
           d.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name as "warehouseName",
           d.to_warehouse_id as "toWarehouseId", tw.name as "toWarehouseName",
           d.reversal_of_id as "reversalOfId", ro.doc_no as "reversalOfNo",
           d.reversed_by_id as "reversedById", rb.doc_no as "reversedByNo",
           d.source_type as "sourceType", d.source_id as "sourceId", d.created_at as "createdAt",
           (select c.id from stock_counts c where c.document_id = d.id) as "countId"
    from stock_documents d
    join warehouses w on w.id = d.warehouse_id
    left join warehouses tw on tw.id = d.to_warehouse_id
    left join stock_documents ro on ro.id = d.reversal_of_id
    left join stock_documents rb on rb.id = d.reversed_by_id
    where d.id = ${id}`);
  const document = head.rows[0];
  if (!document) throw notFound('Stok belgesi');

  const rows = await tx.execute<LineRow>(sql`
    select m.line_no, m.kind, m.item_id, i.code as item_code, i.name as item_name, i.unit,
           m.warehouse_id, w.name as warehouse_name, m.qty, m.value, m.currency_code, m.unit_cost, m.fx_rate
    from stock_movements m
    join items i on i.id = m.item_id
    join warehouses w on w.id = m.warehouse_id
    where m.document_id = ${id}
    order by m.line_no, m.seq`);

  const isTransfer = document.type === 'transfer';
  const byLine = new Map<number, LineRow[]>();
  for (const r of rows.rows) byLine.set(r.line_no, [...(byLine.get(r.line_no) ?? []), r]);

  let total = dec(0);
  const lines = [...byLine.entries()].map(([lineNo, group]) => {
    const qtyRows = group.filter((r) => r.kind === 'qty');
    const adjustment = group.find((r) => r.kind === 'cost_adjust');
    if (qtyRows.length === 0) {
      // Yalnızca maliyet düzeltmesi taşıyan satır (irsaliyeli alış faturasının fiyat farkı)
      const a = adjustment!;
      return {
        lineNo,
        itemId: a.item_id,
        itemCode: a.item_code,
        itemName: a.item_name,
        unit: a.unit,
        direction: 'adjust' as const,
        warehouseName: a.warehouse_name,
        qty: toDbAmount(0),
        value: toDbAmount(dec(a.value).abs()),
        unitCostBase: null,
        currencyCode: null,
        unitCost: null,
        fxRate: null,
        adjustment: a.value,
      };
    }
    const primary = (isTransfer ? qtyRows.find((r) => dec(r.qty).isNegative()) : qtyRows[0])!;
    const qty = dec(primary.qty).abs();
    const value = dec(primary.value).abs();
    total = total.plus(value);
    const direction = isTransfer ? 'transfer' : dec(primary.qty).isNegative() ? 'out' : 'in';
    return {
      lineNo,
      itemId: primary.item_id,
      itemCode: primary.item_code,
      itemName: primary.item_name,
      unit: primary.unit,
      direction,
      warehouseName: primary.warehouse_name,
      qty: toDbAmount(qty),
      value: toDbAmount(value),
      unitCostBase: qty.isZero() ? null : value.div(qty).toFixed(4),
      currencyCode: primary.currency_code,
      unitCost: primary.unit_cost,
      fxRate: primary.fx_rate,
      adjustment: adjustment ? adjustment.value : null,
    };
  });
  return { document, lines, totalValue: toDbAmount(total) };
}

export async function listStockDocuments(tx: Tx, q: ListStockDocumentsQuery) {
  const conds = [];
  if (q.type) conds.push(sql`d.type = ${q.type}`);
  if (q.from) conds.push(sql`d.doc_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`d.doc_date <= ${q.to}::date`);
  if (q.warehouseId) conds.push(sql`(d.warehouse_id = ${q.warehouseId} or d.to_warehouse_id = ${q.warehouseId})`);
  if (q.itemId) {
    conds.push(sql`exists (select 1 from stock_movements x where x.document_id = d.id and x.item_id = ${q.itemId})`);
  }
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select d.id, d.doc_no as "docNo", d.doc_date::text as "docDate", d.type, d.description,
           w.name as "warehouseName", tw.name as "toWarehouseName",
           d.reversal_of_id as "reversalOfId", d.reversed_by_id as "reversedById",
           coalesce(t.lines, 0)::int as "lineCount", coalesce(t.total, 0) as "totalValue"
    from stock_documents d
    join warehouses w on w.id = d.warehouse_id
    left join warehouses tw on tw.id = d.to_warehouse_id
    left join (
      select m.document_id, count(distinct m.line_no) as lines,
             sum(abs(m.value)) filter (where m.kind = 'qty' and (dd.type <> 'transfer' or m.qty < 0)) as total
      from stock_movements m join stock_documents dd on dd.id = m.document_id
      group by m.document_id
    ) t on t.document_id = d.id
    ${where}
    order by d.doc_date desc, d.doc_no desc
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from stock_documents d ${where}`);
  return { documents: rows.rows, total: total.rows[0]?.n ?? 0 };
}
