import { and,eq,inArray,sql } from 'drizzle-orm';
import { branchAssignmentsSchema,createBranchSchema,memberBranchScopeSchema,updateBranchSchema,uuid,type BranchContext } from '@erp/shared';
import type { FastifyPluginAsync,FastifyRequest } from 'fastify';
import type { Tx } from '../../db/client';
import { companyBranches,employees,memberBranchAccess,memberships,warehouses } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { badRequest,forbidden,notFound,unprocessable } from '../../http/errors';

export async function loadBranchContext(tx:Tx,companyId:string,userId:string,req:FastifyRequest):Promise<BranchContext> {
  const [member]=await tx.select({mode:memberships.branchScopeMode,allowUnassigned:memberships.branchAllowUnassigned}).from(memberships).where(and(eq(memberships.companyId,companyId),eq(memberships.userId,userId)));
  if(!member) throw forbidden('Bu şirkete erişiminiz yok','NOT_A_MEMBER');
  const ids=(await tx.select({id:memberBranchAccess.branchId}).from(memberBranchAccess).where(and(eq(memberBranchAccess.companyId,companyId),eq(memberBranchAccess.userId,userId)))).map((r)=>r.id);
  const raw=req.headers['x-branch-id'];
  if(raw!==undefined&&typeof raw!=='string') throw badRequest('X-Branch-Id geçersiz','BRANCH_REQUIRED');
  let selection:BranchContext['selection']='all',activeBranchId:string|null=null;
  if(raw&&raw!=='all') {
    if(raw==='unassigned') {
      if(member.mode==='restricted'&&!member.allowUnassigned) throw forbidden('Şubeye atanmamış kayıtlara erişiminiz yok','BRANCH_ACCESS_DENIED');
      selection='unassigned';
    } else {
      const parsed=uuid.safeParse(raw);if(!parsed.success) throw badRequest('X-Branch-Id geçersiz','BRANCH_REQUIRED');
      if(member.mode==='restricted'&&!ids.includes(parsed.data)) throw forbidden('Bu şubeye erişiminiz yok','BRANCH_ACCESS_DENIED');
      const [branch]=await tx.select().from(companyBranches).where(and(eq(companyBranches.companyId,companyId),eq(companyBranches.id,parsed.data)));
      if(!branch) throw forbidden('Bu şubeye erişiminiz yok','BRANCH_ACCESS_DENIED');
      if(!branch.isActive&&!['GET','HEAD','OPTIONS'].includes(req.method)) throw unprocessable('Pasif şubede yeni işlem yapılamaz','BRANCH_INACTIVE');
      activeBranchId=branch.id;selection='branch';
    }
  }
  await tx.execute(sql`select set_config('app.branch_id',${activeBranchId??''},true),set_config('app.branch_selection',${selection},true)`);
  return {selection,activeBranchId,mode:member.mode,branchIds:ids,allowUnassigned:member.mode==='all'||member.allowUnassigned};
}

