import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { campaignSchema,evaluateCampaign,calcInvoice,dec,idParam,uuid,updateInvoiceSchema,type CampaignRow,type CampaignPreview } from '@erp/shared';
import { tenantRoute,type TenantCtx } from '../../http/context';
import { badRequest,notFound,conflict } from '../../http/errors';
import { getInvoice,resolveVat,updateInvoiceDraft } from '../invoices/service';
import { requireRecord } from '../workspace/records';

async function campaign(c:TenantCtx,id:string,lock=false):Promise<CampaignRow>{
  const row=(await c.tx.execute<{id:string;config:unknown;version:number;applications:number}>(sql`select s.id,s.config,s.version,(select count(*)::int from campaign_applications a where a.campaign_id=s.id) as applications from sales_campaigns s where id=${id}::uuid ${lock?sql`for update`:sql``}`)).rows[0];
  if(!row)throw notFound('Kampanya');return {...campaignSchema.parse(row.config),id:row.id,version:row.version,applications:row.applications};
}
async function validateTargets(c:TenantCtx,input:ReturnType<typeof campaignSchema.parse>){
  if(input.partyId)await requireRecord(c,'party',input.partyId);
  if(input.itemId){c.require('inventory.read');const item=(await c.tx.execute(sql`select id from items where id=${input.itemId}::uuid and is_active`)).rows[0];if(!item)throw notFound('Stok / hizmet');}
}
async function preview(c:TenantCtx,id:string,invoiceId:string){
  const offer=await campaign(c,id),source=await getInvoice(c.tx,invoiceId),i=source.invoice;
  const result=evaluateCampaign(offer,{date:i.invoiceDate,currency:i.currencyCode,partyId:i.partyId,lines:source.lines});
  if(i.type!=='sales'||i.status!=='draft')result.reasons.push('Kampanya yalnızca satış faturası taslağına uygulanır.');
  if((await c.tx.execute(sql`select id from campaign_applications where invoice_id=${invoiceId}::uuid`)).rows.length)result.reasons.push('Bu faturaya daha önce kampanya uygulanmış. İndirimler fatura satırında düzenlenebilir.');
  const rates=await resolveVat(c.tx,source.lines.map(l=>l.vatCode).filter((code):code is string=>!!code),i.invoiceDate);
  const computed=calcInvoice(source.lines.map((l,index)=>({quantity:l.quantity,unitPrice:l.unitPrice,vatRate:rates.get(l.vatCode??'')??'0',discountPct:result.matches[index]?offer.discountPct:l.discountPct})),i.vatIncluded);
  const netAfter=computed.net.toFixed(4),grossAfter=computed.gross.toFixed(4);
  const fingerprint=createHash('sha256').update(JSON.stringify({offer,invoice:i,lines:source.lines,netAfter,grossAfter})).digest('hex');
  const response:CampaignPreview={campaign:offer,fingerprint,eligible:!result.reasons.length,reasons:result.reasons,lines:source.lines.map((l,index)=>({lineNo:l.lineNo,description:l.description,eligible:result.matches[index]!,discountPct:result.matches[index]?offer.discountPct:l.discountPct})),currency:i.currencyCode,netBefore:String(i.netTotal),netAfter,grossBefore:String(i.grossTotal),grossAfter,discountNet:dec(i.netTotal).minus(computed.net).toFixed(4)};
  return {response,source};
}
export const campaignRoutes:FastifyPluginAsync=async app=>{
  const read={module:'core.invoices',permission:'invoices.read'} as const,write={module:'core.invoices',permission:'invoices.manage'} as const;
  app.get('/api/sales/campaigns',tenantRoute(app,read,async c=>{
    const rows=(await c.tx.execute<{id:string;config:unknown;version:number;applications:number}>(sql`select s.id,s.config,s.version,(select count(*)::int from campaign_applications a where a.campaign_id=s.id) as applications from sales_campaigns s order by s.created_at desc limit 200`)).rows;
    return {items:rows.map(row=>({...campaignSchema.parse(row.config),id:row.id,version:row.version,applications:row.applications}))};
  }));
  app.post('/api/sales/campaigns',tenantRoute(app,write,async c=>{
    const input=campaignSchema.parse(c.req.body);await validateTargets(c,input);const id=uuidv7();await c.tx.execute(sql`insert into sales_campaigns(id,company_id,code,config,created_by) values(${id},${c.company.id},${input.code},${JSON.stringify(input)}::jsonb,${c.user.id})`);void c.reply.code(201);return {id};
  }));
  app.put('/api/sales/campaigns/:id',tenantRoute(app,write,async c=>{
    const {id}=idParam.parse(c.req.params),input=z.object({config:campaignSchema,version:z.number().int().positive()}).parse(c.req.body);await campaign(c,id);await validateTargets(c,input.config);
    const rows=await c.tx.execute(sql`update sales_campaigns set code=${input.config.code},config=${JSON.stringify(input.config)}::jsonb,version=version+1,updated_at=now() where id=${id}::uuid and version=${input.version} returning id`);if(!rows.rows.length)throw conflict('Kampanya değişti; yenileyin.');return {ok:true};
  }));
  app.get('/api/sales/campaigns/:id/history',tenantRoute(app,read,async c=>{
    const {id}=idParam.parse(c.req.params);await campaign(c,id);return {items:(await c.tx.execute(sql`select a.id,a.invoice_id as "invoiceId",a.snapshot,a.created_at as "createdAt",u.full_name as "userName",i.status,i.invoice_no as "invoiceNo" from campaign_applications a join invoices i on i.id=a.invoice_id join users u on u.id=a.created_by where a.campaign_id=${id}::uuid order by a.created_at desc limit 200`)).rows};
  }));
  app.post('/api/sales/campaigns/:id/preview',tenantRoute(app,{...read,limit:{name:'campaign-preview',max:30,windowMs:60000}},async c=>{const {id}=idParam.parse(c.req.params),{invoiceId}=z.object({invoiceId:uuid}).parse(c.req.body);return (await preview(c,id,invoiceId)).response;}));
  app.post('/api/sales/campaigns/:id/apply',tenantRoute(app,{...write,limit:{name:'campaign-apply',max:20,windowMs:60000}},async c=>{
    const {id}=idParam.parse(c.req.params),{invoiceId,fingerprint}=z.object({invoiceId:uuid,fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).parse(c.req.body);
    await c.tx.execute(sql`select id from invoices where id=${invoiceId}::uuid for update`);await campaign(c,id,true);
    const {response,source}=await preview(c,id,invoiceId);if(response.fingerprint!==fingerprint)throw conflict('Fatura veya kampanya değişti; tekrar önizleyin.');if(!response.eligible)throw badRequest(response.reasons.join(' '));
    const i=source.invoice;
    const input=updateInvoiceSchema.parse({partyId:i.partyId,invoiceDate:i.invoiceDate,dueDate:i.dueDate,currency:i.currencyCode,...(i.fxRate?{fxRate:i.fxRate}:{}),vatIncluded:i.vatIncluded,warehouseId:i.warehouseId,description:i.description??undefined,post:false,
      lines:source.lines.map((l,index)=>({itemId:l.itemId,description:l.description,quantity:l.quantity,unit:l.unit,unitPrice:l.unitPrice,discountPct:response.lines[index]!.discountPct,vatCode:l.vatCode,accountId:l.accountId,deliveryLineId:l.deliveryLineId,salesOrderLineId:l.salesOrderLineId,projectId:l.projectId,wbsId:l.wbsId,serials:l.serials}))});
    await updateInvoiceDraft(c.tx,{companyId:c.company.id,userId:c.user.id,baseCurrency:c.company.baseCurrency,reportingCurrency:c.company.reportingCurrency,allowNegativeStock:c.company.allowNegativeStock},invoiceId,input);
    await c.tx.execute(sql`insert into campaign_applications(id,company_id,campaign_id,invoice_id,snapshot,created_by) values(${uuidv7()},${c.company.id},${id},${invoiceId},${JSON.stringify(response)}::jsonb,${c.user.id})`);
    return {ok:true,invoiceId,netAfter:response.netAfter,grossAfter:response.grossAfter};
  }));
};
