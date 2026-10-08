import { sql } from 'drizzle-orm';
import { estimateProductionDuration, todayIso } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, type Row } from '../leather/common';
import { getProduction } from '../leather/production';
import { listRecords } from './service';

export async function productionEstimates(tx: Tx, orderId: string) {
  const order = await getProduction(tx, orderId);
  const today = todayIso();
  const samples = await all(
    tx,
    sql`select d.date::text as date,d.order_id,d.config,q.status as quality_status,q.passed_qty as rework_good from leather_production_documents d
    join leather_production_orders o on o.id=d.order_id and o.company_id=d.company_id
    left join leather_quality_checks q on q.id=nullif(d.config->>'qualityCheckId','')::uuid and q.company_id=d.company_id
    where d.kind='operation' and o.item_id=${order.itemId}::uuid and o.revision_id=${order.revisionId}::uuid
      and o.status<>'cancelled' and d.date between ${today}::date-90 and ${today}::date order by d.date desc,d.id limit 5000`,
  );
  const grouped = new Map<string, { date: string; config: Row }>();
  for (const sample of samples) {
    const key = [sample.order_id, sample.config.key, sample.config.resourceId].join(':');
    const existing = grouped.get(key) ?? {
      date: sample.date,
      config: {
        key: sample.config.key,
        resourceId: sample.config.resourceId,
        minutes: 0,
        goodQty: 0,
      },
    };
    existing.config.minutes += Number(sample.config.minutes ?? 0);
    existing.config.goodQty += Number(
      sample.config.rework
        ? sample.quality_status === 'approved'
          ? sample.rework_good
          : 0
        : (sample.config.goodQty ?? 0),
    );
    if (sample.date > existing.date) existing.date = sample.date;
    grouped.set(key, existing);
  }
  const resources = (await listRecords(tx, 'resource')).filter((r) => r.status === 'active');
  return {
    orderId,
    orderCode: order.code,
    asOf: today,
    operations: order.operations.map((op: Row) => ({
      operationKey: op.key,
      name: op.name,
      remainingQty: Math.max(0, Number(order.quantity) - Number(op.goodQty ?? 0)),
      resources: resources
        .filter(
          (r) => !op.resources?.length || op.resources.some((v: Row) => v.resourceId === r.id),
        )
        .map((resource) => ({
          resourceId: resource.id,
          resourceName: resource.name,
          ...estimateProductionDuration(
            [...grouped.values()]
              .filter((s) => s.config.key === op.key && s.config.resourceId === resource.id)
              .map((s) => ({
                date: s.date,
                minutes: Number(s.config.minutes),
                goodQty: Number(s.config.goodQty),
              })),
            Number(
              op.resources?.find((r: Row) => r.resourceId === resource.id)?.minutesPerUnit ??
                op.plannedMinutes ??
                0,
            ),
            Math.max(0, Number(order.quantity) - Number(op.goodQty ?? 0)),
            today,
          ),
        })),
    })),
  };
}
