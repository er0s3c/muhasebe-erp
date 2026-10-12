import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { fiscalPeriods, periodCloseTasks, users } from '../../db/schema';
import type { Tx } from '../../db/client';
import { tenantRoute } from '../../http/context';
import { notFound, unprocessable } from '../../http/errors';
import { trialBalance } from '../ledger/reports';

/** Elle tamamlanan standart kapanış görevleri (otomatik denetlenemeyen işler). */
export const CLOSE_TASKS = [
  { key: 'bank_statements', label: 'Tüm banka ekstreleri alındı ve mutabakatı yapıldı' },
  { key: 'depreciation', label: 'Dönem amortismanı kaydedildi' },
  { key: 'accruals', label: 'Gelir/gider tahakkukları ve dönemsellik kayıtları girildi' },
  { key: 'fx_revaluation', label: 'Dövizli hesapların kur değerlemesi yapıldı' },
  { key: 'payroll_posted', label: 'Bordro ve sosyal güvenlik kayıtları muhasebeleştirildi' },
  { key: 'vat_review', label: 'KDV özeti ve beyan tutarları kontrol edildi' },
] as const;
type CloseTaskKey = (typeof CLOSE_TASKS)[number]['key'];

type Severity = 'ok' | 'info' | 'warning' | 'blocker';
interface Check { key: string; label: string; severity: Severity; count?: number; link?: string; details?: string[] }

const count = async (tx: Tx, q: SQL) => Number((await tx.execute<{ n: number }>(q)).rows[0]?.n ?? 0);

/**
 * Aylık kapanış kontrol listesi (öneri 9). Otomatik kontroller kaynağına bağlanır: engel (blocker) dönemi kapatmayı önler
 * (kapatma kuralı ayrıca taslak fişi reddeder), uyarı kapanıştan önce bakılması gerekeni gösterir. Elle yapılan görevler
 * kimin ne zaman tamamladığıyla tutulur. Liste karar desteğidir; kapatma yetkisi ve kuralı değişmez.
 */
export async function periodChecklist(tx: Tx, periodId: string, baseCurrency: string) {
  const [period] = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.id, periodId));
  if (!period) throw notFound('Dönem');
  const s = period.startDate, e = period.endDate;
  const ym = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const checks: Check[] = [];
  const add = (key: string, label: string, n: number, severity: Exclude<Severity, 'ok'>, extra: Partial<Check> = {}) =>
    checks.push({ key, label, count: n, severity: n > 0 ? severity : 'ok', ...(n > 0 ? extra : {}) });

  add('previous_open', 'Önceki dönemlerden açık kalan', await count(tx, sql`select count(*)::int as n from fiscal_periods where end_date < ${s}::date and status = 'open'`), 'warning', { link: `/settings/periods?year=${period.year}` });
  add('draft_entries', 'Taslak yevmiye fişi', await count(tx, sql`select count(*)::int as n from journal_entries where status = 'draft' and entry_date between ${s}::date and ${e}::date`), 'blocker', { link: '/accounting/journal' });
  add('draft_invoices', 'Taslak fatura', await count(tx, sql`select count(*)::int as n from invoices where status = 'draft' and invoice_date between ${s}::date and ${e}::date`), 'warning', { link: '/invoices/sales' });
  add('draft_deliveries', 'Taslak irsaliye', await count(tx, sql`select count(*)::int as n from delivery_notes where status = 'draft' and note_date between ${s}::date and ${e}::date`), 'warning', { link: '/delivery-notes/sales' });
  add('open_stock_counts', 'Tamamlanmamış stok sayımı', await count(tx, sql`select count(*)::int as n from stock_counts where status = 'draft' and count_date between ${s}::date and ${e}::date`), 'warning', { link: '/inventory/counts' });
  add('pending_approvals', 'Bekleyen onay talebi', await count(tx, sql`select count(*)::int as n from approval_requests where status = 'pending' and requested_at <= (${e}::date + 1)`), 'warning', { link: '/settings/approvals' });
  add('open_bank_lines', 'Eşleşmemiş banka ekstresi satırı', await count(tx, sql`select count(*)::int as n from bank_statement_lines where status = 'open' and txn_date between ${s}::date and ${e}::date`), 'warning', { link: '/treasury/accounts' });
  add('draft_payroll', 'Taslak bordro', await count(tx, sql`select count(*)::int as n from payroll_runs where status = 'draft' and month = ${ym}`), 'warning', { link: '/hr/payroll' });
  add('open_attendance', 'Kapatılmamış puantaj', await count(tx, sql`select count(*)::int as n from attendance_months where status = 'open' and month = ${ym}`), 'warning', { link: '/hr/attendance' });
  add('disputed_reconciliations', 'Mutabık olunmayan cari mutabakat', await count(tx, sql`select count(*)::int as n from party_reconciliations where status = 'disputed' and as_of between ${s}::date and ${e}::date`), 'warning', { link: '/parties' });
  add('undelivered_mail', 'Teslim edilemeyen belge e-postası', await count(tx, sql`select count(*)::int as n from outbox_messages where status = 'dead_letter' and kind <> 'notification_digest'`), 'info');

  // Mizan dengesi: dönem sonuna kadarki bütün kayıtlar
  const tb = await trialBalance(tx, { from: `${period.year}-01-01`, to: e, currency: 'base', baseCurrency, reportingCurrency: null });
  const diff = Number(tb.totals.difference);
  checks.push({ key: 'trial_balance', label: 'Mizan dengesi', severity: diff === 0 ? 'ok' : 'blocker', link: '/accounting/trial-balance', ...(diff === 0 ? {} : { details: [tb.totals.difference] }) });

  const done = await tx
    .select({ key: periodCloseTasks.taskKey, doneAt: periodCloseTasks.doneAt, note: periodCloseTasks.note, doneBy: users.fullName })
    .from(periodCloseTasks)
    .innerJoin(users, eq(users.id, periodCloseTasks.doneBy))
    .where(eq(periodCloseTasks.periodId, periodId));
  const tasks = CLOSE_TASKS.map((t) => {
    const d = done.find((x) => x.key === t.key);
    return { key: t.key, label: t.label, done: d ? { by: d.doneBy, at: d.doneAt, note: d.note } : null };
  });
  const blockers = checks.filter((c) => c.severity === 'blocker').length;
  return {
    period: { id: period.id, year: period.year, month: period.month, startDate: s, endDate: e, status: period.status },
    checks,
    tasks,
    blockers,
    warnings: checks.filter((c) => c.severity === 'warning').length,
    openTasks: tasks.filter((t) => !t.done).length,
  };
}

