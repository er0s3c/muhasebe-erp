import { and,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import { resolveEnabledModules,uuid,type ApiKeyScope,type Permission,type Role,type Sector } from '@erp/shared';
import type { FastifyInstance,RouteHandlerMethod } from 'fastify';
import { withContext,setContext } from '../../db/client';
import { companies,companyApiKeys,companyModules,memberships,users } from '../../db/schema';
import { GUARD,type GuardMeta,type TenantCtx } from '../../http/context';
import { forbidden,unauthorized,AppError } from '../../http/errors';
import { withCompanyTimeZone } from '../../http/company-time';
import { assertLicensed } from '../../licensing/gate';
import { loadMemberAccess,isModuleDenied,requirePermission,requireResourceOperation } from '../access/effective';
import { apiKeyHash,sameHash } from './crypto';

export const scopePermission:Record<ApiKeyScope,Permission>={'inventory.read':'inventory.read','parties.read':'parties.read','invoices.read':'invoices.read','invoices.create_draft':'invoices.manage'};
const scopeModule:Record<ApiKeyScope,string>={'inventory.read':'core.inventory','parties.read':'core.parties','invoices.read':'core.invoices','invoices.create_draft':'core.invoices'};
export function integrationRoute<T>(app:FastifyInstance,scope:ApiKeyScope,handler:(c:TenantCtx&{apiKeyId:string})=>Promise<T>):RouteHandlerMethod{
 const route:RouteHandlerMethod=async(req,reply)=>{
  const license=await assertLicensed(app.license,req),{companyId}=z.object({companyId:uuid}).passthrough().parse(req.params);
  const token=req.headers.authorization?.match(/^Bearer (erp_([0-9a-f-]{36})\.[A-Za-z0-9_-]{43})$/i);
  if(!token||!uuid.safeParse(token[2]).success)throw unauthorized('API anahtarı geçersiz');
  const rate=await app.limiter.consume('platform-key:'+companyId+':'+token[2],120,60000);if(!rate.ok){reply.header('retry-after',String(rate.retryAfterSec));throw new AppError(429,'RATE_LIMITED','API istek sınırı aşıldı');}
  return withContext(app.db,{companyId,ip:req.ip},async(tx)=>{
   const hash=apiKeyHash(token[1]!,app.config.JWT_SECRET);await tx.execute(sql`select set_config('app.api_key_hash',${hash},true)`);
   const [key]=await tx.select().from(companyApiKeys).where(and(eq(companyApiKeys.id,uuid.parse(token[2])),eq(companyApiKeys.companyId,companyId)));
   if(!key||!sameHash(key.keyHash,hash)||key.revokedAt||key.expiresAt<=new Date())throw unauthorized('API anahtarı geçersiz veya süresi dolmuş');
   await setContext(tx,{companyId,orgId:key.organizationId,userId:key.createdBy,ip:req.ip});
   const [member]=await tx.select({role:memberships.role,active:users.isActive,unassigned:memberships.branchAllowUnassigned,mode:memberships.branchScopeMode}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(and(eq(memberships.companyId,companyId),eq(memberships.userId,key.createdBy)));
   if(!member?.active)throw unauthorized('API anahtarının sahibi artık etkin üye değil');
   const [company]=await tx.select().from(companies).where(eq(companies.id,companyId));if(!company)throw unauthorized();
   if(license&&!app.license.sectorAllowed(license,company.sector))throw forbidden('Lisans sektörü kapsamıyor','LICENSE_SECTOR_MISMATCH');
   const branchAllowed=(await tx.execute<{ok:boolean}>(sql`select app_branch_has_access(${companyId}::uuid,${key.branchId}::uuid) as ok`)).rows[0]?.ok;if(!branchAllowed)throw forbidden('API anahtarının şubesi güncel erişim kapsamının dışında','BRANCH_ACCESS_DENIED');
   if(key.branchId&&(await tx.execute(sql`select id from company_branches where id=${key.branchId}::uuid and is_active`)).rows.length===0)throw forbidden('API anahtarının şubesi pasif','BRANCH_INACTIVE');
   await tx.execute(sql`select set_config('app.branch_id',${key.branchId??''},true),set_config('app.branch_selection',${key.branchId?'branch':'unassigned'},true)`);
   const overrides=await tx.select({module:companyModules.module,enabled:companyModules.enabled}).from(companyModules),enabledModules=resolveEnabledModules(company.sector as Sector,overrides),role=member.role as Role,access=await loadMemberAccess(tx,companyId,key.createdBy,role);
   if(!enabledModules.has('core.integrations')||isModuleDenied(access,'core.integrations'))throw forbidden('Genel entegrasyon modülü kapalı','MODULE_DISABLED');
   requirePermission(access,'core.integrations.manage');
   if(!key.scopes.includes(scope)||!enabledModules.has(scopeModule[scope])||isModuleDenied(access,scopeModule[scope]))throw forbidden('API anahtarının bu işlem için erişimi yok','API_KEY_SCOPE_DENIED');
   requirePermission(access,scopePermission[scope]);
   if(scope!=='invoices.create_draft')requireResourceOperation(access,scopeModule[scope],'export');
   if(scope==='invoices.create_draft'){
    requireResourceOperation(access,'core.invoices','create');await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('erp-maintenance-write')),pg_advisory_xact_lock_shared(hashtextextended(${'company-profile:'+companyId},0))`);
    if((await tx.execute(sql`select id from app_updates where status='applying'`)).rows.length)throw new AppError(503,'UPDATE_MAINTENANCE','Güncelleme sürüyor');
   }
   await tx.update(companyApiKeys).set({lastUsedAt:new Date()}).where(eq(companyApiKeys.id,key.id));
   return withCompanyTimeZone(company.timeZone,()=>handler({tx,user:{id:key.createdBy,orgId:key.organizationId},req,reply,company:{...company,sector:company.sector as Sector},role,access,enabledModules,apiKeyId:key.id,branch:{selection:key.branchId?'branch':'unassigned',activeBranchId:key.branchId,mode:member.mode,branchIds:key.branchId?[key.branchId]:[],allowUnassigned:key.branchId===null},can:p=>access.permissions.has(p),require:p=>requirePermission(access,p)}));
  });
 };
 return Object.assign(route,{[GUARD]:{kind:'tenant',permission:scopePermission[scope],module:scopeModule[scope]} satisfies GuardMeta});
}
