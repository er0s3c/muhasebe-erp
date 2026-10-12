import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import {
  addDaysIso,
  idParam,
  obligationCalendarQuerySchema,
  obligationCompletionSchema,
  obligationPeriods,
  obligationSchema,
  obligationState,
  obligationUpdateSchema,
  todayIso,
  type ObligationInput,
  type ObligationState,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, notFound } from '../../http/errors';

/** Düzenli mali yükümlülük takvimi (öneri 57); açıklama için bkz. packages/shared/src/obligations.ts. */
const read = { module: 'core.treasury', permission: 'treasury.read' } as const;
const manage = { module: 'core.treasury', permission: 'treasury.manage' } as const;
/** Takvim ve projeksiyon geçmişe en çok bu kadar gün bakar (kapatılmamış gecikmiş dönemler). */
const OVERDUE_LOOKBACK_DAYS = 180;

interface ObligationRow extends Record<string, unknown> {
  id: string;
  title: string;
  category: string;
  config: ObligationInput;
  active: boolean;
  version: number;
  createdAt: string;
}
export interface ObligationPeriod {
  obligationId: string;
  title: string;
  category: string;
  periodDate: string;
  dueDate: string;
  amount: string | null;
  currency: string;
  amountKind: 'fixed' | 'estimated';
  responsibleUserId: string | null;
  state: ObligationState;
  completion: { status: 'done' | 'skipped'; paidAmount: string | null; note: string; completedAt: string } | null;
}

async function loadObligations(tx: Tx, onlyActive: boolean) {
  return (
    await tx.execute<ObligationRow>(
      sql`select id,title,category,config,active,version,created_at as "createdAt" from financial_obligations ${onlyActive ? sql`where active` : sql``} order by active desc,title`,
    )
  ).rows;
}

/**
 * [from, to] aralığındaki dönemler; `withOverdue` ise bugünden önceki kapatılmamış dönemler de (en çok 180 gün geriye)
 * eklenir. Tamamlama kayıtları dönem anahtarıyla birleştirilir.
 */
export async function obligationCalendar(tx: Tx, from: string, to: string, today: string, withOverdue: boolean): Promise<ObligationPeriod[]> {
  const rows = await loadObligations(tx, true);
  if (!rows.length) return [];
  const start = withOverdue ? [from, addDaysIso(today, -OVERDUE_LOOKBACK_DAYS)].sort()[0]! : from;
  const completions = (
    await tx.execute<{ obligation_id: string; period_date: string; status: 'done' | 'skipped'; paid_amount: string | null; note: string; completed_at: string }>(
      sql`select obligation_id,period_date::text,status,paid_amount,note,completed_at::text from obligation_completions where period_date between ${addDaysIso(start, -3)}::date and ${to}::date`,
    )
  ).rows;
  const done = new Map(completions.map((c) => [`${c.obligation_id}:${c.period_date}`, c]));
  const out: ObligationPeriod[] = [];
  for (const o of rows) {
    const cfg = o.config;
    for (const p of obligationPeriods(cfg.recurrence, cfg.weekendRule, start, to)) {
      const c = done.get(`${o.id}:${p.periodDate}`) ?? null;
      const state = obligationState(p.dueDate, today, cfg.leadDays, c?.status ?? null);
      // Aralık öncesi yalnız açık gecikmiş dönemler gösterilir
      if (p.dueDate < from && state !== 'overdue') continue;
      out.push({
        obligationId: o.id,
        title: o.title,
        category: o.category,
        ...p,
        amount: cfg.amount,
        currency: cfg.currency,
        amountKind: cfg.amountKind,
        responsibleUserId: cfg.responsibleUserId,
        state,
        completion: c ? { status: c.status, paidAmount: c.paid_amount, note: c.note, completedAt: c.completed_at } : null,
      });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title, 'tr'));
}

async function validate(c: TenantCtx, input: ObligationInput) {
  if (input.responsibleUserId) {
    const member = (await c.tx.execute(sql`select 1 from memberships where company_id=${c.company.id}::uuid and user_id=${input.responsibleUserId}::uuid and is_active`)).rows[0];
    if (!member) throw badRequest('Sorumlu kişi şirket üyesi olmalı.', 'OBLIGATION_RESPONSIBLE');
  }
}
async function obligation(c: TenantCtx, id: string, lock = false) {
  const row = (
    await c.tx.execute<ObligationRow>(
      sql`select id,title,category,config,active,version,created_at as "createdAt" from financial_obligations where id=${id}::uuid ${lock ? sql`for update` : sql``}`,
    )
  ).rows[0];
  if (!row) throw notFound('Yükümlülük');
  return row;
}

