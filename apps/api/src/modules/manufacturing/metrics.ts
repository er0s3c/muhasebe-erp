import { sql } from 'drizzle-orm';
import { dec } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, type Row } from '../leather/common';
import { listRecords } from './service';

type Interval = { start: string; end?: string | null };
function minutes(intervals: Interval[], from: number, to: number) {
  const ranges = intervals
    .map(
      (i) =>
        [
          Math.max(from, Date.parse(i.start)),
          Math.min(to, i.end ? Date.parse(i.end) : to),
        ] as const,
    )
    .filter((i) => i[1] > i[0])
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    start = 0,
    end = 0;
  for (const r of ranges) {
    if (r[0] > end) {
      total += end - start;
      start = r[0];
      end = r[1];
    } else end = Math.max(end, r[1]);
  }
  return (total + end - start) / 60000;
}
function withinShifts(blocks: Interval[], shifts: Interval[], from: number, to: number) {
  return minutes(
    blocks
      .flatMap((b) =>
        shifts.map((s) => ({
          start: new Date(Math.max(Date.parse(b.start), Date.parse(s.start))).toISOString(),
          end: new Date(
            Math.min(b.end ? Date.parse(b.end) : to, s.end ? Date.parse(s.end) : to),
          ).toISOString(),
        })),
      )
      .filter((r) => r.start < r.end),
    from,
    to,
  );
}
export async function manufacturingMetrics(tx: Tx, from: string, to: string) {
  const start = Date.parse(from + 'T00:00:00Z'),
    end = Date.parse(to + 'T23:59:59Z'),
    asOf = Math.min(end, Date.now());
  const resources = await listRecords(tx, 'resource'),
    calendars = (await listRecords(tx, 'calendar')).filter((c) => c.status === 'active'),
    maintenance = await listRecords(tx, 'maintenance');
  const operations = await all(
    tx,
    sql`select d.config,o.config as recipe from leather_production_documents d join leather_production_orders o on o.id=d.order_id where d.kind='operation' and d.date between ${from}::date and ${to}::date`,
  );
  return resources.map((r) => {
    const shifts = calendars.filter((c) => c.resourceId === r.id && c.available);
    const planned = minutes(shifts as never, start, end);
    const unavailable = calendars.filter((c) => c.resourceId === r.id && !c.available);
    const stopped = withinShifts(unavailable as never, shifts as never, start, asOf);
    const failures = maintenance.filter(
      (m) =>
        m.resourceId === r.id &&
        m.kind === 'breakdown' &&
        m.status !== 'cancelled' &&
        Date.parse(String(m.start)) < asOf &&
        (m.end ? Date.parse(String(m.end)) : asOf) > start,
    );
    const downtime = withinShifts(failures as never, shifts as never, start, asOf);
    const repaired = failures.filter((m) => m.status === 'completed');
    const repairedDowntime = repaired.reduce(
      (total, failure) => total + withinShifts([failure] as never, shifts as never, start, asOf),
      0,
    );
    const actual = operations.filter((o) => o.config.resourceId === r.id);
    const totalQty = actual.reduce((s, o) => s.plus(o.config.quantity ?? 0), dec(0)),
      good = actual.reduce((s, o) => s.plus(o.config.goodQty ?? 0), dec(0)),
      run = actual.reduce((s, o) => s.plus(o.config.minutes ?? 0), dec(0));
    const standard = actual.reduce((s, o) => {
      const op = o.recipe.operations?.find((p: Row) => p.key === o.config.key);
      return s.plus(dec(op?.plannedMinutes ?? 0).times(o.config.quantity ?? 0));
    }, dec(0));
    const availability =
      planned > 0 ? Math.max(0, (planned - Math.min(planned, stopped)) / planned) : null;
    const performance = run.gt(0) ? Math.min(1, standard.div(run).toNumber()) : null;
    const quality = totalQty.gt(0) ? good.div(totalQty).toNumber() : null;
    return {
      resourceId: r.id,
      name: r.name,
      plannedMinutes: planned,
      downtimeMinutes: downtime,
      mttrMinutes: repaired.length ? repairedDowntime / repaired.length : null,
      mtbfMinutes: failures.length ? Math.max(0, planned - stopped) / failures.length : null,
      availability,
      performance,
      quality,
      oee:
        availability !== null && performance !== null && quality !== null
          ? availability * performance * quality
          : null,
      source: actual.length ? 'actual' : 'no_actual_data',
    };
  });
}
