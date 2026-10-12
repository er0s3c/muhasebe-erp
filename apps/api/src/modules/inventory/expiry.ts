import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { expiryRiskQuerySchema, expiryState } from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute } from '../../http/context';

/**
 * Son kullanma ve raf ömrü (öneri 47). Parti son kullanma tarihi stok kartındaki raf ömründen önerilir (kabul ya da üretim
 * belgesi tarihi + gün); devir ve iade partileri kaynak partinin tarihini taşır. Otomatik parti seçimi FEFO sırasıyla yapılır,
 * üretim sarfında süresi geçmiş parti kullanılmaz. Risk raporu süresi geçmiş ve yaklaşan partileri değeriyle gösterir.
 */

/** Şirketin saat dilimindeki bugün (RLS bağlamındaki şirket). */
export const LOCAL_TODAY = sql`(now() at time zone coalesce((select time_zone from companies where id=app_company_id()),'Europe/Istanbul'))::date`;

/** FEFO sıralaması: son kullanma tarihi en yakın parti önce, tarihsizler en sonda (giriş sırasıyla). */
export const FEFO_ORDER = sql`(config->>'expiryDate') nulls last, created_at, id`;

/** Süresi geçmemiş (ya da tarihsiz) parti koşulu. */
export const NOT_EXPIRED = sql`coalesce(nullif(config->>'expiryDate','')::date, 'infinity'::date) >= ${LOCAL_TODAY}`;

export async function localToday(tx: Tx): Promise<string> {
  const r = await tx.execute<{ d: string }>(sql`select ${LOCAL_TODAY}::text as d`);
  return r.rows[0]!.d;
}

/** Yeni parti için son kullanma tarihi: kaynak partiden devralınır, yoksa kart raf ömrü + belge tarihi; tanımsızsa null. */
export async function lotExpiryFor(tx: Tx, itemId: string, stockDocumentId: string | null, parentLotId: string | null): Promise<string | null> {
  if (parentLotId) {
    const r = await tx.execute<{ e: string | null }>(sql`select nullif(config->>'expiryDate','') as e from manufacturing_records where id=${parentLotId}::uuid and kind='lot'`);
    return r.rows[0]?.e ?? null;
  }
  if (!stockDocumentId) return null;
  const r = await tx.execute<{ e: string | null }>(
    sql`select (sd.doc_date + i.shelf_life_days)::text as e from stock_documents sd, items i where sd.id=${stockDocumentId}::uuid and i.id=${itemId}::uuid and i.shelf_life_days is not null`,
  );
  return r.rows[0]?.e ?? null;
}

type RiskRow = {
  lotId: string;
  code: string;
  status: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  warehouseId: string;
  warehouseName: string;
  expiryDate: string;
  daysLeft: number;
  quantity: string;
  unitCost: string | null;
  value: string;
};

export const expiryRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/inventory/expiry-risk',
    tenantRoute(app, { module: 'core.inventory', permission: 'inventory.read' }, async (c) => {
      const q = expiryRiskQuerySchema.parse(c.req.query);
      const rows = (
        await c.tx.execute<RiskRow>(sql`
          with lots as (
            select r.id, r.code, r.status, r.item_id, r.warehouse_id, nullif(r.config->>'expiryDate','')::date as expiry,
                   coalesce(r.config->>'remainingQty', r.config->>'quantity')::numeric as qty
            from manufacturing_records r
            where r.kind='lot' and r.status in ('available','quarantine') and nullif(r.config->>'expiryDate','') is not null
              ${q.warehouseId ? sql`and r.warehouse_id=${q.warehouseId}::uuid` : sql``}
          ), cost as (
            select m.item_id, case when sum(m.qty)=0 then null else sum(m.value)/sum(m.qty) end as unit
            from stock_movements m where m.item_id in (select item_id from lots) group by m.item_id
          )
          select l.id as "lotId", l.code, l.status, l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.unit,
                 l.warehouse_id as "warehouseId", w.name as "warehouseName", l.expiry::text as "expiryDate",
                 (l.expiry - ${LOCAL_TODAY})::int as "daysLeft", l.qty::text as quantity,
                 round(c.unit, 4)::text as "unitCost", round(coalesce(c.unit, 0) * l.qty, 2)::text as value
          from lots l
          join items i on i.id = l.item_id
          join warehouses w on w.id = l.warehouse_id
          left join cost c on c.item_id = l.item_id
          where l.qty > 0 and l.expiry <= ${LOCAL_TODAY} + ${q.horizonDays}::int
          order by l.expiry, i.code, l.code
          limit 1001`)
      ).rows;
      const lots = rows.slice(0, 1000).map((r) => ({ ...r, state: expiryState(r.daysLeft, q.criticalDays) }));
      const sum = (state: string) => {
        const list = lots.filter((l) => l.state === state);
        return { count: list.length, value: list.reduce((s, l) => s + Number(l.value), 0).toFixed(2) };
      };
      const unknown = (
        await c.tx.execute<{ n: number }>(
          sql`select count(*)::int as n from manufacturing_records r join items i on i.id=r.item_id where r.kind='lot' and r.status in ('available','quarantine') and i.shelf_life_days is not null and nullif(r.config->>'expiryDate','') is null and coalesce(r.config->>'remainingQty', r.config->>'quantity')::numeric > 0`,
        )
      ).rows[0]!.n;
      return {
        today: await localToday(c.tx),
        horizonDays: q.horizonDays,
        criticalDays: q.criticalDays,
        lots,
        truncated: rows.length > 1000,
        summary: { expired: sum('expired'), critical: sum('critical'), warning: sum('warning') },
        lotsWithoutExpiry: unknown,
      };
    }),
  );
};
