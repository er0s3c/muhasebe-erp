import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  dec,
  explodeManufacturingNeed,
  finiteManufacturingSchedule,
  type MrpRecipe,
  type ScheduledOperation,
  type SchedulingJob,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import {
  all,
  one,
  newId,
  json,
  fail,
  lockLeatherCosts,
  type LeatherCtx,
  type Row,
} from '../leather/common';
import { availableStock, createProduction, getProduction } from '../leather/production';
import { requireOpenPeriod } from '../settings/periods';
import { leatherProductionSchema, createStockDocumentSchema } from '@erp/shared';
import { postStockDocument } from '../inventory/documents';

export const recordShape = (r: Row) => ({
  ...r.config,
  id: r.id,
  code: r.code,
  status: r.status,
  recordKind: r.kind,
  kind: r.config.kind ?? r.kind,
  orderId: r.order_id,
  itemId: r.item_id,
  warehouseId: r.warehouse_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export async function listRecords(tx: Tx, kind: string) {
  return (
    await all(
      tx,
      sql`select * from manufacturing_records where kind=${kind} order by created_at desc limit 1000`,
    )
  ).map(recordShape);
}
export async function getRecord(tx: Tx, id: string, kind: string, lock = false) {
  return one(
    tx,
    sql`select * from manufacturing_records where id=${id}::uuid and kind=${kind} ${lock ? sql`for update` : sql``}`,
  );
}
export async function createRecord(
  tx: Tx,
  ctx: LeatherCtx,
  kind: string,
  input: Row,
  status = 'draft',
) {
  const id = newId();
  return recordShape(
    await one(
      tx,
      sql`insert into manufacturing_records(id,company_id,created_by,kind,code,status,order_id,item_id,warehouse_id,source_document_id,request_key,config) values(${id},${ctx.companyId},${ctx.userId},${kind},${input.code ?? id},${status},${input.orderId ?? null},${input.itemId ?? null},${input.warehouseId ?? null},${input.sourceDocumentId ?? null},${input.requestKey ?? null},${json(input)}) returning *`,
    ),
  );
}
export async function updateRecord(tx: Tx, id: string, status: string, config: Row) {
  return recordShape(
    await one(
      tx,
      sql`update manufacturing_records set status=${status},config=${json(config)},updated_at=now() where id=${id}::uuid returning *`,
    ),
  );
}
export async function mrp(
  tx: Tx,
  input: { itemId: string; quantity: string; warehouseId: string },
) {
  await one(
    tx,
    sql`select id from items where id=${input.itemId}::uuid and kind='goods' and is_active`,
    'Ürün',
  );
  await one(
    tx,
    sql`select id from warehouses where id=${input.warehouseId}::uuid and is_active`,
    'Depo',
  );
  const variants = await all(
    tx,
    sql`select v.item_id,r.config from leather_variants v join leather_revisions r on r.id=v.revision_id where r.status='approved'`,
  );
  const recipes: MrpRecipe[] = variants.map((v) => ({
    itemId: v.item_id,
    materials: v.config.materials,
  }));
  const ids = new Set([
    input.itemId,
    ...recipes.flatMap((r) => [r.itemId, ...r.materials.map((m) => m.itemId)]),
  ]);
  const stock: Record<string, string> = {};
  for (const id of ids) stock[id] = await availableStock(tx, id, input.warehouseId);
  const needs = explodeManufacturingNeed(input.itemId, input.quantity, recipes, stock);
  const items = await all(tx, sql`select id,code,name,unit from items`);
  const labels = new Map(items.map((i) => [i.id, i]));
  return needs.map((n) => ({
    ...n,
    code: labels.get(n.itemId)?.code,
    name: labels.get(n.itemId)?.name,
    unit: labels.get(n.itemId)?.unit,
  }));
}
/** Draft work orders and requirements use the same inventory/BOM engine for both sectors. */
export async function createMrpOrders(tx: Tx, ctx: LeatherCtx, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const previous = await all(
    tx,
    sql`select id,config from leather_production_orders where config->>'mrpRequestKey'=${input.requestKey}`,
  );
  if (previous.length) {
    if (previous.some((r) => r.config.mrpPayloadHash !== payloadHash))
      throw fail('İstek kimliği farklı üretim ihtiyacında kullanıldı');
    return Promise.all(previous.map((r) => getProduction(tx, r.id)));
  }
  const needs = await mrp(tx, input as { itemId: string; quantity: string; warehouseId: string });
  const result: Row[] = [];
  const byItem = new Map<string, string>();
  for (const n of needs.filter((n) => n.action === 'produce' && dec(n.net).gt(0))) {
    const v = await one(
      tx,
      sql`select id,revision_id from leather_variants where item_id=${n.itemId}::uuid`,
      'Üretim varyantı',
    );
    const o = await createProduction(
      tx,
      ctx,
      leatherProductionSchema.parse({
        ...input,
        variantId: v.id,
        revisionId: v.revision_id,
        quantity: n.net,
      }),
    );
    await tx.execute(
      sql`update leather_production_orders set config=config||${json({ mrpRequestKey: input.requestKey, mrpPayloadHash: payloadHash, parentOrderId: n.parentItemId ? (byItem.get(n.parentItemId) ?? null) : null })} where id=${o.id}::uuid`,
    );
    byItem.set(n.itemId, o.id);
    result.push(await getProduction(tx, o.id));
  }
  return result;
}
export async function schedule(
  tx: Tx,
  input: { jobs: SchedulingJob[]; anchor: string; direction: 'forward' | 'backward' },
  excludeId?: string,
) {
  const resources = await listRecords(tx, 'resource');
  const capacities = Object.fromEntries(resources.map((r) => [r.id, r.capacity]));
  for (const j of input.jobs) {
    if (!resources.some((r) => r.id === j.resourceId && r.status === 'active'))
      throw fail('Aktif kaynak gerekli');
    const o = await one(
      tx,
      sql`select config,status from leather_production_orders where id=${j.orderId}::uuid`,
    );
    if (
      ['cancelled', 'completed'].includes(o.status) ||
      !o.config.operations.some((p: Row) => p.key === j.operationKey)
    )
      throw fail('Operasyon açık üretim rotasında yok');
  }
  const calendars = (await listRecords(tx, 'calendar')).filter((c) => c.status === 'active');
  const published = (await listRecords(tx, 'schedule')).filter(
    (r) => r.status === 'published' && r.id !== excludeId,
  );
  const occupied = published.flatMap((r) => r.operations ?? []) as ScheduledOperation[];
  return finiteManufacturingSchedule(
    input.jobs,
    calendars as never,
    input.anchor,
    input.direction,
    capacities,
    occupied,
  );
}
export async function publishSchedule(tx: Tx, ctx: LeatherCtx, id: string) {
  await lockLeatherCosts(tx, ctx.companyId);
  const r = await getRecord(tx, id, 'schedule', true);
  if (r.status === 'published') return recordShape(r);
  if (r.status !== 'draft') throw fail('Yalnız taslak plan yayımlanır');
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, v[key]]),
          )
        : v,
    );
  const current = await schedule(tx, r.config, id);
  if (canonical(current) !== canonical(r.config.operations))
    throw fail('Kapasite değişti; senaryoyu yeniden hesaplayın', 'MANUFACTURING_CAPACITY_CHANGED');
  return updateRecord(tx, id, 'published', r.config);
}
export async function transferAction(tx: Tx, ctx: LeatherCtx, id: string, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  const r = await getRecord(tx, id, 'transfer', true);
  const c = r.config;
  if ((c.actions ?? []).some((a: Row) => a.requestKey === input.requestKey)) return recordShape(r);
  const transitions: Record<string, string> = {
    approve: 'approved',
    dispatch: 'dispatched',
    receive: 'received',
    cancel: 'cancelled',
  };
  if (
    (input.action === 'approve' && r.status !== 'draft') ||
    (input.action === 'dispatch' && r.status !== 'approved') ||
    (input.action === 'receive' && !['dispatched', 'part_received'].includes(r.status)) ||
    (input.action === 'cancel' && !['draft', 'approved'].includes(r.status))
  )
    throw fail('Transfer aşaması uygun değil');
  if (input.action === 'dispatch') {
    const o = await getProduction(tx, r.order_id);
    const op = o.operations.find((p: Row) => p.key === c.fromOperation);
    const dispatched = await one(
      tx,
      sql`select coalesce(sum((config->>'quantity')::numeric),0)::text as qty from manufacturing_records where kind='transfer' and order_id=${r.order_id} and config->>'fromOperation'=${c.fromOperation} and status in ('dispatched','part_received','received')`,
    );
    if (
      !op ||
      dec(dispatched.qty)
        .plus(c.quantity)
        .gt(op.goodQty ?? op.completedQty ?? 0)
    )
      throw fail('Transfer iyi operasyon adedini aşamaz');
  }
  const received =
    input.action === 'receive'
      ? dec(c.receivedQty ?? 0).plus(input.quantity ?? c.quantity)
      : dec(c.receivedQty ?? 0);
  if (received.gt(c.quantity)) throw fail('Transfer kabulü gönderileni aşamaz');
  const now = new Date().toISOString();
  return updateRecord(
    tx,
    id,
    input.action === 'receive' && received.lt(c.quantity)
      ? 'part_received'
      : transitions[input.action]!,
    {
      ...c,
      receivedQty: received.toFixed(4),
      [input.action + 'At']: now,
      actions: [...(c.actions ?? []), { ...input, at: now }],
    },
  );
}
export async function maintenance(tx: Tx, ctx: LeatherCtx, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  await getRecord(tx, input.resourceId, 'resource');
  const m = await createRecord(tx, ctx, 'maintenance', input, 'open');
  await createRecord(
    tx,
    ctx,
    'calendar',
    {
      resourceId: input.resourceId,
      start: input.start,
      end: input.end,
      available: false,
      reason: input.kind === 'breakdown' ? 'breakdown' : 'maintenance',
      maintenanceId: m.id,
    },
    'active',
  );
  return m;
}
export async function finishMaintenance(tx: Tx, ctx: LeatherCtx, id: string, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  const m = await getRecord(tx, id, 'maintenance', true);
  if (m.status === 'completed') return recordShape(m);
  if (m.status !== 'open') throw fail('Bakım açık değil');
  await requireOpenPeriod(tx, input.date);
  let stockDocumentId: string | null = null;
  if (m.config.spareParts?.length) {
    const doc = await postStockDocument(
      tx,
      ctx,
      createStockDocumentSchema.parse({
        type: 'issue',
        docDate: input.date,
        warehouseId: m.config.warehouseId,
        description: 'Bakım yedek parça sarfı',
        lines: m.config.spareParts.map((p: Row) => ({ itemId: p.itemId, quantity: p.quantity })),
      }),
    );
    stockDocumentId = doc.document.id;
  }
  return updateRecord(tx, id, 'completed', {
    ...m.config,
    completedAt: new Date().toISOString(),
    stockDocumentId,
    requestKey: input.requestKey,
  });
}
