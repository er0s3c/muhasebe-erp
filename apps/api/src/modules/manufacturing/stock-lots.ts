import { sql } from 'drizzle-orm';
import { dec } from '@erp/shared';
import type { Tx } from '../../db/client';
import type { StockCtx } from '../inventory/documents';
import type { DraftRow } from '../inventory/planner';
import { all, one, newId, json, fail } from '../leather/common';

/** Physical quantity trace only; valuation stays in the shared SKU cost engine. */
export async function syncStockLots(
  tx: Tx,
  ctx: StockCtx,
  doc: {
    id: string;
    sourceType?: string | null;
    sourceId?: string | null;
    reversalOfId?: string | null;
    type?: string;
  },
  rows: readonly DraftRow[],
) {
  // Production issue/return commands persist explicit allocations themselves.
  if (doc.sourceType === 'leather_production_document') return;
  let returnedDocumentId = doc.reversalOfId ?? null;
  let customerReturn = false;
  if (
    !returnedDocumentId &&
    doc.sourceId &&
    (doc.sourceType === 'invoice' || doc.sourceType === 'delivery_note')
  ) {
    const table = doc.sourceType === 'invoice' ? 'invoices' : 'delivery_notes';
    const source = await all(
      tx,
      sql`select return_of_id,type from ${sql.identifier(table)} where id=${doc.sourceId}::uuid`,
    );
    customerReturn = source[0]?.type === 'sales_return' && !doc.reversalOfId;
    if (source[0]?.return_of_id) {
      const original = await all(
        tx,
        sql`select id from stock_documents where source_type=${doc.sourceType} and source_id=${source[0].return_of_id}::uuid and reversal_of_id is null`,
      );
      returnedDocumentId = original[0]?.id ?? null;
    }
  }
  const makeLot = async (
    itemId: string,
    warehouseId: string,
    quantity: string,
    parentLotId: string | null,
    code: string,
    status = 'available',
  ) => {
    const id = newId();
    await tx.execute(
      sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,item_id,warehouse_id,source_document_id,config) values(${id},${ctx.companyId},${ctx.userId},'lot',${code},${status},${itemId},${warehouseId},${doc.id},${json({ code, itemId, warehouseId, sourceDocumentId: doc.id, quantity, remainingQty: quantity, parentLotId, serials: [], automatic: true, qualityReason: customerReturn ? 'Satış iadesi kalite bekliyor' : 'Mal kabul kalite bekliyor' })})`,
    );
    return id;
  };
  for (const row of rows.filter((r) => r.kind === 'qty' && r.qty.lt(0))) {
    const sourceLots = doc.reversalOfId
      ? await all(
          tx,
          sql`select * from manufacturing_records where kind='lot' and source_document_id=${doc.reversalOfId}::uuid and item_id=${row.itemId}::uuid and warehouse_id=${row.warehouseId}::uuid for update`,
        )
      : [];
    if (
      sourceLots.some(
        (l) =>
          !['available', 'quarantine', 'leather_traced'].includes(l.status) ||
          dec(l.config.remainingQty ?? l.config.quantity).lt(l.config.quantity),
      )
    )
      throw fail(
        'Kaynak kabul partisi tüketilmiş veya blokeli; belgeyi geri almadan önce kaynak işlemleri çözümleyin',
      );
    const lots = await all(
      tx,
      sql`select * from manufacturing_records where kind='lot' and item_id=${row.itemId}::uuid and warehouse_id=${row.warehouseId}::uuid ${sourceLots.length ? sql`and source_document_id=${doc.reversalOfId}::uuid and status in ('available','quarantine','leather_traced')` : sql`and status='available'`} order by created_at,id for update`,
    );
    let needed = row.qty.abs();
    for (const lot of lots) {
      const physical = dec(lot.config.remainingQty ?? lot.config.quantity),
        left =
          !doc.reversalOfId &&
          lot.config.releasedQty !== undefined &&
          dec(lot.config.releasedQty).lt(physical)
            ? dec(lot.config.releasedQty)
            : physical,
        take = left.lt(needed) ? left : needed;
      if (take.lte(0)) continue;
      await tx.execute(
        sql`update manufacturing_records set config=config||${json({ remainingQty: physical.minus(take).toFixed(4), ...(lot.config.releasedQty !== undefined ? { releasedQty: Math.max(0, Number(dec(lot.config.releasedQty).minus(take))).toFixed(4) } : {}) })},updated_at=now() where id=${lot.id}`,
      );
      const target = rows.find(
        (r) =>
          r.kind === 'qty' && r.itemId === row.itemId && r.lineNo === row.lineNo && r.qty.gt(0),
      );
      const targetLotId =
        target && !returnedDocumentId
          ? await makeLot(
              row.itemId,
              target.warehouseId,
              take.toFixed(4),
              lot.id,
              'TRANSFER:' + doc.id + ':' + row.lineNo + ':' + lot.id,
            )
          : null;
      await tx.execute(
        sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,item_id,warehouse_id,source_document_id,config) values(${newId()},${ctx.companyId},${ctx.userId},'lot_event',${doc.id + ':' + row.lineNo + ':' + lot.id},'issued',${row.itemId},${row.warehouseId},${doc.id},${json({ lotId: lot.id, targetLotId, quantity: take.toFixed(4), stockDocumentId: doc.id, lineNo: row.lineNo, sourceType: doc.sourceType, sourceId: doc.sourceId })})`,
      );
      await pickLotPlacements(tx, lot.id, take.toFixed(4), doc.id);
      needed = needed.minus(take);
      if (needed.isZero()) break;
    }
  }
  if (returnedDocumentId)
    for (const row of rows.filter((r) => r.kind === 'qty' && r.qty.gt(0))) {
      let needed = row.qty;
      const events = await all(
        tx,
        sql`select * from manufacturing_records where kind='lot_event' and source_document_id=${returnedDocumentId}::uuid and item_id=${row.itemId}::uuid and status='issued' order by created_at,id for update`,
      );
      for (const event of events) {
        const prior = await all(
          tx,
          sql`select config from manufacturing_records where kind='lot_event' and status='returned' and config->>'sourceEventId'=${event.id}`,
        );
        const rest = dec(event.config.quantity).minus(
            prior.reduce<ReturnType<typeof dec>>((s, e) => s.plus(e.config.quantity), dec(0)),
          ),
          take = rest.lt(needed) ? rest : needed;
        if (take.lte(0)) continue;
        const lot = await one(
          tx,
          sql`select * from manufacturing_records where id=${event.config.lotId}::uuid and kind='lot' for update`,
        );
        let lotId = lot.id;
        if (lot.warehouse_id === row.warehouseId && !customerReturn)
          await tx.execute(
            sql`update manufacturing_records set config=config||${json({
              remainingQty: dec(lot.config.remainingQty ?? lot.config.quantity)
                .plus(take)
                .toFixed(4),
              ...(lot.config.releasedQty !== undefined
                ? { releasedQty: dec(lot.config.releasedQty).plus(take).toFixed(4) }
                : {}),
            })},updated_at=now() where id=${lot.id}`,
          );
        else
          lotId = await makeLot(
            row.itemId,
            row.warehouseId,
            take.toFixed(4),
            lot.id,
            'RETURN:' + doc.id + ':' + row.lineNo + ':' + lot.id,
            customerReturn ? 'quarantine' : 'available',
          );
        await tx.execute(
          sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,item_id,warehouse_id,source_document_id,config) values(${newId()},${ctx.companyId},${ctx.userId},'lot_event',${doc.id + ':return:' + row.lineNo + ':' + event.id},'returned',${row.itemId},${row.warehouseId},${doc.id},${json({ lotId, sourceEventId: event.id, quantity: take.toFixed(4), stockDocumentId: doc.id })})`,
        );
        needed = needed.minus(take);
        if (needed.isZero()) break;
      }
      if (customerReturn && needed.gt(0))
        await makeLot(
          row.itemId,
          row.warehouseId,
          needed.toFixed(4),
          null,
          'RETURN:' + doc.id + ':' + row.lineNo,
          'quarantine',
        );
    }
  if (!returnedDocumentId && !doc.reversalOfId && doc.type === 'receipt')
    for (const row of rows.filter((r) => r.kind === 'qty' && r.qty.gt(0))) {
      const item = await one(
        tx,
        sql`select inventory_role,unit from items where id=${row.itemId}::uuid`,
      );
      // Physical leather reception owns its piece quarantine; do not create a duplicate area hold.
      if (item.inventory_role !== 'raw_material') continue;
      if (item.unit === 'm2' && doc.sourceType === 'leather_receipt') continue;
      const existing = await all(
        tx,
        sql`select id from manufacturing_records where kind='lot' and code=${'RECEIPT:' + doc.id + ':' + row.lineNo}`,
      );
      if (!existing.length)
        await makeLot(
          row.itemId,
          row.warehouseId,
          row.qty.toFixed(4),
          null,
          'RECEIPT:' + doc.id + ':' + row.lineNo,
          'quarantine',
        );
    }
}

/** Shelf depletion accompanies the source issue; it has no independent value. */
export async function pickLotPlacements(
  tx: Tx,
  lotId: string,
  quantity: string,
  sourceDocumentId: string,
) {
  let picked = dec(quantity);
  const placements = await all(
    tx,
    sql`select * from manufacturing_records where kind='placement' and config->>'lotId'=${lotId} and status in ('placed','part_picked') order by created_at,id for update`,
  );
  for (const placement of placements) {
    const remaining = dec(placement.config.remainingQty ?? placement.config.quantity),
      amount = remaining.lt(picked) ? remaining : picked;
    if (amount.lte(0)) continue;
    const after = remaining.minus(amount);
    await tx.execute(
      sql`update manufacturing_records set status=${after.isZero() ? 'picked' : 'part_picked'},config=config||${json({ remainingQty: after.toFixed(4), lastStockDocumentId: sourceDocumentId })},updated_at=now() where id=${placement.id}`,
    );
    picked = picked.minus(amount);
    if (picked.isZero()) break;
  }
}

export async function completionLots(
  tx: Tx,
  ctx: StockCtx,
  orderId: string,
  stockDocumentId: string,
  outputs: readonly { itemId: string; quantity: string }[],
  warehouseId: string,
  serials: readonly string[],
  batchId?: string,
) {
  for (const [index, output] of outputs.entries()) {
    const id = newId(),
      code = 'PRODUCTION:' + stockDocumentId + ':' + index;
    await tx.execute(
      sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,order_id,item_id,warehouse_id,source_document_id,config) values(${id},${ctx.companyId},${ctx.userId},'lot',${code},'available',${orderId},${output.itemId},${warehouseId},${stockDocumentId},${json({ code, orderId, batchId: batchId ?? null, itemId: output.itemId, warehouseId, sourceDocumentId: stockDocumentId, quantity: output.quantity, remainingQty: output.quantity, serials: index === 0 ? serials : [] })})`,
    );
  }
}
