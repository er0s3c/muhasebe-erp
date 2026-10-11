import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { dec, defectUsableAreas, leatherRemnantSearchSchema, toneKey, uuid } from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { all, one } from './common';
import { listRecords } from '../manufacturing/service';

/**
 * F8 deri atölyesi görünümleri: kalan parça arama (76), aksesuar partisinden mamule ve müşteriye ileri iz (79),
 * deri malzemesinden ürün maliyetine görünüm (15). Hiçbiri kayıt yazmaz.
 */

type Money = ReturnType<typeof dec>;
const min = (a: Money, b: Money) => (a.lt(b) ? a : b);

/** Kalan parça arama (öneri 76): serbest alan = kalan ∧ sınıfa göre kullanılabilir alan − parça rezervasyonu; açık kesim planındakiler hariç. */
export async function searchRemnants(tx: Tx, q: z.infer<typeof leatherRemnantSearchSchema>) {
  const rows = await all(
    tx,
    sql`select p.*, l.code as lot_code, i.code as item_code, i.name as item_name, w.name as warehouse_name,
               coalesce((select sum(r.quantity - r.consumed_qty) from leather_reservations r where r.piece_id = p.id and r.status = 'reserved'), 0)::text as reserved
          from leather_pieces p
          join leather_lots l on l.id = p.lot_id
          join items i on i.id = p.item_id
          join warehouses w on w.id = p.warehouse_id
         where p.status in ('available', 'second') and p.remaining_area > 0
           ${q.itemId ? sql`and p.item_id = ${q.itemId}::uuid` : sql``}
           ${q.warehouseId ? sql`and p.warehouse_id = ${q.warehouseId}::uuid` : sql``}
           ${q.remnantsOnly ? sql`and p.parent_id is not null` : sql``}
         order by p.remaining_area
         limit 2000`,
  );
  const openPlans = (await listRecords(tx, 'cut_plan')).filter((p) => ['planned', 'in_progress'].includes(p.status));
  const planned = new Set(openPlans.flatMap((p) => (p.pieces ?? []) as string[]));
  const wantTone = q.tone ? toneKey(q.tone) : null;
  const out = rows
    .filter((p) => !planned.has(p.id))
    .filter((p) => !q.grade || (p.config.grade ?? 'A') === q.grade)
    .filter((p) => !wantTone || toneKey(p.config.tone) === wantTone)
    .map((p) => {
      const classes = defectUsableAreas({ area: p.area, usableArea: p.usable_area, outline: p.config.outline, defects: p.config.defects });
      const classUsable = dec(q.visibility === 'visible' ? classes.visibleUsable : classes.hiddenUsable);
      const free = min(dec(p.remaining_area), classUsable).minus(p.reserved);
      return {
        id: p.id,
        code: p.code,
        lotCode: p.lot_code,
        itemId: p.item_id,
        itemCode: p.item_code,
        itemName: p.item_name,
        warehouseName: p.warehouse_name,
        isRemnant: p.parent_id !== null,
        status: p.status,
        grade: p.config.grade ?? 'A',
        tone: p.config.tone ?? '',
        area: dec(p.area).toFixed(4),
        remainingArea: dec(p.remaining_area).toFixed(4),
        reservedArea: dec(p.reserved).toFixed(4),
        freeArea: (free.isNegative() ? dec(0) : free).toFixed(4),
        outline: p.config.outline ?? null,
        defects: p.config.defects ?? [],
        grainAngle: p.config.grainAngle ?? null,
      };
    })
    .filter((p) => dec(p.freeArea).gt(0) && dec(p.freeArea).gte(q.minArea))
    // En iyi uyum: ihtiyacı karşılayan en küçük serbest alan önce (büyük deriyi bölmeden kalanı kullan)
    .sort((a, b) => dec(a.freeArea).comparedTo(dec(b.freeArea)))
    .slice(0, 100);
  return { pieces: out };
}

interface Shipment { noteId: string; noteNo: string | null; partyName: string | null; quantity: string }

