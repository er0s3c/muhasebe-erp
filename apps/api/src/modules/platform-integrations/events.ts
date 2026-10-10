import { and,eq,inArray,sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { resolveEnabledModules,resourceOperationAllowed,type PlatformWebhookEventType,type Role,type Sector } from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import type { Tx } from '../../db/client';
import { withContext,setContext } from '../../db/client';
import { companies,companyModules,memberships,users,webhookEvents,webhookSubscriptions } from '../../db/schema';
import { loadMemberAccess,isModuleDenied } from '../access/effective';
import { decryptField } from '../hr/crypto';
import { webhookSignature } from './crypto';
import type { WebhookTransport } from './transport';

declare module 'fastify' {interface FastifyInstance {webhookTransport:WebhookTransport;}}
export async function enqueueInvoiceWebhook(tx:Tx,invoiceId:string,type:PlatformWebhookEventType){
 await tx.execute(sql`select enqueue_invoice_webhooks(${invoiceId}::uuid,${type})`);
}
const retryMs=[30000,120000,600000,3600000,21600000];
export async function processPlatformWebhooks(app:FastifyInstance,now=new Date()){
 const license=await app.license.current();if(license.enforced&&!['active','grace'].includes(license.state))return;
 const targets=(await app.db.execute<{company_id:string;organization_id:string}>(sql`select company_id,organization_id from notification_scan_targets()`)).rows;
 for(const target of targets){
  for(let count=0;count<10;count++){
   const claimed=await withContext(app.db,{companyId:target.company_id,orgId:target.organization_id},async(tx)=>{
    await tx.execute(sql`select set_config('app.worker','platform-webhook',true)`);
    const [event]=await tx.select().from(webhookEvents).where(and(inArray(webhookEvents.status,['pending','sending']),sql`${webhookEvents.nextAttemptAt}<=${now.toISOString()}::timestamptz`,sql`(${webhookEvents.leaseUntil} is null or ${webhookEvents.leaseUntil}<${now.toISOString()}::timestamptz)`)).orderBy(webhookEvents.nextAttemptAt).limit(1).for('update',{skipLocked:true});
    if(!event)return null;
    const [subscription]=await tx.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id,event.subscriptionId));
    if(!subscription?.enabled||subscription.revokedAt){await tx.update(webhookEvents).set({status:'cancelled',lastError:'Bildirim bağlantısı kapalı veya iptal edilmiş',leaseToken:null,leaseUntil:null}).where(eq(webhookEvents.id,event.id));return {skip:true} as const;}
    await setContext(tx,{companyId:target.company_id,orgId:target.organization_id,userId:subscription.createdBy});
    const [member]=await tx.select({role:memberships.role,active:users.isActive}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(and(eq(memberships.companyId,target.company_id),eq(memberships.userId,subscription.createdBy)));
    const [company]=await tx.select({sector:companies.sector}).from(companies).where(eq(companies.id,target.company_id));
    const access=member?.active?await loadMemberAccess(tx,target.company_id,subscription.createdBy,member.role as Role):null;
    const modules=company?resolveEnabledModules(company.sector as Sector,await tx.select({module:companyModules.module,enabled:companyModules.enabled}).from(companyModules)):new Set<string>();
    const allowed=(await tx.execute<{ok:boolean}>(sql`select app_branch_has_access(${target.company_id}::uuid,${event.branchId}::uuid) as ok`)).rows[0]?.ok;
    if(!access?.permissions.has('core.integrations.manage')||!access.permissions.has('invoices.read')||!resourceOperationAllowed(access.permissions,access.overrides,'core.invoices','export')||isModuleDenied(access,'core.integrations')||isModuleDenied(access,'core.invoices')||!modules.has('core.integrations')||!modules.has('core.invoices')||!allowed||(license.enforced&&company&&!app.license.sectorAllowed(license,company.sector))){
     await setContext(tx,{companyId:target.company_id,orgId:target.organization_id});await tx.update(webhookEvents).set({status:'cancelled',lastError:'Bağlantı sahibinin güncel şirket, şube veya modül erişimi yok',leaseToken:null,leaseUntil:null}).where(eq(webhookEvents.id,event.id));return {skip:true} as const;
    }
    await setContext(tx,{companyId:target.company_id,orgId:target.organization_id});
    const leaseToken=uuidv7();await tx.update(webhookEvents).set({status:'sending',attempts:event.attempts+1,leaseToken,leaseUntil:new Date(now.getTime()+60000)}).where(eq(webhookEvents.id,event.id));
    return {event:{...event,attempts:event.attempts+1},subscription,leaseToken,skip:false} as const;
   });
   if(!claimed)break;if(claimed.skip)continue;
   let status:number|null=null,error:string|null=null;
   try{
    const timestamp=String(Math.floor(Date.now()/1000)),secret=decryptField(claimed.subscription.secretEncrypted,'platform-webhook:'+app.config.JWT_SECRET);
    status=await app.webhookTransport.send(claimed.subscription.url,{'x-erp-event-id':claimed.event.id,'x-erp-timestamp':timestamp,'x-erp-secret-version':String(claimed.subscription.secretVersion),'x-erp-signature':webhookSignature(secret,timestamp,claimed.event.id,claimed.event.body)},claimed.event.body);
    if(status<200||status>=300)error='HTTP '+status;
   }catch(failure){error=failure instanceof Error?failure.message.slice(0,500):'Bildirim teslim edilemedi';}
   await withContext(app.db,{companyId:target.company_id,orgId:target.organization_id},async(tx)=>{
    await tx.execute(sql`select set_config('app.worker','platform-webhook',true)`);
    const delivered=!error,dead=claimed.event.attempts>=6;
    await tx.update(webhookEvents).set({status:delivered?'delivered':dead?'dead_letter':'pending',deliveredAt:delivered?new Date():null,lastHttpStatus:status,lastError:error,nextAttemptAt:new Date(Date.now()+(retryMs[Math.min(claimed.event.attempts-1,retryMs.length-1)]??21600000)),leaseToken:null,leaseUntil:null}).where(and(eq(webhookEvents.id,claimed.event.id),eq(webhookEvents.leaseToken,claimed.leaseToken)));
   });
  }
 }
}
export function startPlatformWebhookScheduler(app:FastifyInstance){
 let running=false;const tick=async()=>{if(running)return;running=true;try{await processPlatformWebhooks(app);}catch(error){app.log.warn({error},'İmzalı bildirim teslimi');}finally{running=false;}};
 const timer=setInterval(()=>void tick(),30000);timer.unref();const first=setTimeout(()=>void tick(),20000);first.unref();return()=>{clearInterval(timer);clearTimeout(first);};
}
