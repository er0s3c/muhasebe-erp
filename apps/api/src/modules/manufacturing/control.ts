import { sql } from 'drizzle-orm';
import { dec, defectUsableAreas, patternScaleIssue, todayIso, toneKey } from '@erp/shared';
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
/**
 * Dijital kalıp (öneri 73): ölçü kutusuyla ölçek denetlenir; aynı model ve kodla yeni kayıt yeni revizyondur, önceki revizyon
 * "yerine geçildi" olur. Kesim planı yalnız güncel revizyonu seçer; emirde önceden kullanılan revizyon o emirde korunur.
 */
export async function createPattern(tx: Tx, ctx: LeatherCtx, input: Row & { requestKey: string }) {
  return command(tx, ctx, 'pattern', input, async () => {
    await one(tx, sql`select id from leather_models where id=${input.modelId}::uuid`, 'Model');
    const scale = patternScaleIssue(input.area, input.widthMm, input.heightMm);
    if (scale) throw fail(scale, 'PATTERN_SCALE_MISMATCH');
    const patternCode = String(input.code).trim();
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.companyId + ':pattern:' + patternCode},0))`);
    const previous = (await listRecords(tx, 'pattern')).filter(
      (p) => (p.patternCode ?? p.code) === patternCode && p.modelId === input.modelId && p.status === 'active',
    );
    const revision = Math.max(0, ...(await listRecords(tx, 'pattern')).filter((p) => (p.patternCode ?? p.code) === patternCode).map((p) => Number(p.revision ?? 1))) + 1;
    for (const p of previous) {
      const raw = await getRecord(tx, p.id, 'pattern', true);
      await updateRecord(tx, p.id, 'superseded', { ...raw.config, supersededAt: new Date().toISOString() });
    }
    return createRecord(
      tx,
      ctx,
      'pattern',
      { ...input, code: revision > 1 ? `${patternCode}-R${revision}` : patternCode, patternCode, revision },
      'active',
    );
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
    // Emrin önceki (iptal edilmemiş) kesim planları: kalıp revizyonu ve ton grubu bu emirde korunur (öneri 73, 74)
    const orderPlans = (await listRecords(tx, 'cut_plan')).filter((p) => p.orderId === order.id && p.status !== 'cancelled');
    const pieceSnapshots: Row[] = [],
      patternSnapshots: Row[] = [];
    let available = dec(0),
      availableVisible = dec(0),
      required = dec(0),
      requiredVisible = dec(0);
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
      // Kusur bölgeleri: delik her parçada, diğer kusurlar görünür parçada kullanılamaz (öneri 75)
      const usableByClass = defectUsableAreas({ area: piece.area, usableArea: piece.usable_area, outline: piece.config.outline, defects: piece.config.defects });
      const remaining = dec(piece.remaining_area);
      const hidden = remaining.lt(usableByClass.hiddenUsable) ? remaining : dec(usableByClass.hiddenUsable);
      const visible = remaining.lt(usableByClass.visibleUsable) ? remaining : dec(usableByClass.visibleUsable);
      available = available.plus(hidden);
      availableVisible = availableVisible.plus(visible);
      pieceSnapshots.push({
        id: piece.id,
        itemId: piece.item_id,
        remainingArea: piece.remaining_area,
        usableArea: piece.usable_area,
        visibleUsable: visible.toFixed(4),
        hiddenUsable: hidden.toFixed(4),
        tone: piece.config.tone ?? '',
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
      const patternCode = pattern.config.patternCode ?? pattern.config.code;
      const pinned = orderPlans.flatMap((p) => (p.patternSnapshots ?? []) as Row[]).find((s) => (s.patternCode ?? s.code) === patternCode);
      if (pinned && pinned.id !== pattern.id)
        throw fail(`${patternCode} kalıbının bu emirde kullanılan revizyonu ${pinned.revision ?? 1}; aynı revizyonla devam edin`, 'PATTERN_REVISION_PINNED');
      if (!pinned && pattern.status !== 'active')
        throw fail(`${patternCode} kalıbının bu revizyonu güncel değil; güncel revizyonu seçin`, 'PATTERN_REVISION_SUPERSEDED');
      const area = dec(pattern.config.area).times(part.perSet).times(input.sets);
      required = required.plus(area);
      if ((pattern.config.visibility ?? 'visible') === 'visible') requiredVisible = requiredVisible.plus(area);
      patternSnapshots.push({ ...pattern.config, id: pattern.id, perSet: part.perSet });
    }
    if (required.gt(available) || input.sets > Number(order.quantity))
      throw fail('Kesim hedefi kullanılabilir alanı veya emir miktarını aşamaz');
    if (requiredVisible.gt(availableVisible))
      throw fail(
        `Görünür parçalar için kusursuz alan yetersiz (gerekli ${requiredVisible.toFixed(4)}, kusursuz ${availableVisible.toFixed(4)} m²)`,
        'LEATHER_DEFECT_AREA',
      );
    // Ton uyumu: bir sette ve emrin tüm kesimlerinde aynı ton grubu (öneri 74)
    const tones = [...new Set(pieceSnapshots.map((p) => toneKey(p.tone)).filter(Boolean))];
    const orderTones = [...new Set(orderPlans.map((p) => p.toneGroup).filter(Boolean))] as string[];
    const toneConflict = tones.length > 1 || (tones.length === 1 && orderTones.length > 0 && !orderTones.includes(tones[0]!));
    if (toneConflict && !input.toneOverrideReason)
      throw fail(
        `Kesim parçalarının ton grupları uyuşmuyor (${[...new Set([...orderTones, ...tones])].join(', ')}); aynı ton grubundan parça seçin ya da gerekçe girin`,
        'LEATHER_TONE_MISMATCH',
      );
    return createRecord(
      tx,
      ctx,
      'cut_plan',
      {
        ...input,
        pieceSnapshots,
        patternSnapshots,
        availableArea: available.toFixed(4),
        availableVisibleArea: availableVisible.toFixed(4),
        requiredArea: required.toFixed(4),
        requiredVisibleArea: requiredVisible.toFixed(4),
        plannedYield: required.div(available).times(100).toFixed(2),
        toneGroup: tones.length === 1 ? tones[0] : null,
        toneOverrideReason: toneConflict ? input.toneOverrideReason : null,
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
