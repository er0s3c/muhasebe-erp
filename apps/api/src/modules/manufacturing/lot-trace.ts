import { sql } from 'drizzle-orm';
import { dec } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, one, json, newId, fail, type LeatherCtx, type Row } from '../leather/common';
import { pickLotPlacements } from './stock-lots';

export interface LotAllocation {
  lotId: string;
  quantity: string;
}
export async function issueLots(
  tx: Tx,
  ctx: LeatherCtx,
  orderId: string,
  documentId: string,
  warehouseId: string,
  lines: readonly { itemId: string; quantity: string; lotAllocations?: LotAllocation[] }[],
) {
  for (const line of lines) {
    let allocations = line.lotAllocations ?? [];
    const explicit = allocations.length > 0;
    if (!explicit) {
      const lots = await all(
        tx,
        sql`select * from manufacturing_records where kind='lot' and item_id=${line.itemId}::uuid and warehouse_id=${warehouseId}::uuid and status='available' order by created_at,id for update`,
      );
      if (!lots.length) continue;
      let need = dec(line.quantity);
      allocations = [];
      for (const lot of lots) {
        const left = dec(lot.config.remainingQty ?? lot.config.quantity),
          take = left.lt(need) ? left : need;
        if (take.gt(0)) allocations.push({ lotId: lot.id, quantity: take.toFixed(4) });
        need = need.minus(take);
        if (need.isZero()) break;
      }
      if (need.gt(0)) {
        const balance = await one(
          tx,
          sql`select coalesce(sum(qty),0)::text as qty from stock_movements where item_id=${line.itemId}::uuid and warehouse_id=${warehouseId}::uuid`,
        );
        const tracked = await one(
          tx,
          sql`select coalesce(sum(coalesce(config->>'remainingQty',config->>'quantity')::numeric),0)::text as qty from manufacturing_records where kind='lot' and item_id=${line.itemId}::uuid and warehouse_id=${warehouseId}::uuid`,
        );
        if (need.gt(dec(balance.qty).minus(tracked.qty)))
          throw fail('İzlenen serbest partiler ve mevcut partisiz stok sarfı karşılamıyor');
      }
      line.lotAllocations = allocations;
    }
    if (new Set(allocations.map((a) => a.lotId)).size !== allocations.length)
      throw fail('Aynı parti tek sarf satırında birleştirilmeli');
    if (explicit && !allocations.reduce((s, a) => s.plus(a.quantity), dec(0)).eq(line.quantity))
      throw fail('Parti dağılımı sarf miktarına eşit olmalı');
    for (const a of allocations) {
      const lot = await one(
        tx,
        sql`select * from manufacturing_records where id=${a.lotId}::uuid and kind='lot' for update`,
        'Sarf partisi',
      );
      const left = dec(lot.config.remainingQty ?? lot.config.quantity);
      if (
        lot.status !== 'available' ||
        lot.item_id !== line.itemId ||
        lot.warehouse_id !== warehouseId ||
        left.lt(a.quantity)
      )
        throw fail('Serbest parti, malzeme, depo ve miktar eşleşmeli');
      await tx.execute(
        sql`update manufacturing_records set config=config||${json({ remainingQty: left.minus(a.quantity).toFixed(4) })},updated_at=now() where id=${lot.id}`,
      );
      await pickLotPlacements(tx, lot.id, a.quantity, documentId);
      await tx.execute(
        sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,order_id,item_id,warehouse_id,source_document_id,config) values(${newId()},${ctx.companyId},${ctx.userId},'lot_event',${documentId + ':' + lot.id},'issued',${orderId},${line.itemId},${warehouseId},${documentId},${json({ lotId: lot.id, quantity: a.quantity, sourceDocumentId: documentId })})`,
      );
    }
  }
}
export async function returnLots(
  tx: Tx,
  ctx: LeatherCtx,
  orderId: string,
  issueId: string,
  documentId: string,
  lines: readonly { lineNo: number; quantity: string }[],
  originalLines: Row[],
) {
  for (const line of lines) {
    const original = originalLines[line.lineNo - 1];
    if (!original?.lotAllocations?.length) continue;
    const fraction = dec(line.quantity).div(original.quantity);
    for (const allocation of original.lotAllocations) {
      const returned = dec(allocation.quantity).times(fraction).toDecimalPlaces(4);
      const lot = await one(
        tx,
        sql`select * from manufacturing_records where id=${allocation.lotId}::uuid and kind='lot' for update`,
      );
      const prior = await all(
        tx,
        sql`select config from manufacturing_records where kind='lot_event' and status='returned' and config->>'issueId'=${issueId} and config->>'lotId'=${lot.id}`,
      );
      if (
        prior
          .reduce((s, p) => s.plus(p.config.quantity), dec(0))
          .plus(returned)
          .gt(allocation.quantity)
      )
        throw fail('Parti iadesi kaynak sarfı aşamaz');
      await tx.execute(
        sql`update manufacturing_records set config=config||${json({
          remainingQty: dec(lot.config.remainingQty ?? lot.config.quantity)
            .plus(returned)
            .toFixed(4),
        })},updated_at=now() where id=${lot.id}`,
      );
      await tx.execute(
        sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,order_id,item_id,warehouse_id,source_document_id,config) values(${newId()},${ctx.companyId},${ctx.userId},'lot_event',${documentId + ':' + lot.id},'returned',${orderId},${lot.item_id},${lot.warehouse_id},${documentId},${json({ lotId: lot.id, issueId, quantity: returned.toFixed(4) })})`,
      );
    }
  }
}
