import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  isoDate,
  manufacturingPolicySchema,
  manufacturingResourceRulesSchema,
  operatorSkillSchema,
  todayIso,
  uuid,
  type ScheduledOperation,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { all, fail, one, type Row } from '../leather/common';
import { getRecord, listRecords, updateRecord } from './service';

/**
 * F7 planlama kuralları: kaynak hazırlık matrisi, gereken beceri ve saatlik maliyet (63, 64, 65, 72), operatör becerileri (65),
 * yakın dönem dondurma politikası (66) ve planlanan–gerçekleşen karşılaştırması (14).
 */

/** Operatör kaynağın gerektirdiği tüm becerilere bugün geçerli olarak sahip olmalı (öneri 65). */
export async function assertOperatorSkills(tx: Tx, userId: string, resource: Row) {
  const required: string[] = resource.config?.requiredSkills ?? resource.requiredSkills ?? [];
  if (!required.length) return;
  const held = await all(
    tx,
    sql`select skill from operator_skills where user_id=${userId}::uuid and (valid_until is null or valid_until >= ${todayIso()}::date)`,
  );
  const missing = required.filter((s) => !held.some((h) => h.skill === s));
  if (missing.length)
    throw fail(`Bu kaynakta çalışmak için geçerli beceri gerekli: ${missing.join(', ')}`, 'MANUFACTURING_SKILL_REQUIRED');
}

/** Kaynağın gerektirdiği becerilere sahip operatörler (iş ataması için). */
async function qualifiedOperators(tx: Tx, companyId: string, resourceId: string) {
  const resource = await getRecord(tx, resourceId, 'resource');
  const required: string[] = resource.config.requiredSkills ?? [];
  const users = await all(
    tx,
    sql`select u.id, u.full_name as name,
               coalesce(json_agg(json_build_object('skill', s.skill, 'level', s.level, 'validUntil', s.valid_until) order by s.skill) filter (where s.id is not null), '[]') as skills
          from memberships m join users u on u.id = m.user_id and u.is_active
          left join operator_skills s on s.user_id = u.id and (s.valid_until is null or s.valid_until >= ${todayIso()}::date)
         where m.company_id = ${companyId}
         group by u.id, u.full_name order by u.full_name`,
  );
  return {
    requiredSkills: required,
    operators: users
      .filter((u) => required.every((r) => (u.skills as { skill: string }[]).some((s) => s.skill === r)))
      .map((u) => ({ id: u.id, name: u.name, skills: u.skills })),
  };
}

interface PlanActualRow {
  scheduleId: string;
  scheduleCode: string;
  orderId: string;
  orderCode: string | null;
  operationKey: string;
  resourceId: string;
  plannedStart: string;
  plannedEnd: string;
  plannedMinutes: number;
  actualStart: string | null;
  actualEnd: string | null;
  actualMinutes: number;
  goodQty: number;
  scrapQty: number;
  status: 'not_started' | 'running' | 'done';
  startDelayMinutes: number | null;
  endDelayMinutes: number | null;
  late: boolean;
}

/**
 * Planlanan–gerçekleşen (öneri 14): yayımlanmış (ve yerine yenisi geçmiş) plan operasyonları, aynı emir/operasyondaki canlı
 * çalışma oturumlarıyla eşleştirilir. Gecikme pozitif dakikadır; başlamamış ve bitişi geçmiş iş gecikmiş sayılır.
 */
