import { createHash } from 'node:crypto';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { createPosTillSchema, openPosSessionSchema, closePosSessionSchema, posSaleSchema, posReturnSchema, posExpectedCash, createInvoiceSchema, createPartySchema, createTreasuryTransactionSchema, dec, roundMoney, todayIso, uuid, type CurrencyCode, type PosSaleInput, type PosReturnInput } from '@erp/shared';
import { items, memberships, users, warehouses, treasuryAccounts, parties } from '../../db/schema';
import { posTills, posSessions, posSales, type PosPayment } from '../../db/pos-schema';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden, notFound, unprocessable, conflict } from '../../http/errors';
import { createInvoiceDraft, getInvoice, resolveVat, type InvoiceCtx } from '../invoices/service';
import { postInvoice } from '../invoices/posting';
import { createParty, openItemsFor } from '../parties/service';
import { resolvePrice } from '../sales/pricing';
import { postTreasuryTransaction } from '../treasury/posting';
import { assertCashOk, lockTreasuryAccounts } from '../treasury/accounts';
import { createJournalEntry } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { requireOpenPeriod } from '../settings/periods';
import { requireActiveWarehouse } from '../inventory/warehouses';
import { availableStock } from '../leather/production';

const idParams = z.object({ id: uuid });
const ctxOf = (c: TenantCtx): InvoiceCtx => ({ companyId:c.company.id,userId:c.user.id,baseCurrency:c.company.baseCurrency,reportingCurrency:c.company.reportingCurrency,allowNegativeStock:false });
const hashOf = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function lockPos(c:TenantCtx) {
  // Shared with leather cost tracing, before any row locks.
  await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`leather-costs:${c.company.id}`},0))`);
}
async function tillFor(c:TenantCtx,id:string,lock=false) {
  const query=c.tx.select().from(posTills).where(eq(posTills.id,id));
  const [till]=await (lock?query.for('update'):query);
  if(!till)throw notFound('Mağaza kasası');
  if(!c.can('pos.manage')&&!till.assignedUserIds.includes(c.user.id))throw forbidden('Bu kasaya atanmadınız','POS_TILL_ACCESS');
  return till;
}
async function sessionFor(c:TenantCtx,id:string,write=false) {
  const query=c.tx.select().from(posSessions).where(eq(posSessions.id,id));
  const [session]=await (write?query.for('update'):query);
  if(!session)throw notFound('Kasa vardiyası');
  if(session.userId!==c.user.id&&!c.can('pos.manage'))throw forbidden('Bu vardiyaya erişiminiz yok','POS_SESSION_ACCESS');
  const till=await tillFor(c,session.tillId);
  if(write&&(session.status!=='open'||!till.isActive))throw unprocessable('Kasa vardiyası kapalı veya kasa pasif','POS_SESSION_CLOSED');
  return {session,till};
}
async function safeInvoice(c:TenantCtx,id:string) {
  const result=await getInvoice(c.tx,id);
  return {...result,lines:result.lines.map(line=>{
    const publicLine:Record<string,unknown>={...line};
    delete publicLine.costValue;delete publicLine.stockValue;
    return publicLine;
  })};
}
async function saleResult(c:TenantCtx,sale:typeof posSales.$inferSelect) {
  const invoice=await safeInvoice(c,sale.invoiceId);
  const returned=(await c.tx.execute<{source_id:string;qty:string}>(sql`select l.source_line_id as source_id,sum(l.quantity)::text as qty from invoice_lines l join invoices i on i.id=l.invoice_id where i.type='sales_return' and i.status='posted' and i.return_of_id=${sale.invoiceId}::uuid group by l.source_line_id`)).rows;
  const quantities=new Map(returned.map(r=>[r.source_id,r.qty]));
  return {sale:{...sale,date:invoice.invoice.invoiceDate,lines:invoice.lines.map(line=>({...line,returnedQuantity:quantities.get(String(line.id))??'0'}))},invoice};
}
async function replay(c:TenantCtx,requestId:string,requestHash:string,sessionId:string) {
  const [sale]=await c.tx.select().from(posSales).where(eq(posSales.requestId,requestId));
  if(!sale)return null;
  if(sale.sessionId!==sessionId||sale.requestHash!==requestHash)throw conflict('İşlem kimliği farklı bir işlem için kullanılmış','POS_REQUEST_CONFLICT');
  await sessionFor(c,sessionId);
  return saleResult(c,sale);
}
async function pricedLines(c:TenantCtx,till:typeof posTills.$inferSelect,partyId:string,input:PosSaleInput['lines']) {
  const rows=await c.tx.select().from(items).where(inArray(items.id,[...new Set(input.map(l=>l.itemId))]));
  const byId=new Map(rows.map(r=>[r.id,r]));
  const output=[];
  for(const line of input) {
    const item=byId.get(line.itemId);
    if(!item||!item.isActive||item.kind!=='goods')throw unprocessable('Aktif ürün bulunamadı','POS_ITEM_INVALID');
    const price=await resolvePrice(c.tx,{kind:'sales',item:{id:item.id,salePrice:item.salePrice,saleCurrency:item.saleCurrency,purchasePrice:item.purchasePrice,purchaseCurrency:item.purchaseCurrency},partyId,date:todayIso(),currency:till.currencyCode,quantity:line.quantity});
    if(price.unitPrice===null)throw unprocessable(`${item.name}: kasa para biriminde satış fiyatı tanımlayın`,'POS_PRICE_MISSING');
    const discount=line.discountPct??price.discountPct;
    if(line.discountPct!==undefined&&dec(discount).gt(dec(price.discountPct).gt(till.maxDiscountPct)?price.discountPct:till.maxDiscountPct))c.require('pos.approve');
    output.push({itemId:item.id,description:item.name,quantity:line.quantity,unitPrice:price.unitPrice,discountPct:discount,vatCode:item.vatCode,unit:item.unit,...(line.serials?{serials:line.serials}:{})});
  }
  return output;
}
function assertPayments(payments:readonly {method:string;amount:string}[],total:string,till:typeof posTills.$inferSelect) {
  if(!dec(total).gt(0))throw unprocessable('Satış toplamı sıfırdan büyük olmalı','POS_ZERO_TOTAL');
  if(!roundMoney(payments.reduce((s,p)=>s.plus(p.amount),dec(0))).eq(total))throw unprocessable('Ödemeler işlem toplamına eşit olmalı','POS_PAYMENT_TOTAL');
  if(payments.some(p=>p.method==='card')&&!till.cardAccountId)throw unprocessable('Bu kasada kart ödeme hesabı tanımlı değil','POS_CARD_DISABLED');
}
async function recordSale(c:TenantCtx,sessionId:string,input:PosSaleInput) {
  await lockPos(c);
  const requestHash=hashOf({kind:'sale',sessionId,input});
  const duplicate=await replay(c,input.requestId,requestHash,sessionId);if(duplicate)return duplicate;
  const {till}=await sessionFor(c,sessionId,true);
  const partyId=input.customerId??till.walkInPartyId;
  const lines=await pricedLines(c,till,partyId,input.lines);
  const ctx=ctxOf(c);
  const invoiceId=await createInvoiceDraft(c.tx,ctx,createInvoiceSchema.parse({type:'sales',partyId,invoiceDate:todayIso(),currency:till.currencyCode,warehouseId:till.warehouseId,description:`Mağaza satışı · ${till.name}`,lines}));
  const posted=await postInvoice(c.tx,ctx,invoiceId);
  assertPayments(input.payments,posted.invoice.grossTotal!,till);
  const saleId=uuidv7();
  const open=(await openItemsFor(c.tx,partyId,'receivable',todayIso())).items.find(i=>i.entryId===posted.invoice.journalEntryId);
  if(!open)throw unprocessable('Satışın cari kalemi bulunamadı','POS_INVOICE_ITEM');
  const payments:PosPayment[]=[];
  for(const payment of input.payments) {
    const result=await postTreasuryTransaction(c.tx,ctx,createTreasuryTransactionSchema.parse({type:'receipt',date:todayIso(),accountId:payment.method==='cash'?till.cashAccountId:till.cardAccountId,amount:payment.amount,partyId,items:[{lineId:open.lineId,amount:payment.amount,settleAmount:payment.amount}],description:`Mağaza satışı ${posted.invoice.invoiceNo}`}));
    payments.push({...payment,transactionId:result.transaction.id});
  }
  const [sale]=await c.tx.insert(posSales).values({id:saleId,companyId:c.company.id,sessionId,requestId:input.requestId,invoiceId,kind:'sale',total:posted.invoice.grossTotal!,payments,requestHash,createdBy:c.user.id}).returning();
  return saleResult(c,sale!);
}
async function recordReturn(c:TenantCtx,sourceSaleId:string,input:PosReturnInput) {
  c.require('pos.approve');
  await lockPos(c);
  const requestHash=hashOf({kind:'return',sourceSaleId,input});
  const duplicate=await replay(c,input.requestId,requestHash,input.sessionId);if(duplicate)return duplicate;
  const {till}=await sessionFor(c,input.sessionId,true);
  const [source]=await c.tx.select().from(posSales).where(eq(posSales.id,sourceSaleId)).for('update');
  if(!source||source.kind!=='sale')throw notFound('Asıl mağaza satışı');
  await sessionFor(c,source.sessionId);
  const original=await getInvoice(c.tx,source.invoiceId);
  if(original.invoice.status!=='posted')throw unprocessable('Asıl satış iptal edilmiş','POS_SALE_CANCELLED');
  const byId=new Map(original.lines.map(l=>[l.id,l]));
  if(new Set(input.lines.map(l=>l.sourceLineId)).size!==input.lines.length)throw unprocessable('Aynı iade satırı iki kez girilemez','POS_RETURN_DUPLICATE');
  const lines=input.lines.map(l=>{
    const sourceLine=byId.get(l.sourceLineId);if(!sourceLine)throw unprocessable('İade satırı asıl satışta yok','POS_RETURN_SOURCE');
    return {itemId:sourceLine.itemId,description:sourceLine.description,quantity:l.quantity,unitPrice:sourceLine.unitPrice,discountPct:sourceLine.discountPct,vatCode:sourceLine.vatCode,unit:sourceLine.unit,sourceLineId:l.sourceLineId,...(l.serials?{serials:l.serials}:{})};
  });
  const ctx=ctxOf(c);
  const invoiceId=await createInvoiceDraft(c.tx,ctx,createInvoiceSchema.parse({type:'sales_return',partyId:original.invoice.partyId,invoiceDate:todayIso(),currency:till.currencyCode,warehouseId:till.warehouseId,returnOfId:source.invoiceId,description:input.reason,lines}));
  const posted=await postInvoice(c.tx,ctx,invoiceId);
  assertPayments(input.refunds,posted.invoice.grossTotal!,till);
  const saleId=uuidv7(), payments:PosPayment[]=[];
  const map=await requireMappings(c.tx,['receivable']);
  const locked=await lockTreasuryAccounts(c.tx,[till.cashAccountId,...(till.cardAccountId?[till.cardAccountId]:[])]);
  for(const payment of input.refunds) {
    const accountId=payment.method==='cash'?till.cashAccountId:till.cardAccountId!;
    const account=locked.get(accountId)!;
    if(!account.isActive)throw unprocessable('Ödeme hesabı pasif','TREASURY_ACCOUNT_INACTIVE');
    await assertCashOk(c.tx,account,todayIso(),dec(payment.amount));
    const refundId=uuidv7();
    // Customer refund debits the customer's receivable credit from the return,
    // rather than using supplier-payment semantics or duplicating sale revenue.
    const entry=await createJournalEntry(c.tx,ctx,{entryDate:todayIso(),description:`Mağaza iadesi ${posted.invoice.invoiceNo}`,post:true,lines:[
      {accountId:map.receivable,currency:till.currencyCode as CurrencyCode,debit:payment.amount,credit:'0',partyId:original.invoice.partyId,dueDate:todayIso()},
      {accountId:account.accountId,currency:till.currencyCode as CurrencyCode,debit:'0',credit:payment.amount},
    ]},{source:{type:'pos_refund',id:refundId}});
    payments.push({...payment,journalEntryId:entry.id});
  }
  const [sale]=await c.tx.insert(posSales).values({id:saleId,companyId:c.company.id,sessionId:input.sessionId,requestId:input.requestId,invoiceId,sourceSaleId,kind:'return',total:posted.invoice.grossTotal!,payments,requestHash,createdBy:c.user.id}).returning();
  return saleResult(c,sale!);
}

export const posRoutes:FastifyPluginAsync=async app=>{
  const read={module:'sales.pos',permission:'pos.read'} as const;
  const manage={module:'sales.pos',permission:'pos.manage'} as const;
  const sell={module:'sales.pos',permission:'pos.sell'} as const;
  app.get('/api/pos/customers',tenantRoute(app,read,async c=>{
    const query=z.object({query:z.string().trim().max(100).optional()}).parse(c.req.query);
    return {customers:await c.tx.select({id:parties.id,name:parties.name,code:parties.code}).from(parties).where(and(eq(parties.isActive,true),inArray(parties.kind,['customer','both']),query.query?or(ilike(parties.name,`%${query.query}%`),ilike(parties.code,`%${query.query}%`)):undefined)).limit(100)};
  }));
  app.get('/api/pos/bootstrap',tenantRoute(app,manage,async c=>({
    warehouses:await c.tx.select({id:warehouses.id,name:warehouses.name}).from(warehouses).where(eq(warehouses.isActive,true)),
    accounts:await c.tx.select({id:treasuryAccounts.id,name:treasuryAccounts.name,kind:treasuryAccounts.kind,currencyCode:treasuryAccounts.currencyCode}).from(treasuryAccounts).where(eq(treasuryAccounts.isActive,true)),
    customers:await c.tx.select({id:parties.id,name:parties.name,code:parties.code}).from(parties).where(and(eq(parties.isActive,true),inArray(parties.kind,['customer','both']))),
    members:await c.tx.select({userId:users.id,fullName:users.fullName,email:users.email}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(and(eq(memberships.companyId,c.company.id),eq(users.isActive,true))),
  })));
  app.get('/api/pos/tills',tenantRoute(app,read,async c=>({tills:(await c.tx.select().from(posTills)).filter(t=>c.can('pos.manage')||t.assignedUserIds.includes(c.user.id))})));
  app.post('/api/pos/tills',tenantRoute(app,manage,async c=>{
    const input=createPosTillSchema.parse(c.req.body);await lockPos(c);
    await requireActiveWarehouse(c.tx,input.warehouseId,'Mağaza deposu');
    const accounts=await lockTreasuryAccounts(c.tx,[input.cashAccountId,...(input.cardAccountId?[input.cardAccountId]:[])]);
    if(accounts.get(input.cashAccountId)!.kind!=='cash')throw unprocessable('Nakit hesabı kasa türünde olmalı','POS_CASH_ACCOUNT');
    for(const account of accounts.values())if(!account.isActive||account.currencyCode!==c.company.baseCurrency)throw unprocessable('Kasa ödeme hesapları aktif ve şirket para biriminde olmalı','POS_ACCOUNT_CURRENCY');
    if(input.cardAccountId&&accounts.get(input.cardAccountId)!.kind!=='bank')throw unprocessable('Kart hesabı banka türünde olmalı','POS_CARD_ACCOUNT');
    const members=await c.tx.select({id:memberships.userId}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(and(eq(memberships.companyId,c.company.id),eq(users.isActive,true),inArray(memberships.userId,input.assignedUserIds)));
    if(new Set(members.map(m=>m.id)).size!==new Set(input.assignedUserIds).size)throw unprocessable('Atanan kullanıcı şirketin aktif üyesi olmalı','POS_ASSIGNEE_INVALID');
    const partyId=input.walkInPartyId??(await createParty(c.tx,c.company.id,createPartySchema.parse({name:`Mağaza müşterileri · ${input.name}`,kind:'customer',currencyCode:c.company.baseCurrency}))).id;
    const [party]=await c.tx.select().from(parties).where(eq(parties.id,partyId));
    if(!party||!party.isActive||party.kind==='supplier')throw unprocessable('Aktif müşteri carisi seçin','POS_CUSTOMER_INVALID');
    const [till]=await c.tx.insert(posTills).values({id:uuidv7(),companyId:c.company.id,...input,walkInPartyId:partyId,currencyCode:c.company.baseCurrency,createdBy:c.user.id}).returning();
    void c.reply.code(201);return {till};
  }));
  app.get('/api/pos/catalog',tenantRoute(app,read,async c=>{
    const query=z.object({tillId:uuid,customerId:uuid.optional(),query:z.string().trim().max(100).optional(),barcode:z.string().trim().max(40).optional()}).parse(c.req.query);
    const till=await tillFor(c,query.tillId);
    if(query.customerId){
      const [customer]=await c.tx.select().from(parties).where(eq(parties.id,query.customerId));
      if(!customer||!customer.isActive||customer.kind==='supplier')throw unprocessable('Aktif müşteri carisi seçin','POS_CUSTOMER_INVALID');
    }
    const conditions=[eq(items.isActive,true),eq(items.kind,'goods')];
    if(query.barcode)conditions.push(eq(items.barcode,query.barcode));
    else if(query.query)conditions.push(or(ilike(items.name,`%${query.query}%`),ilike(items.code,`%${query.query}%`))!);
    const rows=await c.tx.select().from(items).where(and(...conditions)).limit(100);
    const rates=await resolveVat(c.tx,rows.flatMap(i=>i.vatCode?[i.vatCode]:[]),todayIso());
    const output=[];
    for(const item of rows) {
      const price=await resolvePrice(c.tx,{kind:'sales',item:{id:item.id,salePrice:item.salePrice,saleCurrency:item.saleCurrency,purchasePrice:item.purchasePrice,purchaseCurrency:item.purchaseCurrency},partyId:query.customerId??till.walkInPartyId,date:todayIso(),currency:till.currencyCode});
      if(price.unitPrice===null)continue;
      const vatRate=(item.vatCode?rates.get(item.vatCode):null)??'0';
      const available=await availableStock(c.tx,item.id,till.warehouseId);
      output.push({id:item.id,code:item.code,name:item.name,barcode:item.barcode,unit:item.unit,vatCode:item.vatCode,vatRate,unitPrice:price.unitPrice,discountPct:price.discountPct,grossUnitPrice:roundMoney(dec(price.unitPrice).times(dec(1).minus(dec(price.discountPct).div(100))).times(dec(1).plus(dec(vatRate).div(100)))).toFixed(2),available});
    }
    return {items:output};
  }));
  app.get('/api/pos/sessions',tenantRoute(app,read,async c=>({sessions:await c.tx.select().from(posSessions).where(c.can('pos.manage')?undefined:eq(posSessions.userId,c.user.id)).orderBy(sql`${posSessions.openedAt} desc`).limit(100)})));
  app.get('/api/pos/sales/:id',tenantRoute(app,read,async c=>{
    const [sale]=await c.tx.select().from(posSales).where(eq(posSales.id,idParams.parse(c.req.params).id));
    if(!sale)throw notFound('Mağaza satışı');const {session,till}=await sessionFor(c,sale.sessionId);
    return {...await saleResult(c,sale),session,till};
  }));
  app.post('/api/pos/sessions',tenantRoute(app,sell,async c=>{
    const input=openPosSessionSchema.parse(c.req.body);await lockPos(c);const till=await tillFor(c,input.tillId,true);
    if(!till.isActive)throw unprocessable('Kasa pasif','POS_TILL_INACTIVE');await requireOpenPeriod(c.tx,todayIso());
    const existing=await c.tx.select().from(posSessions).where(and(eq(posSessions.status,'open'),or(eq(posSessions.tillId,till.id),eq(posSessions.userId,c.user.id))));
    if(existing.length)throw conflict('Bu kasanın veya kullanıcının açık vardiyası var','POS_SESSION_ALREADY_OPEN');
    const [session]=await c.tx.insert(posSessions).values({id:uuidv7(),companyId:c.company.id,tillId:till.id,userId:c.user.id,openingCash:input.openingCash}).returning();void c.reply.code(201);return {session};
  }));
  app.get('/api/pos/sessions/:id',tenantRoute(app,read,async c=>{
    const {session,till}=await sessionFor(c,idParams.parse(c.req.params).id);
    const rows=await c.tx.select().from(posSales).where(eq(posSales.sessionId,session.id)).orderBy(posSales.createdAt);
    const sales=[];for(const row of rows)sales.push((await saleResult(c,row)).sale);
    return {session:{...session,expectedCash:posExpectedCash(session.openingCash,rows)},till,sales};
  }));
  app.post('/api/pos/sessions/:id/sales',tenantRoute(app,sell,async c=>{const result=await recordSale(c,idParams.parse(c.req.params).id,posSaleSchema.parse(c.req.body));void c.reply.code(201);return result;}));
  app.post('/api/pos/sales/:id/returns',tenantRoute(app,{module:'sales.pos',permission:'pos.approve'},async c=>{const result=await recordReturn(c,idParams.parse(c.req.params).id,posReturnSchema.parse(c.req.body));void c.reply.code(201);return result;}));
  app.post('/api/pos/sessions/:id/close',tenantRoute(app,sell,async c=>{
    const input=closePosSessionSchema.parse(c.req.body);await lockPos(c);const {session}=await sessionFor(c,idParams.parse(c.req.params).id,true);
    const rows=await c.tx.select().from(posSales).where(eq(posSales.sessionId,session.id));
    const expectedCash=posExpectedCash(session.openingCash,rows),variance=dec(input.countedCash).minus(expectedCash).toFixed(2);
    if(!dec(variance).isZero()&&!input.reason)throw unprocessable('Kasa farkı için gerekçe girin','POS_VARIANCE_REASON');
    const [closed]=await c.tx.update(posSessions).set({status:'closed',expectedCash,countedCash:input.countedCash,variance,closeReason:input.reason??null,closedAt:new Date()}).where(eq(posSessions.id,session.id)).returning();return {session:closed};
  }));
};
