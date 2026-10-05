import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { idParam,operationKindSchema,operationPayloads,operationSchema,scheduleImpact,todayIso,type OperationInput,type OperationKind,type OperationRow,type Permission } from '@erp/shared';
import { tenantRoute,type TenantCtx } from '../../http/context';
import { badRequest,conflict,forbidden,notFound } from '../../http/errors';
import { requireRecord } from './records';

const select=sql`o.id,o.kind,o.title,o.project_id AS "projectId",o.party_id AS "partyId",o.owner_id AS "ownerId",u.full_name AS "ownerName",o.event_date::text AS "eventDate",o.due_date::text AS "dueDate",o.payload,o.status,o.version,o.created_by AS "createdBy"`;
export const operationAccess:Record<OperationKind,{module:string;read:Permission;write:Permission}>={
  collection:{module:'core.parties',read:'parties.read',write:'parties.manage'},
  site_report:{module:'construction.projects',read:'projects.read',write:'projects.manage'},
  schedule:{module:'construction.projects',read:'projects.read',write:'projects.manage'},
  equipment:{module:'construction.projects',read:'projects.read',write:'projects.manage'},
  equipment_log:{module:'construction.projects',read:'projects.read',write:'projects.manage'},
  defect:{module:'construction.realestate',read:'realestate.read',write:'realestate.manage'},
};
function requireAccess(c:TenantCtx,kind:OperationKind,write=false) {
  const access=operationAccess[kind];
  if(!c.enabledModules.has(access.module)||!c.can(write?access.write:access.read))throw forbidden();
}
async function getEntry(c:TenantCtx,id:string) {
  const rows=await c.tx.execute<OperationRow>(sql`select ${select} from operation_entries o join users u on u.id=o.owner_id where o.id=${id}::uuid`);
  const row=rows.rows[0];if(!row)throw notFound();requireAccess(c,row.kind);return row;
}
async function validate(c:TenantCtx,input:OperationInput,id:string) {
  requireAccess(c,input.kind,true);
  if(input.projectId)await requireRecord(c,'project',input.projectId);
  if(input.partyId)await requireRecord(c,'party',input.partyId);
  if(input.ownerId){
    const result=await c.tx.execute(sql`select 1 from memberships m join users u on u.id=m.user_id where m.company_id=${c.company.id}::uuid and m.user_id=${input.ownerId}::uuid and u.is_active`);
    if(!result.rows.length)throw notFound('Sorumlu');
  }
  const payload=operationPayloads[input.kind].parse(input.payload);
  if(input.kind==='equipment_log'){
    const p=operationPayloads.equipment_log.parse(payload);
    const equipment=await getEntry(c,p.equipmentId);
    if(equipment.kind!=='equipment'||equipment.status!=='open'||equipment.projectId!==input.projectId)throw badRequest('Ekipman bu projede etkin değil.');
    if(p.invoiceId)await requireRecord(c,'invoice',p.invoiceId);
  }
  if(input.kind==='defect'){
    const p=operationPayloads.defect.parse(payload);
    const unit=await c.tx.execute(sql`select id from real_estate_units where id=${p.unitId}::uuid and project_id=${input.projectId}::uuid`);
    if(!unit.rows.length)throw notFound('Proje birimi');
    if(p.contractorId)await requireRecord(c,'party',p.contractorId);
  }
  if(input.kind==='schedule'){
    await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id+':schedule:'+input.projectId},0))`);
    const rows=await c.tx.execute<{id:string;payload:Record<string,unknown>}>(sql`select id,payload from operation_entries where kind='schedule' and project_id=${input.projectId}::uuid and status<>'cancelled' and id<>${id}::uuid`);
    const list=[...rows.rows,{id,payload}].map(r=>({id:r.id,...operationPayloads.schedule.parse(r.payload)}));
    try{scheduleImpact(list,todayIso());}catch(e){throw badRequest((e as Error).message);}
  }
  return payload;
}
export const operationRoutes:FastifyPluginAsync=async app=>{
  const access={module:'core.dashboard',permission:'workspace.use'} as const;
  app.get('/api/workspace/units/:id',tenantRoute(app,{module:'construction.realestate',permission:'realestate.read'},async c=>{
    const {id}=idParam.parse(c.req.params);
    return {items:(await c.tx.execute(sql`select id,block || ' ' || unit_no as name from real_estate_units where project_id=${id}::uuid order by block,unit_no limit 1000`)).rows};
  }));
  app.get('/api/workspace/operations',tenantRoute(app,access,async c=>{
    const q=z.object({kind:operationKindSchema,id:z.uuid().optional(),projectId:z.uuid().optional(),offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(c.req.query);requireAccess(c,q.kind);
    const rows=await c.tx.execute<OperationRow>(sql`select ${select} from operation_entries o join users u on u.id=o.owner_id where o.kind=${q.kind}
      ${q.projectId?sql`and o.project_id=${q.projectId}::uuid`:sql``} ${q.id?sql`and o.id=${q.id}::uuid`:sql``} order by o.due_date desc,o.id limit 101 offset ${q.offset}`);
    return {items:rows.rows.slice(0,100),hasMore:rows.rows.length>100};
  }));
  app.post('/api/workspace/operations',tenantRoute(app,access,async c=>{
    const input=operationSchema.parse(c.req.body);const id=input.id??uuidv7();
    requireAccess(c,input.kind,true);
    await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id},0))`);
    const existing=await c.tx.execute(sql`select id from operation_entries where id=${id}::uuid`);
    if(existing.rows.length){const item=await getEntry(c,id);if(item.createdBy!==c.user.id||item.kind!==input.kind||item.title!==input.title||item.projectId!==(input.projectId??null)||item.partyId!==(input.partyId??null)||item.eventDate!==input.eventDate||item.dueDate!==input.dueDate||item.ownerId!==(input.ownerId??c.user.id)||!isDeepStrictEqual(item.payload,operationPayloads[input.kind].parse(input.payload)))throw conflict('Bu taslak daha önce farklı içerikle kaydedilmiş. Mevcut kaydı düzenleyin.');return {item,replayed:true};}
    const payload=await validate(c,input,id);
    await c.tx.execute(sql`insert into operation_entries(id,company_id,kind,title,project_id,party_id,owner_id,event_date,due_date,payload,created_by)
      values(${id},${c.company.id},${input.kind},${input.title},${input.projectId??null},${input.partyId??null},${input.ownerId??c.user.id},${input.eventDate},${input.dueDate},${JSON.stringify(payload)}::jsonb,${c.user.id})`);
    void c.reply.code(201);return {item:await getEntry(c,id)};
  }));
  app.put('/api/workspace/operations/:id',tenantRoute(app,access,async c=>{
    const {id}=idParam.parse(c.req.params);const cur=await getEntry(c,id);requireAccess(c,cur.kind,true);
    const raw=z.object({version:z.number().int().positive(),status:z.enum(['open','done','cancelled'])}).parse(c.req.body);
    const input=operationSchema.parse(c.req.body);
    if(input.kind!==cur.kind)throw badRequest('Kayıt türü değiştirilemez.');
    if(cur.kind==='schedule'&&input.projectId!==cur.projectId)throw badRequest('İşin projesi değiştirilemez.');
    const payload=await validate(c,input,id);
    if(cur.kind==='defect'&&raw.status==='done'&&!operationPayloads.defect.parse(payload).resolution.trim())throw badRequest('Kapatmak için çözüm açıklaması girin.');
    if(cur.kind==='schedule'&&raw.status==='cancelled'){
      const deps=await c.tx.execute(sql`select id from operation_entries where kind='schedule' and status<>'cancelled' and payload->'dependencies' @> ${JSON.stringify([id])}::jsonb limit 1`);
      if(deps.rows.length)throw conflict('Bu işe bağlı işler var; önce bağımlılıkları kaldırın.');
    }
    const result=await c.tx.execute(sql`update operation_entries set title=${input.title},project_id=${input.projectId??null},party_id=${input.partyId??null},owner_id=${input.ownerId??cur.ownerId},event_date=${input.eventDate},due_date=${input.dueDate},payload=${JSON.stringify(payload)}::jsonb,status=${raw.status},version=version+1,updated_at=now() where id=${id}::uuid and version=${raw.version} returning id`);
    if(!result.rows.length)throw conflict('Kayıt değişti. Yenileyip tekrar deneyin.');return {item:await getEntry(c,id)};
  }));
  app.get('/api/workspace/schedule/:id',tenantRoute(app,{module:'construction.projects',permission:'projects.read'},async c=>{
    const {id}=idParam.parse(c.req.params);await requireRecord(c,'project',id);
    const rows=await c.tx.execute<{id:string;payload:Record<string,unknown>}>(sql`select id,payload from operation_entries where kind='schedule' and project_id=${id}::uuid and status<>'cancelled'`);
    return {items:scheduleImpact(rows.rows.map(r=>({id:r.id,...operationPayloads.schedule.parse(r.payload)})),todayIso()),asOf:todayIso()};
  }));
};