export async function planActual(tx: Tx, from: string, to: string) {
  const fromMs = Date.parse(from + 'T00:00:00Z');
  const toMs = Date.parse(to + 'T23:59:59Z');
  const plans = (await listRecords(tx, 'schedule')).filter((p) => p.status === 'published');
  const ops = plans.flatMap((p) =>
    ((p.operations ?? []) as ScheduledOperation[])
      .filter((o) => Date.parse(o.start) <= toMs && Date.parse(o.end) >= fromMs)
      .map((o) => ({ plan: p, op: o })),
  );
  const orderIds = [...new Set(ops.map((o) => o.op.orderId))];
  const sessions = orderIds.length
    ? await all(
        tx,
        sql`select order_id, status, config from manufacturing_records where kind='work_session' and order_id in (${sql.join(orderIds.map((i) => sql`${i}::uuid`), sql`, `)})`,
      )
    : [];
  const codes = orderIds.length
    ? await all(tx, sql`select id, code from leather_production_orders where id in (${sql.join(orderIds.map((i) => sql`${i}::uuid`), sql`, `)})`)
    : [];
  const now = Date.now();
  const rows: PlanActualRow[] = ops.map(({ plan, op }) => {
    const mine = sessions.filter((s) => s.order_id === op.orderId && s.config.operationKey === op.operationKey);
    const starts = mine.map((s) => Date.parse(s.config.startedAt)).filter((t) => !Number.isNaN(t));
    const running = mine.some((s) => s.status === 'running' || s.status === 'paused');
    const completed = mine.filter((s) => s.status === 'completed');
    const ends = completed.map((s) => Date.parse(s.config.endedAt)).filter((t) => !Number.isNaN(t));
    const actualStart = starts.length ? Math.min(...starts) : null;
    const actualEnd = completed.length && !running ? Math.max(...ends) : null;
    const status: PlanActualRow['status'] = actualEnd !== null ? 'done' : actualStart !== null ? 'running' : 'not_started';
    const plannedEnd = Date.parse(op.end);
    const minutes = (ms: number) => Math.round(ms / 60000);
    return {
      scheduleId: plan.id,
      scheduleCode: plan.code,
      orderId: op.orderId,
      orderCode: codes.find((c) => c.id === op.orderId)?.code ?? null,
      operationKey: op.operationKey,
      resourceId: op.resourceId,
      plannedStart: op.start,
      plannedEnd: op.end,
      plannedMinutes: op.minutes + (op.setupMinutes ?? 0),
      actualStart: actualStart === null ? null : new Date(actualStart).toISOString(),
      actualEnd: actualEnd === null ? null : new Date(actualEnd).toISOString(),
      actualMinutes: Math.round(mine.reduce((s, x) => s + Number(x.config.minutes ?? 0), 0)),
      goodQty: completed.reduce((s, x) => s + Number(x.config.goodQty ?? 0), 0),
      scrapQty: completed.reduce((s, x) => s + Number(x.config.scrapQty ?? 0), 0),
      status,
      startDelayMinutes: actualStart === null ? null : minutes(actualStart - Date.parse(op.start)),
      endDelayMinutes: actualEnd === null ? null : minutes(actualEnd - plannedEnd),
      late: actualEnd !== null ? actualEnd > plannedEnd : now > plannedEnd,
    };
  });
  rows.sort((a, b) => Date.parse(a.plannedStart) - Date.parse(b.plannedStart));
  const done = rows.filter((r) => r.status === 'done');
  const resources = new Map<string, { resourceId: string; plannedMinutes: number; actualMinutes: number; operations: number; late: number }>();
  for (const r of rows) {
    const agg = resources.get(r.resourceId) ?? { resourceId: r.resourceId, plannedMinutes: 0, actualMinutes: 0, operations: 0, late: 0 };
    agg.operations++;
    agg.plannedMinutes += r.plannedMinutes;
    agg.actualMinutes += r.actualMinutes;
    if (r.late) agg.late++;
    resources.set(r.resourceId, agg);
  }
  return {
    from,
    to,
    rows,
    resources: [...resources.values()],
    summary: {
      operations: rows.length,
      done: done.length,
      onTime: done.filter((r) => !r.late).length,
      onTimePct: done.length ? Math.round((done.filter((r) => !r.late).length / done.length) * 1000) / 10 : null,
      late: rows.filter((r) => r.late).length,
      plannedMinutes: done.reduce((s, r) => s + r.plannedMinutes, 0),
      actualMinutes: done.reduce((s, r) => s + r.actualMinutes, 0),
    },
  };
}

export const manufacturingPlanningRulesRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'manufacturing.planning', permission: 'manufacturing.planning.read' as never };
  const manage = { module: 'manufacturing.planning', permission: 'manufacturing.planning.manage' as never };
  const approve = { module: 'manufacturing.planning', permission: 'manufacturing.planning.approve' as never };
  const id = (c: TenantCtx) => z.object({ id: uuid }).parse(c.req.params).id;

  app.put(
    '/api/manufacturing/resources/:id/rules',
    tenantRoute(app, manage, async (c) => {
      const r = await getRecord(c.tx, id(c), 'resource', true);
      const rules = manufacturingResourceRulesSchema.parse(c.req.body);
      if (r.config.type === 'tool' && (rules.setupMatrix.length || rules.defaultSetupMinutes || rules.requiredSkills.length))
        throw fail('Kalıp/takım kaynağında hazırlık ve beceri kuralı tanımlanmaz');
      return { record: await updateRecord(c.tx, r.id, r.status, { ...r.config, ...rules }) };
    }),
  );
  app.get('/api/manufacturing/planning/operators', tenantRoute(app, read, async (c) => ({
    operators: await all(c.tx, sql`select u.id, u.full_name as name from memberships m join users u on u.id = m.user_id and u.is_active where m.company_id = ${c.company.id} order by u.full_name`),
  })));
  app.get('/api/manufacturing/resources/:id/qualified-operators', tenantRoute(app, read, async (c) => qualifiedOperators(c.tx, c.company.id, id(c))));

  app.get('/api/manufacturing/planning/policy', tenantRoute(app, read, async (c) => {
    const [row] = await all(c.tx, sql`select freeze_hours from manufacturing_policies`);
    return { freezeHours: Number(row?.freeze_hours ?? 0) };
  }));
  app.put('/api/manufacturing/planning/policy', tenantRoute(app, approve, async (c) => {
    const input = manufacturingPolicySchema.parse(c.req.body);
    await c.tx.execute(sql`insert into manufacturing_policies(company_id, freeze_hours, updated_by) values (${c.company.id}, ${input.freezeHours}, ${c.user.id})
      on conflict (company_id) do update set freeze_hours = excluded.freeze_hours, updated_by = excluded.updated_by, updated_at = now()`);
    return input;
  }));

  app.get('/api/manufacturing/operator-skills', tenantRoute(app, read, async (c) => ({
    skills: await all(
      c.tx,
      sql`select s.id, s.user_id as "userId", u.full_name as "userName", s.skill, s.level, s.valid_until::text as "validUntil", s.note,
                 (s.valid_until is not null and s.valid_until < ${todayIso()}::date) as expired
            from operator_skills s join users u on u.id = s.user_id order by u.full_name, s.skill`,
    ),
  })));
  app.put('/api/manufacturing/operator-skills', tenantRoute(app, manage, async (c) => {
    const input = operatorSkillSchema.parse(c.req.body);
    await one(c.tx, sql`select user_id from memberships where company_id=${c.company.id} and user_id=${input.userId}::uuid`, 'Operatör');
    const row = await one(
      c.tx,
      sql`insert into operator_skills(id, company_id, user_id, skill, level, valid_until, note, updated_by)
          values (gen_random_uuid(), ${c.company.id}, ${input.userId}::uuid, ${input.skill}, ${input.level}, ${input.validUntil ?? null}, ${input.note ?? null}, ${c.user.id})
          on conflict (company_id, user_id, skill) do update set level = excluded.level, valid_until = excluded.valid_until, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
          returning id`,
    );
    return { id: row.id };
  }));
  app.delete('/api/manufacturing/operator-skills/:id', tenantRoute(app, manage, async (c) => {
    const r = await c.tx.execute(sql`delete from operator_skills where id = ${id(c)}::uuid returning id`);
    if (!r.rows.length) throw fail('Beceri kaydı bulunamadı');
    return { ok: true };
  }));

  app.get('/api/manufacturing/reports/plan-actual', tenantRoute(app, read, async (c) => {
    const q = z
      .object({ from: isoDate, to: isoDate })
      .refine((v) => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000, 'Geçerli tarih aralığı gerekli')
      .parse(c.req.query);
    return planActual(c.tx, q.from, q.to);
  }));
};
