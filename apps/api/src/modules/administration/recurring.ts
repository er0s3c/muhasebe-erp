import type { FastifyInstance,FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { recurringCreateSchema,recurrenceSchema,occurrenceDate,createInvoiceSchema,createAgendaSchema,idParam,todayIso,addDaysIso,resolveEnabledModules,type RecurringTemplate,type Role,type CreateInvoiceInput } from '@erp/shared';
import { tenantRoute,type TenantCtx } from '../../http/context';
import { badRequest,forbidden,notFound,conflict } from '../../http/errors';
import { withContext,setContext } from '../../db/client';
import { withCompanyTimeZone } from '../../http/company-time';
import type { CompanyInfo } from '../../http/context';
import { loadMemberAccess,requirePermission,isModuleDenied } from '../access/effective';
import { getInvoice,createInvoiceDraft } from '../invoices/service';
import { createAgendaItem,validateAgendaInput } from '../directory/agenda';

type SeriesContext=Pick<TenantCtx,'tx'|'company'|'user'|'can'|'enabledModules'|'require'|'access'>;
const select=sql`id,kind,title,recurrence,payload,status,next_date::text as "nextDate",generated,version,created_by as "createdBy",error`;
function seriesAllowed(c:SeriesContext,kind:string,write=false) {
  return kind==='invoice' ? c.enabledModules.has('core.invoices')&&!isModuleDenied(c.access,'core.invoices')&&c.can(write?'invoices.manage':'invoices.read') : c.enabledModules.has('core.directory')&&!isModuleDenied(c.access,'core.directory')&&c.can(write?'directory.manage':'directory.read');
}
function agendaVisibility(c:SeriesContext) {
  return c.can('directory.manage') ? sql`` : sql` and (kind <> 'agenda' or payload->>'ownerId'=${c.user.id} or payload->'ownerId'='null'::jsonb)`;
}
async function snapshotInvoice(c:TenantCtx,id:string) {
  const source=await getInvoice(c.tx,id),i=source.invoice;
  if(!['sales','purchase','expense'].includes(i.type) || i.status==='cancelled') throw badRequest('Tekrar şablonu için satış, alış veya gider faturası seçin.');
  if(source.lines.some(l=>l.itemKind==='goods' || l.deliveryLineId || l.poLineId || l.salesOrderLineId || l.sourceLineId)) throw badRequest('Tekrarlayan kira ve abonelik faturası stoksuz ve sipariş/irsaliyeden bağımsız olmalıdır.');
  const result=createInvoiceSchema.parse({type:i.type,partyId:i.partyId,invoiceDate:i.invoiceDate,currency:i.currencyCode,vatIncluded:i.vatIncluded,description:i.description??undefined,
    lines:source.lines.map(l=>({itemId:l.itemId,description:l.description,quantity:l.quantity,unit:l.unit,unitPrice:l.unitPrice,discountPct:l.discountPct,vatCode:l.vatCode,accountId:l.accountId,projectId:l.projectId,wbsId:l.wbsId})),post:false});
  return {invoice:result,sourceInvoiceId:id,partyName:i.partyName,currency:i.currencyCode,grossTotal:i.grossTotal};
}
export async function generateRecurring(c:SeriesContext,id:string,asOf=todayIso()) {
  const row=(await c.tx.execute<RecurringTemplate&Record<string,unknown>>(sql`select ${select} from recurring_templates where id=${id}::uuid for update`)).rows[0];
  if(!row)throw notFound('Tekrar şablonu');
  if(!seriesAllowed(c,row.kind,true))throw forbidden('Bu tekrar türü için modül ve düzenleme yetkisi gerekir.');
  if(row.status!=='active')throw conflict('Şablon aktif değil.');
  const rule=recurrenceSchema.parse(row.recurrence),created:{date:string;targetId:string}[]=[];
  let index=row.generated,nextDate=row.nextDate;
  while(nextDate && nextDate<=asOf && created.length<20) {
    if(rule.endDate && nextDate>rule.endDate){nextDate=null;break;}
    const exists=(await c.tx.execute(sql`select target_id from recurring_occurrences where template_id=${id}::uuid and date=${nextDate}::date`)).rows[0];
    if(exists)throw conflict('Tekrar sayacı ile oluşum geçmişi uyuşmuyor.');
    let targetId:string;
    if(row.kind==='agenda') {
      const agenda=createAgendaSchema.parse({...row.payload,dueDate:nextDate});
      const target=await createAgendaItem(c.tx,{companyId:c.company.id,userId:c.user.id,canManage:c.can('directory.manage')},agenda);
      targetId=String(target.item.id);
    } else {
      const template=z.object({invoice:z.unknown(),dueDays:z.number().int().min(0).max(365)}).parse(row.payload);
      const original=template.invoice as CreateInvoiceInput;
      const invoice=createInvoiceSchema.parse({...original,invoiceDate:nextDate,dueDate:addDaysIso(nextDate,template.dueDays),fxRate:undefined,externalNo:undefined,post:false,
        description:[original.description,`${row.title} · ${nextDate}`].filter(Boolean).join(' · ').slice(0,300)});
      targetId=await createInvoiceDraft(c.tx,{companyId:c.company.id,userId:c.user.id,baseCurrency:c.company.baseCurrency,reportingCurrency:c.company.reportingCurrency,allowNegativeStock:c.company.allowNegativeStock},invoice);
    }
    await c.tx.execute(sql`insert into recurring_occurrences(id,company_id,template_id,date,target_id) values(${uuidv7()},${c.company.id},${id},${nextDate},${targetId})`);
    created.push({date:nextDate,targetId});index++;nextDate=occurrenceDate(rule,index);
    if(nextDate>'2100-12-31'||(rule.endDate&&nextDate>rule.endDate))nextDate=null;
  }
  await c.tx.execute(sql`update recurring_templates set generated=${index},next_date=${nextDate},status=${nextDate?'active':'finished'},version=version+1,updated_at=now(),error=null where id=${id}::uuid`);
  return {created,nextDate,hasMore:!!nextDate&&nextDate<=asOf};
}
export async function processRecurringAll(app:FastifyInstance) {
  const targets=(await app.db.execute<{company_id:string;organization_id:string}>(sql`select company_id,organization_id from notification_scan_targets()`)).rows;
  for(const t of targets) {
    try {
      await withContext(app.db,{companyId:t.company_id,orgId:t.organization_id},async tx=>{
        const company=(await tx.execute<CompanyInfo & Record<string, unknown>>(sql`select id,name,sector,base_currency as "baseCurrency",reporting_currency as "reportingCurrency",allow_negative_stock as "allowNegativeStock",jurisdiction,profile_mode as "profileMode",profile_version_id as "profileVersionId",time_zone as "timeZone",fx_provider as "fxProvider",tax_setup_status as "taxSetupStatus" from companies where id=${t.company_id}::uuid`)).rows[0];
        if (!company) return;
        const asOf = todayIso(new Date(), company.timeZone);
        const templates=(await tx.execute<{id:string;created_by:string}>(sql`select id,created_by from recurring_templates where status='active' and next_date<=${asOf}::date order by next_date limit 30 for update skip locked`)).rows;
        for(const template of templates) {
          try {
            await tx.transaction(async nested=>{
              const member=(await nested.execute<{role:Role}>(sql`select m.role from memberships m join users u on u.id=m.user_id where m.company_id=${t.company_id}::uuid and m.user_id=${template.created_by}::uuid and u.is_active`)).rows[0];
              if(!member)throw forbidden('Şablonu oluşturan kullanıcının üyeliği kaldırılmış.');
              await setContext(nested,{companyId:t.company_id,orgId:t.organization_id,userId:template.created_by});
              const modules=(await nested.execute<{module:string;enabled:boolean}>(sql`select module,enabled from company_modules`)).rows;
              const access=await loadMemberAccess(nested,t.company_id,template.created_by,member.role);
              if(!access.permissions.has('settings.manage'))throw forbidden('Şablon sahibinin işletim yetkisi kaldırılmış.');
              await withCompanyTimeZone(company.timeZone, () => generateRecurring({tx:nested,company,user:{id:template.created_by,orgId:t.organization_id},access,enabledModules:resolveEnabledModules(company.sector,modules),can:p=>access.permissions.has(p),require:p=>requirePermission(access,p)},template.id,asOf));
            });
          }catch(error){await tx.execute(sql`update recurring_templates set status='paused',error=${error instanceof Error?error.message.slice(0,1000):'Tekrar işlemi başarısız.'},version=version+1,updated_at=now() where id=${template.id}::uuid`);}
        }
      });
    }catch(error){app.log.warn({companyId:t.company_id,error},'Tekrarlayan işlem');}
  }
}
export const recurringRoutes:FastifyPluginAsync=async app=>{
  const access={module:'core.settings',permission:'settings.manage'} as const;
  app.get('/api/settings/recurring',tenantRoute(app,access,async c=>{
    const kinds=['agenda','invoice'].filter(k=>seriesAllowed(c,k));if(!kinds.length)return {items:[]};
    return {items:(await c.tx.execute(sql`select ${select} from recurring_templates where kind in (${sql.join(kinds.map(k=>sql`${k}`),sql`, `)}) ${agendaVisibility(c)} order by created_at desc limit 200`)).rows};
  }));
  app.post('/api/settings/recurring',tenantRoute(app,access,async c=>{
    const input=recurringCreateSchema.parse(c.req.body);if(!seriesAllowed(c,input.kind,true))throw forbidden('Bu tekrar türünü oluşturma yetkiniz yok.');
    const payload=input.kind==='agenda'?createAgendaSchema.parse({...input.agenda,dueDate:input.recurrence.startDate,ownerId:input.agenda.ownerId===undefined?c.user.id:input.agenda.ownerId}):{...await snapshotInvoice(c,input.sourceInvoiceId),dueDays:input.dueDays};
    if(input.kind==='agenda') await validateAgendaInput(c.tx,{companyId:c.company.id,userId:c.user.id,canManage:c.can('directory.manage')},createAgendaSchema.parse(payload));
    const id=uuidv7();await c.tx.execute(sql`insert into recurring_templates(id,company_id,kind,title,recurrence,payload,next_date,created_by) values(${id},${c.company.id},${input.kind},${input.title},${JSON.stringify(input.recurrence)}::jsonb,${JSON.stringify(payload)}::jsonb,${input.recurrence.startDate},${c.user.id})`);void c.reply.code(201);return {id};
  }));
  app.patch('/api/settings/recurring/:id',tenantRoute(app,access,async c=>{
    const {id}=idParam.parse(c.req.params),input=z.object({status:z.enum(['active','paused']),version:z.number().int().positive()}).parse(c.req.body);
    const row=(await c.tx.execute<RecurringTemplate&Record<string,unknown>>(sql`select ${select} from recurring_templates where id=${id}::uuid`)).rows[0];if(!row)throw notFound();if(!seriesAllowed(c,row.kind,true))throw forbidden();
    if(row.status==='finished')throw conflict('Seri tamamlandı; yeni şablon oluşturun.');
    const result=await c.tx.execute(sql`update recurring_templates set status=${input.status},error=null,version=version+1,updated_at=now() where id=${id}::uuid and version=${input.version} returning id`);if(!result.rows.length)throw conflict('Şablon değişti; yenileyin.');return {ok:true};
  }));
  app.post('/api/settings/recurring/:id/run',tenantRoute(app,{...access,limit:{name:'recurring-run',max:10,windowMs:60000}},async c=>{
    const {id}=idParam.parse(c.req.params);return generateRecurring(c,id);
  }));
  app.get('/api/settings/recurring/:id/history',tenantRoute(app,access,async c=>{
    const {id}=idParam.parse(c.req.params);const template=(await c.tx.execute<{kind:string}>(sql`select kind from recurring_templates where id=${id}::uuid ${agendaVisibility(c)}`)).rows[0];if(!template)throw notFound();if(!seriesAllowed(c,template.kind))throw forbidden();
    return {kind:template.kind,items:(await c.tx.execute(sql`select id,date::text,target_id as "targetId",created_at as "createdAt" from recurring_occurrences where template_id=${id}::uuid order by date desc limit 200`)).rows};
  }));
};
