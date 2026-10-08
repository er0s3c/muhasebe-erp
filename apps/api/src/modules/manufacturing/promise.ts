import { sql } from 'drizzle-orm';
import { dec, finiteManufacturingSchedule, type ScheduledOperation } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, one, fail, type Row } from '../leather/common';
import { orderLineUsage } from '../sales/usage';
import { stockAvailability } from './availability';
import { listRecords, mrp } from './service';

const plusDays = (date: string, days: number) =>
  new Date(Date.parse(date) + days * 86400000).toISOString();
export async function procurementSupply(tx: Tx, itemId: string) {
  const profiles = (await listRecords(tx, 'supplier_profile')).filter(
    (p) => p.itemId === itemId && p.status === 'active',
  );
  const lines = await all(
    tx,
    sql`select l.id,o.id as order_id,o.code,o.party_id,o.issued_at,l.quantity,l.unit_price,
    coalesce((select sum(r.quantity) from po_receipt_lines r join po_receipts h on h.id=r.receipt_id and h.company_id=r.company_id where r.order_line_id=l.id and h.status='posted'),0)::text as received
    from purchase_order_lines l join purchase_orders o on o.id=l.order_id and o.company_id=l.company_id where l.item_id=${itemId}::uuid and o.status='issued'`,
  );
  const open = lines
    .filter((l) => dec(l.quantity).gt(l.received))
    .map((l) => {
      const p = profiles.find((p) => p.partyId === l.party_id);
      return {
        orderId: l.order_id,
        code: l.code,
        quantity: dec(l.quantity).minus(l.received).toFixed(4),
        expectedDate:
          p && l.issued_at
            ? plusDays(new Date(l.issued_at).toISOString(), p.leadDays).slice(0, 10)
            : null,
        source: 'supplier_lead_time',
      };
    });
  const history = await all(
    tx,
    sql`select o.party_id,count(*)::int as samples,avg(extract(epoch from (r.receipt_date::timestamp-o.issued_at))/86400)::numeric as days,
    avg(l.unit_price)::text as average_price from purchase_orders o join purchase_order_lines l on l.order_id=o.id and l.company_id=o.company_id join po_receipt_lines rl on rl.order_line_id=l.id join po_receipts r on r.id=rl.receipt_id and r.status='posted' where l.item_id=${itemId}::uuid and o.issued_at is not null group by o.party_id`,
  );
  return {
    open,
    profiles: profiles.map((p) => ({
      ...p,
      performance: history.find((h) => h.party_id === p.partyId) ?? null,
    })),
  };
}
export async function purchaseProposals(
  tx: Tx,
  needs: Row[],
  anchor: string,
  usedIncoming: Readonly<Record<string, string>> = {},
  horizon?: string,
) {
  const result = [];
  for (const n of needs.filter((n) => n.action === 'purchase' && dec(n.net).gt(0))) {
    const supply = await procurementSupply(tx, n.itemId);
    const incoming = supply.open
      .filter((o) => o.expectedDate !== null && (!horizon || o.expectedDate <= horizon))
      .reduce<ReturnType<typeof dec>>((s, o) => s.plus(o.quantity), dec(0));
    const freeIncoming = incoming.minus(usedIncoming[n.itemId] ?? 0);
    const usableIncoming = freeIncoming.gt(0) ? freeIncoming : dec(0);
    const buy = dec(n.net).minus(usableIncoming);
    const proposals = supply.profiles
      .map((p) => {
        const minimum = dec(p.minOrderQty),
          pack = dec(p.packQty);
        const quantity = (buy.gt(minimum) ? buy : minimum).div(pack).ceil().times(pack);
        return {
          partyId: p.partyId,
          supplierName: p.supplierName,
          supplierCode: p.supplierCode,
          quantity: (buy.gt(0) ? quantity : dec(0)).toFixed(4),
          unitPrice: p.unitPrice,
          currency: p.currency,
          leadDays: p.leadDays,
          expectedDate: plusDays(anchor, p.leadDays).slice(0, 10),
          preferred: p.preferred,
          performance: p.performance,
        };
      })
      .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.leadDays - b.leadDays);
    result.push({
      ...n,
      itemId: n.itemId as string,
      name: n.name as string,
      unit: n.unit as string,
      incoming: usableIncoming.toFixed(4),
      purchaseQty: (buy.gt(0) ? buy : dec(0)).toFixed(4),
      openOrders: supply.open,
      suppliers: proposals,
    });
  }
  return result;
}
export async function promiseSales(
  tx: Tx,
  input: { salesOrderId: string; warehouseId: string; anchor: string },
) {
  const source = await one(
    tx,
    sql`select id,doc_no,status,kind from sales_orders where id=${input.salesOrderId}::uuid`,
    'Sipariş',
  );
  if (source.kind !== 'order' || source.status !== 'confirmed')
    throw fail('Onaylı satış siparişi gerekli');
  await one(
    tx,
    sql`select id from warehouses where id=${input.warehouseId}::uuid and is_active`,
    'Depo',
  );
  const lines = await all(
    tx,
    sql`select l.*,i.name,i.code from sales_order_lines l join items i on i.id=l.item_id and i.company_id=l.company_id where l.order_id=${source.id} and i.kind='goods' order by l.line_no`,
  );
  const usage = await orderLineUsage(
    tx,
    lines.map((l) => l.id),
  );
  const resources = (await listRecords(tx, 'resource')).filter((r) => r.status === 'active');
  const calendars = (await listRecords(tx, 'calendar')).filter((r) => r.status === 'active');
  const occupied = (await listRecords(tx, 'schedule'))
    .filter((r) => r.status === 'published')
    .flatMap((r) => r.operations ?? []) as ScheduledOperation[];
  const capacities = Object.fromEntries(resources.map((r) => [r.id, Number(r.capacity)]));
  const variants = await all(
    tx,
    sql`select v.item_id,r.config from leather_variants v join leather_revisions r on r.id=v.revision_id and r.company_id=v.company_id where r.status='approved'`,
  );
  const openProduction = await all(
    tx,
    sql`select id,code,quantity,completed_qty,config,status from leather_production_orders where output_warehouse_id=${input.warehouseId}::uuid and status not in ('completed','cancelled')`,
  );
  const consumed = new Map<string, ReturnType<typeof dec>>(),
    output = [];
  const incomingUsed: Record<string, string> = {};
  const stockIds = new Set<string>(
    variants.flatMap((v) => [v.item_id, ...v.config.materials.map((m: Row) => m.itemId)]),
  );
  for (const line of lines) {
    const u = usage.get(line.id)!;
    const demand = dec(line.quantity).minus(u.delivered).minus(u.direct);
    const stock = await stockAvailability(tx, line.item_id, input.warehouseId, undefined, [
      line.id,
    ]);
    const free = dec(stock.available).minus(consumed.get(line.item_id) ?? 0);
    const atp = demand.gt(0) && free.gt(0) ? (free.lt(demand) ? free : demand) : dec(0);
    consumed.set(line.item_id, (consumed.get(line.item_id) ?? dec(0)).plus(atp));
    const shortage = demand.minus(atp);
    const reasons: string[] = [],
      jobs: ScheduledOperation[] = [];
    let assigned = dec(0),
      existingFinish = input.anchor;
    const existingOrders: Row[] = [];
    for (const order of openProduction.filter((o) => o.config.salesOrderLineId === line.id)) {
      const remaining = dec(order.quantity)
        .minus(order.completed_qty)
        .minus(order.config.scrappedQty ?? 0);
      const unassigned = shortage.minus(assigned);
      const take =
        remaining.gt(0) && unassigned.gt(0)
          ? remaining.lt(unassigned)
            ? remaining
            : unassigned
          : dec(0);
      if (take.lte(0)) continue;
      assigned = assigned.plus(take);
      existingOrders.push({
        id: order.id,
        code: order.code,
        quantity: take.toFixed(4),
        status: order.status,
      });
      if (
        !['released', 'in_progress'].includes(order.status) ||
        ['on_hold', 'paused', 'material_waiting'].includes(order.config.executionPhase)
      )
        reasons.push(order.code + ': üretim çalışmaya açık değil');
      for (const op of order.config.operations ?? []) {
        const plan = occupied.find(
          (p) =>
            p.orderId === order.id &&
            p.operationKey === op.key &&
            Date.parse(p.end) >= Date.parse(input.anchor),
        );
        if (plan) {
          if (Date.parse(plan.end) > Date.parse(existingFinish)) existingFinish = plan.end;
        } else if (
          dec(op.goodQty ?? 0).lt(dec(order.quantity).minus(order.config.scrappedQty ?? 0))
        )
          reasons.push(
            order.code + ' / ' + op.name + ': kalan iş için yayımlanmış gelecek plan yok',
          );
      }
      const pending = await one(
        tx,
        sql`select count(*)::int as n from leather_quality_checks where scope='production' and source_id=${order.id}::uuid and status='pending'`,
      );
      if (pending.n) reasons.push(order.code + ': kalite kararı bekliyor');
      const rework = await one(
        tx,
        sql`select count(*)::int as n from manufacturing_records where kind='rework' and order_id=${order.id}::uuid and status<>'completed'`,
      );
      if (rework.n) reasons.push(order.code + ': yeniden işleme açık; termin doğrulanamıyor');
    }
    const newProduction = shortage.minus(assigned);
    let finish: string | null = shortage.lte(0) ? input.anchor : null;
    let proposals: Row[] = [];
    if (newProduction.gt(0)) {
      const overrides: Record<string, string> = {};
      for (const itemId of stockIds) {
        const available = dec(
          (await stockAvailability(tx, itemId, input.warehouseId)).available,
        ).minus(consumed.get(itemId) ?? 0);
        overrides[itemId] = (available.gt(0) ? available : dec(0)).toFixed(4);
      }
      overrides[line.item_id] = '0';
      const needs = await mrp(
        tx,
        {
          itemId: line.item_id,
          quantity: newProduction.toFixed(4),
          warehouseId: input.warehouseId,
        },
        overrides,
      );
      for (const n of needs)
        if (n.itemId !== line.item_id)
          consumed.set(
            n.itemId,
            (consumed.get(n.itemId) ?? dec(0)).plus(dec(n.gross).minus(n.net)),
          );
      proposals = await purchaseProposals(tx, needs, input.anchor, incomingUsed);
      for (const p of proposals)
        incomingUsed[p.itemId] = dec(incomingUsed[p.itemId] ?? 0)
          .plus(dec(p.net).minus(p.purchaseQty))
          .toFixed(4);
      let ready = input.anchor;
      for (const p of proposals) {
        if (dec(p.purchaseQty).gt(0) && !p.suppliers.length)
          reasons.push(p.name + ': tedarik süresi tanımlı değil');
        const dates = p.openOrders
          .filter((o: Row) => o.expectedDate)
          .map((o: Row) => o.expectedDate + 'T00:00:00Z');
        if (dec(p.purchaseQty).gt(0) && p.suppliers.length)
          dates.push(p.suppliers[0].expectedDate + 'T00:00:00Z');
        for (const date of dates) if (Date.parse(date) > Date.parse(ready)) ready = date;
      }
      for (const need of [...needs]
        .reverse()
        .filter((n) => n.action === 'produce' && dec(n.net).gt(0))) {
        const recipe = variants.find((v) => v.item_id === need.itemId)?.config;
        for (const op of recipe?.operations ?? []) {
          const candidates: ScheduledOperation[] = [];
          const eligible = op.resources ?? [];
          if (!eligible.length) {
            reasons.push(need.name + ' / ' + op.name + ': uygun kaynak tanımlı değil');
            continue;
          }
          for (const option of eligible) {
            const resource = resources.find((r) => r.id === option.resourceId);
            const rate = Number(option.minutesPerUnit ?? op.plannedMinutes);
            if (!resource || !Number.isFinite(rate) || rate <= 0) continue;
            try {
              candidates.push(
                ...finiteManufacturingSchedule(
                  [
                    {
                      orderId: line.id,
                      operationKey: need.itemId + ':' + op.key,
                      resourceId: resource.id,
                      minutes: Math.ceil(rate * Number(need.net)),
                      priority: 50,
                    },
                  ],
                  calendars as never,
                  ready,
                  'forward',
                  capacities,
                  [...occupied, ...jobs],
                ),
              );
            } catch {
              /* No feasible capacity on this eligible resource. */
            }
          }
          candidates.sort(
            (a, b) =>
              a.end.localeCompare(b.end) ||
              Number(eligible.find((r: Row) => r.resourceId === b.resourceId)?.priority ?? 50) -
                Number(eligible.find((r: Row) => r.resourceId === a.resourceId)?.priority ?? 50),
          );
          if (!candidates[0]) reasons.push(need.name + ' / ' + op.name + ': uygun kapasite yok');
          else {
            jobs.push(candidates[0]);
            ready = candidates[0].end;
          }
        }
      }
      if (!reasons.length) {
        finish = Date.parse(ready) > Date.parse(existingFinish) ? ready : existingFinish;
        occupied.push(...jobs);
      }
    } else if (shortage.gt(0) && !reasons.length) finish = existingFinish;
    output.push({
      id: line.id,
      itemId: line.item_id,
      itemName: line.name,
      code: line.code,
      demand: (demand.gt(0) ? demand : dec(0)).toFixed(4),
      atp: atp.toFixed(4),
      productionQty: (shortage.gt(0) ? shortage : dec(0)).toFixed(4),
      openProductionQty: assigned.toFixed(4),
      newProductionQty: (newProduction.gt(0) ? newProduction : dec(0)).toFixed(4),
      existingOrders,
      stock,
      expectedAt: finish,
      source: shortage.lte(0) ? 'stock' : 'finite_capacity',
      reasons,
      operations: jobs,
      proposals,
    });
  }
  return { orderId: source.id, orderCode: source.doc_no, lines: output, forecast: true };
}
