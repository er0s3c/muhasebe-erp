import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { operationsSettingsSchema, resolveEnabledModules, nowLocal, type Role, type Sector } from '@erp/shared';
import { withContext, setContext } from '../../db/client';
import { loadMemberAccess, requirePermission } from '../access/effective';
import { runRateImport } from './routes';
import { processBackupJobs, queueAutomaticBackup } from './backups';
import { processRecurringAll } from './recurring';

export async function processAdministration(app:FastifyInstance,now=new Date()) {
  const targets=(await app.db.execute<{company_id:string;organization_id:string}>(sql`select company_id,organization_id from notification_scan_targets()`)).rows;
  const local=nowLocal(now);
  const hour=Number(local.time.slice(0,2));
  for(const target of targets) {
    try {
      await withContext(app.db,{companyId:target.company_id,orgId:target.organization_id},async tx=>{
        const got=(await tx.execute<{ok:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${target.company_id+':admin-scheduler'},0)) as ok`)).rows[0];
        if(!got?.ok) return;
        const row=(await tx.execute<{settings:unknown;updated_by:string}>(sql`select settings,updated_by from company_operations_settings`)).rows[0];
        if(!row) return;
        const settings=operationsSettingsSchema.parse(row.settings);
        const member=(await tx.execute<{id:string;role:Role}>(sql`select u.id,m.role from users u join memberships m on m.user_id=u.id where m.company_id=${target.company_id}::uuid and u.id=${row.updated_by}::uuid and u.is_active and m.role in ('owner','admin')`)).rows[0];
        if(!member) return;
        await setContext(tx,{companyId:target.company_id,orgId:target.organization_id,userId:member.id});
        const access=await loadMemberAccess(tx,target.company_id,member.id,member.role);
        const company=(await tx.execute<{id:string;name:string;sector:Sector;baseCurrency:string;reportingCurrency:string|null;allowNegativeStock:boolean}>(sql`select id,name,sector,base_currency as "baseCurrency",reporting_currency as "reportingCurrency",allow_negative_stock as "allowNegativeStock" from companies where id=${target.company_id}::uuid`)).rows[0];
        if(!company) return;
        const overrides=(await tx.execute<{module:string;enabled:boolean}>(sql`select module,enabled from company_modules`)).rows;
        const enabled=resolveEnabledModules(company.sector,overrides);
        if(!enabled.has('core.settings') || !access.permissions.has('settings.manage')) return;
        const c={tx,company,user:{id:member.id,orgId:target.organization_id},require:(p:Parameters<typeof requirePermission>[1])=>requirePermission(access,p)};
        if(settings.automaticRates && access.permissions.has('rates.manage') && hour>=settings.rateHour) {
          const recent=(await tx.execute(sql`select id from administration_runs where kind='rates' and ((status='succeeded' and (started_at at time zone 'Europe/Nicosia')::date=${local.date}::date) or started_at>${now.toISOString()}::timestamptz-interval '30 minutes') limit 1`)).rows;
          if(!recent.length) await runRateImport(app,c);
        }
        if(settings.automaticBackup && hour>=settings.backupHour) await queueAutomaticBackup(app,c,local.date);
        // Abandoned timers are closed with an explicit note, never inferred from browser activity.
        await tx.execute(sql`update work_time_sessions set stopped_at=started_at+interval '24 hours',note=note || ' · 24 saat sınırında otomatik kapatıldı' where stopped_at is null and started_at<now()-interval '24 hours'`);
      });
    } catch(error) { app.log.warn({companyId:target.company_id,error:error instanceof Error?error.message:'İşlem hatası'},'İşletim zamanlayıcısı'); }
  }
  await processBackupJobs(app);
  await processRecurringAll(app);
}
export function startAdministrationScheduler(app:FastifyInstance) {
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await processAdministration(app);}catch(error){app.log.warn({error},'İşletim zamanlayıcısı');}finally{running=false;}};
  const timer=setInterval(()=>void tick(),60000);timer.unref();
  const first=setTimeout(()=>void tick(),15000);first.unref();
  return()=>{clearInterval(timer);clearTimeout(first);};
}
