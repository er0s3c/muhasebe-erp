import { and,desc,eq,sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createApiKeySchema,createWebhookSubscriptionSchema,createInvoiceSchema,uuid } from '@erp/shared';
import { uuidv7 } from 'uuidv7';
import { companyApiKeys,integrationWriteRequests,items,parties,webhookEvents,webhookSubscriptions } from '../../db/schema';
import { tenantRoute,type TenantCtx } from '../../http/context';
import { conflict,forbidden,notFound,unprocessable } from '../../http/errors';
import { encryptField } from '../hr/crypto';
import { requireResourceOperation } from '../access/effective';
import { createInvoiceDraft,getInvoice,listInvoices } from '../invoices/service';
import { listInvoicesQuerySchema } from '@erp/shared';
import { apiKeyHash,newSecret,requestHash } from './crypto';
import { integrationRoute,scopePermission } from './auth';
import { enqueueInvoiceWebhook } from './events';

const idOf=(params:unknown)=>z.object({id:uuid}).parse(params).id;
function admin(c:TenantCtx){if(!['owner','admin'].includes(c.role)||c.branch.mode!=='all'||c.branch.selection!=='all')throw forbidden('Entegrasyon yönetimi yönetici yetkisi ve tüm şubeler görünümü ister','PLATFORM_ADMIN_REQUIRED');}
async function checkBranch(c:TenantCtx,id:string|null){if(id&&(await c.tx.execute(sql`select id from company_branches where id=${id}::uuid and is_active`)).rows.length===0)throw unprocessable('Etkin ve aynı şirkete ait şube seçin','BRANCH_INACTIVE');}
const safeSubscription=(row:typeof webhookSubscriptions.$inferSelect)=>{const {secretEncrypted,...safe}=row;void secretEncrypted;return safe;};
// İki aşama: dış sözleşme post alanını reddeder, ortak şema satır/refine kurallarını uygular.
const externalDraftSchema=z.object(createInvoiceSchema.shape).omit({post:true}).extend({type:z.literal('sales')}).strict();
export const platformIntegrationRoutes:FastifyPluginAsync=async(app)=>{
 const read={module:'core.integrations',permission:'core.integrations.read'} as const,write={module:'core.integrations',permission:'core.integrations.manage'} as const;
 app.get('/api/company/api-keys',tenantRoute(app,read,async(c)=>{admin(c);return {keys:await c.tx.select({id:companyApiKeys.id,name:companyApiKeys.name,lastFour:companyApiKeys.lastFour,scopes:companyApiKeys.scopes,branchId:companyApiKeys.branchId,expiresAt:companyApiKeys.expiresAt,revokedAt:companyApiKeys.revokedAt,lastUsedAt:companyApiKeys.lastUsedAt,createdAt:companyApiKeys.createdAt}).from(companyApiKeys).orderBy(desc(companyApiKeys.createdAt))};}));
 app.post('/api/company/api-keys',tenantRoute(app,write,async(c)=>{
  admin(c);const input=createApiKeySchema.parse(c.req.body),expiresAt=new Date(input.expiresAt);if(expiresAt<=new Date()||expiresAt.getTime()>Date.now()+365*86400000)throw unprocessable('Anahtarın süresi gelecek bir tarih ve en çok 365 gün olmalı','API_KEY_TTL');
  await checkBranch(c,input.branchId);for(const scope of input.scopes)c.require(scopePermission[scope]);if(input.scopes.includes('invoices.create_draft'))requireResourceOperation(c.access,'core.invoices','create');
  const id=uuidv7(),token='erp_'+id+'.'+newSecret();await c.tx.insert(companyApiKeys).values({id,companyId:c.company.id,organizationId:c.user.orgId,createdBy:c.user.id,name:input.name,keyHash:apiKeyHash(token,app.config.JWT_SECRET),lastFour:token.slice(-4),scopes:input.scopes,branchId:input.branchId,expiresAt});
  c.reply.code(201).header('cache-control','no-store');return {id,token};
 }));
 app.post('/api/company/api-keys/:id/revoke',tenantRoute(app,write,async(c)=>{admin(c);const [key]=await c.tx.update(companyApiKeys).set({revokedAt:new Date()}).where(eq(companyApiKeys.id,idOf(c.req.params))).returning({id:companyApiKeys.id});if(!key)throw notFound('API anahtarı');return {ok:true};}));
 app.get('/api/company/webhook-subscriptions',tenantRoute(app,read,async(c)=>{admin(c);return {subscriptions:(await c.tx.select().from(webhookSubscriptions).orderBy(desc(webhookSubscriptions.createdAt))).map(safeSubscription)};}));
 app.post('/api/company/webhook-subscriptions',tenantRoute(app,write,async(c)=>{admin(c);c.require('invoices.read');const input=createWebhookSubscriptionSchema.parse(c.req.body);await checkBranch(c,input.branchId);await app.webhookTransport.validate(input.url);const secret=newSecret();const [row]=await c.tx.insert(webhookSubscriptions).values({...input,companyId:c.company.id,createdBy:c.user.id,secretEncrypted:encryptField(secret,'platform-webhook:'+app.config.JWT_SECRET)}).returning();c.reply.code(201).header('cache-control','no-store');return {subscription:safeSubscription(row!),secret};}));
 app.patch('/api/company/webhook-subscriptions/:id',tenantRoute(app,write,async(c)=>{admin(c);const input=z.object({enabled:z.boolean()}).strict().parse(c.req.body),[row]=await c.tx.update(webhookSubscriptions).set({...input,updatedAt:new Date()}).where(and(eq(webhookSubscriptions.id,idOf(c.req.params)),sql`${webhookSubscriptions.revokedAt} is null`)).returning();if(!row)throw notFound('Bildirim bağlantısı');return {subscription:safeSubscription(row)};}));
 app.post('/api/company/webhook-subscriptions/:id/revoke',tenantRoute(app,write,async(c)=>{admin(c);const [row]=await c.tx.update(webhookSubscriptions).set({enabled:false,revokedAt:new Date(),updatedAt:new Date()}).where(eq(webhookSubscriptions.id,idOf(c.req.params))).returning();if(!row)throw notFound('Bildirim bağlantısı');return {ok:true};}));
 app.post('/api/company/webhook-subscriptions/:id/rotate-secret',tenantRoute(app,write,async(c)=>{admin(c);const secret=newSecret(),[row]=await c.tx.update(webhookSubscriptions).set({secretEncrypted:encryptField(secret,'platform-webhook:'+app.config.JWT_SECRET),secretVersion:sql`${webhookSubscriptions.secretVersion}+1`,updatedAt:new Date()}).where(and(eq(webhookSubscriptions.id,idOf(c.req.params)),sql`${webhookSubscriptions.revokedAt} is null`)).returning();if(!row)throw notFound('Bildirim bağlantısı');c.reply.header('cache-control','no-store');return {subscription:safeSubscription(row),secret};}));
 app.get('/api/company/webhook-subscriptions/:id/deliveries',tenantRoute(app,read,async(c)=>{admin(c);return {deliveries:await c.tx.select({id:webhookEvents.id,eventType:webhookEvents.eventType,status:webhookEvents.status,attempts:webhookEvents.attempts,createdAt:webhookEvents.createdAt,deliveredAt:webhookEvents.deliveredAt,lastHttpStatus:webhookEvents.lastHttpStatus,lastError:webhookEvents.lastError,nextAttemptAt:webhookEvents.nextAttemptAt,invoiceId:webhookEvents.invoiceId}).from(webhookEvents).where(eq(webhookEvents.subscriptionId,idOf(c.req.params))).orderBy(desc(webhookEvents.createdAt)).limit(100)};}));
 app.post('/api/company/webhook-deliveries/:id/retry',tenantRoute(app,write,async(c)=>{admin(c);const [event]=await c.tx.update(webhookEvents).set({status:'pending',attempts:0,nextAttemptAt:new Date(),leaseToken:null,leaseUntil:null,lastError:null}).where(and(eq(webhookEvents.id,idOf(c.req.params)),sql`${webhookEvents.status} in ('dead_letter','cancelled')`)).returning();if(!event)throw conflict('Yalnız teslimi duran bildirim yeniden denenebilir','WEBHOOK_RETRY_STATUS');return {ok:true};}));
 const base='/api/integration/v1/companies/:companyId';const page=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
 app.get(base+'/items',integrationRoute(app,'inventory.read',async(c)=>{const p=page.parse(c.req.query);return {items:await c.tx.select({id:items.id,code:items.code,name:items.name,kind:items.kind,unit:items.unit,isActive:items.isActive}).from(items).orderBy(items.code).limit(p.limit).offset(p.offset)};}));
 app.get(base+'/parties',integrationRoute(app,'parties.read',async(c)=>{const p=page.parse(c.req.query);return {parties:await c.tx.select({id:parties.id,code:parties.code,name:parties.name,kind:parties.kind,isActive:parties.isActive}).from(parties).orderBy(parties.code).limit(p.limit).offset(p.offset)};}));
 app.get(base+'/invoices',integrationRoute(app,'invoices.read',async(c)=>listInvoices(c.tx,listInvoicesQuerySchema.extend({limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(c.req.query))));
 app.post(base+'/invoices',integrationRoute(app,'invoices.create_draft',async(c)=>{
  const requestId=uuid.parse(c.req.headers['idempotency-key']),input=createInvoiceSchema.parse({...externalDraftSchema.parse(c.req.body),post:false});if(input.matchOverrideReason)throw forbidden('Dış API eşleştirme sapması uygulamaz');
  const hash=requestHash(input);await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'integration-write:'+c.apiKeyId+':'+requestId},0))`);
  const [prior]=await c.tx.select().from(integrationWriteRequests).where(and(eq(integrationWriteRequests.apiKeyId,c.apiKeyId),eq(integrationWriteRequests.requestId,requestId)));
  if(prior){if(prior.requestHash!==hash)throw conflict('Aynı tekrar anahtarı farklı belge içeriğiyle kullanıldı','IDEMPOTENCY_CONFLICT');c.reply.code(201).header('idempotency-replayed','true');return prior.response;}
  const id=await createInvoiceDraft(c.tx,{companyId:c.company.id,userId:c.user.id,baseCurrency:c.company.baseCurrency,reportingCurrency:c.company.reportingCurrency,allowNegativeStock:c.company.allowNegativeStock},{...input,post:false});
  const response=await getInvoice(c.tx,id);await enqueueInvoiceWebhook(c.tx,id,'invoice.draft.created');await c.tx.insert(integrationWriteRequests).values({companyId:c.company.id,apiKeyId:c.apiKeyId,requestId,requestHash:hash,response});c.reply.code(201);return response;
 }));
};
