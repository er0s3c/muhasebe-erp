import { sql } from 'drizzle-orm';
import { dec, roundMoney, splitLeatherCostDelta, type LeatherCostAllocationInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { insertDocument } from '../inventory/documents';
import { loadItemStates, lockItems } from '../inventory/balances';
import type { DraftRow } from '../inventory/planner';
import { requireOpenPeriod } from '../settings/periods';
import { reverseJournalEntry, type AutoJournalLine } from '../ledger/journal';
import { all, one, newId, json, fail, mapped, itemAccounts, journalLine, journal, lockLeatherCosts, type LeatherCtx, type Row } from './common';
export { lockLeatherCosts } from './common';

export interface CostTarget { key: string; kind: 'stock' | 'wip' | 'sale' | 'pending_delivery' | 'loss' | 'purchase_return'; id: string; itemId?: string; warehouseId?: string; orderId?: string; config?: Record<string, unknown> }
const stockTarget = (itemId: string, warehouseId: string): CostTarget => ({ key: `stock:${itemId}`, kind: 'stock', id: itemId, itemId, warehouseId });
export const productionTarget = (orderId: string): CostTarget => ({ key: `wip:${orderId}`, kind: 'wip', id: orderId, orderId });

export async function addRoot(tx: Tx, ctx: LeatherCtx, source: { type: string; id: string; lineNo?: number; kind: string; itemId?: string; orderId?: string; quantity?: string; value: string; accrued?: boolean; config?: Record<string,unknown> }, target: CostTarget): Promise<Row> {
 const existing = await all(tx, sql`select * from leather_cost_roots where source_type=${source.type} and source_id=${source.id}::uuid and line_no=${source.lineNo ?? 1} and kind=${source.kind}`);
 if (existing[0]) return existing[0];
 const r = await one(tx, sql`insert into leather_cost_roots(id,company_id,created_by,source_type,source_id,line_no,kind,item_id,order_id,quantity,provisional_value,current_value,accrued,config) values(${newId()},${ctx.companyId},${ctx.userId},${source.type},${source.id},${source.lineNo ?? 1},${source.kind},${source.itemId ?? null},${source.orderId ?? null},${source.quantity ?? '0'},${source.value},${source.value},${source.accrued ?? false},${json(source.config ?? {})}) returning *`);
 await addShare(tx, ctx, r.id, target, '1');
 return r;
}
async function addShare(tx: Tx, ctx: LeatherCtx, rootId: string, target: CostTarget, share: string): Promise<void> {
 await tx.execute(sql`insert into leather_cost_shares(id,company_id,root_id,target_key,target_kind,target_id,item_id,warehouse_id,order_id,share,config) values(${newId()},${ctx.companyId},${rootId},${target.key},${target.kind},${target.id},${target.itemId ?? null},${target.warehouseId ?? null},${target.orderId ?? null},${share},${json(target.config ?? {})}) on conflict(root_id,target_key) do update set share=leather_cost_shares.share+excluded.share`);
}
/** Shares follow the monetary weighted-average pool; physical lot selection never selects a cost root. */
export async function moveShares(tx: Tx, ctx: LeatherCtx, fromKey: string, to: CostTarget, fraction: string, sourceKey: string, date: string): Promise<void> {
 const f = dec(fraction); if (f.lt(0) || f.gt(1)) throw fail('Geçersiz maliyet aktarım oranı');
 const shares = await all(tx, sql`select s.*,r.current_value from leather_cost_shares s join leather_cost_roots r on r.id=s.root_id where s.target_key=${fromKey} and s.share>0 order by s.root_id for update of s`);
 for (const s of shares) {
  const moved = f.eq(1) ? dec(s.share) : dec(s.share).times(f).toDecimalPlaces(24);
  if (moved.isZero()) continue;
  await tx.execute(sql`update leather_cost_shares set share=${dec(s.share).minus(moved).toFixed(24)} where id=${s.id}`);
  await addShare(tx, ctx, s.root_id, to, moved.toFixed(24));
  await tx.execute(sql`insert into leather_cost_events(id,company_id,created_by,root_id,source_key,from_key,to_key,share,value,date,config) values(${newId()},${ctx.companyId},${ctx.userId},${s.root_id},${sourceKey},${fromKey},${to.key},${moved.toFixed(24)},${roundMoney(moved.times(s.current_value)).toFixed(2)},${date},${json(to.config ?? {})})`);
 }
 if (to.config) await tx.execute(sql`update leather_cost_shares set config=${json(to.config)} where target_key=${to.key}`);
}
export interface TraceOptions { movementKind?: string; orderId?: string; purpose?: 'normal' | 'production' | 'completion' | 'material_return'; lineRefs?: Record<number,{ type: string; id: string }>; originalTargets?: Record<number,string> }
export async function traceStockDocument(tx: Tx, ctx: LeatherCtx, doc: {id:string;docDate:string;type:string;sourceType?:string|null;sourceId?:string|null}, rows: readonly DraftRow[], opts: TraceOptions = {}): Promise<void> {
 const c = await one(tx, sql`select sector from companies where id=${ctx.companyId}`); if (!['LEATHER_FASHION','MANUFACTURING_WHOLESALE'].includes(c.sector)) return;
 await lockLeatherCosts(tx,ctx.companyId);
 const qtyRows=rows.filter(r=>r.kind==='qty'); const ids=[...new Set(qtyRows.map(r=>r.itemId))];
 const states=await loadItemStates(tx,ids); const before=new Map(ids.map(id=>[id,dec(states.get(id)!.qty).minus(qtyRows.filter(r=>r.itemId===id).reduce((s,r)=>s.plus(r.qty),dec(0)))]));
 for(const id of ids){ const have=await all(tx,sql`select id from leather_cost_shares where target_key=${'stock:'+id} and share>0 limit 1`); if(!have.length && before.get(id)!.gt(0)){ const oldValue=dec(states.get(id)!.value).minus(rows.filter(r=>r.itemId===id).reduce((s,r)=>s.plus(r.value),dec(0))); await addRoot(tx,ctx,{type:'legacy_stock',id,kind:'opening',itemId:id,quantity:before.get(id)!.toFixed(4),value:oldValue.toFixed(2)},stockTarget(id,qtyRows.find(r=>r.itemId===id)!.warehouseId)); } }
 for(const r of qtyRows){
  if(doc.type==='transfer') continue;
  const eventKey=`stock:${doc.id}:${r.lineNo}`;
  const occurred=await all(tx,sql`select id from leather_cost_events where source_key=${eventKey} limit 1`); if(occurred.length) continue;
  const amount=r.qty.abs(); const old=before.get(r.itemId)!;
  if(r.qty.lt(0)){
   if(old.lte(0)||amount.gt(old)) throw fail('İzlenen üretim stokunda negatif bakiye oluşamaz','LEATHER_NEGATIVE_STOCK');
   let target:CostTarget;
   const ref=opts.lineRefs?.[r.lineNo];
   if(opts.purpose==='production'&&opts.orderId) target=productionTarget(opts.orderId);
   else if(opts.movementKind==='sales') target={key:doc.sourceType==='delivery_note'?`pending_delivery:${ref?.id ?? doc.sourceId}:${r.lineNo}`:`sale:invoice:${doc.sourceId}:${r.lineNo}`,kind:doc.sourceType==='delivery_note'?'pending_delivery':'sale',id:ref?.id ?? doc.sourceId ?? doc.id,itemId:r.itemId,warehouseId:r.warehouseId};
   else target={key:`${opts.movementKind==='purchase_return'?'purchase_return':'loss'}:${doc.id}:${r.lineNo}`,kind:opts.movementKind==='purchase_return'?'purchase_return':'loss',id:doc.id,itemId:r.itemId,warehouseId:r.warehouseId};
   target.config={quantity:amount.toFixed(4),remainingValue:r.value.abs().toFixed(2),sourceType:doc.sourceType,sourceId:doc.sourceId,lineNo:r.lineNo,accountKey:doc.type==='waste'?'stock_loss':'consumption'};
   await moveShares(tx,ctx,`stock:${r.itemId}`,target,amount.div(old).toFixed(24),eventKey,doc.docDate);
  } else if(opts.originalTargets?.[r.lineNo]) {
   const from=opts.originalTargets[r.lineNo]!; const targetInfo=await one(tx,sql`select config from leather_cost_shares where target_key=${from} limit 1`,'Orijinal maliyet izi'); const q=dec(targetInfo.config.quantity ?? 0); if(q.lt(amount)) throw fail('İade miktarı orijinal çıkışın kalan miktarını aşamaz');
   await moveShares(tx,ctx,from,stockTarget(r.itemId,r.warehouseId),amount.div(q).toFixed(24),eventKey,doc.docDate);
   await tx.execute(sql`update leather_cost_shares set config=config || ${json({quantity:q.minus(amount).toFixed(4),remainingValue:dec(targetInfo.config.remainingValue).minus(r.value).toFixed(2)})} where target_key=${from}`);
  } else if(opts.purpose==='completion'&&opts.orderId) {
   // Completion shares are transferred explicitly by the production service before inserting the receipt.
  } else {
   const ref=opts.lineRefs?.[r.lineNo];
   await addRoot(tx,ctx,{type:doc.sourceType??'stock_document',id:doc.sourceId??doc.id,lineNo:r.lineNo,kind:'acquisition',itemId:r.itemId,quantity:amount.toFixed(4),value:r.value.toFixed(2),config:{documentId:doc.id,deliveryLineId:ref?.type==='delivery_line'?ref.id:null}},stockTarget(r.itemId,r.warehouseId));
  }
  before.set(r.itemId,old.plus(r.qty));
 }
}
export async function accruedDeliveryLines(tx:Tx,ids:readonly string[]):Promise<Set<string>>{ if(!ids.length)return new Set(); const roots=await all(tx,sql`select config->>'deliveryLineId' as id from leather_cost_roots where accrued and config->>'deliveryLineId' in (${sql.join(ids.map(i=>sql`${i}`),sql`,`)})`);return new Set(roots.map(r=>r.id)); }
export async function accruePurchaseDelivery(tx:Tx,ctx:LeatherCtx,doc:{id:string;docDate:string;type:string;sourceType?:string|null;sourceId?:string|null},lines:readonly {id:string;lineNo:number;itemId:string;quantity:string;stockValue:string|null}[],rows:readonly DraftRow[]):Promise<string|null>{
 await lockLeatherCosts(tx,ctx.companyId); const c=await one(tx,sql`select sector from companies where id=${ctx.companyId}`);if(!['LEATHER_FASHION','MANUFACTURING_WHOLESALE'].includes(c.sector))return null;
 const sourceId=doc.sourceId??doc.id;const existing=await all(tx,sql`select id from journal_entries where source_type='leather_receipt_accrual' and source_id=${sourceId}::uuid and reversal_of_id is null`);if(existing[0])return existing[0].id;
 await traceStockDocument(tx,ctx,doc,rows,{movementKind:'purchase',lineRefs:Object.fromEntries(lines.map(l=>[l.lineNo,{type:'delivery_line',id:l.id}]))});
 const out:AutoJournalLine[]=[];let total=dec(0);
 for(const l of lines){const value=dec(l.stockValue??0);if(value.lte(0))throw fail('Faturasız kabulde pozitif geçici maliyet gerekli','LEATHER_PROVISIONAL_COST_REQUIRED');const root=await one(tx,sql`select * from leather_cost_roots where source_type=${doc.sourceType??'stock_document'} and source_id=${sourceId}::uuid and line_no=${l.lineNo} and kind='acquisition'`);await tx.execute(sql`update leather_cost_roots set accrued=true,config=config || ${json({deliveryLineId:l.id})} where id=${root.id}`);out.push(journalLine(ctx,(await itemAccounts(tx,l.itemId)).stockAccountId,value));total=total.plus(value);}
 out.push(journalLine(ctx,await mapped(tx,'goods_receipt_accrual'),total.neg()));return journal(tx,ctx,doc.docDate,'leather_receipt_accrual',sourceId,'Faturasız mal kabulü geçici değer',out);
}
async function accountForTarget(tx:Tx,s:Row):Promise<string>{if(s.target_kind==='wip')return mapped(tx,'production_wip');const acc=await itemAccounts(tx,s.item_id);if(s.target_kind==='stock'||s.target_kind==='pending_delivery')return acc.stockAccountId;if(s.target_kind==='loss')return mapped(tx,s.config.accountKey??'stock_loss');return acc.cogsAccountId;}
/** Current-period adjustment only. The historical quantities and weighted-average transfer fractions are immutable. */
export async function applyRootDelta(tx:Tx,ctx:LeatherCtx,input:{rootId:string;amount:string;date:string;sourceKey:string;creditAccountId?:string}):Promise<{lines:AutoJournalLine[];destinations:{target:string;amount:string}[];id:string}>{
 await lockLeatherCosts(tx,ctx.companyId);const period=await requireOpenPeriod(tx,input.date);
 const existing=await all(tx,sql`select * from leather_cost_corrections where root_id=${input.rootId}::uuid and source_key=${input.sourceKey}`);if(existing[0])throw fail('Bu maliyet farkı daha önce işlendi','LEATHER_CORRECTION_DUPLICATE');
 const root=await one(tx,sql`select * from leather_cost_roots where id=${input.rootId}::uuid for update`,'Maliyet kaynağı');if(dec(root.current_value).plus(input.amount).lt(0))throw fail('Kaynağın kesin maliyeti negatif olamaz');
 const shares=await all(tx,sql`select * from leather_cost_shares where root_id=${root.id} and share>0 order by target_key for update`);
 const split=splitLeatherCostDelta(input.amount,shares.map(s=>({key:s.target_key,share:s.share})));const destinations=split.map(s=>({target:s.key,amount:s.amount}));
 const correctionId=newId(); const lines:AutoJournalLine[]=[]; const rows:DraftRow[]=[];let index=0;
 const stockIds=[...new Set(shares.filter(s=>s.target_kind==='stock').map(s=>s.item_id as string))];await lockItems(tx,stockIds);const states=await loadItemStates(tx,stockIds);
 for(const p of split){const s=shares.find(v=>v.target_key===p.key)!;const delta=dec(p.amount);if(delta.isZero())continue;lines.push(journalLine(ctx,await accountForTarget(tx,s),delta,'Geç gelen maliyet farkı'));
  if(s.target_kind==='stock'){const st=states.get(s.item_id)!;if(dec(st.value).plus(delta).lt(0))throw fail('Düzeltme stok değerini negatif yapamaz');st.value=dec(st.value).plus(delta);const wh=await one(tx,sql`select warehouse_id from stock_movements where item_id=${s.item_id}::uuid group by warehouse_id having sum(qty)>0 order by warehouse_id limit 1`,'Eldeki stok deposu');rows.push({lineNo:++index,kind:'cost_adjust',itemId:s.item_id,warehouseId:wh.warehouse_id,qty:dec(0),value:delta});}
  else if(s.target_kind==='wip') await tx.execute(sql`update leather_production_orders set wip_value=wip_value+${delta.toFixed(2)} where id=${s.order_id}::uuid`);
  else await tx.execute(sql`update leather_cost_shares set config=config || jsonb_build_object('remainingValue',((coalesce(config->>'remainingValue','0'))::numeric+${delta.toFixed(2)}::numeric)::text) where target_key=${s.target_key}`);
 }
 let stockDocumentId:string|null=null;if(rows.length){const d=await insertDocument(tx,ctx,period.id,{docDate:input.date,type:'receipt',warehouseId:rows[0]!.warehouseId,sourceType:'leather_cost_correction',sourceId:correctionId,description:'Geç gelen üretim/edinim maliyeti'},rows);stockDocumentId=d.id;}
 let journalEntryId:string|null=null;if(input.creditAccountId){lines.push(journalLine(ctx,input.creditAccountId,dec(input.amount).neg()));journalEntryId=await journal(tx,ctx,input.date,'leather_cost_correction',correctionId,'Üretim maliyeti düzeltmesi',lines);}
 await tx.execute(sql`insert into leather_cost_corrections(id,company_id,created_by,root_id,source_key,date,amount,journal_entry_id,stock_document_id,config) values(${correctionId},${ctx.companyId},${ctx.userId},${root.id},${input.sourceKey},${input.date},${input.amount},${journalEntryId},${stockDocumentId},${json({destinations})})`);
 await tx.execute(sql`update leather_cost_roots set current_value=current_value+${input.amount}::numeric where id=${root.id}`);
 return {lines,destinations,id:correctionId};
}
export async function settleAccruedPurchase(tx:Tx,ctx:LeatherCtx,input:{invoiceId:string;date:string;lines:readonly {lineNo:number;deliveryLineId:string;quantity:string;netBase:string}[]}):Promise<{journalLines:AutoJournalLine[];handledLineNos:Set<number>}>{
 await lockLeatherCosts(tx,ctx.companyId);const journalLines:AutoJournalLine[]=[];const handledLineNos=new Set<number>();
 for(const l of input.lines){const roots=await all(tx,sql`select * from leather_cost_roots where accrued and config->>'deliveryLineId'=${l.deliveryLineId} for update`);const root=roots[0];if(!root)continue;
  const remaining=dec(root.quantity).minus(root.settled_qty);const q=dec(l.quantity);if(q.gt(remaining))throw fail('Fatura miktarı tahakkuk bakiyesini aşamaz','LEATHER_ACCRUAL_QTY_EXCEEDED');
  const p=q.eq(remaining)?dec(root.provisional_value).minus(root.settled_provisional):roundMoney(dec(root.provisional_value).times(q).div(root.quantity));const delta=roundMoney(dec(l.netBase).minus(p));
  journalLines.push(journalLine(ctx,await mapped(tx,'goods_receipt_accrual'),p));
  if(!delta.isZero()){const correction=await applyRootDelta(tx,ctx,{rootId:root.id,amount:delta.toFixed(2),date:input.date,sourceKey:`invoice:${input.invoiceId}:${l.lineNo}`});journalLines.push(...correction.lines);}
  const settlements={...(root.config.settlements??{}),[`${input.invoiceId}:${l.lineNo}`]:{invoiceId:input.invoiceId,lineNo:l.lineNo,quantity:q.toFixed(4),provisional:p.toFixed(2),delta:delta.toFixed(2),cancelled:false}};
  await tx.execute(sql`update leather_cost_roots set settled_qty=settled_qty+${q.toFixed(4)}::numeric,settled_provisional=settled_provisional+${p.toFixed(2)}::numeric,config=config || ${json({settlements})} where id=${root.id}`);handledLineNos.add(l.lineNo);
 }
 return {journalLines,handledLineNos};
}
export async function effectiveReturnValue(tx:Tx,targetKey:string,quantity:string):Promise<string|null>{const r=await all(tx,sql`select config from leather_cost_shares where target_key=${targetKey} limit 1`);if(!r[0])return null;const q=dec(r[0].config.quantity??0);if(q.lte(0)||dec(quantity).gt(q))throw fail('İade orijinal çıkışın kalan miktarını aşamaz');return roundMoney(dec(r[0].config.remainingValue??0).times(quantity).div(q)).toFixed(2);}
export async function recognizeDeliverySale(tx:Tx,ctx:LeatherCtx,deliveryLineId:string,invoiceId:string,invoiceLineNo:number,quantity:string,date:string):Promise<string|null>{
 await lockLeatherCosts(tx,ctx.companyId);const candidates=await all(tx,sql`select * from leather_cost_shares where target_kind='pending_delivery' and target_id=${deliveryLineId}::uuid limit 1`);const s=candidates[0];if(!s)return null;const value=await effectiveReturnValue(tx,s.target_key,quantity);const q=dec(s.config.quantity);await moveShares(tx,ctx,s.target_key,{key:`sale:invoice:${invoiceId}:${invoiceLineNo}`,kind:'sale',id:invoiceId,itemId:s.item_id,warehouseId:s.warehouse_id,config:{quantity,remainingValue:value}},dec(quantity).div(q).toFixed(24),`invoice-sale:${invoiceId}:${invoiceLineNo}`,date);await tx.execute(sql`update leather_cost_shares set config=config || ${json({quantity:q.minus(quantity).toFixed(4),remainingValue:dec(s.config.remainingValue).minus(value??0).toFixed(2)})} where target_key=${s.target_key}`);return value;
}
export async function allocateCost(tx:Tx,ctx:LeatherCtx,input:LeatherCostAllocationInput):Promise<Row>{
 await lockLeatherCosts(tx,ctx.companyId);await requireOpenPeriod(tx,input.date);const prior=await all(tx,sql`select * from leather_cost_allocations where request_key=${input.requestKey}::uuid`);if(prior[0])return prior[0];
 const line=await one(tx,sql`select l.*,e.status,e.entry_date,e.reversal_of_id,e.reversed_by_id,a.code as account_code,a.type as account_type from journal_lines l join journal_entries e on e.id=l.entry_id join accounts a on a.id=l.account_id where l.id=${input.sourceJournalLineId}::uuid for update of l`,'Maliyet kaynak satırı');if(line.status!=='posted'||dec(line.debit_base).lte(0)||line.party_id||line.reversal_of_id||line.reversed_by_id||!(line.account_type==='expense'||(line.account_type==='cost'&&line.account_code.startsWith('7'))||line.account_id===await mapped(tx,'default_expense')))throw fail('Kayıtlı borç gider satırı seçilmeli');
 const used=await one(tx,sql`select coalesce(sum(a.amount),0)::text as amount from leather_cost_allocations a where a.source_journal_line_id=${line.id} and not exists(select 1 from leather_cost_corrections c where c.source_key='cancel-allocation:'||a.id::text)`);if(dec(used.amount).plus(input.amount).gt(line.debit_base))throw fail('Kaynak gider tutarı birden çok kez tahsis edilemez','LEATHER_COST_OVER_ALLOCATED');
 let root:Row;if(input.orderId){root=await one(tx,sql`select * from leather_cost_roots where order_id=${input.orderId}::uuid and source_type='production_order' and kind=${input.kind}`,'Üretim maliyet izi');}else{root=await one(tx,sql`select * from leather_cost_roots where config->>'deliveryLineId'=${input.receiptLineId!} and kind='acquisition'`,'Edinim maliyet izi');}
 const applied=await applyRootDelta(tx,ctx,{rootId:root.id,amount:roundMoney(input.amount).toFixed(2),date:input.date,sourceKey:`allocation:${input.requestKey}`,creditAccountId:line.account_id});
 return one(tx,sql`insert into leather_cost_allocations(id,company_id,created_by,order_id,receipt_line_id,root_id,source_journal_line_id,amount,kind,date,request_key,config) values(${newId()},${ctx.companyId},${ctx.userId},${input.orderId??null},${input.receiptLineId??null},${root.id},${line.id},${input.amount},${input.kind},${input.date},${input.requestKey},${json({destinations:applied.destinations,note:input.note})}) returning *`);
}
export async function applyAcquisitionDelta(tx:Tx,ctx:LeatherCtx,input:{sourceKind:'invoice'|'delivery';sourceLineId:string;amount:string;date:string;sourceKey:string;creditAccountId?:string}){
 let roots:Row[];
 if(input.sourceKind==='delivery')roots=await all(tx,sql`select * from leather_cost_roots where config->>'deliveryLineId'=${input.sourceLineId} and kind='acquisition'`);
 else{const l=await one(tx,sql`select invoice_id,line_no,delivery_line_id from invoice_lines where id=${input.sourceLineId}::uuid`,'Kaynak fatura satırı');roots=l.delivery_line_id?await all(tx,sql`select * from leather_cost_roots where config->>'deliveryLineId'=${l.delivery_line_id} and kind='acquisition'`):await all(tx,sql`select * from leather_cost_roots where source_type='invoice' and source_id=${l.invoice_id} and line_no=${l.line_no} and kind='acquisition'`);}
 if(!roots[0])return null;return applyRootDelta(tx,ctx,{rootId:roots[0].id,amount:input.amount,date:input.date,sourceKey:input.sourceKey,creditAccountId:input.creditAccountId});
}
export async function reverseAcquisitionDelta(tx:Tx,ctx:LeatherCtx,input:{sourceKind:'invoice'|'delivery';sourceLineId:string;amount:string;date:string;sourceKey:string;originalSourceKey:string}){
 await lockLeatherCosts(tx,ctx.companyId);const originals=await all(tx,sql`select * from leather_cost_corrections where source_key=${input.originalSourceKey} order by created_at`);const original=originals[0];if(!original)return null;const applied=await applyRootDelta(tx,ctx,{rootId:original.root_id,amount:dec(original.amount).neg().toFixed(2),date:input.date,sourceKey:input.sourceKey});const lines=[...applied.lines];for(const d of original.config.destinations){const target=await one(tx,sql`select * from leather_cost_shares where root_id=${original.root_id} and target_key=${d.target}`);lines.push(journalLine(ctx,await accountForTarget(tx,target),d.amount));}await journal(tx,ctx,input.date,'leather_import_cancellation',applied.id,'İthalat maliyetinin güncel hedeflerden geri alınması',lines);return applied;
}
/** Parent reverses the original invoice journal. This journal changes that reversal's old destinations to today's destinations. */
export async function cancelAccruedPurchase(tx:Tx,ctx:LeatherCtx,invoiceId:string,date:string):Promise<void>{
 await lockLeatherCosts(tx,ctx.companyId);const roots=await all(tx,sql`select * from leather_cost_roots where accrued and config->'settlements' is not null for update`);
 for(const root of roots){const settlements={...root.config.settlements};for(const [key,v] of Object.entries(settlements)){const s=v as Row;if(s.invoiceId!==invoiceId||s.cancelled)continue;const delta=dec(s.delta);if(!delta.isZero()){const original=await one(tx,sql`select * from leather_cost_corrections where root_id=${root.id} and source_key=${'invoice:'+invoiceId+':'+s.lineNo}`);const applied=await applyRootDelta(tx,ctx,{rootId:root.id,amount:delta.neg().toFixed(2),date,sourceKey:`cancel-invoice:${invoiceId}:${s.lineNo}`});const lines=[...applied.lines];for(const d of original.config.destinations){const target=await one(tx,sql`select * from leather_cost_shares where root_id=${root.id} and target_key=${d.target}`);lines.push(journalLine(ctx,await accountForTarget(tx,target),d.amount));}await journal(tx,ctx,date,'leather_invoice_cancellation',applied.id,'Geç maliyet farkının güncel hedeflerden geri alınması',lines);}settlements[key]={...s,cancelled:true};await tx.execute(sql`update leather_cost_roots set settled_qty=settled_qty-${s.quantity}::numeric,settled_provisional=settled_provisional-${s.provisional}::numeric where id=${root.id}`);}await tx.execute(sql`update leather_cost_roots set config=config || ${json({settlements})} where id=${root.id}`);}
}
export async function reverseAllocatedJournalCosts(tx:Tx,ctx:LeatherCtx,entryId:string,date:string):Promise<void>{
 await lockLeatherCosts(tx,ctx.companyId);const allocations=await all(tx,sql`select a.*,l.account_id from leather_cost_allocations a join journal_lines l on l.id=a.source_journal_line_id where l.entry_id=${entryId}::uuid and not exists(select 1 from leather_cost_corrections c where c.source_key='cancel-allocation:'||a.id::text)`);for(const a of allocations)await applyRootDelta(tx,ctx,{rootId:a.root_id,amount:dec(a.amount).neg().toFixed(2),date,sourceKey:'cancel-allocation:'+a.id,creditAccountId:a.account_id});
}
export async function reverseStockTrace(tx:Tx,ctx:LeatherCtx,originalDoc:{id:string},reversalDoc:{id:string;docDate:string},originalRows:readonly {itemId:string;lineNo:number;kind:string;qty:string;value:string;warehouseId:string}[]):Promise<void>{
 void originalRows;
 await lockLeatherCosts(tx,ctx.companyId);const prior=await all(tx,sql`select id from leather_cost_events where source_key=${'reverse-stock:'+reversalDoc.id} limit 1`);if(prior.length)return;
 const roots=await all(tx,sql`select * from leather_cost_roots where config->>'documentId'=${originalDoc.id} for update`);for(const r of roots){const located=await all(tx,sql`select * from leather_cost_shares where root_id=${r.id} and share>0`);if(located.some(s=>s.target_kind!=='stock'))throw fail('Edinim maliyeti üretime veya satışa aktarılmış; kabul doğrudan ters çevrilemez');await tx.execute(sql`update leather_cost_shares set share=0 where root_id=${r.id}`);await tx.execute(sql`update leather_cost_roots set current_value=0,config=config || '{"cancelled":true}'::jsonb where id=${r.id}`);}
 const events=await all(tx,sql`select * from leather_cost_events where source_key like ${'stock:'+originalDoc.id+':%'} order by created_at desc`);
 for(const e of events){const destination=await one(tx,sql`select * from leather_cost_shares where root_id=${e.root_id} and target_key=${e.to_key} for update`);if(dec(destination.share).lt(e.share))throw fail('Sonraki maliyet pay hareketi var; kaynak düzeltme belgesi kullanın');const from=await one(tx,sql`select * from leather_cost_shares where root_id=${e.root_id} and target_key=${e.from_key} for update`);await tx.execute(sql`update leather_cost_shares set share=share-${e.share}::numeric where id=${destination.id}`);await tx.execute(sql`update leather_cost_shares set share=share+${e.share}::numeric where id=${from.id}`);await tx.execute(sql`insert into leather_cost_events(id,company_id,created_by,root_id,source_key,from_key,to_key,share,value,date) values(${newId()},${ctx.companyId},${ctx.userId},${e.root_id},${'reverse-stock:'+reversalDoc.id},${e.to_key},${e.from_key},${e.share},${e.value},${reversalDoc.docDate})`);}
 const pieces=await all(tx,sql`select p.* from leather_pieces p join leather_lots l on l.id=p.lot_id join delivery_notes n on n.id=l.delivery_note_id where n.stock_document_id=${originalDoc.id}::uuid for update of p`);
 for(const p of pieces){if(!dec(p.remaining_area).eq(p.area)||p.parent_id)throw fail('Fiziksel kabulde sonraki kesim veya tüketim var; kabul doğrudan iptal edilemez');await tx.execute(sql`update leather_pieces set remaining_area=0,status='consumed',config=config || ${json({receiptCancelled:true,reversalStockDocumentId:reversalDoc.id})} where id=${p.id}`);await tx.execute(sql`insert into leather_piece_events(id,company_id,created_by,piece_id,date,kind,quantity,config) values(${newId()},${ctx.companyId},${ctx.userId},${p.id},${reversalDoc.docDate},'receipt_cancel',${p.area},${json({stockDocumentId:reversalDoc.id})})`);}
}
export async function reverseDeliveryAccrual(tx:Tx,ctx:LeatherCtx,noteId:string,date:string):Promise<void>{const entries=await all(tx,sql`select id from journal_entries where source_type='leather_receipt_accrual' and source_id=${noteId}::uuid and reversal_of_id is null`);if(entries[0])await reverseJournalEntry(tx,ctx,entries[0].id,{entryDate:date,description:'Mal kabul tahakkuk iptali',source:{type:'leather_receipt_accrual_cancel',id:noteId}});}
export async function unrecognizeDeliverySale(tx:Tx,ctx:LeatherCtx,invoiceId:string,invoiceLineNo:number,deliveryLineId:string,deliveryLineNo:number,originalCost:string,date:string):Promise<void>{
 await lockLeatherCosts(tx,ctx.companyId);const key=`sale:invoice:${invoiceId}:${invoiceLineNo}`;const rows=await all(tx,sql`select * from leather_cost_shares where target_key=${key} and share>0 limit 1`);const s=rows[0];if(!s)return;const pending=`pending_delivery:${deliveryLineId}:${deliveryLineNo}`;const prior=await all(tx,sql`select config from leather_cost_shares where target_key=${pending} limit 1`);const conf={quantity:dec(prior[0]?.config.quantity??0).plus(s.config.quantity).toFixed(4),remainingValue:dec(prior[0]?.config.remainingValue??0).plus(s.config.remainingValue).toFixed(2)};await moveShares(tx,ctx,key,{key:pending,kind:'pending_delivery',id:deliveryLineId,itemId:s.item_id,warehouseId:s.warehouse_id,config:conf},'1',`cancel-sale:${invoiceId}:${invoiceLineNo}`,date);const extra=dec(s.config.remainingValue).minus(originalCost);if(!extra.isZero()){const acc=await itemAccounts(tx,s.item_id);await journal(tx,ctx,date,'leather_sale_cancellation',invoiceId,'Sevk maliyet farkının geri taşınması',[journalLine(ctx,acc.stockAccountId,extra),journalLine(ctx,acc.cogsAccountId,extra.neg())]);}
}