/** Lot olaylarından satış irsaliyesi sevklerini ve transfer hedef lotlarını toplar. */
async function lotForward(tx: Tx, lotId: string, depth = 0): Promise<{ shipments: Shipment[]; orderUse: Map<string, Money> }> {
  const events = await all(tx, sql`select status, order_id, config from manufacturing_records where kind = 'lot_event' and config->>'lotId' = ${lotId}`);
  const shipments: Shipment[] = [];
  const orderUse = new Map<string, Money>();
  for (const e of events) {
    const qty = dec(e.config.quantity ?? 0);
    if (e.order_id) {
      orderUse.set(e.order_id, (orderUse.get(e.order_id) ?? dec(0)).plus(e.status === 'returned' ? qty.negated() : qty));
      continue;
    }
    if (e.status === 'issued' && e.config.sourceType === 'delivery_note' && e.config.sourceId) {
      const [note] = await all(tx, sql`select n.id, n.note_no, n.type, p.name as party_name from delivery_notes n join parties p on p.id = n.party_id where n.id = ${e.config.sourceId}::uuid`);
      if (note && note.type === 'sales') shipments.push({ noteId: note.id, noteNo: note.note_no, partyName: note.party_name, quantity: qty.toFixed(4) });
    }
    if (e.status === 'issued' && e.config.targetLotId && depth < 5) {
      const next = await lotForward(tx, e.config.targetLotId, depth + 1);
      shipments.push(...next.shipments);
      for (const [k, v] of next.orderUse) orderUse.set(k, (orderUse.get(k) ?? dec(0)).plus(v));
    }
  }
  return { shipments, orderUse };
}

/** Aksesuar (ya da herhangi bir) partisinden üretim emirlerine, mamul partilerine ve müşteri sevklerine ileri iz (öneri 79). */
export async function lotTraceForward(tx: Tx, lotId: string) {
  const lot = await one(
    tx,
    sql`select r.id, r.code, r.item_id, i.code as item_code, i.name as item_name, r.config from manufacturing_records r join items i on i.id = r.item_id where r.id = ${lotId}::uuid and r.kind = 'lot'`,
    'Parti',
  );
  const forward = await lotForward(tx, lot.id);
  const orders = [];
  for (const [orderId, used] of forward.orderUse) {
    if (used.lte(0)) continue;
    const [order] = await all(tx, sql`select o.id, o.code, o.status, i.name as item_name from leather_production_orders o join items i on i.id = o.item_id where o.id = ${orderId}::uuid`);
    const outputs = await all(tx, sql`select id, code, config from manufacturing_records where kind = 'lot' and order_id = ${orderId}::uuid order by created_at`);
    const outLots = [];
    for (const o of outputs) {
      const next = await lotForward(tx, o.id);
      outLots.push({ lotId: o.id, code: o.code, quantity: dec(o.config.quantity ?? 0).toFixed(4), shipments: next.shipments });
    }
    orders.push({ orderId, code: order?.code ?? null, status: order?.status ?? null, itemName: order?.item_name ?? null, consumedQty: used.toFixed(4), outputs: outLots });
  }
  const customers = [...new Set([...forward.shipments, ...orders.flatMap((o) => o.outputs.flatMap((x) => x.shipments))].map((s) => s.partyName).filter(Boolean))];
  return {
    lot: { id: lot.id, code: lot.code, itemCode: lot.item_code, itemName: lot.item_name, quantity: dec(lot.config.quantity ?? 0).toFixed(4), remainingQty: dec(lot.config.remainingQty ?? lot.config.quantity ?? 0).toFixed(4) },
    orders,
    directShipments: forward.shipments,
    customers,
  };
}

/**
 * Deri malzemesinden ürün maliyetine görünüm (öneri 15): emre verilen deri alanı, emirden dönen kalan parça, net kullanılan alan,
 * kesim planlarının kalıp alanıyla verim, deri değeri ve birim mamule düşen deri/diğer malzeme/diğer maliyet payı.
 */
