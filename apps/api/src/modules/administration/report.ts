import { sql } from 'drizzle-orm';
import { administrationQuerySchema,insightKeys, type Permission, type WorkflowKind, type OperationKind } from '@erp/shared';
import type { TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { RECORDS, canAccessRecord } from '../workspace/records';
import { operationAccess } from '../workspace/operations';
import { workflowAccess } from '../construction-control/workflows';
import { isModuleDenied } from '../access/effective';
import { EXPORTS } from '../exports/registry';

// Explicit allowlist: authentication secrets and ungranted modules never enter the report.
const groups: [string, Permission, string[]][] = [
  ['core.dashboard','workspace.use',['work_items','work_time_sessions','record_documents','saved_insights']],
  ['core.settings','settings.read',['company_operations_settings','administration_runs','exchange_rates']],
  ['core.ledger','ledger.read',['journal_entries','journal_lines','accounts','fixed_assets','asset_depreciation','company_budgets']],
  ['core.invoices','invoices.read',['invoices','invoice_lines','sales_campaigns','campaign_applications']],
  ['core.inventory','inventory.read',['items','warehouses','stock_documents','stock_movements']],
  ['core.parties','parties.read',['parties','party_contacts']],
  ['core.treasury','treasury.read',['treasury_transactions','treasury_accounts','bank_statements']],
  ['treasury.cheques','treasury.read',['cheques','cheque_events','cheque_batches','cheque_allocations']],
  ['treasury.expenses','treasury.read',['expense_cards','expense_entries']],
  ['hr.employee_ledger','hr.payroll',['employee_advances','employee_advance_settlements','employee_advance_events']],
  ['core.directory','directory.read',['agenda_items']],
  ['construction.projects','projects.read',['projects','project_wbs','project_budgets','construction_drawings','construction_pins','construction_photos','construction_locations','construction_assets','construction_jobs','construction_snapshots','construction_model_links']],
  ['construction.subcontracts','subcontracts.read',['subcontracts','progress_payments','progress_payment_lines','variation_orders','approval_requests','approval_steps']],
  ['construction.procurement','procurement.read',['purchase_requests','purchase_request_lines','purchase_orders','purchase_order_lines']],
  ['construction.realestate','realestate.read',['real_estate_units','sales_contracts','sales_installments']],
  ['hr.core','hr.sensitive',['employees','attendance_entries','attendance_months']],
  ['hr.foreign','hr.sensitive',['foreign_worker_docs','foreign_doc_renewals']],
];
const safeFields = ['title','name','code','full_name','description','status','priority','due_date','owner_id','version','doc_no','invoice_no','txn_no','entry_no','event_date','work_date','normal_hours','overtime_hours','amount','currency_code','quantity','total','net_total','gross_total','expiry_date','filename','size','updated_at','created_at','started_at','stopped_at','note','debit','credit','debit_base','credit_base','exchange_rate','rate','unit_price','vat_total','vat_rate','discount_rate','project_id','wbs_id','record_kind','record_id','linked_kind','linked_id'];
const detailColumns:Record<string,string[]>={operation_entries:['payload'],construction_workflows:['payload'],company_operations_settings:['settings'],cheques:['amount_base','fx_rate'],cheque_batches:['total_base'],agenda_items:['start_time','end_time','all_day','remind_before_minutes'],recurring_templates:['recurrence','next_date','generated','error'],saved_insights:['config','archived'],sales_campaigns:['config'],campaign_applications:['snapshot'],expense_entries:['payment_kind','employee_id','advance_id','advance_applied_amount','net','vat','withholding','payable','cancel_reason'],employee_advances:['advance_date','settled_amount','purpose'],employee_advance_settlements:['kind','settled_date','expense_entry_id','reversed_at','reverse_reason']};
const sensitiveKey=/(password|secret|token|base64|content|cipher|(?:^|_)enc$)/i;
Object.assign(detailColumns,{fixed_assets:['config','active'],asset_depreciation:['snapshot','month','asset_id','journal_entry_id','reversal_entry_id','cancelled_at','cancel_reason']});
Object.assign(detailColumns,{company_budgets:['config','revision','series_id','approved_by','approved_at']});
function safeDetail(value:unknown,depth=0):unknown {
  if(depth>5)return '[ayrıntı sınırı]';
  if(typeof value==='string')return value.length>3000?value.slice(0,3000)+'…':value;
  if(Array.isArray(value))return value.slice(0,100).map(v=>safeDetail(v,depth+1));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!sensitiveKey.test(key)).slice(0,100).map(([key,v])=>[key,safeDetail(v,depth+1)]));
  return value;
}
export const sanitizeAudit = (raw: unknown,table='') => Object.fromEntries([...safeFields,...(detailColumns[table]??[])].filter(k => raw && Object.hasOwn(raw,k)).map(k=>[k,safeDetail((raw as Record<string,unknown>)[k])]));
export function requireAdministrator(c: TenantCtx) {
  c.require('members.manage');
}
export function activityTables(c: TenantCtx) {
  return [...groups.filter(([module,p]) => c.enabledModules.has(module) && !isModuleDenied(c.access,module) && c.can(p)).flatMap(([, , tables]) => tables),
    ...(Object.values(operationAccess).some(a=>c.enabledModules.has(a.module)&&!isModuleDenied(c.access,a.module)&&c.can(a.read))?['operation_entries']:[]),
    ...(Object.values(workflowAccess).some(a=>c.enabledModules.has(a.module)&&!isModuleDenied(c.access,a.module)&&c.can(a.read))?['construction_workflows']:[])];
}
export async function activityReport(c: TenantCtx) {
  requireAdministrator(c);
  const q = administrationQuerySchema.parse(c.req.query);
  const allowed = activityTables(c);
  if (q.table && !allowed.includes(q.table)) throw forbidden('Bu kayıt türünü görüntüleme yetkiniz yok.');
  const linkedKinds = Object.keys(RECORDS).filter(k => canAccessRecord(c, k as keyof typeof RECORDS));
  const kindVisibility = (field: string) => linkedKinds.length ? sql`(${sql.raw(field)} is null or ${sql.raw(field)} in (${sql.join(linkedKinds.map(k=>sql`${k}`),sql`, `)}))` : sql`${sql.raw(field)} is null`;
  const visibleTaskIds = sql`select id from work_items where ${kindVisibility('record_kind')}`;
  const kindsWhere=(table:string,kinds:string[])=>sql`(a.table_name<>${table} or ${kinds.length?sql`coalesce(a.new_data,a.old_data)->>'kind' in (${sql.join(kinds.map(k=>sql`${k}`),sql`, `)})`:sql`false`})`;
  const operationKinds=Object.keys(operationAccess).filter(k=>{const a=operationAccess[k as OperationKind];return c.enabledModules.has(a.module)&&!isModuleDenied(c.access,a.module)&&c.can(a.read);});
  const workflowKinds=Object.keys(workflowAccess).filter(k=>{const a=workflowAccess[k as WorkflowKind];return c.enabledModules.has(a.module)&&!isModuleDenied(c.access,a.module)&&c.can(a.read);});
  const auditVisibility = sql`(a.table_name not in ('work_items','record_documents') or ${kindVisibility("coalesce(a.new_data,a.old_data)->>'record_kind'")}) and ${kindsWhere('operation_entries',operationKinds)} and ${kindsWhere('construction_workflows',workflowKinds)}`;
  const agendaVisibility=c.can('directory.manage')?sql``:sql`and (a.table_name<>'agenda_items' or coalesce(a.new_data,a.old_data)->>'owner_id' is null or coalesce(a.new_data,a.old_data)->>'owner_id'=${c.user.id})`;
  const insightAllowed=EXPORTS.filter(d=>insightKeys.includes(d.key as typeof insightKeys[number])&&c.enabledModules.has(d.module)&&!isModuleDenied(c.access,d.module)&&c.can(d.permission)).map(d=>d.key);
  const insightVisibility=sql`and (a.table_name<>'saved_insights' or ((coalesce(a.new_data,a.old_data)->>'created_by'=${c.user.id} or coalesce(a.new_data,a.old_data)->'config'->>'shared'='true') and ${insightAllowed.length?sql`coalesce(a.new_data,a.old_data)->'config'->>'reportKey' in (${sql.join(insightAllowed.map(k=>sql`${k}`),sql`, `)})`:sql`false`}))`;
  const budgetVisibility=c.enabledModules.has('construction.projects')&&!isModuleDenied(c.access,'construction.projects')&&c.can('projects.read')?sql``:sql`and (a.table_name<>'company_budgets' or jsonb_array_length(coalesce(a.new_data->'config'->'projectIds','[]'::jsonb))=0 and jsonb_array_length(coalesce(a.old_data->'config'->'projectIds','[]'::jsonb))=0)`;
  const where = sql`a.company_id=${c.company.id}::uuid and a.at >= ${q.from}::date::timestamp at time zone 'Europe/Nicosia' and a.at < (${q.to}::date + 1)::timestamp at time zone 'Europe/Nicosia'
    and a.table_name in (${sql.join((q.table ? [q.table] : allowed).map(t=>sql`${t}`),sql`, `)}) ${auditVisibility ? sql`and ${auditVisibility}` : sql``}
    ${q.userId ? sql`and a.user_id=${q.userId}::uuid` : sql``} ${agendaVisibility} ${insightVisibility} ${budgetVisibility}`;
  const rangeStart=sql`${q.from}::date::timestamp at time zone 'Europe/Nicosia'`,rangeEnd=sql`(${q.to}::date+1)::timestamp at time zone 'Europe/Nicosia'`;
  const sessionEnd=sql`coalesce(s.stopped_at,least(now(),s.started_at+interval '24 hours'))`;
  const timeWhere = sql`s.started_at < ${rangeEnd} and ${sessionEnd}>${rangeStart} and s.task_id in (${visibleTaskIds}) ${q.userId ? sql`and s.user_id=${q.userId}::uuid` : sql``}`;
  const seconds = sql`greatest(0,extract(epoch from (least(${sessionEnd},${rangeEnd})-greatest(s.started_at,${rangeStart}))))::int`;
  const rows = (await c.tx.execute<Record<string,unknown>>(sql`select a.id::text,a.at,a.user_id as "userId",u.full_name as "userName",a.table_name as "table",a.row_id as "rowId",a.action,a.old_data,a.new_data from audit_log a left join users u on u.id=a.user_id where ${where} order by a.at desc,a.id desc limit 101 offset ${q.offset}`)).rows;
  const events = rows.slice(0,100).map(r => {
    const before=sanitizeAudit(r.old_data,String(r.table)), after=sanitizeAudit(r.new_data,String(r.table));
    return { id:r.id,at:r.at,userId:r.userId,userName:r.userName,table:r.table,rowId:r.rowId,action:r.action,
      title: after.title ?? after.name ?? after.doc_no ?? after.entry_no ?? after.code ?? before.title ?? before.name ?? before.entry_no ?? null,
      changedFields:[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k])),before,after };
  });
  const daily=(await c.tx.execute(sql`with e as (select (a.at at time zone 'Europe/Nicosia')::date as day,count(*)::int as events from audit_log a where ${where} group by 1), t as (select d::date as day,sum(greatest(0,extract(epoch from (least(${sessionEnd},(d::date+1)::timestamp at time zone 'Europe/Nicosia')-greatest(s.started_at,d::date::timestamp at time zone 'Europe/Nicosia')))))::int as seconds from generate_series(${q.from}::date,${q.to}::date,interval '1 day') d join work_time_sessions s on s.started_at < (d::date+1)::timestamp at time zone 'Europe/Nicosia' and ${sessionEnd}>d::date::timestamp at time zone 'Europe/Nicosia' where ${timeWhere} group by 1)
    select d::date::text as date,coalesce(e.events,0) as events,coalesce(t.seconds,0) as seconds from generate_series(${q.from}::date,${q.to}::date,interval '1 day') d left join e on e.day=d::date left join t on t.day=d::date order by d`)).rows;
  const users=(await c.tx.execute(sql`with e as (select a.user_id,count(*)::int as events,count(*) filter(where a.table_name='work_items' and a.new_data->>'status'='done' and a.old_data->>'status' is distinct from 'done')::int as done from audit_log a where ${where} group by 1),t as (select s.user_id,sum(${seconds})::int as seconds from work_time_sessions s where ${timeWhere} group by 1)
    select u.id,u.full_name as name,coalesce(e.events,0) as events,coalesce(t.seconds,0) as seconds,coalesce(e.done,0) as "completedTasks" from memberships m join users u on u.id=m.user_id left join e on e.user_id=u.id left join t on t.user_id=u.id where m.company_id=${c.company.id}::uuid ${q.userId ? sql`and u.id=${q.userId}::uuid`:sql``} order by coalesce(e.events,0) desc,u.full_name`)).rows;
  const tables=(await c.tx.execute(sql`select a.table_name as "table",count(*)::int as events from audit_log a where ${where} group by 1 order by events desc`)).rows;
  const summary=(await c.tx.execute(sql`select count(*)::int as events,count(distinct a.user_id)::int as people,count(*) filter(where a.table_name='work_items' and a.new_data->>'status'='done' and a.old_data->>'status' is distinct from 'done')::int as "completedTasks" from audit_log a where ${where}`)).rows[0];
  const totalTime=(await c.tx.execute(sql`select coalesce(sum(${seconds}),0)::int as seconds from work_time_sessions s where ${timeWhere}`)).rows[0];
  const sessions=(await c.tx.execute(sql`select s.id,s.task_id as "taskId",w.title,s.user_id as "userId",u.full_name as "userName",s.started_at as "startedAt",s.stopped_at as "stoppedAt",${seconds} as seconds,s.note from work_time_sessions s join work_items w on w.id=s.task_id join users u on u.id=s.user_id where ${timeWhere} order by s.started_at desc limit 100`)).rows;
  const attendance=c.enabledModules.has('hr.core') && !isModuleDenied(c.access,'hr.core') && c.can('hr.sensitive') ? (await c.tx.execute(sql`select e.id as "employeeId",e.full_name as name,p.id as "projectId",p.name as "projectName",sum(a.normal_hours)::text as "normalHours",sum(a.overtime_hours)::text as "overtimeHours",count(*)::int as days from attendance_entries a join employees e on e.id=a.employee_id left join projects p on p.id=a.project_id where a.work_date between ${q.from}::date and ${q.to}::date ${q.userId ? sql`and a.created_by=${q.userId}::uuid`:sql``} group by e.id,e.full_name,p.id,p.name order by e.full_name limit 1000`)).rows : [];
  return { summary:{...summary,...totalTime},daily,users,tables,events,hasMore:rows.length>100,sessions,attendance };
}
