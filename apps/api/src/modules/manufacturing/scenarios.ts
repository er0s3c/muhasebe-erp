import { finiteManufacturingSchedule, type ScheduledOperation } from '@erp/shared';
import type { Tx } from '../../db/client';
import { type LeatherCtx, type Row, fail } from '../leather/common';
import { command } from './commands';
import { createRecord, getRecord, listRecords, recordShape } from './service';

export async function scenario(tx: Tx, ctx: LeatherCtx, input: Row & { requestKey: string }) {
  return command(tx, ctx, 'scenario', input, async () => {
    const parent = await getRecord(tx, input.parentId, 'schedule');
    const resources = (await listRecords(tx, 'resource')).filter((r) => r.status === 'active');
    if (
      new Set(input.resourceOverrides.map((r: Row) => r.resourceId)).size !==
      input.resourceOverrides.length
    )
      throw fail('Kaynak varsayımları benzersiz olmalı');
    for (const override of input.resourceOverrides) {
      if (!resources.some((r) => r.id === override.resourceId))
        throw fail('Varsayım için aktif kaynak gerekli');
    }
    const jobs = parent.config.jobs.map((j: Row) => {
      const override = input.resourceOverrides.find((r: Row) => r.resourceId === j.resourceId);
      return {
        ...j,
        minutes: override ? Math.ceil(Number(j.minutes) / override.speedFactor) : j.minutes,
      };
    });
    for (const override of input.calendarOverrides) {
      await getRecord(tx, override.resourceId, 'resource');
      if (override.start >= override.end) throw fail('Takvim varsayımı geçerli aralıkta olmalı');
    }
    const calendars = (await listRecords(tx, 'calendar')).filter((r) => r.status === 'active');
    const schedules = (await listRecords(tx, 'schedule')).filter(
      (r) => r.status === 'published' && r.id !== parent.id,
    );
    const operations = finiteManufacturingSchedule(
      jobs,
      [...calendars, ...input.calendarOverrides] as never,
      input.anchor ?? parent.config.anchor,
      parent.config.direction,
      Object.fromEntries(
        resources.map((r) => [
          r.id,
          input.resourceOverrides.find((o: Row) => o.resourceId === r.id)?.capacity ?? r.capacity,
        ]),
      ),
      schedules.flatMap((r) => r.operations ?? []) as ScheduledOperation[],
    );
    const differences = operations.map((op) => ({
      orderId: op.orderId,
      operationKey: op.operationKey,
      previousStart: parent.config.operations.find(
        (p: Row) => p.orderId === op.orderId && p.operationKey === op.operationKey,
      )?.start,
      previousEnd: parent.config.operations.find(
        (p: Row) => p.orderId === op.orderId && p.operationKey === op.operationKey,
      )?.end,
      start: op.start,
      end: op.end,
    }));
    return createRecord(
      tx,
      ctx,
      'schedule',
      {
        ...parent.config,
        code: undefined,
        parentId: parent.id,
        version: Number(parent.config.version ?? 1) + 1,
        reason: input.reason,
        anchor: input.anchor ?? parent.config.anchor,
        calendarOverrides: input.calendarOverrides,
        resourceOverrides: input.resourceOverrides,
        jobs,
        scenarioCost: input.resourceOverrides.some((r: Row) => r.hourlyCost !== undefined)
          ? jobs.reduce(
              (sum: number, j: Row) =>
                sum +
                (Number(j.minutes) / 60) *
                  Number(
                    input.resourceOverrides.find((r: Row) => r.resourceId === j.resourceId)
                      ?.hourlyCost ?? 0,
                  ),
              0,
            )
          : null,
        operations,
        differences,
        previewOnly:
          Boolean(parent.config.previewOnly) ||
          input.calendarOverrides.length > 0 ||
          input.resourceOverrides.length > 0,
      },
      'draft',
    );
  });
}
export async function calendarTemplate(
  tx: Tx,
  ctx: LeatherCtx,
  input: Row & { requestKey: string },
) {
  return command(tx, ctx, 'calendar-template', input, async () => {
    await getRecord(tx, input.resourceId, 'resource');
    const records = [];
    for (
      let t = Date.parse(input.from + 'T00:00:00Z');
      t <= Date.parse(input.to + 'T00:00:00Z');
      t += 86400000
    ) {
      const date = new Date(t).toISOString().slice(0, 10);
      if (!input.weekdays.includes(new Date(t).getUTCDay())) continue;
      records.push(
        await createRecord(
          tx,
          ctx,
          'calendar',
          {
            resourceId: input.resourceId,
            start: new Date(date + 'T' + input.startTime + ':00' + input.utcOffset).toISOString(),
            end: new Date(date + 'T' + input.endTime + ':00' + input.utcOffset).toISOString(),
            available: !input.holidays.includes(date),
            reason: input.holidays.includes(date) ? 'holiday' : 'shift',
            templateRequestKey: input.requestKey,
          },
          'active',
        ),
      );
    }
    return { records };
  });
}
export async function planHistory(tx: Tx, id: string) {
  const record = await getRecord(tx, id, 'schedule');
  const plans = await listRecords(tx, 'schedule');
  const related = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const plan of plans)
      if (related.has(plan.id) || related.has(plan.parentId)) {
        for (const key of [plan.id, plan.parentId].filter(Boolean))
          if (!related.has(key)) {
            related.add(key);
            changed = true;
          }
      }
  }
  const history = plans.filter((r) => related.has(r.id));
  return { record: recordShape(record), history };
}