const params = z.object({ id: z.string().uuid(), key: z.enum(CLOSE_TASKS.map((t) => t.key) as [CloseTaskKey, ...CloseTaskKey[]]).optional() });

export const periodCloseRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.ledger', permission: 'ledger.read' } as const;
  const close = { module: 'core.ledger', permission: 'ledger.close_period' } as const;

  app.get('/api/periods/:id/checklist', tenantRoute(app, read, async (c) => periodChecklist(c.tx, params.parse(c.req.params).id, c.company.baseCurrency)));

  app.post('/api/periods/:id/tasks/:key', tenantRoute(app, { ...close, operation: 'update' }, async (c) => {
    const { id, key } = params.parse(c.req.params);
    const { note } = z.object({ note: z.string().trim().max(300).optional() }).parse(c.req.body ?? {});
    const [period] = await c.tx.select({ status: fiscalPeriods.status }).from(fiscalPeriods).where(eq(fiscalPeriods.id, id));
    if (!period) throw notFound('Dönem');
    if (period.status !== 'open') throw unprocessable('Kapalı dönemin kapanış görevleri değiştirilemez', 'PERIOD_CLOSED');
    await c.tx.insert(periodCloseTasks).values({ id: randomUUID(), companyId: c.company.id, periodId: id, taskKey: key!, doneBy: c.user.id, note: note || null })
      .onConflictDoNothing({ target: [periodCloseTasks.companyId, periodCloseTasks.periodId, periodCloseTasks.taskKey] });
    return periodChecklist(c.tx, id, c.company.baseCurrency);
  }));

  app.delete('/api/periods/:id/tasks/:key', tenantRoute(app, { ...close, operation: 'update' }, async (c) => {
    const { id, key } = params.parse(c.req.params);
    const [period] = await c.tx.select({ status: fiscalPeriods.status }).from(fiscalPeriods).where(eq(fiscalPeriods.id, id));
    if (!period) throw notFound('Dönem');
    if (period.status !== 'open') throw unprocessable('Kapalı dönemin kapanış görevleri değiştirilemez', 'PERIOD_CLOSED');
    await c.tx.delete(periodCloseTasks).where(and(eq(periodCloseTasks.periodId, id), eq(periodCloseTasks.taskKey, key!)));
    return periodChecklist(c.tx, id, c.company.baseCurrency);
  }));
};
