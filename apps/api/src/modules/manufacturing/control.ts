import { sql } from 'drizzle-orm';
import { dec, todayIso } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, one, fail, type LeatherCtx, type Row } from '../leather/common';
import { productionOrderScope } from '../leather/visibility';
import type { Role } from '@erp/shared';
import { getProduction } from '../leather/production';
import { createRecord, getRecord, listRecords, updateRecord } from './service';
import { command } from './commands';
import { stockAvailability } from './availability';
import { capacityReport } from './reports';

export async function exceptions(tx: Tx, role: Role, userId: string, includeResolved = false) {
  const orders = await all(
    tx,
    sql`select o.id,o.code,o.due_date,o.status from leather_production_orders o where o.status not in ('completed','cancelled') and ${productionOrderScope(role, userId, 'o')}`,
  );
  const visible = new Set(orders.map((o) => o.id));
  const results: Row[] = [];
  for (const o of orders)
    if (o.due_date && o.due_date < todayIso())
      results.push({
        sourceKey: 'late:' + o.id,
        kind: 'late_order',
        code: o.code,
        message: 'Üretim termini geçti',
        severity: 'high',
        path: '/manufacturing/production?focus=' + o.id,
      });
  const quality = await all(
    tx,
    sql`select q.id,q.source_id,q.scope,o.code from leather_quality_checks q left join leather_production_orders o on o.id=q.source_id and o.company_id=q.company_id where q.status='pending'`,
  );
  for (const q of quality)
    if (role !== 'operator' || (q.scope === 'production' && visible.has(q.source_id)))
      results.push({
        sourceKey: 'quality:' + q.id,
        kind: 'quality_hold',
        code: q.code ?? 'Kalite kontrolü',
        message: 'Kalite kararı bekliyor',
        severity: 'medium',
        path: '/manufacturing/quality?focus=' + q.id,
      });
  const records = await all(
    tx,
    sql`select * from manufacturing_records where kind in ('maintenance','transfer') and status not in ('completed','received','cancelled')`,
  );
  for (const r of records) {
    if (role === 'operator' && r.order_id && !visible.has(r.order_id)) continue;
    if (r.kind === 'maintenance' && r.config.kind === 'breakdown')
      results.push({
        sourceKey: 'failure:' + r.id,
        kind: 'machine_failure',
        code: r.config.description,
        message: 'Makine arızalı',
        severity: 'high',
        path: '/manufacturing/maintenance',
      });
    if (
      r.kind === 'transfer' &&
      r.config.dispatchAt &&
      Date.now() - Date.parse(r.config.dispatchAt) > 86400000
    )
      results.push({
        sourceKey: 'transfer:' + r.id,
        kind: 'transfer_waiting',
        code: 'Operasyon transferi',
        message: 'Transfer bir günden uzun süredir bekliyor',
        severity: 'medium',
        path: '/manufacturing/production?focus=' + r.order_id,
      });
  }
  const subcontract = await all(
    tx,
    sql`select j.id,j.order_id,j.due_date,o.code from leather_subcontract_jobs j join leather_production_orders o on o.id=j.order_id and o.company_id=j.company_id where j.status='dispatched' and j.due_date<${todayIso()}::date`,
  );
  for (const s of subcontract)
    if (role !== 'operator' || visible.has(s.order_id))
      results.push({
        sourceKey: 'subcontract:' + s.id,
        kind: 'late_subcontract',
        code: s.code,
        message: 'Fason teslimi gecikti',
        severity: 'high',
        path: '/manufacturing/subcontracting?focus=' + s.id,
      });
  const states = await listRecords(tx, 'exception');
  for (const o of orders) {
    const materials = await all(
      tx,
      sql`select r.item_id,i.name,r.warehouse_id,sum(r.quantity-r.consumed_qty)::text as need from leather_reservations r join items i on i.id=r.item_id and i.company_id=r.company_id where r.order_id=${o.id}::uuid and r.status in ('planned','reserved') group by r.item_id,i.name,r.warehouse_id`,
    );
    for (const m of materials) {
      const stock = await stockAvailability(tx, m.item_id, m.warehouse_id, o.id);
      if (dec(m.need).gt(stock.available))
        results.push({
          sourceKey: 'shortage:' + o.id + ':' + m.item_id,
          kind: 'material_shortage',
          code: o.code,
          message: m.name + ': serbest malzeme eksik',
          severity: 'high',
          path: '/manufacturing/production?focus=' + o.id,
        });
    }
  }
  if (role !== 'operator') {
    const from = todayIso() + 'T00:00:00+03:00',
      to = new Date(Date.parse(from) + 7 * 86400000).toISOString();
    for (const r of (await capacityReport(tx, from, to)).resources)
      if (r.overloadMinutes > 0 || (r.noCalendar && r.loadMinutes > 0))
        results.push({
          sourceKey: 'capacity:' + r.id,
          kind: 'capacity_overload',
          code: r.code,
          message: r.name + ': yayımlanmış yük net kapasiteyi aşıyor',
          severity: 'high',
          path: '/manufacturing/planning',
        });
  }
  return results
    .map((r) => {
      const state = states.find((s) => s.sourceKey === r.sourceKey);
      return {
        ...r,
        id: r.sourceKey,
        assignedUserId: state?.assignedUserId,
        status: state?.status,
        reason: state?.reason,
      };
    })
    .filter((r) => includeResolved || r.status !== 'resolved');
}
export async function exceptionAction(
  tx: Tx,
  ctx: LeatherCtx,
  input: Row & { requestKey: string },
) {
  return command(tx, ctx, 'exception', input, async () => {
    if (input.assignedUserId)
      await one(
        tx,
        sql`select user_id from memberships where company_id=${ctx.companyId}::uuid and user_id=${input.assignedUserId}::uuid`,
        'Sorumlu',
      );
    const current = (await listRecords(tx, 'exception')).find(
      (s) => s.sourceKey === input.sourceKey,
    );
    const status = input.action === 'resolve' ? 'resolved' : 'open';
    const value = {
      ...current,
      ...input,
      resolvedAt: status === 'resolved' ? new Date().toISOString() : null,
    };
    return current
      ? updateRecord(tx, current.id, status, value)
      : createRecord(tx, ctx, 'exception', value, status);
  });
}
export async function createPattern(tx: Tx, ctx: LeatherCtx, input: Row & { requestKey: string }) {
  return command(tx, ctx, 'pattern', input, async () => {
    await one(tx, sql`select id from leather_models where id=${input.modelId}::uuid`, 'Model');
    return createRecord(tx, ctx, 'pattern', input, 'active');
  });
}
export async function cutPlan(tx: Tx, ctx: LeatherCtx, input: Row & { requestKey: string }) {
  return command(tx, ctx, 'cut-plan', input, async () => {
    const order = await getProduction(tx, input.orderId);
    if (['completed', 'cancelled'].includes(order.status)) throw fail('Açık üretim gerekli');
    if (new Set(input.pieces).size !== input.pieces.length)
      throw fail('Deri parçaları benzersiz olmalı');
    if (new Set(input.patterns.map((p: Row) => p.patternId)).size !== input.patterns.length)
      throw fail('Kalıplar benzersiz olmalı; set başına adedi aynı satırda girin');
    const activeOrders = new Set(
      (
        await all(
          tx,
          sql`select id from leather_production_orders where status not in ('cancelled','completed')`,
        )
      ).map((o) => o.id),
    );
    const activePlans = (await listRecords(tx, 'cut_plan')).filter(
      (p) => ['planned', 'in_progress'].includes(p.status) && activeOrders.has(p.orderId),
    );
    if (activePlans.some((p) => p.pieces.some((id: string) => input.pieces.includes(id))))
      throw fail('Seçilen deri parçası açık bir kesim planında kullanılıyor');
    const pieceSnapshots: Row[] = [],
      patternSnapshots: Row[] = [];
    let available = dec(0),
      required = dec(0);
    for (const pieceId of input.pieces) {
      const piece = await one(
        tx,
        sql`select * from leather_pieces where id=${pieceId}::uuid`,
        'Deri parçası',
      );
      if (
        piece.warehouse_id !== order.warehouseId ||
        !order.materials.some((m: Row) => m.itemId === piece.item_id) ||
        !['available', 'second'].includes(piece.status)
      )
        throw fail('Kesim parçası üretim malzemesine, depoya ve kaliteye uygun olmalı');
      available = available.plus(
        dec(piece.remaining_area).lt(piece.usable_area) ? piece.remaining_area : piece.usable_area,
      );
      pieceSnapshots.push({
        id: piece.id,
        itemId: piece.item_id,
        remainingArea: piece.remaining_area,
        usableArea: piece.usable_area,
        grainAngle: piece.config.grainAngle ?? null,
        outline: piece.config.outline ?? null,
        defects: piece.config.defects ?? [],
      });
    }
    for (const part of input.patterns) {
      const pattern = await getRecord(tx, part.patternId, 'pattern');
      const variant = await one(
        tx,
        sql`select model_id from leather_variants where id=${order.variantId}::uuid`,
      );
      if (pattern.config.modelId !== variant.model_id)
        throw fail('Kalıp üretim modeline bağlı olmalı');
      if (pattern.config.direction === 'grain' && pieceSnapshots.some((p) => p.grainAngle === null))
        throw fail('Damar yönü gerektiren kalıp için her parçanın damar açısını kaydedin');
      required = required.plus(dec(pattern.config.area).times(part.perSet).times(input.sets));
      patternSnapshots.push({ ...pattern.config, id: pattern.id, perSet: part.perSet });
    }
    if (required.gt(available) || input.sets > Number(order.quantity))
      throw fail('Kesim hedefi kullanılabilir alanı veya emir miktarını aşamaz');
    return createRecord(
      tx,
      ctx,
      'cut_plan',
      {
        ...input,
        pieceSnapshots,
        patternSnapshots,
        availableArea: available.toFixed(4),
        requiredArea: required.toFixed(4),
        plannedYield: required.div(available).times(100).toFixed(2),
      },
      'planned',
    );
  });
}
export async function cancelCutPlan(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: Row & { requestKey: string },
) {
  return command(tx, ctx, 'cut-plan-cancel:' + id, input, async () => {
    const plan = await getRecord(tx, id, 'cut_plan', true);
    if (!['planned', 'in_progress'].includes(plan.status))
      throw fail('Yalnızca açık kesim planı iptal edilebilir');
    // Completed cuts and their stock/cost documents are retained; only unused selections are released.
    return updateRecord(tx, id, 'cancelled', {
      ...plan.config,
      cancellationReason: input.reason,
      cancelledBy: ctx.userId,
      cancelledAt: new Date().toISOString(),
    });
  });
}
