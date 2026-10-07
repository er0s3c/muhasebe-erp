import { sql } from 'drizzle-orm';
import { dec, type LeatherIssueInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { loadItemStates, loadWarehouseQty, lockItems } from '../inventory/balances';
import { insertDocument, loadStockableItems } from '../inventory/documents';
import { StockPlanner } from '../inventory/planner';
import { requireActiveWarehouse } from '../inventory/warehouses';
import { requireOpenPeriod } from '../settings/periods';
import { all, one, fail, newId, json, mapped, itemAccounts, journalLine, journal, lockLeatherCosts, type LeatherCtx, type Row } from './common';
import { traceStockDocument } from './costs';
import { availableStock } from './production';

type Lines=LeatherIssueInput['lines'];
/** The stock document is the quantity/value authority. Piece events only trace measured hides. */
export async function physicalMovement(tx:Tx,ctx:LeatherCtx,p:{sourceType:string;sourceId:string;date:string;warehouseId:string;toWarehouseId?:string;lines:Lines;kind:'issue'|'waste'|'transfer';orderId?:string;allowQuarantine?:boolean}){
 await lockLeatherCosts(tx,ctx.companyId);const period=await requireOpenPeriod(tx,p.date);await requireActiveWarehouse(tx,p.warehouseId);if(p.toWarehouseId){await requireActiveWarehouse(tx,p.toWarehouseId);if(p.toWarehouseId===p.warehouseId)throw fail('Fason deposu çıkış deposundan farklı olmalı');}
 const ids=[...new Set(p.lines.map(l=>l.itemId))];await lockItems(tx,ids);const goods=await loadStockableItems(tx,ids);const planner=new StockPlanner(await loadItemStates(tx,ids),await loadWarehouseQty(tx,ids,[p.warehouseId,...(p.toWarehouseId?[p.toWarehouseId]:[])]),{allowNegative:false,items:goods,warehouseNames:new Map()});
 const pieces:{piece:Row;quantity:string}[]=[];const requested=new Map<string,ReturnType<typeof dec>>();
 for(const [i,l] of p.lines.entries()){
  const next=(requested.get(l.itemId)??dec(0)).plus(l.quantity);requested.set(l.itemId,next);
  if(!p.allowQuarantine&&next.gt(await availableStock(tx,l.itemId,p.warehouseId,p.orderId)))throw fail('Kalite blokesi ve rezervasyon sonrası malzeme yetersiz');
  const traced=await all(tx,sql`select id from leather_lots where item_id=${l.itemId}::uuid limit 1`);if(traced.length&&(!l.pieces.length||!l.pieces.reduce((s,x)=>s.plus(x.quantity),dec(0)).eq(l.quantity)))throw fail('Fiziksel deri çıkışı ölçülen parça alanlarıyla eşleşmeli');
  for(const v of l.pieces){const piece=await one(tx,sql`select * from leather_pieces where id=${v.pieceId}::uuid for update`,'Deri parçası');if(piece.item_id!==l.itemId||piece.warehouse_id!==p.warehouseId||(!p.allowQuarantine&&!['available','second'].includes(piece.status)))throw fail('Parça depo, ürün veya kabul durumu uygun değil');const used=pieces.filter(x=>x.piece.id===piece.id).reduce((s,x)=>s.plus(x.quantity),dec(0));if(used.plus(v.quantity).gt(piece.remaining_area))throw fail('Fiziksel parça alanı yetersiz');if(p.kind==='transfer'&&(used.gt(0)||!dec(v.quantity).eq(piece.remaining_area)))throw fail('Fason sevkinde parça kalan alanının tamamı taşınmalı; kısmi sevk için önce ölçülü kalan ayırın');const other=await one(tx,sql`select coalesce(sum(quantity-consumed_qty),0)::text as qty from leather_reservations where piece_id=${piece.id} and status='reserved' ${p.orderId?sql`and order_id<>${p.orderId}::uuid`:sql``}`);if(dec(piece.remaining_area).minus(used).minus(v.quantity).lt(other.qty))throw fail('Başka emrin parçası sevk/tüketim için kullanılamaz');pieces.push({piece,quantity:v.quantity});}
  if(p.kind==='transfer')planner.transfer(i+1,l.itemId,p.warehouseId,p.toWarehouseId!,dec(l.quantity));else planner.issue(i+1,l.itemId,p.warehouseId,dec(l.quantity));
 }
 const doc=await insertDocument(tx,ctx,period.id,{docDate:p.date,type:p.kind,warehouseId:p.warehouseId,toWarehouseId:p.toWarehouseId,sourceType:p.sourceType,sourceId:p.sourceId,description:p.kind==='transfer'?'Fasona ait işletme malzemesi sevk/iade':'Deri '+(p.kind==='waste'?'anormal fire':'servis parça sarfı')},planner.rows);
 await traceStockDocument(tx,ctx,doc,planner.rows,{movementKind:p.kind});let je:string|null=null;const value=planner.rows.filter(r=>r.qty.lt(0)).reduce((s,r)=>s.plus(r.value.abs()),dec(0));
 if(p.kind!=='transfer'){const lines=[journalLine(ctx,await mapped(tx,p.kind==='waste'?'stock_loss':'consumption'),value)];for(const r of planner.rows)lines.push(journalLine(ctx,(await itemAccounts(tx,r.itemId)).stockAccountId,r.value));je=await journal(tx,ctx,p.date,p.sourceType,p.sourceId,'Deri '+(p.kind==='waste'?'anormal fire':'servis parça sarfı'),lines);}
 for(const v of pieces){if(p.kind==='transfer')await tx.execute(sql`update leather_pieces set warehouse_id=${p.toWarehouseId}::uuid where id=${v.piece.id}`);else await tx.execute(sql`update leather_pieces set remaining_area=remaining_area-${v.quantity}::numeric,status=case when remaining_area-${v.quantity}::numeric=0 then 'consumed' else status end where id=${v.piece.id}`);await tx.execute(sql`insert into leather_piece_events(id,company_id,created_by,piece_id,order_id,date,kind,quantity,config) values(${newId()},${ctx.companyId},${ctx.userId},${v.piece.id},${p.orderId??null},${p.date},${p.kind},${v.quantity},${json({stockDocumentId:doc.id,sourceType:p.sourceType,sourceId:p.sourceId,toWarehouseId:p.toWarehouseId??null})})`);}
 return {stockDocumentId:doc.id,journalEntryId:je,value:value.toFixed(2)};
}
