import { z } from 'zod';
import { changeVariantRevision } from './catalog';
import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';

import { uuid, idParam, manufacturingModelSchema, manufacturingRevisionSchema, leatherModelSchema, leatherRevisionSchema, leatherVariantSchema, leatherReceiptSchema, leatherPieceAcceptanceSchema, leatherProductionSchema, leatherProductionFromSalesSchema, leatherDatedActionSchema, leatherIssueSchema, leatherMaterialReturnSchema, leatherCompletionSchema, leatherOperationSchema, leatherCutSchema, leatherQualitySchema, leatherQualityDecisionSchema, leatherCostAllocationSchema, leatherSubcontractSchema, leatherSubcontractActionSchema, leatherCustomOrderSchema, leatherCustomOrderActionSchema, leatherServiceSchema, leatherServiceActionSchema } from '@erp/shared';
import { tenantRoute, type TenantCtx, type TenantRouteOptions } from '../../http/context';
import { forbidden } from '../../http/errors';
import { all, one, mapped, type LeatherCtx } from './common';
import { listModels, createModel, listRevisions, createRevision, updateRevision, approveRevision, listVariants, createVariant } from './catalog';
import { listLots, listPieces, receiveMaterial, acceptPiece, cutMaterial } from './materials';
import { createProduction, getProduction, documentsFor, releaseProduction, issueProduction, returnMaterial, completeProduction, recordOperation, productionFromSales, cancelProduction } from './production';
import { allocateCost } from './costs';
import { createSubcontract, subcontractAction, customAction, serviceAction } from './advanced';
import { redactLeatherCosts } from './access';
import { overview, qualityShape, createQuality, decideQuality, listSubcontracts, listCustomOrders, createCustomOrder, listServiceCases, createServiceCase } from './workflows';
const ctx=(c:TenantCtx):LeatherCtx=>({companyId:c.company.id,userId:c.user.id,baseCurrency:c.company.baseCurrency,reportingCurrency:c.company.reportingCurrency,allowNegativeStock:false});
const id=(c:TenantCtx)=>idParam.parse(c.req.params).id;
const catalogRead={module:'leather.catalog',permission:'leather.catalog.read'} as const;
const catalogManage={module:'leather.catalog',permission:'leather.catalog.manage'} as const;
const catalogApprove={module:'leather.catalog',permission:'leather.catalog.approve'} as const;
const materialRead={module:'leather.materials',permission:'leather.materials.read'} as const;
const materialManage={module:'leather.materials',permission:'leather.materials.manage'} as const;
const productionRead={module:'leather.production',permission:'leather.production.read'} as const;
const productionManage={module:'leather.production',permission:'leather.production.manage'} as const;
const productionApprove={module:'leather.production',permission:'leather.production.approve'} as const;
const qualityRead={module:'leather.quality',permission:'leather.quality.read'} as const;
const qualityManage={module:'leather.quality',permission:'leather.quality.manage'} as const;
const qualityApprove={module:'leather.quality',permission:'leather.quality.approve'} as const;
const subcontractRead={module:'leather.subcontracting',permission:'leather.subcontracting.read'} as const;
const subcontractManage={module:'leather.subcontracting',permission:'leather.subcontracting.manage'} as const;
const serviceRead={module:'leather.service',permission:'leather.service.read'} as const;
const serviceManage={module:'leather.service',permission:'leather.service.manage'} as const;
async function assignedOrder(c:TenantCtx,orderId:string){if(c.role!=='operator')return;const o=await one(c.tx,sql`select coalesce(config->>'assignedUserId',created_by::text) as assigned from leather_production_orders where id=${orderId}::uuid`);if(o.assigned!==c.user.id)throw forbidden('Operatör yalnızca kendisine atanmış üretimde işlem yapabilir','LEATHER_ASSIGNMENT_REQUIRED');}
export function productionCoreRoutes(generic = false): FastifyPluginAsync { return async app=>{
 const translate = (p:string)=>generic?p.replace('leather.','manufacturing.'):p;
 const adapt = (c:TenantCtx):TenantCtx=>generic?{...c,can:p=>c.can(translate(p) as never),require:p=>c.require(translate(p) as never)}:c;
 const register = (method:'get'|'post'|'put',path:string,handler:ReturnType<typeof tenantRoute>)=>{
  if(generic && (path.includes('/materials/')||path.includes('/custom-orders')||path.includes('/service/')))return;
  app[method](generic?path.replace('/api/leather','/api/manufacturing'):path,handler);
 };

 const route=<T>(options:TenantRouteOptions,handler:(c:TenantCtx)=>Promise<T>)=>tenantRoute(app,{...options,module:options.module?translate(options.module):undefined,permission:options.permission?translate(options.permission) as never:undefined},async original=>{
  const c=adapt(original);
  if(c.role==='operator'){
   const path=c.req.routeOptions.url??'';const body=c.req.body as Record<string,unknown>|undefined;
   if(path.includes('/production/orders/:id'))await assignedOrder(c,id(c));
   if(path.endsWith('/materials/cuts')&&body?.orderId)await assignedOrder(c,String(body.orderId));
   if(path.endsWith('/production/orders')&&c.req.method==='POST')throw forbidden('Üretim planını atölye yöneticisi açar; operatör atanmış emirde çalışır','LEATHER_ASSIGNMENT_REQUIRED');
   if(path.endsWith('/production/from-sales-order'))throw forbidden('Siparişleri üretime atölye yöneticisi aktarır','LEATHER_ASSIGNMENT_REQUIRED');
   if(path.endsWith('/quality/checks')&&c.req.method==='POST'&&body?.scope==='production')await assignedOrder(c,String(body.sourceId));
  }
  const result=await handler(c);return(c.can('leather.costs.read')?result:redactLeatherCosts(result)) as T;
 });
 register('get','/api/leather/overview',route(catalogRead,async c=>({overview:await overview(c.tx)})));
 register('get','/api/leather/lookups',route({},async c=>{
  if(!['leather.catalog.read','leather.materials.read','leather.production.read','leather.quality.read','leather.subcontracting.read','leather.service.read'].some(p=>c.can(p as never)))throw forbidden('Deri çalışma alanı okuma izni gerekli','LEATHER_LOOKUP_DENIED');
  const items=await all(c.tx,sql`select id,code,name,unit,kind,inventory_role as "inventoryRole" from items where is_active order by name limit 1000`);
  const warehouses=await all(c.tx,sql`select id,name from warehouses where is_active order by name`);const parties=await all(c.tx,sql`select id,name,kind from parties where is_active order by name limit 1000`);
  const saleLines=c.can('leather.service.read')||c.can('leather.catalog.manage')?await all(c.tx,sql`select l.id,l.invoice_id as "invoiceId",i.party_id as "partyId",l.item_id as "itemId",l.description,l.quantity from invoice_lines l join invoices i on i.id=l.invoice_id join leather_variants v on v.item_id=l.item_id where i.type='sales' and i.status='posted' order by i.invoice_date desc limit 500`):[];
  const serviceInvoices=c.can('leather.service.read')?await all(c.tx,sql`select distinct i.id,i.party_id as "partyId",i.invoice_no as "invoiceNo",i.description from invoices i join invoice_lines l on l.invoice_id=i.id left join items it on it.id=l.item_id where i.type='sales' and i.status='posted' and (l.item_id is null or it.kind='service') limit 500`):[];
  const customInvoices=c.can('leather.catalog.manage')?await all(c.tx,sql`select distinct i.id,i.party_id as "partyId",i.invoice_no as "invoiceNo",s.order_id as "salesOrderId" from invoices i join invoice_lines l on l.invoice_id=i.id join sales_order_lines s on s.id=l.sales_order_line_id join leather_custom_orders o on o.config->>'salesOrderId'=s.order_id::text where i.type='sales' and i.status='posted' limit 500`):[];
  const salesOrderLines=c.can('leather.production.read')?await all(c.tx,sql`select l.id,l.order_id as "orderId",o.doc_no as "orderNo",o.party_id as "partyId",l.item_id as "itemId",i.name as "itemName",v.id as "variantId",l.quantity,(l.quantity-coalesce((select sum(case when p.status='completed' then p.completed_qty else p.quantity end) from leather_production_orders p where p.config->>'salesOrderLineId'=l.id::text and p.status<>'cancelled'),0))::text as remaining from sales_order_lines l join sales_orders o on o.id=l.order_id join items i on i.id=l.item_id join leather_variants v on v.item_id=l.item_id where o.kind='order' and o.status='confirmed' limit 500`):[];
  const costLines=c.can('leather.costs.read')?await all(c.tx,sql`select l.id,e.entry_date as "entryDate",a.code as "accountCode",l.description,l.debit_base as "debitBase",(l.debit_base-coalesce((select sum(c.amount) from leather_cost_allocations c where c.source_journal_line_id=l.id and not exists(select 1 from leather_cost_corrections x where x.source_key='cancel-allocation:'||c.id::text)),0))::text as remaining from journal_lines l join journal_entries e on e.id=l.entry_id join accounts a on a.id=l.account_id where e.status='posted' and l.debit_base>0 and l.party_id is null and (a.type='expense' or (a.type='cost' and a.code like '7%') or a.id=${await mapped(c.tx,'default_expense')}::uuid) and e.reversal_of_id is null and e.reversed_by_id is null order by e.entry_date desc limit 500`):[];
  const depositTransactions=c.can('leather.catalog.manage')?await all(c.tx,sql`select id,party_id as "partyId",description,amount,currency_code as "currencyCode" from treasury_transactions where status='posted' and type='other_receipt' and gl_account_id=${await mapped(c.tx,'advance_received')}::uuid and not exists(select 1 from leather_custom_orders o where o.deposit_transaction_id=treasury_transactions.id) order by txn_date desc limit 200`):[];
  const members=c.can('leather.production.manage')?await all(c.tx,sql`select m.user_id as id,u.full_name as name from memberships m join users u on u.id=m.user_id where m.company_id=${c.company.id}::uuid and u.is_active ${c.role==='operator'?sql`and m.user_id=${c.user.id}::uuid`:sql``} order by u.full_name`):[];
  const resources=await all(c.tx,sql`select id,config->>'name' as name from manufacturing_records where kind='resource' and status='active' order by code`);
  const lots=c.can('leather.production.read')?await all(c.tx,sql`select id,code,item_id as "itemId",warehouse_id as "warehouseId",coalesce(config->>'remainingQty',config->>'quantity') as quantity from manufacturing_records where kind='lot' and status='available' order by created_at`):[];
  return {items,warehouses,parties,saleLines,serviceInvoices,customInvoices,salesOrderLines,costLines,depositTransactions,members,resources,lots};
 }));
 register('get','/api/leather/catalog/models',route(catalogRead,async c=>({models:await listModels(c.tx)})));
 register('post','/api/leather/catalog/models',route(catalogManage,async c=>{const model=await createModel(c.tx,ctx(c),(generic?manufacturingModelSchema:leatherModelSchema).parse(c.req.body));void c.reply.code(201);return{model};}));
 register('get','/api/leather/catalog/models/:id/revisions',route(catalogRead,async c=>({revisions:await listRevisions(c.tx,id(c))})));
 register('post','/api/leather/catalog/models/:id/revisions',route(catalogManage,async c=>{const revision=await createRevision(c.tx,ctx(c),id(c),(generic?manufacturingRevisionSchema:leatherRevisionSchema).parse(c.req.body));void c.reply.code(201);return{revision};}));
 register('put','/api/leather/catalog/revisions/:id',route(catalogManage,async c=>({revision:await updateRevision(c.tx,id(c),(generic?manufacturingRevisionSchema:leatherRevisionSchema).parse(c.req.body))})));
 register('post','/api/leather/catalog/revisions/:id/approve',route(catalogApprove,async c=>({revision:await approveRevision(c.tx,ctx(c),id(c))})));
 register('get','/api/leather/catalog/variants',route(catalogRead,async c=>({variants:await listVariants(c.tx)})));
 register('post','/api/leather/catalog/variants',route(catalogManage,async c=>{const variant=await createVariant(c.tx,ctx(c),leatherVariantSchema.parse(c.req.body));void c.reply.code(201);return{variant};}));
 register('post','/api/leather/catalog/variants/:id/revision',route(catalogApprove,async c=>({variant:await changeVariantRevision(c.tx,ctx(c),id(c),z.object({revisionId:uuid}).parse(c.req.body).revisionId)})));
 register('get','/api/leather/materials/lots',route(materialRead,async c=>({lots:await listLots(c.tx)})));
 register('get','/api/leather/materials/pieces',route(materialRead,async c=>({pieces:await listPieces(c.tx)})));
 register('post','/api/leather/materials/receipts',route(materialManage,async c=>{const lot=await receiveMaterial(c.tx,ctx(c),leatherReceiptSchema.parse(c.req.body));void c.reply.code(201);return{lot};}));
 register('post','/api/leather/materials/pieces/:id/accept',route(qualityApprove,async c=>({piece:await acceptPiece(c.tx,ctx(c),id(c),leatherPieceAcceptanceSchema.parse(c.req.body))})));
 register('post','/api/leather/materials/cuts',route(productionManage,async c=>{const d=await cutMaterial(c.tx,ctx(c),leatherCutSchema.parse(c.req.body));return {document:(await documentsFor(c.tx,d.order_id)).find(x=>x.id===d.id)};}));
 register('get','/api/leather/production/orders',route(productionRead,async c=>{const ids=await all(c.tx,sql`select id from leather_production_orders ${c.role==='operator'?sql`where coalesce(config->>'assignedUserId',created_by::text)=${c.user.id}`:sql``} order by created_at desc limit 300`);return {orders:await Promise.all(ids.map(o=>getProduction(c.tx,o.id)))};}));
 register('post','/api/leather/production/orders',route(productionManage,async c=>{const order=await createProduction(c.tx,ctx(c),leatherProductionSchema.parse(c.req.body));void c.reply.code(201);return{order};}));
 register('post','/api/leather/production/from-sales-order',route(productionManage,async c=>{const orders=await productionFromSales(c.tx,ctx(c),leatherProductionFromSalesSchema.parse(c.req.body));void c.reply.code(201);return {orders};}));
 register('get','/api/leather/production/orders/:id',route(productionRead,async c=>({order:await getProduction(c.tx,id(c)),documents:await documentsFor(c.tx,id(c))})));
 register('post','/api/leather/production/orders/:id/release',route(productionApprove,async c=>({order:await releaseProduction(c.tx,ctx(c),id(c),leatherDatedActionSchema.parse(c.req.body))})));
 register('post','/api/leather/production/orders/:id/issues',route(productionManage,async c=>{const d=await issueProduction(c.tx,ctx(c),id(c),leatherIssueSchema.parse(c.req.body));return {order:await getProduction(c.tx,id(c)),document:(await documentsFor(c.tx,id(c))).find(x=>x.id===d.id)};}));
 register('post','/api/leather/production/orders/:id/returns',route(productionManage,async c=>{const d=await returnMaterial(c.tx,ctx(c),id(c),leatherMaterialReturnSchema.parse(c.req.body));return {order:await getProduction(c.tx,id(c)),document:(await documentsFor(c.tx,id(c))).find(x=>x.id===d.id)};}));
 register('post','/api/leather/production/orders/:id/completions',route(productionApprove,async c=>{const d=await completeProduction(c.tx,ctx(c),id(c),leatherCompletionSchema.parse(c.req.body));return {order:await getProduction(c.tx,id(c)),document:(await documentsFor(c.tx,id(c))).find(x=>x.id===d.id)};}));
 register('post','/api/leather/production/orders/:id/operations',route(productionManage,async c=>({order:await recordOperation(c.tx,ctx(c),id(c),leatherOperationSchema.parse(c.req.body))})));
 register('post','/api/leather/production/orders/:id/cancel',route(productionApprove,async c=>({order:await cancelProduction(c.tx,ctx(c),id(c),leatherDatedActionSchema.parse(c.req.body))})));
 register('get','/api/leather/quality/checks',route(qualityRead,async c=>({checks:(await all(c.tx,sql`select * from leather_quality_checks order by created_at desc limit 500`)).map(qualityShape)})));
 register('post','/api/leather/quality/checks',route(qualityManage,async c=>{const check=await createQuality(c.tx,ctx(c),leatherQualitySchema.parse(c.req.body));void c.reply.code(201);return{check};}));
 register('post','/api/leather/quality/checks/:id/decision',route(qualityApprove,async c=>({check:await decideQuality(c.tx,ctx(c),id(c),leatherQualityDecisionSchema.parse(c.req.body))})));
 register('get','/api/leather/costs/allocations',route({module:'leather.production',permission:'leather.costs.read'},async c=>({allocations:(await all(c.tx,sql`select * from leather_cost_allocations order by created_at desc limit 500`)).map(r=>({...r.config,id:r.id,orderId:r.order_id,receiptLineId:r.receipt_line_id,sourceJournalLineId:r.source_journal_line_id,amount:r.amount,kind:r.kind,date:r.date}))})));
 register('post','/api/leather/costs/allocations',route({module:'leather.production',permission:'leather.costs.manage'},async c=>{const allocation=await allocateCost(c.tx,ctx(c),leatherCostAllocationSchema.parse(c.req.body));void c.reply.code(201);return {allocation};}));
 register('get','/api/leather/subcontracting/jobs',route(subcontractRead,async c=>({jobs:await listSubcontracts(c.tx)})));
 register('post','/api/leather/subcontracting/jobs',route(subcontractManage,async c=>{const job=await createSubcontract(c.tx,ctx(c),leatherSubcontractSchema.parse(c.req.body));void c.reply.code(201);return{job};}));
 register('post','/api/leather/subcontracting/jobs/:id/actions',route(subcontractManage,async c=>{const input=leatherSubcontractActionSchema.parse(c.req.body);if(input.sourceJournalLineId)c.require('leather.costs.manage');return {job:await subcontractAction(c.tx,ctx(c),id(c),input)};}));
 register('get','/api/leather/custom-orders',route(catalogRead,async c=>({customOrders:await listCustomOrders(c.tx)})));
 register('post','/api/leather/custom-orders',route(catalogManage,async c=>{const customOrder=await createCustomOrder(c.tx,ctx(c),leatherCustomOrderSchema.parse(c.req.body));void c.reply.code(201);return{customOrder};}));
 register('post','/api/leather/custom-orders/:id/actions',route(catalogManage,async c=>({customOrder:await customAction(c.tx,ctx(c),id(c),leatherCustomOrderActionSchema.parse(c.req.body))})));
 register('get','/api/leather/service/cases',route(serviceRead,async c=>({cases:await listServiceCases(c.tx)})));
 register('post','/api/leather/service/cases',route(serviceManage,async c=>{const serviceCase=await createServiceCase(c.tx,ctx(c),leatherServiceSchema.parse(c.req.body));void c.reply.code(201);return{serviceCase};}));
 register('post','/api/leather/service/cases/:id/actions',route(serviceManage,async c=>({serviceCase:await serviceAction(c.tx,ctx(c),id(c),leatherServiceActionSchema.parse(c.req.body))})));
 register('get','/api/leather/costs/corrections',route({module:'leather.production',permission:'leather.costs.read'},async c=>({corrections:await all(c.tx,sql`select id,root_id as "rootId",source_key as "sourceKey",date,amount,config from leather_cost_corrections order by created_at desc limit 500`)})));
 register('get','/api/leather/materials/lots/:id',route(materialRead,async c=>({lot:await one(c.tx,sql`select * from leather_lots where id=${id(c)}::uuid`,'Deri partisi')})));
 // A deliberately bounded query, not arbitrary record/table access.
 register('get','/api/leather/catalog/revisions/:id',route(catalogRead,async c=>{const r=await one(c.tx,sql`select * from leather_revisions where id=${id(c)}::uuid`);return {revision:{...r.config,id:r.id,modelId:r.model_id,revision:r.revision,status:r.status,approvedAt:r.approved_at}};}));

}; }
export const leatherRoutes = productionCoreRoutes();
export const manufacturingCoreRoutes = productionCoreRoutes(true);
