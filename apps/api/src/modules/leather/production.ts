import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  dec,
  explodeManufacturingNeed,
  roundMoney,
  leatherCompletionShare,
  leatherProductionSchema,
  type LeatherProductionInput,
  type LeatherIssueInput,
  type LeatherMaterialReturnInput,
  type LeatherCompletionInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { loadItemStates, loadWarehouseQty, lockItems } from '../inventory/balances';
import { insertDocument, loadStockableItems } from '../inventory/documents';
import { StockPlanner, type DraftRow } from '../inventory/planner';
import { requireActiveWarehouse } from '../inventory/warehouses';
import { requireOpenPeriod } from '../settings/periods';
import { nextNumber } from '../settings/numbering';
import {
  all,
  one,
  newId,
  json,
  fail,
  requireGoods,
  itemAccounts,
  journalLine,
  journal,
  mapped,
  lockLeatherCosts,
  type LeatherCtx,
  type Row,
} from './common';
import { issueLots, returnLots } from '../manufacturing/lot-trace';
import { completionLots } from '../manufacturing/stock-lots';
import { orderLineUsage } from '../sales/usage';
import { addRoot, moveShares, productionTarget, traceStockDocument } from './costs';
import { stockAvailability } from '../manufacturing/availability';
import { queueInventoryChanges } from '../manufacturing/channels';
import { consumeMaterialHandoffs } from '../manufacturing/handoff';

export async function getProductions(tx: Tx, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  const oRows = await all(
    tx,
    sql`select o.*,i.name as "itemName",r.revision from leather_production_orders o join items i on i.id=o.item_id join leather_revisions r on r.id=o.revision_id where o.id = any(${ids}::uuid[])`,
  );
  const rRows = await all(
    tx,
    sql`select r.id,r.order_id as "orderId",r.item_id as "itemId",i.name as "itemName",r.piece_id as "pieceId",r.quantity,r.consumed_qty as "consumedQty",r.status from leather_reservations r join items i on i.id=r.item_id where r.order_id = any(${ids}::uuid[]) order by r.created_at`,
  );

  const resByOrder = new Map<string, Record<string, unknown>[]>();
  for (const r of rRows) {
    const arr = resByOrder.get(r.orderId as string) || [];
    arr.push({
      id: r.id,
      itemId: r.itemId,
      itemName: r.itemName,
      pieceId: r.pieceId,
      quantity: r.quantity,
      consumedQty: r.consumedQty,
      status: r.status,
    });
    resByOrder.set(r.orderId as string, arr);
  }

  return oRows.map((o) => ({
    id: o.id,
    code: o.code,
    variantId: o.variant_id,
    revisionId: o.revision_id,
    revision: o.revision,
    itemId: o.item_id,
    itemName: o.itemName,
    quantity: o.quantity,
    completedQty: o.completed_qty,
    scrappedQty: o.config.scrappedQty ?? '0',
    wipValue: o.wip_value,
    status: o.status,
    dueDate: o.due_date,
    warehouseId: o.warehouse_id,
    outputWarehouseId: o.output_warehouse_id,
    assignedUserId: o.config.assignedUserId ?? o.created_by,
    reservations: (resByOrder.get(o.id as string) as unknown as Row['reservations']) || [],
    operations: o.config.operations ?? [],
    materials: o.config.materials ?? [],
    note: o.config.note ?? '',
    customOrderId: o.config.customOrderId ?? null,
    salesOrderLineId: o.config.salesOrderLineId ?? null,
    salesOrderId: o.config.salesOrderId ?? null,
    parentOrderId: o.config.parentOrderId ?? null,
  }));
}