export async function leatherCostView(tx: Tx, orderId: string) {
  const order = await one(tx, sql`select id, code, quantity, status, item_id from leather_production_orders where id = ${orderId}::uuid`, 'Üretim emri');
  const areas = await all(
    tx,
    sql`select e.kind, p.item_id, coalesce(sum(e.quantity), 0)::text as area
          from leather_piece_events e join leather_pieces p on p.id = e.piece_id
         where e.order_id = ${orderId}::uuid and e.kind in ('issue', 'remnant') group by e.kind, p.item_id`,
  );
  const leatherItems = new Set(areas.map((a) => a.item_id as string));
  const values = await all(
    tx,
    sql`select m.item_id, coalesce(sum(-m.value), 0)::text as value
          from leather_production_documents d join stock_movements m on m.document_id = d.stock_document_id
         where d.order_id = ${orderId}::uuid and d.kind in ('issue', 'return') group by m.item_id`,
  );
  const plans = (await listRecords(tx, 'cut_plan')).filter((p) => p.orderId === orderId && p.status !== 'cancelled');
  const issued = areas.filter((a) => a.kind === 'issue').reduce<Money>((s, a) => s.plus(a.area), dec(0));
  const remnant = areas.filter((a) => a.kind === 'remnant').reduce<Money>((s, a) => s.plus(a.area), dec(0));
  const used = issued.minus(remnant);
  const patternArea = plans.reduce<Money>((s, p) => s.plus(p.requiredArea ?? 0), dec(0));
  const leatherValue = values.filter((v) => leatherItems.has(v.item_id)).reduce<Money>((s, v) => s.plus(v.value), dec(0));
  const otherMaterial = values.filter((v) => !leatherItems.has(v.item_id)).reduce<Money>((s, v) => s.plus(v.value), dec(0));
  const other = await all(
    tx,
    sql`select kind, sum(current_value)::text as value from leather_cost_roots where order_id = ${orderId}::uuid and source_type = 'production_order' and not coalesce((config->>'cancelled')::boolean, false) group by kind order by kind`,
  );
  const otherTotal = other.reduce<Money>((s, o) => s.plus(o.value), dec(0));
  const qty = dec(order.quantity);
  const per = (v: Money) => (qty.gt(0) ? v.div(qty).toFixed(2) : null);
  return {
    order: { id: order.id, code: order.code, quantity: qty.toFixed(4), status: order.status },
    area: {
      issued: issued.toFixed(4),
      remnantReturned: remnant.toFixed(4),
      netUsed: used.toFixed(4),
      patternArea: patternArea.toFixed(4),
      // Verim: kalıp alanı / net kullanılan deri; kesim planı yoksa hesaplanmaz
      yieldPct: used.gt(0) && patternArea.gt(0) ? patternArea.div(used).times(100).toFixed(2) : null,
      perUnit: qty.gt(0) ? used.div(qty).toFixed(4) : null,
    },
    value: {
      leather: leatherValue.toFixed(2),
      leatherPerM2: used.gt(0) ? leatherValue.div(used).toFixed(2) : null,
      otherMaterial: otherMaterial.toFixed(2),
      other: other.map((o) => ({ kind: o.kind, value: dec(o.value).toFixed(2) })),
      total: leatherValue.plus(otherMaterial).plus(otherTotal).toFixed(2),
    },
    perUnit: {
      leather: per(leatherValue),
      otherMaterial: per(otherMaterial),
      other: per(otherTotal),
      total: per(leatherValue.plus(otherMaterial).plus(otherTotal)),
    },
  };
}

export const leatherInsightRoutes: FastifyPluginAsync = async (app) => {
  const id = (c: TenantCtx) => z.object({ id: uuid }).parse(c.req.params).id;
  app.get(
    '/api/leather/materials/remnants',
    tenantRoute(app, { module: 'leather.materials', permission: 'leather.materials.read' as never }, async (c) => searchRemnants(c.tx, leatherRemnantSearchSchema.parse(c.req.query))),
  );
  app.get(
    '/api/manufacturing/lots/:id/trace-forward',
    tenantRoute(app, { module: 'manufacturing.production', permission: 'manufacturing.production.read' as never }, async (c) => lotTraceForward(c.tx, id(c))),
  );
  app.get(
    '/api/leather/production/orders/:id/leather-cost',
    tenantRoute(app, { module: 'manufacturing.costs', permission: 'manufacturing.costs.read' as never }, async (c) => leatherCostView(c.tx, id(c))),
  );
};

