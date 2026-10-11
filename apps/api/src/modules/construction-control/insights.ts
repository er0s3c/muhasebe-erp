import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { WORKFLOW_PAYLOADS, criticalPath, dec, levelCrews, readinessStatus, todayIso, type CalendarActivity } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest } from '../../http/errors';
import { requireRecord } from '../workspace/records';

/**
 * F9 Proje 360 kararları: iş cephesi hazırlığı (84), ekip dengeleme önerisi (87), değişiklik etki dosyası (16) ve
 * taşeron ölçüm/kabul farkı (88). Hepsi okuma uçlarıdır; programı ya da hakedişi değiştirmez.
 */

const read = { module: 'construction.projects', permission: 'projects.read' } as const;
const projectQuery = z.object({ projectId: z.uuid() });
const dayDiff = (from: string, to: string) => Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000);

async function program(c: TenantCtx, projectId: string) {
  await requireRecord(c, 'project', projectId);
  const ops = await c.tx.execute<{ id: string; title: string; version: number; wbsId: string | null; payload: CalendarActivity }>(
    sql`select id,title,version,payload->>'wbsId' as "wbsId",payload from operation_entries where project_id=${projectId}::uuid and kind='schedule' and status<>'cancelled' order by event_date limit 2000`,
  );
  const calendars = await c.tx.execute<{ payload: Record<string, unknown> }>(
    sql`select payload from construction_workflows where project_id=${projectId}::uuid and kind='calendar' and status='approved' order by created_at desc limit 1`,
  );
  const calendar = calendars.rows[0] ? WORKFLOW_PAYLOADS.calendar.parse(calendars.rows[0].payload) : { weekdays: [1, 2, 3, 4, 5], holidays: [] as string[], crews: [] as { name: string; size: number }[] };
  try {
    return { calendar, result: criticalPath(ops.rows.map((x) => ({ ...x.payload, id: x.id, title: x.title, wbsId: x.wbsId })), calendar.weekdays, calendar.holidays) };
  } catch (e) {
    throw badRequest((e as Error).message);
  }
}

/** Üç haftalık iş cephesi hazırlığı (öneri 84): başlayacak işlerin hazırlık kısıtları, kritiklik ve risk. */
async function lookahead(c: TenantCtx, projectId: string, days: number) {
  const { result } = await program(c, projectId);
  const today = todayIso();
  const horizon = new Date(today + 'T12:00:00Z');
  horizon.setUTCDate(horizon.getUTCDate() + days);
  const until = horizon.toISOString().slice(0, 10);
  const readiness = await c.tx.execute<{ id: string; payload: Record<string, unknown>; created_at: string; owner: string | null }>(
    sql`select w.id, w.payload, w.created_at::text, u.full_name as owner from construction_workflows w left join users u on u.id = w.owner_id
         where w.project_id=${projectId}::uuid and w.kind='readiness' and w.status in ('approved','closed') order by w.created_at desc`,
  );
  const rows = result.activities
    .filter((a) => a.progress < 100 && a.computedStart <= until && a.computedEnd >= today)
    .map((a) => {
      const rec = readiness.rows.find((r) => r.payload.activityId === a.id) ?? null;
      const state = readinessStatus(rec?.payload);
      const startsInDays = dayDiff(today, a.computedStart);
      return {
        activityId: a.id,
        title: a.title,
        start: a.computedStart,
        end: a.computedEnd,
        critical: a.critical,
        slack: a.slack,
        crew: a.crew ?? null,
        startsInDays,
        status: state.status,
        missing: state.missing,
        blocker: rec ? String(rec.payload.blocker ?? '') : '',
        readinessId: rec?.id ?? null,
        owner: rec?.owner ?? null,
        // Yakında başlayacak, hazır olmayan iş risklidir; kritikse program gecikir
        atRisk: state.status !== 'ready' && startsInDays <= 7,
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start) || Number(b.critical) - Number(a.critical));
  return {
    from: today,
    until,
    activities: rows,
    summary: {
      total: rows.length,
      ready: rows.filter((r) => r.status === 'ready').length,
      blocked: rows.filter((r) => r.status === 'blocked').length,
      unknown: rows.filter((r) => r.status === 'unknown').length,
      criticalAtRisk: rows.filter((r) => r.atRisk && r.critical).length,
    },
  };
}

/** Değişiklik etki dosyası (öneri 16): onaylı değişiklikler kesin, onay bekleyenler olası etki olarak ayrılır. */
async function changeImpact(c: TenantCtx, projectId: string) {
  await requireRecord(c, 'project', projectId);
  const rows = await c.tx.execute<{ id: string; title: string; status: string; payload: Record<string, unknown>; linked_id: string | null; variation_status: string | null; variation_code: string | null; created_at: string }>(
    sql`select w.id, w.title, w.status, w.payload, w.linked_id, v.status as variation_status, v.code as variation_code, w.created_at::text
          from construction_workflows w left join variation_orders v on w.linked_kind = 'variation_order' and v.id = w.linked_id
         where w.project_id=${projectId}::uuid and w.kind='change_event' and w.status not in ('cancelled','rejected')
         order by w.created_at`,
  );
  const items = rows.rows.map((r) => {
    const p = WORKFLOW_PAYLOADS.change_event.parse(r.payload);
    const firm = ['approved', 'closed'].includes(r.status);
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      firm,
      reason: p.reason,
      currency: p.currency,
      cost: dec(p.costImpact).toFixed(2),
      revenue: dec(p.revenueImpact).toFixed(2),
      margin: dec(p.revenueImpact).minus(p.costImpact).toFixed(2),
      days: p.days,
      variationCode: r.variation_code,
      variationStatus: r.variation_status,
      // Gelir etkisi işverene yansıtılmadıkça (onaylı değişiklik + taşeron değişiklik emri) tahsilat beklenmez
      collectible: firm && dec(p.revenueImpact).gt(0),
    };
  });
  const totals = new Map<string, { currency: string; firmCost: string; firmRevenue: string; firmMargin: string; pendingCost: string; pendingRevenue: string; firmDays: number; pendingDays: number }>();
  for (const i of items) {
    const t = totals.get(i.currency) ?? { currency: i.currency, firmCost: '0', firmRevenue: '0', firmMargin: '0', pendingCost: '0', pendingRevenue: '0', firmDays: 0, pendingDays: 0 };
    if (i.firm) {
      t.firmCost = dec(t.firmCost).plus(i.cost).toFixed(2);
      t.firmRevenue = dec(t.firmRevenue).plus(i.revenue).toFixed(2);
      t.firmMargin = dec(t.firmRevenue).minus(t.firmCost).toFixed(2);
      t.firmDays += i.days;
    } else {
      t.pendingCost = dec(t.pendingCost).plus(i.cost).toFixed(2);
      t.pendingRevenue = dec(t.pendingRevenue).plus(i.revenue).toFixed(2);
      t.pendingDays += i.days;
    }
    totals.set(i.currency, t);
  }
  return { items, totals: [...totals.values()] };
}

