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
    variance: await varianceComponents(tx, order, materialActual, summary.sessions as Row[]),
  };
}

const d2 = (v: ReturnType<typeof dec>) => v.toFixed(2);

/**
 * Üretim maliyet sapmasının bileşenleri (öneri 72). Malzeme: kart başına fiyat sapması (gerçek birim − standart birim) × gerçek
 * miktar ve miktar sapması (gerçek − standart miktar) × standart birim; ikisinin toplamı kart sapmasıdır. Gerçek değer üretim
 * çıkış/iade stok belgelerinden okunur; maliyet izi toplamıyla farkı ayrıca gösterilir. İşçilik: operasyon başına standart dakika
 * (rota dakika/birim × emir miktarı) ile gerçekleşen oturum dakikası; kaynakta saatlik maliyet varsa verimlilik sapması tutarı.
 * Fason ve genel gider için standart tutulmadığından yalnız gerçekleşen gösterilir.
 */
async function varianceComponents(tx: Tx, order: Row, materialActual: ReturnType<typeof dec>, sessions: Row[]) {
  const std = new Map<string, { quantity: ReturnType<typeof dec>; unitCost: ReturnType<typeof dec> }>();
  for (const m of (order.config.standardMaterialCosts ?? []) as Row[]) {
    const cur = std.get(m.itemId);
    std.set(m.itemId, { quantity: (cur?.quantity ?? dec(0)).plus(m.quantity), unitCost: dec(m.unitCost) });
  }
  const actualRows = await all(
    tx,
    sql`select m.item_id, coalesce(sum(case when m.kind = 'qty' then -m.qty else 0 end), 0)::text as qty, coalesce(sum(-m.value), 0)::text as value
          from leather_production_documents d join stock_movements m on m.document_id = d.stock_document_id
         where d.order_id = ${order.id}::uuid and d.kind in ('issue', 'return')
         group by m.item_id`,
  );
  const labels = await all(tx, sql`select id, code, name from items`);
  const itemIds = new Set([...std.keys(), ...actualRows.map((r) => r.item_id as string)]);
  let price = dec(0), usage = dec(0), itemsActual = dec(0), itemsStandard = dec(0);
  const materials = [...itemIds].map((itemId) => {
    const s = std.get(itemId);
    const a = actualRows.find((r) => r.item_id === itemId);
    const aQty = dec(a?.qty ?? 0), aValue = dec(a?.value ?? 0);
    const sQty = s?.quantity ?? dec(0), sUnit = s?.unitCost ?? (aQty.gt(0) ? aValue.div(aQty) : dec(0));
    const priceVar = aValue.minus(aQty.times(sUnit));
    const usageVar = aQty.minus(sQty).times(sUnit);
    price = price.plus(priceVar);
    usage = usage.plus(usageVar);
    itemsActual = itemsActual.plus(aValue);
    itemsStandard = itemsStandard.plus(sQty.times(sUnit));
    const label = labels.find((l) => l.id === itemId);
    return {
      itemId,
      code: label?.code ?? null,
      name: label?.name ?? null,
      standardQty: sQty.toFixed(4),
      standardUnitCost: sUnit.toFixed(4),
      actualQty: aQty.toFixed(4),
      actualValue: d2(aValue),
      priceVariance: d2(priceVar),
      usageVariance: d2(usageVar),
      inStandard: s !== undefined,
    };
  });
  const resources = await listRecords(tx, 'resource');
  const labor = ((order.config.operations ?? []) as Row[]).map((op) => {
    const mine = sessions.filter((x) => x.operationKey === op.key && ['completed', 'paused'].includes(x.status));
    const actualMinutes = mine.reduce((s, x) => s.plus(x.minutes ?? 0), dec(0));
    const resourceId: string | undefined = mine[0]?.resourceId ?? op.resources?.[0]?.resourceId;
    const route = (op.resources ?? []).find((r: Row) => r.resourceId === resourceId) ?? op.resources?.[0];
    const standardMinutes = route ? dec(route.minutesPerUnit).times(order.quantity) : dec(op.plannedMinutes ?? 0);
    const rate = resources.find((r) => r.id === resourceId)?.hourlyCost;
    const efficiency = rate !== undefined ? actualMinutes.minus(standardMinutes).times(rate).div(60) : null;
    return {
      operationKey: op.key,
      name: op.name,
      resourceId: resourceId ?? null,
      standardMinutes: standardMinutes.toFixed(2),
      actualMinutes: actualMinutes.toFixed(2),
      minuteVariance: actualMinutes.minus(standardMinutes).toFixed(2),
      hourlyCost: rate ?? null,
      efficiencyVariance: efficiency === null ? null : d2(efficiency),
    };
  });
  const other = await all(
    tx,
    sql`select kind, sum(current_value)::text as value from leather_cost_roots where order_id=${order.id}::uuid and source_type='production_order' and not coalesce((config->>'cancelled')::boolean,false) group by kind order by kind`,
  );
  return {
    material: {
      standard: d2(itemsStandard),
      actual: d2(itemsActual),
      price: d2(price),
      usage: d2(usage),
      total: d2(price.plus(usage)),
      // Maliyet izi (yansıtılan payların güncel değeri) ile stok belgesi değeri farkı: sonradan düzeltilen alış maliyetleri vb.
      traceDifference: d2(materialActual.minus(itemsActual)),
      items: materials,
    },
    labor: {
      operations: labor,
      minuteVariance: labor.reduce((s, l) => s.plus(l.minuteVariance), dec(0)).toFixed(2),
      efficiencyVariance: labor.some((l) => l.efficiencyVariance !== null)
        ? d2(labor.reduce((s, l) => s.plus(l.efficiencyVariance ?? 0), dec(0)))
        : null,
    },
    other: other.map((o) => ({ kind: o.kind, actual: dec(o.value).toFixed(2), standard: null })),
  };
}
