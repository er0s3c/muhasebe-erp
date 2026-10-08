import { sql } from 'drizzle-orm';
import {
  dec,
  netCapacityMinutes,
  scheduledLoadMinutes,
  type CapacityInterval,
  type ScheduledOperation,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, one, type Row } from '../leather/common';
import { listRecords } from './service';
import { executionSummary } from './execution';
import { loadItemStates } from '../inventory/balances';

export async function capacityReport(tx: Tx, from: string, to: string) {
  const resources = (await listRecords(tx, 'resource')).filter((r) => r.status === 'active');
  const calendars = (await listRecords(tx, 'calendar')).filter(
    (r) => r.status === 'active',
  ) as unknown as CapacityInterval[];
  const plans = (await listRecords(tx, 'schedule')).filter((r) => r.status === 'published');
  const operations = plans.flatMap((p) => p.operations ?? []) as ScheduledOperation[];
  const rows = resources
    .map((r) => {
      const capacityMinutes = netCapacityMinutes(calendars, r.id, from, to) * r.capacity;
      const loadMinutes = scheduledLoadMinutes(operations, r.id, from, to);
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        capacityMinutes,
        loadMinutes,
        loadPct: capacityMinutes ? (loadMinutes / capacityMinutes) * 100 : null,
        overloadMinutes: Math.max(0, loadMinutes - capacityMinutes),
        source: 'published_plans',
        noCalendar: capacityMinutes === 0,
      };
    })
    .sort(
      (a, b) =>
        (b.loadPct ?? (b.loadMinutes ? Infinity : 0)) -
        (a.loadPct ?? (a.loadMinutes ? Infinity : 0)),
    );
  return { from, to, resources: rows };
}
export async function costCloseReport(tx: Tx, id: string) {
  const summary = await executionSummary(tx, id);
  const order = await one(tx, sql`select * from leather_production_orders where id=${id}::uuid`);
  const quality = await one(
    tx,
    sql`select count(*)::int as n from leather_quality_checks where scope='production' and source_id=${id}::uuid and status='pending'`,
  );
  const external = await one(
    tx,
    sql`select count(*)::int as n from leather_subcontract_jobs where order_id=${id}::uuid and status not in ('received','cancelled')`,
  );
  const rework = await one(
    tx,
    sql`select count(*)::int as n from manufacturing_records where kind='rework' and order_id=${id}::uuid and status<>'completed'`,
  );
  const states = await loadItemStates(
    tx,
    order.config.materials.map((m: Row) => m.itemId),
  );
  const planned = order.config.materials.reduce((s: ReturnType<typeof dec>, m: Row) => {
    const state = states.get(m.itemId)!;
    return s.plus(
      dec(m.quantity)
        .times(order.quantity)
        .times(dec(1).plus(dec(m.wastePct ?? 0).div(100)))
        .times(state.qty.gt(0) ? state.value.div(state.qty) : (state.lastCost ?? 0)),
    );
  }, dec(0));
  const trace = await one(
    tx,
    sql`select coalesce(sum(case when e.to_key=${'wip:' + id} and e.from_key like 'stock:%' then e.share*r.current_value when e.from_key=${'wip:' + id} and e.source_key like 'return:%' then -e.share*r.current_value else 0 end),0)::text as material from leather_cost_events e join leather_cost_roots r on r.id=e.root_id and r.company_id=e.company_id where e.to_key=${'wip:' + id} or e.from_key=${'wip:' + id}`,
  );
  const components = await all(
    tx,
    sql`select kind,sum(current_value)::text as value from leather_cost_roots where order_id=${id}::uuid and source_type='production_order' and not coalesce((config->>'cancelled')::boolean,false) group by kind`,
  );
  const materialActual = dec(trace.material),
    actual = components.reduce((s, d) => s.plus(d.value), materialActual);
  const standard =
    order.config.standardMaterialValue !== undefined
      ? dec(order.config.standardMaterialValue)
      : planned;
  const reasons = [];
  if (order.status !== 'completed') reasons.push('Fiziksel üretim tamamlanmadı');
  if (dec(order.wip_value).abs().gt('0.01')) reasons.push('Devam eden üretim maliyeti var');
  if (quality.n) reasons.push('Kalite kararı bekliyor');
  if (external.n) reasons.push('Fason mutabakatı açık');
  if (rework.n) reasons.push('Yeniden işleme açık');
  if (summary.materials.some(m => dec(m.stagedBalance ?? 0).gt(0))) reasons.push('Kullanılmamış atölye teslimi var');
  if (summary.sessions.some((s: Row) => s.status === 'running'))
    reasons.push('Çalışma oturumu açık');
  return {
    orderCode: order.code,
    canClose: !reasons.length,
    reasons,
    wipValue: order.wip_value,
    actualValue: actual.toFixed(2),
    materialActualValue: materialActual.toFixed(2),
    components,
    materialStandardValue: standard.toFixed(2),
    materialVariance: materialActual.minus(standard).toFixed(2),
    standardAt: order.config.standardAt ?? null,
    standardSource:
      order.config.standardMaterialValue !== undefined
        ? 'order_creation_sku_average_material_only'
        : 'current_sku_average_material_only',
    actualSource: 'immutable_cost_shares_at_adjusted_root_values',
    materials: summary.materials,
  };
}