export const obligationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/obligations', tenantRoute(app, read, async (c) => ({ obligations: await loadObligations(c.tx, false) })));
  app.post(
    '/api/obligations',
    tenantRoute(app, manage, async (c) => {
      const input = obligationSchema.parse(c.req.body);
      await validate(c, input);
      const id = uuidv7();
      await c.tx.execute(
        sql`insert into financial_obligations(id,company_id,title,category,config,created_by) values(${id},${c.company.id},${input.title},${input.category},${JSON.stringify(input)}::jsonb,${c.user.id})`,
      );
      void c.reply.code(201);
      return { obligation: await obligation(c, id) };
    }),
  );
  app.put(
    '/api/obligations/:id',
    tenantRoute(app, manage, async (c) => {
      const id = idParam.parse(c.req.params).id,
        { config, version } = obligationUpdateSchema.parse(c.req.body);
      const row = await obligation(c, id, true);
      if (row.version !== version) throw conflict('Yükümlülük başka biri tarafından değiştirildi; yenileyin.');
      await validate(c, config);
      await c.tx.execute(
        sql`update financial_obligations set title=${config.title},category=${config.category},config=${JSON.stringify(config)}::jsonb,version=version+1,updated_at=now() where id=${id}::uuid`,
      );
      return { obligation: await obligation(c, id) };
    }),
  );
  app.patch(
    '/api/obligations/:id/active',
    tenantRoute(app, manage, async (c) => {
      const id = idParam.parse(c.req.params).id,
        { active, version } = z.object({ active: z.boolean(), version: z.number().int().positive() }).parse(c.req.body);
      const row = await obligation(c, id, true);
      if (row.version !== version) throw conflict('Yükümlülük başka biri tarafından değiştirildi; yenileyin.');
      await c.tx.execute(sql`update financial_obligations set active=${active},version=version+1,updated_at=now() where id=${id}::uuid`);
      return { obligation: await obligation(c, id) };
    }),
  );
  app.get(
    '/api/obligations/calendar',
    tenantRoute(app, read, async (c) => {
      const q = obligationCalendarQuerySchema.parse(c.req.query);
      const today = todayIso(new Date(), c.company.timeZone);
      const periods = await obligationCalendar(c.tx, q.from, q.to, today, true);
      // Tutarlar para birimi bazında toplanır (kur çevrimi nakit projeksiyonunda yapılır)
      const summary = Object.fromEntries(
        (['overdue', 'due_soon', 'upcoming', 'done', 'skipped'] as const).map((state) => {
          const list = periods.filter((p) => p.state === state);
          const byCurrency: Record<string, string> = {};
          for (const p of list) if (p.amount) byCurrency[p.currency] = (Number(byCurrency[p.currency] ?? 0) + Number(p.amount)).toFixed(2);
          return [state, { count: list.length, byCurrency }];
        }),
      );
      return { today, from: q.from, to: q.to, periods, summary };
    }),
  );
  app.post(
    '/api/obligations/:id/complete',
    tenantRoute(app, manage, async (c) => {
      const id = idParam.parse(c.req.params).id,
        input = obligationCompletionSchema.parse(c.req.body);
      const row = await obligation(c, id, true);
      const cfg = row.config;
      // Dönem anahtarı kuralın ürettiği bir tarih olmalı
      const valid = obligationPeriods(cfg.recurrence, 'none', input.periodDate, input.periodDate).some((p) => p.periodDate === input.periodDate);
      if (!valid) throw badRequest('Bu tarih yükümlülüğün bir dönemi değil.', 'OBLIGATION_PERIOD');
      const today = todayIso(new Date(), c.company.timeZone);
      if (input.status === 'done' && input.periodDate > addDaysIso(today, 60))
        throw badRequest('60 günden ileri bir dönem ödendi olarak işaretlenemez.', 'OBLIGATION_PERIOD');
      const inserted = (
        await c.tx.execute(
          sql`insert into obligation_completions(id,company_id,obligation_id,period_date,status,paid_amount,note,completed_by) values(${uuidv7()},${c.company.id},${id},${input.periodDate},${input.status},${input.paidAmount},${input.note},${c.user.id}) on conflict (obligation_id,period_date) do nothing returning id`,
        )
      ).rows[0];
      if (!inserted) throw conflict('Bu dönem zaten işaretlenmiş.', 'OBLIGATION_ALREADY_DONE');
      void c.reply.code(201);
      return { ok: true };
    }),
  );
  app.delete(
    '/api/obligations/:id/completions/:periodDate',
    tenantRoute(app, manage, async (c) => {
      const { id, periodDate } = z.object({ id: z.uuid(), periodDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(c.req.params);
      await obligation(c, id, true);
      const removed = (await c.tx.execute(sql`delete from obligation_completions where obligation_id=${id}::uuid and period_date=${periodDate}::date returning id`)).rows[0];
      if (!removed) throw notFound('Dönem işareti');
      return { ok: true };
    }),
  );
};