export async function getProduction(tx: Tx, id: string): Promise<Row> {
  const list = await getProductions(tx, [id]);
  if (!list[0]) throw fail('Üretim emri bulunamadı');
  return list[0];
}
export async function documentsFor(tx: Tx, id: string): Promise<Row[]> {
  return all(
    tx,
    sql`select id,order_id as "orderId",kind,date,quantity,value,stock_document_id as "stockDocumentId",journal_entry_id as "journalEntryId",request_key as "requestKey",config from leather_production_documents where order_id=${id}::uuid order by created_at`,
  );
}
async function lockedOrder(tx: Tx, id: string): Promise<Row> {
  return one(
    tx,
    sql`select * from leather_production_orders where id=${id}::uuid for update`,
    'Üretim emri',
  );
}
function requireExecutionOpen(o: Row, qualityReceipt = false) {
  if (
    ['on_hold', 'closed', 'paused', ...(!qualityReceipt ? ['quality_waiting'] : [])].includes(
      o.config.executionPhase,
    )
  )
    throw fail('Üretim aşaması bu işleme kapalı; önce onaylı aşama değişikliği yapın');
}
export async function availableStock(
  tx: Tx,
  itemId: string,
  warehouseId: string,
  exceptOrderId?: string,
): Promise<string> {
  return (await stockAvailability(tx, itemId, warehouseId, exceptOrderId)).available;
}
async function existing(tx: Tx, key: string, orderId: string, kind: string): Promise<Row | null> {
  const d = await all(
    tx,
    sql`select * from leather_production_documents where request_key=${key}::uuid`,
  );
  if (!d[0]) return null;
  if (d[0].order_id !== orderId || d[0].kind !== kind)
    throw fail('İstek kimliği farklı işlemde kullanıldı', 'LEATHER_REQUEST_KEY_CONFLICT');
  return d[0];
}
export async function saveDocument(
  tx: Tx,
  ctx: LeatherCtx,
  p: {
    id: string;
    orderId: string;
    kind: string;
    date: string;
    requestKey: string;
    quantity?: string;
    value?: string;
    stockDocumentId?: string | null;
    journalEntryId?: string | null;
    config?: unknown;
  },
): Promise<Row> {
  return one(
    tx,
    sql`insert into leather_production_documents(id,company_id,created_by,order_id,kind,date,request_key,quantity,value,stock_document_id,journal_entry_id,config) values(${p.id},${ctx.companyId},${ctx.userId},${p.orderId},${p.kind},${p.date},${p.requestKey},${p.quantity ?? '0'},${p.value ?? '0'},${p.stockDocumentId ?? null},${p.journalEntryId ?? null},${json(p.config ?? {})}) returning *`,
  );
}
export async function createProduction(
  tx: Tx,
  ctx: LeatherCtx,
  input: LeatherProductionInput,
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  const variant = await one(
    tx,
    sql`select v.*,r.status,r.config as recipe from leather_variants v join leather_revisions r on r.id=v.revision_id where v.id=${input.variantId}::uuid`,
    'Varyant',
  );
  if (variant.revision_id !== input.revisionId || variant.status !== 'approved')
    throw fail('Varyantın onaylı reçete revizyonu seçilmeli', 'LEATHER_REVISION_REQUIRED');
  await requireGoods(tx, variant.item_id);
  await requireActiveWarehouse(tx, input.warehouseId);
  await requireActiveWarehouse(tx, input.outputWarehouseId);
  for (const selection of input.materialAlternatives) {
    const line = variant.recipe.materials.find((m: Row) => m.itemId === selection.itemId);
    if (!line || !line.alternatives?.includes(selection.alternativeId))
      throw fail('Alternatif malzeme onaylı reçetede tanımlı olmalı');
    await requireGoods(tx, selection.alternativeId);
    line.originalItemId = line.itemId;
    line.itemId = selection.alternativeId;
  }
  const assignedUserId = input.assignedUserId ?? ctx.userId;
  await one(
    tx,
    sql`select m.user_id from memberships m join users u on u.id=m.user_id where m.company_id=${ctx.companyId}::uuid and m.user_id=${assignedUserId}::uuid and u.is_active`,
    'Atölye görevlisi',
  );
  if (input.salesOrderLineId) {
    const source = await one(
      tx,
      sql`select l.*,o.status,o.kind from sales_order_lines l join sales_orders o on o.id=l.order_id where l.id=${input.salesOrderLineId}::uuid for update of l`,
      'Satış sipariş satırı',
    );
    if (
      source.status !== 'confirmed' ||
      source.kind !== 'order' ||
      source.item_id !== variant.item_id
    )
      throw fail('Üretim aynı varyantın onaylı satış siparişine bağlanmalı');
    const booked = await one(
      tx,
      sql`select coalesce(sum(case when status='completed' then completed_qty else quantity end),0)::text as qty from leather_production_orders where config->>'salesOrderLineId'=${source.id} and status<>'cancelled'`,
    );
    if (dec(booked.qty).plus(input.quantity).gt(source.quantity))
      throw fail('Planlanan üretim satış siparişi satırını aşamaz');
  }
  if (input.customOrderId) {
    const custom = await one(
      tx,
      sql`select * from leather_custom_orders where id=${input.customOrderId}::uuid for update`,
      'Kişiye özel sipariş',
    );
    if (custom.variant_id !== input.variantId || custom.status !== 'confirmed')
      throw fail('Onaylı kişisel sipariş varyantı gerekli');
    const booked = await one(
      tx,
      sql`select coalesce(sum(quantity),0)::text as qty from leather_production_orders where config->>'customOrderId'=${input.customOrderId} and status<>'cancelled'`,
    );
    if (dec(booked.qty).plus(input.quantity).gt(custom.quantity))
      throw fail('Üretim kişisel sipariş miktarını aşamaz');
  }
  const reservations = input.reservations.length
    ? input.reservations
    : variant.recipe.materials.map((l: Row) => ({
        itemId: l.itemId,
        quantity: dec(l.quantity)
          .times(input.quantity)
          .times(dec(1).plus(dec(l.wastePct ?? 0).div(100)))
          .toDecimalPlaces(4)
          .toFixed(4),
        pieceId: null,
      }));
  const n = await nextNumber(tx, ctx.companyId, 'LEATHER_PRODUCTION', 0);
  const id = newId();
  const standardStates = await loadItemStates(
    tx,
    variant.recipe.materials.map((m: Row) => m.itemId),
  );
  const standardMaterialCosts = variant.recipe.materials.map((m: Row) => {
    const state = standardStates.get(m.itemId)!;
    const quantity = dec(m.quantity)
      .times(input.quantity)
      .times(dec(1).plus(dec(m.wastePct ?? 0).div(100)));
    const unitCost = state.qty.gt(0) ? state.value.div(state.qty) : dec(state.lastCost ?? 0);
    return {
      itemId: m.itemId,
      quantity: quantity.toFixed(4),
      unitCost: unitCost.toFixed(4),
      value: quantity.times(unitCost).toFixed(2),
    };
  });
  const standardMaterialValue = standardMaterialCosts
    .reduce((sum: ReturnType<typeof dec>, m: Row) => sum.plus(m.value), dec(0))
    .toFixed(2);
  await tx.execute(
    sql`insert into leather_production_orders(id,company_id,created_by,code,variant_id,revision_id,item_id,warehouse_id,output_warehouse_id,quantity,due_date,config) values(${id},${ctx.companyId},${ctx.userId},${'URE-' + String(n).padStart(6, '0')},${variant.id},${input.revisionId},${variant.item_id},${input.warehouseId},${input.outputWarehouseId},${input.quantity},${input.dueDate ?? null},${json({ ...variant.recipe, standardMaterialValue, standardMaterialCosts, standardAt: new Date().toISOString(), assignedUserId, salesOrderLineId: input.salesOrderLineId ?? null, customOrderId: input.customOrderId ?? null, note: input.note })})`,
  );
  for (const r of reservations) {
    await requireGoods(tx, r.itemId);
    if (r.pieceId) {
      const p = await one(
        tx,
        sql`select * from leather_pieces where id=${r.pieceId}::uuid`,
        'Deri parçası',
      );
      if (p.item_id !== r.itemId || p.warehouse_id !== input.warehouseId)
        throw fail('Parça rezervasyon stok/depo seçimiyle uyuşmuyor');
    }
    await tx.execute(
      sql`insert into leather_reservations(id,company_id,created_by,order_id,item_id,piece_id,warehouse_id,quantity) values(${newId()},${ctx.companyId},${ctx.userId},${id},${r.itemId},${r.pieceId ?? null},${input.warehouseId},${r.quantity})`,
    );
  }
  return getProduction(tx, id);
}
export async function releaseProduction(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: { date: string; requestKey: string; note: string },
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  await requireOpenPeriod(tx, input.date);
  if (await existing(tx, input.requestKey, id, 'release')) return getProduction(tx, id);
  const o = await lockedOrder(tx, id);
  if (o.status !== 'planned') throw fail('Yalnızca planlanan emir serbest bırakılır');
  requireExecutionOpen(o);
  const res = await all(tx, sql`select * from leather_reservations where order_id=${id}::uuid`);
  await lockItems(
    tx,
    res.map((r) => r.item_id),
  );
  for (const itemId of [...new Set(res.map((r) => r.item_id))]) {
    const free = await availableStock(tx, itemId, o.warehouse_id, id);
    const need = res
      .filter((r) => r.item_id === itemId)
      .reduce((s, r) => s.plus(r.quantity), dec(0));
    if (need.gt(free))
      throw fail(
        'Serbest ve kalite kabul edilmiş stok rezervasyon için yetersiz',
        'LEATHER_RESERVATION_SHORTAGE',
      );
  }
  for (const r of res.filter((r) => r.piece_id)) {
    const p = await one(
      tx,
      sql`select * from leather_pieces where id=${r.piece_id}::uuid for update`,
    );
    if (!['available', 'second'].includes(p.status) || dec(p.remaining_area).lt(r.quantity))
      throw fail('Rezervasyon parçası kabul edilmemiş veya alan yetersiz');
    const used = await one(
      tx,
      sql`select coalesce(sum(quantity-consumed_qty),0)::text as qty from leather_reservations where piece_id=${r.piece_id}::uuid and order_id<>${id}::uuid and status='reserved'`,
    );
    if (dec(used.qty).plus(r.quantity).gt(p.remaining_area))
      throw fail('Parça başka emre rezerve edilmiş');
  }
  await tx.execute(
    sql`update leather_reservations set status='reserved' where order_id=${id}::uuid`,
  );
  await tx.execute(
    sql`update leather_production_orders set status='released' where id=${id}::uuid`,
  );
  for (const kind of ['labor', 'subcontract', 'overhead'])
    await addRoot(
      tx,
      ctx,
      { type: 'production_order', id, kind, orderId: id, quantity: o.quantity, value: '0' },
      productionTarget(id),
    );
  await saveDocument(tx, ctx, {
    id: newId(),
    orderId: id,
    kind: 'release',
    date: input.date,
    requestKey: input.requestKey,
    config: input,
  });
  await queueInventoryChanges(
    tx,
    ctx,
    'production-release:' + input.requestKey,
    o.config.materials.map((m: Row) => m.itemId),
  );
  return getProduction(tx, id);
}
export async function issueProduction(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: LeatherIssueInput,
  extra: Record<string, unknown> = {},
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  const duplicate = await existing(tx, input.requestKey, id, 'issue');
  if (duplicate) return duplicate;
  const o = await lockedOrder(tx, id);
  if (!['released', 'in_progress'].includes(o.status))
    throw fail('Sarf için serbest bırakılmış üretim gerekli');
  requireExecutionOpen(o);
  const period = await requireOpenPeriod(tx, input.date);
  if (input.batchId)
    await one(
      tx,
      sql`select id from manufacturing_records where id=${input.batchId}::uuid and kind='batch' and order_id=${id}::uuid and status in ('planned','in_progress')`,
      'Emrin üretim partisi',
    );
  if (extra.issueWarehouseId) {
    await requireActiveWarehouse(tx, String(extra.issueWarehouseId));
    o.warehouse_id = extra.issueWarehouseId;
  }
  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const goods = await loadStockableItems(tx, itemIds);
  await lockItems(tx, itemIds);
  const states = await loadItemStates(tx, itemIds);
  const wh = await loadWarehouseQty(tx, itemIds, [o.warehouse_id]);
  const planner = new StockPlanner(states, wh, {
    allowNegative: false,
    items: goods,
    warehouseNames: new Map([[o.warehouse_id, 'Üretim malzeme deposu']]),
  });
  const pieceInputs: { piece: Row; quantity: string; lineNo: number }[] = [];
  const issuedByItem = new Map<string, ReturnType<typeof dec>>();
  for (const [i, l] of input.lines.entries()) {
    const used = (issuedByItem.get(l.itemId) ?? dec(0)).plus(l.quantity);
    if (used.gt(await availableStock(tx, l.itemId, o.warehouse_id, id)))
      throw fail('Kalite blokesi ve diğer rezervasyonlar sonrası sarf stoğu yetersiz');
    issuedByItem.set(l.itemId, used);
    const traced = await all(
      tx,
      sql`select id from leather_lots where item_id=${l.itemId}::uuid limit 1`,
    );
    if (
      traced.length &&
      (!l.pieces.length || !l.pieces.reduce((s, p) => s.plus(p.quantity), dec(0)).eq(l.quantity))
    )
      throw fail('Deri parça alanı sarf miktarına eşit olmalı', 'LEATHER_PIECE_QTY_MISMATCH');
    const other = await one(
      tx,
      sql`select coalesce(sum(quantity-consumed_qty),0)::text as qty from leather_reservations where item_id=${l.itemId}::uuid and warehouse_id=${o.warehouse_id}::uuid and order_id<>${id}::uuid and status='reserved'`,
    );
    if (planner.available(l.itemId, o.warehouse_id).minus(l.quantity).lt(other.qty))
      throw fail('Sarf başka emrin rezervasyonunu tüketemez');
    for (const p of l.pieces) {
      const planned = await all(
        tx,
        sql`select p.id from manufacturing_records p join leather_production_orders o on o.id=p.order_id and o.company_id=p.company_id where p.kind='cut_plan' and p.status in ('planned','in_progress') and o.status not in ('completed','cancelled') and p.config->'pieces' @> ${json([p.pieceId])}`,
      );
      if (planned.length && !extra.cut)
        throw fail('Planlanmış deri parçasını kesim planının sonuç girişi üzerinden tüketin');
      const piece = await one(
        tx,
        sql`select * from leather_pieces where id=${p.pieceId}::uuid for update`,
        'Deri parçası',
      );
      if (
        piece.item_id !== l.itemId ||
        piece.warehouse_id !== o.warehouse_id ||
        !['available', 'second'].includes(piece.status)
      )
        throw fail('Sarf parçası uygun değil');
      const prior = pieceInputs
        .filter((x) => x.piece.id === piece.id)
        .reduce((s, x) => s.plus(x.quantity), dec(0));
      const blocked = await one(
        tx,
        sql`select coalesce(sum(quantity-consumed_qty),0)::text as qty from leather_reservations where piece_id=${piece.id} and order_id<>${id}::uuid and status='reserved'`,
      );
      if (dec(piece.remaining_area).minus(prior).minus(p.quantity).lt(blocked.qty))
        throw fail('Parça alanı yetersiz veya başka emre rezerve');
      pieceInputs.push({ piece, quantity: p.quantity, lineNo: i + 1 });
    }
    planner.issue(i + 1, l.itemId, o.warehouse_id, dec(l.quantity));
  }
  const documentId = newId();
  await issueLots(tx, ctx, id, documentId, o.warehouse_id, input.lines);
  const doc = await insertDocument(
    tx,
    ctx,
    period.id,
    {
      docDate: input.date,
      type: 'issue',
      warehouseId: o.warehouse_id,
      sourceType: 'leather_production_document',
      sourceId: documentId,
      description: 'Üretim sarfı ' + o.code,
    },
    planner.rows,
  );
  await traceStockDocument(tx, ctx, doc, planner.rows, { purpose: 'production', orderId: id });
  const value = planner.rows.reduce((s, r) => s.plus(r.value.abs()), dec(0));
  const lines = [journalLine(ctx, await mapped(tx, 'production_wip'), value)];
  for (const r of planner.rows)
    lines.push(journalLine(ctx, (await itemAccounts(tx, r.itemId)).stockAccountId, r.value));
  const je = await journal(
    tx,
    ctx,
    input.date,
    'leather_production_document',
    documentId,
    'Üretim sarfı ' + o.code,
    lines,
  );
  const trace = await all(
    tx,
    sql`select root_id as "rootId",source_key as "sourceKey",share::text from leather_cost_events where source_key like ${'stock:' + doc.id + ':%'} order by root_id`,
  );
  const handoffs = await consumeMaterialHandoffs(tx, id, o.warehouse_id, input.lines);
  const record = await saveDocument(tx, ctx, {
    id: documentId,
    orderId: id,
    kind: 'issue',
    date: input.date,
    requestKey: input.requestKey,
    value: value.toFixed(2),
    stockDocumentId: doc.id,
    journalEntryId: je,
    config: { ...input, ...extra, trace, handoffs },
  });
  for (const p of pieceInputs) {
    await tx.execute(
      sql`update leather_pieces set remaining_area=remaining_area-${p.quantity}::numeric,status=case when remaining_area-${p.quantity}::numeric=0 then 'consumed' else status end where id=${p.piece.id}`,
    );
    await tx.execute(
      sql`insert into leather_piece_events(id,company_id,created_by,piece_id,order_id,document_id,date,kind,quantity,config) values(${newId()},${ctx.companyId},${ctx.userId},${p.piece.id},${id},${documentId},${input.date},'issue',${p.quantity},${json({ lineNo: p.lineNo })})`,
    );
  }
  for (const l of input.lines) {
    let left = dec(l.quantity);
    const res = await all(
      tx,
      sql`select * from leather_reservations where order_id=${id}::uuid and item_id=${l.itemId}::uuid and status='reserved' order by created_at for update`,
    );
    for (const r of res) {
      const available = dec(r.quantity).minus(r.consumed_qty);
      const used = left.lt(available) ? left : available;
      if (used.gt(0)) {
        await tx.execute(
          sql`update leather_reservations set consumed_qty=consumed_qty+${used.toFixed(4)}::numeric where id=${r.id}`,
        );
        left = left.minus(used);
      }
      if (left.isZero()) break;
    }
  }
  await tx.execute(
    sql`update leather_production_orders set wip_value=wip_value+${value.toFixed(2)}::numeric,status='in_progress' where id=${id}::uuid`,
  );
  return record;
}
export async function returnMaterial(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: LeatherMaterialReturnInput,
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  const duplicate = await existing(tx, input.requestKey, id, 'return');
  if (duplicate) return duplicate;
  const o = await lockedOrder(tx, id);
  if (!['released', 'in_progress'].includes(o.status))
    throw fail('Kapalı emre malzeme iadesi yapılamaz');
  const period = await requireOpenPeriod(tx, input.date);
  const original = await one(
    tx,
    sql`select * from leather_production_documents where id=${input.issueId}::uuid and order_id=${id}::uuid and kind='issue'`,
    'Orijinal sarf',
  );
  if (original.config.cut)
    throw fail(
      'Kesilmiş parça sarfı alan iadesiyle geri alınamaz; kalan parçalar kesimde zaten stoktadır',
    );
  const originalRows = await all(
    tx,
    sql`select * from stock_movements where document_id=${original.stock_document_id} and kind='qty' order by line_no`,
  );
  await lockItems(
    tx,
    originalRows.map((r) => r.item_id),
  );
  const rows: DraftRow[] = [];
  let total = dec(0);
  const documentId = newId();
  for (const l of input.lines) {
    const r = originalRows.find((r) => r.line_no === l.lineNo);
    if (!r) throw fail('İade satırı orijinal sarfta yok');
    const returns = await all(
      tx,
      sql`select config from leather_production_documents where order_id=${id}::uuid and kind='return' and config->>'issueId'=${original.id}`,
    );
    let used = dec(0);
    for (const d of returns)
      for (const x of (d.config.lines ?? []) as Row[])
        if (x.lineNo === l.lineNo) used = used.plus(x.quantity);
    if (dec(l.quantity).plus(used).gt(dec(r.qty).abs())) throw fail('İade orijinal sarfı aşamaz');
    const originalPieces = original.config.lines[l.lineNo - 1]?.pieces ?? [];
    if (
      originalPieces.length &&
      (!l.pieces.length || !l.pieces.reduce((s, p) => s.plus(p.quantity), dec(0)).eq(l.quantity))
    )
      throw fail('İade parça alanları miktara eşit olmalı');
    let value = dec(0);
    const events = await all(
      tx,
      sql`select e.*,r.current_value from leather_cost_events e join leather_cost_roots r on r.id=e.root_id where e.source_key=${'stock:' + original.stock_document_id + ':' + l.lineNo}`,
    );
    for (const e of events) {
      const fraction = dec(e.share).times(l.quantity).div(dec(r.qty).abs());
      const share = await one(
        tx,
        sql`select * from leather_cost_shares where root_id=${e.root_id} and target_key=${'wip:' + id} for update`,
        'Devam eden üretim maliyet payı',
      );
      if (dec(share.share).lt(fraction))
        throw fail('Bu malzeme maliyeti mamule aktarılmış; devam eden üretimde kalan maliyet payı iade için yetersiz');
      await tx.execute(
        sql`update leather_cost_shares set share=share-${fraction.toFixed(24)}::numeric where id=${share.id}`,
      );
      await tx.execute(
        sql`insert into leather_cost_shares(id,company_id,root_id,target_key,target_kind,target_id,item_id,warehouse_id,share,config) values(${newId()},${ctx.companyId},${e.root_id},${'stock:' + r.item_id},'stock',${r.item_id},${r.item_id},${o.warehouse_id},${fraction.toFixed(24)},'{}'::jsonb) on conflict(root_id,target_key) do update set share=leather_cost_shares.share+excluded.share`,
      );
      value = value.plus(dec(e.current_value).times(fraction));
      await tx.execute(
        sql`insert into leather_cost_events(id,company_id,created_by,root_id,source_key,from_key,to_key,share,value,date) values(${newId()},${ctx.companyId},${ctx.userId},${e.root_id},${'return:' + documentId + ':' + l.lineNo},${'wip:' + id},${'stock:' + r.item_id},${fraction.toFixed(24)},${roundMoney(dec(e.current_value).times(fraction)).toFixed(2)},${input.date})`,
      );
    }
    value = roundMoney(value);
    total = total.plus(value);
    rows.push({
      lineNo: l.lineNo,
      kind: 'qty',
      itemId: r.item_id,
      warehouseId: o.warehouse_id,
      qty: dec(l.quantity),
      value,
    });
    for (const p of l.pieces) {
      if (!originalPieces.some((v: Row) => v.pieceId === p.pieceId))
        throw fail('Parça orijinal sarfta yok');
      const piece = await one(
        tx,
        sql`select * from leather_pieces where id=${p.pieceId}::uuid for update`,
      );
      if (dec(piece.remaining_area).plus(p.quantity).gt(piece.area))
        throw fail('İade parça başlangıç alanını aşamaz');
      await tx.execute(
        sql`update leather_pieces set remaining_area=remaining_area+${p.quantity}::numeric,status='available' where id=${piece.id}`,
      );
    }
  }
  await returnLots(tx, ctx, id, input.issueId, documentId, input.lines, original.config.lines);
  if (total.gt(o.wip_value)) throw fail('İade, devam eden üretim maliyetini aşamaz');
  const doc = await insertDocument(
    tx,
    ctx,
    period.id,
    {
      docDate: input.date,
      type: 'receipt',
      warehouseId: o.warehouse_id,
      sourceType: 'leather_production_document',
      sourceId: documentId,
      description: 'Üretim malzeme iadesi',
    },
    rows,
  );
  const lines = [journalLine(ctx, await mapped(tx, 'production_wip'), total.neg())];
  for (const r of rows)
    lines.push(journalLine(ctx, (await itemAccounts(tx, r.itemId)).stockAccountId, r.value));
  const je = await journal(
    tx,
    ctx,
    input.date,
    'leather_production_document',
    documentId,
    'Üretim malzeme iadesi',
    lines,
  );
  await tx.execute(
    sql`update leather_production_orders set wip_value=wip_value-${total.toFixed(2)}::numeric where id=${id}::uuid`,
  );
  return saveDocument(tx, ctx, {
    id: documentId,
    orderId: id,
    kind: 'return',
    date: input.date,
    requestKey: input.requestKey,
    value: total.toFixed(2),
    stockDocumentId: doc.id,
    journalEntryId: je,
    config: input,
  });
}
export async function completeProduction(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: LeatherCompletionInput,
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  const duplicate = await existing(tx, input.requestKey, id, 'completion');
  if (duplicate) return duplicate;
  const o = await lockedOrder(tx, id);
  if (!['released', 'in_progress'].includes(o.status))
    throw fail('Mamul kabulü için açık üretim emri gerekli');
  requireExecutionOpen(o, true);
  const activeSessions = await one(
    tx,
    sql`select count(*)::int as n from manufacturing_records where kind='work_session' and order_id=${id}::uuid and status='running'`,
  );
  if (activeSessions.n) throw fail('Mamul kabulünden önce çalışan oturumları tamamlayın');
  const period = await requireOpenPeriod(tx, input.date);
  const q = await one(
    tx,
    sql`select * from leather_quality_checks where id=${input.qualityCheckId}::uuid`,
    'Son kalite kontrolü',
  );
  if (q.config.batchId && q.config.batchId !== input.batchId)
    throw fail('Mamul kabulü kalite kontrolünün üretim partisiyle uyuşmalı');
  if (input.batchId) {
    const batch = await one(
      tx,
      sql`select * from manufacturing_records where id=${input.batchId}::uuid and kind='batch' and order_id=${id}::uuid for update`,
      'Emrin üretim partisi',
    );
    const completed = dec(batch.config.completedQty ?? 0).plus(input.quantity);
    if (completed.gt(batch.config.quantity)) throw fail('Üretim partisi mamul kabulü hedefi aşamaz');
    await tx.execute(
      sql`update manufacturing_records set status=${completed.eq(batch.config.quantity) ? 'completed' : 'in_progress'},config=config||${json({ completedQty: completed.toFixed(4), qualityCheckId: q.id })},updated_at=now() where id=${batch.id}::uuid`,
    );
  }
  if (
    q.scope !== 'production' ||
    q.source_id !== id ||
    q.stage !== 'final' ||
    q.status !== 'approved'
  )
    throw fail('Onaylı son kalite kontrolü gerekli', 'LEATHER_FINAL_QUALITY_REQUIRED');
  const taken = await one(
    tx,
    sql`select coalesce(sum(quantity),0)::text as qty from leather_production_documents where kind='completion' and config->>'qualityCheckId'=${q.id}`,
  );
  if (dec(taken.qty).plus(input.quantity).gt(q.passed_qty))
    throw fail('Kabul adedi kalite onayını aşamaz');
  const remaining = dec(o.quantity)
    .minus(o.completed_qty)
    .minus(o.config.scrappedQty ?? 0);
  const fraction = leatherCompletionShare(input.quantity, remaining.toFixed(4), input.final);
  const value = fraction.eq(1) ? dec(o.wip_value) : roundMoney(dec(o.wip_value).times(fraction));
  const consumed = await one(
    tx,
    sql`select count(*)::int as n from leather_production_documents where order_id=${id}::uuid and kind='issue'`,
  );
  if (!consumed.n) throw fail('Mamul kabulünden önce malzeme sarfı gerekli');
  const activeFason = await one(
    tx,
    sql`select count(*)::int as n from leather_subcontract_jobs where order_id=${id}::uuid and status='dispatched'`,
  );
  if (activeFason.n) throw fail('Fasonda kalan işler tamamlanmadan mamul kabul edilemez');
  const documentId = newId();
  const byproducts = o.config.byproducts ?? [];
  const byproductValues = byproducts.map((b: Row) => roundMoney(value.times(b.costShare)));
  const primaryValue = value.minus(
    byproductValues.reduce(
      (s: ReturnType<typeof dec>, v: ReturnType<typeof dec>) => s.plus(v),
      dec(0),
    ),
  );
  const outputs = [
    { itemId: o.item_id, quantity: input.quantity, value: primaryValue },
    ...byproducts.map((b: Row, i: number) => ({
      itemId: b.itemId,
      quantity: dec(b.quantity).times(input.quantity).toFixed(4),
      value: byproductValues[i],
    })),
  ];
  if (new Set(outputs.map((x) => x.itemId)).size !== outputs.length)
    throw fail('Yan ürün stokları benzersiz olmalı');
  let moved = dec(0);
  for (const [i, output] of outputs.entries()) {
    const weight =
      i === 0
        ? dec(1).minus(
            byproducts.reduce((s: ReturnType<typeof dec>, b: Row) => s.plus(b.costShare), dec(0)),
          )
        : dec(byproducts[i - 1].costShare);
    const desired = fraction.times(weight);
    if (desired.gt(0)) {
      const relative = desired.div(dec(1).minus(moved));
      await moveShares(
        tx,
        ctx,
        'wip:' + id,
        {
          key: 'stock:' + output.itemId,
          kind: 'stock',
          id: output.itemId,
          itemId: output.itemId,
          warehouseId: o.output_warehouse_id,
        },
        relative.toFixed(24),
        'completion:' + documentId + ':' + i,
        input.date,
      );
      moved = moved.plus(desired);
    }
  }
  const outputIds = outputs.map((x) => x.itemId);
  await lockItems(tx, outputIds);
  const items = await loadStockableItems(tx, outputIds);
  const planner = new StockPlanner(
    await loadItemStates(tx, outputIds),
    await loadWarehouseQty(tx, outputIds, [o.output_warehouse_id]),
    {
      allowNegative: false,
      items,
      warehouseNames: new Map([[o.output_warehouse_id, 'Mamul deposu']]),
    },
  );
  for (const [i, output] of outputs.entries())
    planner.receipt(
      i + 1,
      output.itemId,
      o.output_warehouse_id,
      dec(output.quantity),
      output.value,
    );
  const outputLedger = await Promise.all(
    outputs.map(async (output) =>
      journalLine(ctx, (await itemAccounts(tx, output.itemId)).stockAccountId, output.value),
    ),
  );
  const doc = await insertDocument(
    tx,
    ctx,
    period.id,
    {
      docDate: input.date,
      type: 'receipt',
      warehouseId: o.output_warehouse_id,
      sourceType: 'leather_production_document',
      sourceId: documentId,
      description: 'Üretim mamul kabulü ' + o.code,
    },
    planner.rows,
    { intent: { byLine: new Map([[1, input.serials]]) } },
  );
  await completionLots(
    tx,
    ctx,
    id,
    doc.id,
    outputs,
    o.output_warehouse_id,
    input.serials,
    input.batchId,
  );
  const je = await journal(
    tx,
    ctx,
    input.date,
    'leather_production_document',
    documentId,
    'Üretim mamul kabulü ' + o.code,
    [...outputLedger, journalLine(ctx, await mapped(tx, 'production_wip'), value.neg())],
  );
  await tx.execute(
    sql`update leather_production_orders set completed_qty=completed_qty+${input.quantity}::numeric,wip_value=wip_value-${value.toFixed(2)}::numeric,status=${fraction.eq(1) ? 'completed' : 'in_progress'},config=config||${json({ executionPhase: fraction.eq(1) ? 'completed' : 'in_progress' })} where id=${id}::uuid`,
  );
  if (fraction.eq(1))
    await tx.execute(
      sql`update leather_reservations set status='released' where order_id=${id}::uuid`,
    );
  await queueInventoryChanges(tx, ctx, 'production-completion:' + input.requestKey, [
    ...outputIds,
    ...o.config.materials.map((m: Row) => m.itemId),
  ]);
  return saveDocument(tx, ctx, {
    id: documentId,
    orderId: id,
    kind: 'completion',
    date: input.date,
    requestKey: input.requestKey,
    quantity: input.quantity,
    value: value.toFixed(2),
    stockDocumentId: doc.id,
    journalEntryId: je,
    config: input,
  });
}
export async function recordOperation(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: Row,
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  await requireOpenPeriod(tx, input.date);
  if (await existing(tx, input.requestKey, id, 'operation')) return getProduction(tx, id);
  const o = await lockedOrder(tx, id);
  if (!['released', 'in_progress'].includes(o.status))
    throw fail('Operasyon için açık üretim gerekli');
  requireExecutionOpen(o);
  const ops = o.config.operations ?? [];
  const op = ops.find((x: Row) => x.key === input.key);
  if (!op) throw fail('Operasyon onaylı rotada yok');
  if (
    op.resources?.length &&
    (!input.resourceId || !op.resources.some((r: Row) => r.resourceId === input.resourceId))
  )
    throw fail('Kaynak onaylı operasyon için uygun değil');
  if (
    dec(input.quantity).gt(o.quantity) ||
    dec(op.goodQty ?? 0)
      .plus(input.goodQty)
      .gt(o.quantity)
  )
    throw fail('Operasyon iyi adedi üretim miktarını aşamaz');
  if (input.resourceId)
    await one(
      tx,
      sql`select id from manufacturing_records where id=${input.resourceId}::uuid and kind='resource' and status='active'`,
      'Aktif üretim kaynağı',
    );
  if (input.batchId) {
    const batch = await one(
      tx,
      sql`select * from manufacturing_records where id=${input.batchId}::uuid and kind='batch' and order_id=${id}::uuid and status in ('planned','in_progress') for update`,
      'Açık emrin üretim partisi',
    );
    const results = batch.config.operations ?? {},
      prior = results[input.key] ?? { goodQty: '0', scrapQty: '0', reworkQty: '0', minutes: '0' };
    if (dec(prior.goodQty).plus(input.goodQty).gt(batch.config.quantity))
      throw fail('Üretim partisindeki iyi adet hedefi aşamaz');
    results[input.key] = {
      goodQty: dec(prior.goodQty).plus(input.goodQty).toFixed(4),
      scrapQty: dec(prior.scrapQty).plus(input.scrapQty).toFixed(4),
      reworkQty: dec(prior.reworkQty).plus(input.reworkQty).toFixed(4),
      minutes: dec(prior.minutes).plus(input.minutes).toFixed(4),
      resourceId: input.resourceId,
      userId: ctx.userId,
    };
    await tx.execute(
      sql`update manufacturing_records set status='in_progress',config=config||${json({ operations: results })},updated_at=now() where id=${batch.id}::uuid`,
    );
  }
  op.status = input.status;
  op.actualMinutes = dec(op.actualMinutes ?? 0)
    .plus(input.minutes)
    .toFixed(4);
  op.completedQty = dec(op.completedQty ?? 0)
    .plus(input.quantity)
    .toFixed(4);
  op.goodQty = dec(op.goodQty ?? 0)
    .plus(input.goodQty)
    .toFixed(4);
  op.reworkQty = dec(op.reworkQty ?? 0)
    .plus(input.reworkQty)
    .toFixed(4);
  op.scrapQty = dec(op.scrapQty ?? 0)
    .plus(input.scrapQty)
    .toFixed(4);
  const documentId = newId();
  let qualityCheckId: string | null = null;
  if (
    dec(input.reworkQty ?? 0)
      .plus(input.scrapQty ?? 0)
      .gt(0)
  ) {
    qualityCheckId = newId();
    await tx.execute(
      sql`insert into leather_quality_checks(id,company_id,created_by,scope,source_id,stage,inspected_qty,passed_qty,config) values(${qualityCheckId},${ctx.companyId},${ctx.userId},'production',${id},'intermediate',${input.quantity},${input.goodQty},${json({ reworkQty: input.reworkQty, scrapQty: input.scrapQty, secondQty: '0', operationKey: input.key, batchId: input.batchId, operationDocumentId: documentId, checks: [{ label: op.name, passed: false, note: input.note }] })})`,
    );
  }
  await tx.execute(
    sql`update leather_production_orders set config=${json({ ...o.config, operations: ops })},status='in_progress' where id=${id}::uuid`,
  );
  await saveDocument(tx, ctx, {
    id: documentId,
    orderId: id,
    kind: 'operation',
    date: input.date,
    requestKey: input.requestKey,
    quantity: input.quantity,
    config: { ...input, qualityCheckId },
  });
  return getProduction(tx, id);
}
export async function productionFromSales(tx: Tx, ctx: LeatherCtx, input: Row): Promise<Row[]> {
  await lockLeatherCosts(tx, ctx.companyId);
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const marker = await all(
    tx,
    sql`select config from manufacturing_records where kind='integration_event' and code=${'sales-production:' + input.requestKey}`,
  );
  if (marker.length) {
    if (marker[0]!.config.payloadHash !== payloadHash)
      throw fail('İstek kimliği farklı üretim aktarımında kullanıldı');
    return Promise.all(marker[0]!.config.orderIds.map((id: string) => getProduction(tx, id)));
  }
  const previous = await all(
    tx,
    sql`select id,config from leather_production_orders where config->>'sourceRequestKey'=${input.requestKey} order by created_at`,
  );
  if (previous.length) {
    if (previous.some((r) => r.config.salesOrderId !== input.salesOrderId))
      throw fail('İstek kimliği farklı siparişte kullanıldı');
    return Promise.all(previous.map((r) => getProduction(tx, r.id)));
  }
  const source = await one(
    tx,
    sql`select * from sales_orders where id=${input.salesOrderId}::uuid for update`,
    'Ortak satış siparişi',
  );
  if (source.kind !== 'order' || source.status !== 'confirmed')
    throw fail('Üretime aktarım için onaylı satış siparişi gerekli');
  const lines = await all(
    tx,
    sql`select l.*,v.id as variant_id,v.revision_id from sales_order_lines l join items i on i.id=l.item_id left join leather_variants v on v.item_id=i.id where l.order_id=${source.id} and i.inventory_role='finished_goods' order by l.line_no`,
  );
  const orders: Row[] = [];
  const variants = await all(
    tx,
    sql`select v.id,v.item_id,v.revision_id,r.config from leather_variants v join leather_revisions r on r.id=v.revision_id where r.status='approved'`,
  );
  const recipes = variants.map((v) => ({ itemId: v.item_id, materials: v.config.materials }));
  const usage = await orderLineUsage(
    tx,
    lines.map((l) => l.id),
  );
  const stockUsed = new Map<string, ReturnType<typeof dec>>();
  for (const l of lines) {
    if (!l.variant_id) throw fail('Sipariş mamulünün onaylı üretim varyantı yok');
    const booked = await one(
      tx,
      sql`select coalesce(sum(quantity-completed_qty-coalesce((config->>'scrappedQty')::numeric,0)),0)::text as qty from leather_production_orders where config->>'salesOrderLineId'=${l.id} and status not in ('cancelled','completed')`,
    );
    const u = usage.get(l.id)!;
    const gross = dec(l.quantity).minus(u.delivered).minus(u.direct).minus(booked.qty);
    if (gross.lte(0)) continue;
    const stock = dec(await availableStock(tx, l.item_id, input.outputWarehouseId)).minus(
      stockUsed.get(l.item_id) ?? 0,
    );
    const used = stock.gt(0) ? (stock.lt(gross) ? stock : gross) : dec(0);
    stockUsed.set(l.item_id, (stockUsed.get(l.item_id) ?? dec(0)).plus(used));
    const quantity = gross.minus(used);
    if (quantity.lte(0)) continue;
    const balances: Record<string, string> = {};
    for (const itemId of new Set<string>(
      recipes.flatMap((r) => [r.itemId, ...r.materials.map((m: Row) => m.itemId)]),
    )) {
      balances[itemId] = dec(await availableStock(tx, itemId, input.warehouseId))
        .minus(stockUsed.get(itemId) ?? 0)
        .toFixed(4);
    }
    balances[l.item_id] = '0';
    const needs = explodeManufacturingNeed(l.item_id, quantity.toFixed(4), recipes, balances);
    const parents = new Map<string, string>();
    for (const n of needs) {
      if (n.itemId !== l.item_id)
        stockUsed.set(n.itemId, (stockUsed.get(n.itemId) ?? dec(0)).plus(n.available));
      if (n.action !== 'produce' || dec(n.net).lte(0)) continue;
      const v = variants.find((v) => v.item_id === n.itemId);
      if (!v) throw fail('Onaylı üretim reçetesi gerekli');
      const order = await createProduction(
        tx,
        ctx,
        leatherProductionSchema.parse({
          variantId: v.id,
          revisionId: v.revision_id,
          warehouseId: input.warehouseId,
          outputWarehouseId: n.parentItemId ? input.warehouseId : input.outputWarehouseId,
          quantity: n.net,
          salesOrderLineId: n.parentItemId ? undefined : l.id,
          assignedUserId: input.assignedUserId,
          dueDate: input.dueDate ?? source.delivery_date ?? undefined,
          note: input.note,
        }),
      );
      await tx.execute(
        sql`update leather_production_orders set config=config || ${json({ sourceRequestKey: input.requestKey, salesOrderId: source.id, parentOrderId: n.parentItemId ? (parents.get(n.parentItemId) ?? null) : null })} where id=${order.id}::uuid`,
      );
      parents.set(n.itemId, order.id);
      orders.push(await getProduction(tx, order.id));
    }
  }
  await tx.execute(
    sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,config) values(${newId()},${ctx.companyId},${ctx.userId},'integration_event',${'sales-production:' + input.requestKey},'processed',${json({ payloadHash, orderIds: orders.map((o) => o.id) })})`,
  );
  return orders;
}
export async function cancelProduction(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: Row,
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  await requireOpenPeriod(tx, input.date);
  if (await existing(tx, input.requestKey, id, 'cancel')) return getProduction(tx, id);
  const o = await lockedOrder(tx, id);
  if (!['planned', 'released'].includes(o.status) || dec(o.wip_value).gt(0))
    throw fail(
      'Tüketilmiş/üretilmiş emir doğrudan iptal edilemez; sarf iadesi veya kalite kaydıyla çözümleyin',
    );
  const active = await one(
    tx,
    sql`select count(*)::int as n from leather_subcontract_jobs where order_id=${id}::uuid and status='dispatched'`,
  );
  if (active.n) throw fail('Fasonda sevk edilmiş işletme malzemeleri var');
  const running = await one(
    tx,
    sql`select count(*)::int as n from manufacturing_records where order_id=${id}::uuid and kind in ('work_session','rework') and status in ('running','quality_waiting')`,
  );
  if (running.n) throw fail('Çalışan oturumu veya açık yeniden işleme olan emir iptal edilemez');
  await tx.execute(
    sql`update leather_production_orders set status='cancelled' where id=${id}::uuid`,
  );
  await tx.execute(
    sql`update leather_reservations set status='released' where order_id=${id}::uuid`,
  );
  await saveDocument(tx, ctx, {
    id: newId(),
    orderId: id,
    kind: 'cancel',
    date: input.date,
    requestKey: input.requestKey,
    config: input,
  });
  await queueInventoryChanges(
    tx,
    ctx,
    'production-cancel:' + input.requestKey,
    o.config.materials.map((m: Row) => m.itemId),
  );
  return getProduction(tx, id);
}
/** Abnormal loss is posted only by a quality approver, never by an operator's report. */
export async function scrapProduction(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  qualityId: string,
  quantity: string,
  date: string,
): Promise<Row> {
  await lockLeatherCosts(tx, ctx.companyId);
  await requireOpenPeriod(tx, date);
  const duplicate = await existing(tx, qualityId, id, 'scrap');
  if (duplicate) return duplicate;
  const o = await lockedOrder(tx, id);
  if (!['released', 'in_progress'].includes(o.status))
    throw fail('Fire açık üretim emrine kaydedilir');
  const remaining = dec(o.quantity)
    .minus(o.completed_qty)
    .minus(o.config.scrappedQty ?? 0);
  if (dec(quantity).gt(remaining)) throw fail('Fire kalan üretim adedini aşamaz');
  const fraction = dec(quantity).div(remaining);
  const value = roundMoney(dec(o.wip_value).times(fraction));
  const documentId = newId();
  await moveShares(
    tx,
    ctx,
    'wip:' + id,
    {
      key: 'loss:quality:' + qualityId,
      kind: 'loss',
      id: qualityId,
      itemId: o.item_id,
      orderId: id,
      config: { accountKey: 'stock_loss', quantity, remainingValue: value.toFixed(2) },
    },
    fraction.toFixed(24),
    'quality:' + qualityId,
    date,
  );
  const je = await journal(tx, ctx, date, 'leather_quality', qualityId, 'Üretim anormal fire', [
    journalLine(ctx, await mapped(tx, 'stock_loss'), value),
    journalLine(ctx, await mapped(tx, 'production_wip'), value.neg()),
  ]);
  const scrapped = dec(o.config.scrappedQty ?? 0).plus(quantity);
  await tx.execute(
    sql`update leather_production_orders set wip_value=wip_value-${value.toFixed(2)}::numeric,config=config || ${json({ scrappedQty: scrapped.toFixed(4) })},status=${fraction.eq(1) ? 'completed' : o.status} where id=${id}::uuid`,
  );
  if (fraction.eq(1))
    await tx.execute(
      sql`update leather_reservations set status='released' where order_id=${id}::uuid`,
    );
  return saveDocument(tx, ctx, {
    id: documentId,
    orderId: id,
    kind: 'scrap',
    date,
    requestKey: qualityId,
    quantity,
    value: value.toFixed(2),
    journalEntryId: je,
    config: { qualityCheckId: qualityId },
  });
}
