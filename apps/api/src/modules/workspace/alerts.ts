import { sql } from 'drizzle-orm';
import { todayIso, dec } from '@erp/shared';
import type { TenantCtx } from '../../http/context';
import { allOpenItems } from '../parties/service';
import { pendingForMe } from '../approvals/service';

export interface WorkAlert { key:string; title:string; dueDate:string; path:string; category:string }
export async function workAlerts(c:TenantCtx) {
  const items:WorkAlert[]=[];
  const today=todayIso();
  if(c.enabledModules.has('core.parties')&&c.can('parties.read')) {
    for(const item of await allOpenItems(c.tx,'receivable',today)) {
      if(item.dueDate>today || dec(item.remaining).lte(0)) continue;
      items.push({key:`receivable:${item.lineId}`,title:`${item.partyName} · ${item.remaining} ${item.currencyCode} tahsilat`,dueDate:item.dueDate,path:`/parties/${item.partyId}`,category:'Tahsilat'});
    }
  }
  if(c.enabledModules.has('construction.subcontracts')&&c.can('subcontracts.read')) {
    const requests=await pendingForMe(c.tx,{companyId:c.company.id,userId:c.user.id,role:c.role,permissions:c.access.permissions});
    for(const r of requests) {
      const procurement=r.docType==='purchase_request';
      if(procurement&&(!c.enabledModules.has('construction.procurement')||!c.can('procurement.read'))) continue;
      items.push({key:`approval:${r.id}`,title:'Kararınızı bekleyen onay',dueDate:today,path:'/approvals',category:procurement?'Satın alma onayı':'Hakediş / sözleşme onayı'});
    }
  }
  if(c.enabledModules.has('hr.foreign')&&c.can('hr.read')) {
    const docs=await c.tx.execute<{id:string;due:string;name:string}>(sql`select d.id,d.expiry_date::text as due,e.full_name as name from foreign_worker_docs d join employees e on e.id=d.employee_id
      where d.revoked_at is null and d.expiry_date <= ${today}::date + 30 order by d.expiry_date limit 100`);
    items.push(...docs.rows.map(d=>({key:`foreign:${d.id}`,title:`${d.name} · belge süresi`,dueDate:d.due,path:'/hr/foreign-workers',category:'Personel belgesi (30 gün)'})));
  }
  const states=await c.tx.execute<{key:string;snoozed_until:string|null;read_at:string|null}>(sql`select key,snoozed_until::text,read_at::text from work_alert_states where user_id=${c.user.id}::uuid`);
  const map=new Map(states.rows.map(s=>[s.key,s]));
  const visible=items.filter(i=>!map.get(i.key)?.snoozed_until||map.get(i.key)!.snoozed_until!<=today).sort((a,b)=>a.dueDate.localeCompare(b.dueDate)||a.key.localeCompare(b.key));
  return {items:visible.slice(0,100).map(i=>({...i,read:!!map.get(i.key)?.read_at})),total:visible.length,truncated:visible.length>100};
}