export const branchRoutes:FastifyPluginAsync=async(app)=>{
  app.get('/api/company/branches',tenantRoute(app,{},async(c)=>({branches:await c.tx.select().from(companyBranches).orderBy(companyBranches.name),scope:c.branch})));
  app.post('/api/company/branches',tenantRoute(app,{permission:'company.manage'},async(c)=>{
    if(c.branch.mode!=='all') throw forbidden('Şube oluşturmak için tüm şubelere erişim gerekir','BRANCH_ADMIN_SCOPE_REQUIRED');
    const [branch]=await c.tx.insert(companyBranches).values({companyId:c.company.id,createdBy:c.user.id,...createBranchSchema.parse(c.req.body)}).returning();
    void c.reply.code(201);return {branch};
  }));
  app.patch('/api/company/branches/:id',tenantRoute(app,{permission:'company.manage'},async(c)=>{
    if(c.branch.mode!=='all') throw forbidden('Şube düzenlemek için tüm şubelere erişim gerekir','BRANCH_ADMIN_SCOPE_REQUIRED');
    const id=uuid.parse((c.req.params as {id:string}).id),input=updateBranchSchema.parse(c.req.body);
    if(Object.keys(input).length===0) throw badRequest('Değiştirilecek alan seçin');
    const [branch]=await c.tx.update(companyBranches).set(input).where(eq(companyBranches.id,id)).returning();
    if(!branch)throw notFound('Şube');return {branch};
  }));
  app.get('/api/company/members/:userId/branches',tenantRoute(app,{permission:'members.manage'},async(c)=>{
    const id=uuid.parse((c.req.params as {userId:string}).userId);
    const [m]=await c.tx.select().from(memberships).where(and(eq(memberships.companyId,c.company.id),eq(memberships.userId,id)));
    if(!m)throw notFound('Üye');
    return {scope:{mode:m.branchScopeMode,allowUnassigned:m.branchAllowUnassigned,branchIds:(await c.tx.select().from(memberBranchAccess).where(and(eq(memberBranchAccess.companyId,c.company.id),eq(memberBranchAccess.userId,id)))).map((a)=>a.branchId)}};
  }));
  app.put('/api/company/members/:userId/branches',tenantRoute(app,{permission:'members.manage'},async(c)=>{
    const id=uuid.parse((c.req.params as {userId:string}).userId),input=memberBranchScopeSchema.parse(c.req.body);
    await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'branch-access:'+c.company.id},0))`);
    const [m]=await c.tx.select().from(memberships).where(and(eq(memberships.companyId,c.company.id),eq(memberships.userId,id)));
    if(!m)throw notFound('Üye');
    if(m.role==='owner'&&(input.mode!=='all'||!input.allowUnassigned)) throw forbidden('Şirket sahibinin şube erişimi kısıtlanamaz','OWNER_BRANCH_ACCESS');
    if(c.branch.mode==='restricted'&&(input.mode==='all'||input.branchIds.some((branchId)=>!c.branch.branchIds.includes(branchId))||(input.allowUnassigned&&!c.branch.allowUnassigned))) throw forbidden('Kendi şube erişiminizden fazlasını veremezsiniz','BRANCH_ACCESS_EXCEEDS_OWN');
    const found=input.branchIds.length?await c.tx.select({id:companyBranches.id}).from(companyBranches).where(inArray(companyBranches.id,input.branchIds)):[];
    if(found.length!==input.branchIds.length) throw unprocessable('Şube bu şirkete ait değil veya erişiminiz yok','BRANCH_NOT_FOUND');
    await c.tx.delete(memberBranchAccess).where(and(eq(memberBranchAccess.companyId,c.company.id),eq(memberBranchAccess.userId,id)));
    if(input.mode==='restricted'&&input.branchIds.length) await c.tx.insert(memberBranchAccess).values(input.branchIds.map((branchId)=>({companyId:c.company.id,userId:id,branchId})));
    const scope={mode:input.mode,allowUnassigned:input.mode==='all'||input.allowUnassigned,branchIds:input.mode==='all'?[]:input.branchIds};
    await c.tx.update(memberships).set({branchScopeMode:scope.mode,branchAllowUnassigned:scope.allowUnassigned}).where(eq(memberships.id,m.id));
    return {scope};
  }));
  app.get('/api/company/branches/resources',tenantRoute(app,{permission:'company.manage'},async(c)=>({
    warehouses:c.can('inventory.read')?await c.tx.select({id:warehouses.id,name:warehouses.name,branchId:warehouses.branchId}).from(warehouses):[],
    employees:c.can('hr.read')?await c.tx.select({id:employees.id,name:employees.fullName,branchId:employees.branchId}).from(employees):[],
  })));
  app.post('/api/company/branch-assignments',tenantRoute(app,{permission:'company.manage'},async(c)=>{
    const input=branchAssignmentsSchema.parse(c.req.body);
    if(input.branchId){const [b]=await c.tx.select().from(companyBranches).where(eq(companyBranches.id,input.branchId));if(!b?.isActive)throw unprocessable('Etkin şube seçin','BRANCH_INACTIVE');}
    if(input.warehouseIds.length){c.require('inventory.manage');const rows=await c.tx.update(warehouses).set({branchId:input.branchId}).where(inArray(warehouses.id,input.warehouseIds)).returning({id:warehouses.id});if(rows.length!==new Set(input.warehouseIds).size)throw notFound('Depo');}
    if(input.employeeIds.length){c.require('hr.manage');const rows=await c.tx.update(employees).set({branchId:input.branchId}).where(inArray(employees.id,input.employeeIds)).returning({id:employees.id});if(rows.length!==new Set(input.employeeIds).size)throw notFound('Personel');}
    return {ok:true};
  }));
};