/** Taşeron ölçüm/kabul farkı (öneri 88): beyan edilen, ölçümle kabul edilen ve hakedişe aktarılan üretim. */
async function measurementDiffs(c: TenantCtx, projectId: string) {
  await requireRecord(c, 'project', projectId);
  const rows = await c.tx.execute<{ id: string; title: string; status: string; payload: Record<string, unknown>; computed: Record<string, unknown>; transferred: string; subcontract_code: string | null }>(
    sql`select w.id, w.title, w.status, w.payload, w.computed,
               coalesce((select sum(a.quantity) from construction_production_allocations a join progress_payments pp on pp.id = a.payment_id where a.production_id = w.id and pp.status <> 'cancelled'), 0)::text as transferred,
               s.code as subcontract_code
          from construction_workflows w left join subcontracts s on s.id = (w.payload->>'subcontractId')::uuid
         where w.project_id=${projectId}::uuid and w.kind='production' and w.status in ('approved','closed')
         order by w.created_at`,
  );
  const items = rows.rows.map((r) => {
    const claimed = dec(String(r.payload.quantity));
    const accepted = dec(String(r.computed.acceptedQuantity ?? r.payload.quantity));
    return {
      id: r.id,
      title: r.title,
      subcontractCode: r.subcontract_code,
      unit: String(r.payload.unit ?? ''),
      date: String(r.payload.date ?? ''),
      claimed: claimed.toFixed(4),
      accepted: accepted.toFixed(4),
      difference: claimed.minus(accepted).toFixed(4),
      note: (r.computed.acceptanceNote as string | undefined) ?? null,
      transferred: dec(r.transferred).toFixed(4),
      remaining: accepted.minus(r.transferred).toFixed(4),
    };
  });
  return { items, withDifference: items.filter((i) => !dec(i.difference).isZero()).length };
}

export const constructionInsightRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/construction/lookahead',
    tenantRoute(app, read, async (c) => {
      const q = projectQuery.extend({ days: z.coerce.number().int().min(1).max(90).default(21) }).parse(c.req.query);
      return lookahead(c, q.projectId, q.days);
    }),
  );
  app.get(
    '/api/construction/program/leveling',
    tenantRoute(app, read, async (c) => {
      const { projectId } = projectQuery.parse(c.req.query);
      const { calendar, result } = await program(c, projectId);
      const crews = 'crews' in calendar ? calendar.crews : [];
      return { crews, ...levelCrews(result.activities, crews, calendar.weekdays, calendar.holidays) };
    }),
  );
  app.get('/api/construction/change-impact', tenantRoute(app, read, async (c) => changeImpact(c, projectQuery.parse(c.req.query).projectId)));
  app.get('/api/construction/measurement-diffs', tenantRoute(app, read, async (c) => measurementDiffs(c, projectQuery.parse(c.req.query).projectId)));
};
