import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import {
  companyBudgetSchema,
  compareBudget,
  dec,
  idParam,
  isoDate,
  todayIso,
  type CompanyBudget,
  type CompanyBudgetInput,
  type CompanyBudgetReport,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, forbidden, notFound, AppError } from '../../http/errors';
import { renderCsv } from '../../files/csv-write';
import { writeXlsxStream, XLSX_CONTENT_TYPE } from '../../files/xlsx-write';
import type { ReportTable } from '../../files/table';
import { assertReportSize, maxReportRows } from '../../http/limits';
import { notClosingEntry } from '../ledger/closing';
import { isModuleDenied } from '../access/effective';

const read = { module: 'core.ledger', permission: 'ledger.read' } as const;
const write = { module: 'core.ledger', permission: 'ledger.post' } as const;
const columns = sql`b.id,b.series_id as "seriesId",b.revision,b.version,b.status,b.config,b.created_at as "createdAt",b.approved_at as "approvedAt",b.approved_by as "approvedBy",u.full_name as "approverName"`;
async function get(c: TenantCtx, id: string, lock = false): Promise<CompanyBudget> {
  const b = (
    await c.tx.execute(
      sql`select ${columns} from company_budgets b left join users u on u.id=b.approved_by where b.id=${id}::uuid ${lock ? sql`for update of b` : sql``}`,
    )
  ).rows[0];
  if (!b) throw notFound('Bütçe');
  const budget = b as unknown as CompanyBudget;
  budget.config = companyBudgetSchema.parse(budget.config);
  requireProjectAccess(c, budget.config);
  return budget;
}
function requireProjectAccess(c: TenantCtx, config: CompanyBudgetInput) {
  if (
    config.projectIds.length &&
    (!c.enabledModules.has('construction.projects') ||
      isModuleDenied(c.access, 'construction.projects') ||
      !c.can('projects.read'))
  )
    throw forbidden('Proje kapsamlı bütçe için proje okuma yetkisi gerekir.');
}
async function validate(c: TenantCtx, config: CompanyBudgetInput) {
  requireProjectAccess(c, config);
  const ids = config.lines.map((l) => l.accountId);
  const accounts = (
    await c.tx.execute<{
      id: string;
      is_postable: boolean;
      is_active: boolean;
      party_control: string | null;
    }>(
      sql`select id,is_postable,is_active,party_control from accounts where id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})`,
    )
  ).rows;
  if (
    accounts.length !== ids.length ||
    accounts.some((a) => !a.is_postable || !a.is_active || a.party_control)
  )
    throw badRequest(
      'Bütçe için aktif, kayıt yapılabilir ve cari kontrol hesabı olmayan hesaplar seçin.',
    );
  if (config.projectIds.length) {
    const projects = (
      await c.tx.execute(
        sql`select id from projects where id in (${sql.join(
          config.projectIds.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})`,
      )
    ).rows;
    if (projects.length !== config.projectIds.length)
      throw badRequest('Proje bulunamadı veya bu şirkete ait değil.');
  }
}
const projectFilter = (config: CompanyBudgetInput) =>
  config.projectIds.length
    ? sql`l.project_id in (${sql.join(
        config.projectIds.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})`
    : sql`true`;
export async function companyBudgetReport(
  c: TenantCtx,
  budget: CompanyBudget,
  asOf: string,
): Promise<CompanyBudgetReport> {
  requireProjectAccess(c, budget.config);
  const { config } = budget,
    from = `${config.year}-01-01`,
    to = asOf < `${config.year}-12-31` ? asOf : `${config.year}-12-31`;
  // Only posted ERP ledger amounts, including reversals; year-end closing entries are excluded.
  const actual = (
    await c.tx.execute<{
      account_id: string;
      month: number;
      amount: string;
    }>(sql`select l.account_id,extract(month from e.entry_date)::int as month,sum(l.debit_base-l.credit_base)::text as amount
    from journal_lines l join journal_entries e on e.id=l.entry_id
    where e.status='posted' and e.entry_date between ${from}::date and ${to}::date and ${notClosingEntry('e')} and ${projectFilter(config)} group by l.account_id,extract(month from e.entry_date) limit ${maxReportRows() + 1}`)
  ).rows;
  assertReportSize(actual.length, 'proje kapsamını daraltın');
  const accounts = (
    await c.tx.execute<{ id: string; code: string; name: string; type: string }>(
      sql`select id,code,name,type from accounts limit ${maxReportRows() + 1}`,
    )
  ).rows;
  assertReportSize(accounts.length, 'hesap sayısı rapor tavanını aşıyor');
  const lookup = new Map(actual.map((r) => [`${r.account_id}:${r.month}`, r.amount]));
  const lines = config.lines.map((l) => {
    const a = accounts.find((a) => a.id === l.accountId);
    if (!a) throw conflict('Bütçe hesabı bulunamadı.');
    const months = l.amounts.map((p, i) =>
      compareBudget(
        l.kind,
        i + 1,
        p,
        dec(lookup.get(`${l.accountId}:${i + 1}`) ?? 0)
          .mul(l.kind === 'expense' ? 1 : -1)
          .toFixed(2),
      ),
    );
    const total = compareBudget(
      l.kind,
      0,
      months.reduce((s, m) => s.plus(m.planned), dec(0)).toFixed(2),
      months.reduce((s, m) => s.plus(m.actual), dec(0)).toFixed(2),
    );
    return { accountId: l.accountId, code: a.code, name: a.name, kind: l.kind, months, total };
  });
  const total = (kind: 'expense' | 'revenue') =>
    compareBudget(
      kind,
      0,
      lines
        .filter((l) => l.kind === kind)
        .reduce((s, l) => s.plus(l.total.planned), dec(0))
        .toFixed(2),
      lines
        .filter((l) => l.kind === kind)
        .reduce((s, l) => s.plus(l.total.actual), dec(0))
        .toFixed(2),
    );
  const expense = total('expense'),
    revenue = total('revenue');
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    ...Object.fromEntries(
      ['expense', 'revenue'].flatMap((kind) =>
        ['planned', 'actual'].map((field) => [
          `${kind}${field === 'planned' ? 'Planned' : 'Actual'}`,
          lines
            .filter((l) => l.kind === kind)
            .reduce((s, l) => s.plus(l.months[i]![field as 'planned' | 'actual']), dec(0))
            .toFixed(2),
        ]),
      ),
    ),
  })) as CompanyBudgetReport['months'];
  const chosen = new Set(config.lines.map((l) => l.accountId));
  const unbudgeted = actual.filter((r) => !chosen.has(r.account_id));
  const otherAccounts = accounts.filter(
    (a) =>
      ['expense', 'cost', 'income'].includes(a.type) &&
      unbudgeted.some((r) => r.account_id === a.id),
  );
  const projectNames = config.projectIds.length
    ? (
        await c.tx.execute<{ name: string }>(
          sql`select name from projects where id in (${sql.join(
            config.projectIds.map((id) => sql`${id}::uuid`),
            sql`,`,
          )}) order by name`,
        )
      ).rows.map((r) => r.name)
    : [];
  const netPlanned = dec(revenue.planned).minus(expense.planned),
    netActual = dec(revenue.actual).minus(expense.actual);
  return {
    budget,
    currency: c.company.baseCurrency,
    asOf: to,
    lines,
    months,
    totals: {
      expense,
      revenue,
      net: {
        planned: netPlanned.toFixed(2),
        actual: netActual.toFixed(2),
        variance: netActual.minus(netPlanned).toFixed(2),
      },
    },
    coverage: {
      projectNames,
      departmentMethod:
        config.scope === 'company' ? null : config.projectIds.length ? 'projects' : 'accounts',
      unbudgetedAccountCount: otherAccounts.length,
      unbudgetedAccounts: otherAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        netDebit: unbudgeted
          .filter((r) => r.account_id === a.id)
          .reduce((s, r) => s.plus(r.amount), dec(0))
          .toFixed(2),
      })),
    },
  };
}
export const companyBudgetRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/company-budgets/:id/export',
    tenantRoute(
      app,
      { ...read, limit: { name: 'budget-export', max: 10, windowMs: 60000 } },
      async (c) => {
        const { asOf, format } = z
          .object({
            asOf: isoDate.default(todayIso()),
            format: z.enum(['xlsx', 'csv']).default('xlsx'),
          })
          .parse(c.req.query);
        if (!app.exportGate.tryAcquire())
          throw new AppError(
            429,
            'EXPORT_BUSY',
            'Başka dışa aktarmalar hazırlanıyor; tekrar deneyin.',
          );
        let streaming = false;
        try {
          const report = await companyBudgetReport(
            c,
            await get(c, idParam.parse(c.req.params).id),
            asOf,
          );
          const table: ReportTable = {
            key: 'company-budget',
            title: report.budget.config.title,
            subtitle: `${report.budget.config.year} · R${report.budget.revision} · ${report.budget.status} · Gerçekleşen ${report.asOf} tarihine kadar · ${report.currency}`,
            columns: [
              { key: 'account', label: 'Hesap', kind: 'text' },
              { key: 'kind', label: 'Tür', kind: 'text' },
              { key: 'month', label: 'Ay', kind: 'int' },
              { key: 'planned', label: 'Bütçe', kind: 'money', currency: report.currency },
              { key: 'actual', label: 'Gerçekleşen', kind: 'money', currency: report.currency },
              { key: 'variance', label: 'Sapma', kind: 'money', currency: report.currency },
              { key: 'percentage', label: 'Sapma %', kind: 'rate' },
              { key: 'state', label: 'Durum', kind: 'text' },
            ],
            rows: report.lines.flatMap((l) =>
              l.months.map((m) => {
                const future =
                  `${report.budget.config.year}-${String(m.month).padStart(2, '0')}-01` >
                  report.asOf;
                return {
                  account: `${l.code} ${l.name}`,
                  kind: l.kind === 'expense' ? 'Gider' : 'Gelir',
                  month: m.month,
                  planned: m.planned,
                  actual: future ? null : m.actual,
                  variance: future ? null : m.variance,
                  percentage: future ? null : m.variancePct,
                  state: future ? 'Henüz gelmedi' : m.favorable ? 'Olumlu' : 'Olumsuz',
                };
              }),
            ),
          };
          void c.reply
            .header('cache-control', 'no-store')
            .header(
              'content-disposition',
              `attachment; filename="budget-${report.budget.config.year}-r${report.budget.revision}.${format}"`,
            );
          if (format === 'csv') {
            void c.reply.header('content-type', 'text/csv; charset=utf-8');
            return renderCsv(table);
          }
          void c.reply.header('content-type', XLSX_CONTENT_TYPE);
          const stream = writeXlsxStream([table]);
          stream.once('close', () => app.exportGate.release());
          streaming = true;
          return stream;
        } finally {
          if (!streaming) app.exportGate.release();
        }
      },
    ),
  );
  app.get(
    '/api/company-budgets',
    tenantRoute(app, read, async (c) => {
      const items = (
        await c.tx.execute(
          sql`select ${columns} from company_budgets b left join users u on u.id=b.approved_by order by b.created_at desc limit 501`,
        )
      ).rows;
      return {
        items: items.slice(0, 500).filter((b) => {
          try {
            requireProjectAccess(c, companyBudgetSchema.parse(b.config));
            return true;
          } catch (e) {
            if ((e as { status?: number }).status === 403) return false;
            throw e;
          }
        }),
        truncated: items.length > 500,
      };
    }),
  );
  app.post(
    '/api/company-budgets',
    tenantRoute(app, write, async (c) => {
      const config = companyBudgetSchema.parse(c.req.body);
      await validate(c, config);
      const id = uuidv7();
      await c.tx.execute(
        sql`insert into company_budgets(id,company_id,series_id,revision,config,created_by) values(${id},${c.company.id},${id},1,${JSON.stringify(config)}::jsonb,${c.user.id})`,
      );
      void c.reply.code(201);
      return { budget: await get(c, id) };
    }),
  );
  app.get(
    '/api/company-budgets/:id',
    tenantRoute(app, read, async (c) => {
      const budget = await get(c, idParam.parse(c.req.params).id);
      const { asOf } = z.object({ asOf: isoDate.default(todayIso()) }).parse(c.req.query);
      return companyBudgetReport(c, budget, asOf);
    }),
  );
  app.put(
    '/api/company-budgets/:id',
    tenantRoute(app, write, async (c) => {
      const { config, version } = z
          .object({ config: companyBudgetSchema, version: z.number().int().positive() })
          .parse(c.req.body),
        budget = await get(c, idParam.parse(c.req.params).id, true);
      if (budget.status !== 'draft')
        throw conflict('Onaylı bütçeyi değiştiremezsiniz; yeni revizyon açın.');
      if (budget.version !== version)
        throw conflict('Bütçe başka biri tarafından değiştirildi; yenileyin.');
      if (
        config.year !== budget.config.year ||
        config.scope !== budget.config.scope ||
        config.department !== budget.config.department
      )
        throw badRequest('Bütçe yılı ve departman kapsamı seride değiştirilemez.');
      await validate(c, config);
      await c.tx.execute(
        sql`update company_budgets set config=${JSON.stringify(config)}::jsonb,version=version+1,updated_at=now() where id=${budget.id}`,
      );
      return { budget: await get(c, budget.id) };
    }),
  );
  app.post(
    '/api/company-budgets/:id/approve',
    tenantRoute(app, write, async (c) => {
      c.require('members.manage');
      const { version } = z.object({ version: z.number().int().positive() }).parse(c.req.body);
      const initial = await get(c, idParam.parse(c.req.params).id);
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + initial.seriesId + ':budget'},0))`,
      );
      const b = await get(c, initial.id, true);
      if (b.version !== version || b.status !== 'draft')
        throw conflict('Bütçe onay için güncel bir taslak olmalı.');
      await validate(c, b.config);
      await c.tx.execute(
        sql`update company_budgets set status='superseded',version=version+1,updated_at=now() where series_id=${b.seriesId}::uuid and status='approved'`,
      );
      await c.tx.execute(
        sql`update company_budgets set status='approved',approved_by=${c.user.id},approved_at=now(),version=version+1,updated_at=now() where id=${b.id}`,
      );
      return { budget: await get(c, b.id) };
    }),
  );
  app.post(
    '/api/company-budgets/:id/revise',
    tenantRoute(app, write, async (c) => {
      const initial = await get(c, idParam.parse(c.req.params).id);
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + initial.seriesId + ':budget'},0))`,
      );
      const b = await get(c, initial.id, true);
      if (b.status !== 'approved')
        throw conflict('Yalnızca güncel onaylı bütçeden revizyon açılır.');
      if (
        (
          await c.tx.execute(
            sql`select id from company_budgets where series_id=${b.seriesId}::uuid and status='draft'`,
          )
        ).rows.length
      )
        throw conflict('Bu bütçenin açık revizyonu zaten var.');
      const revision = (
          await c.tx.execute<{ n: number }>(
            sql`select max(revision)::int+1 as n from company_budgets where series_id=${b.seriesId}::uuid`,
          )
        ).rows[0]!.n,
        id = uuidv7();
      await c.tx.execute(
        sql`insert into company_budgets(id,company_id,series_id,revision,config,created_by) values(${id},${c.company.id},${b.seriesId},${revision},${JSON.stringify(b.config)}::jsonb,${c.user.id})`,
      );
      void c.reply.code(201);
      return { budget: await get(c, id) };
    }),
  );
  app.get(
    '/api/company-budgets/:id/transactions',
    tenantRoute(app, read, async (c) => {
      const b = await get(c, idParam.parse(c.req.params).id),
        q = z
          .object({
            accountId: z.uuid(),
            month: z.coerce.number().int().min(1).max(12),
            asOf: isoDate.default(todayIso()),
          })
          .parse(c.req.query);
      if (!b.config.lines.some((l) => l.accountId === q.accountId))
        throw badRequest('Hesap bütçenin kapsamında değil.');
      const rows = (
        await c.tx
          .execute(sql`select e.id as "entryId",e.entry_no as "entryNo",e.entry_date::text as date,e.description,l.debit_base as debit,l.credit_base as credit,${c.enabledModules.has('construction.projects') && !isModuleDenied(c.access, 'construction.projects') && c.can('projects.read') ? sql`p.name` : sql`null::text`} as "projectName"
      from journal_lines l join journal_entries e on e.id=l.entry_id left join projects p on p.id=l.project_id
      where e.status='posted' and l.account_id=${q.accountId}::uuid and extract(year from e.entry_date)=${b.config.year} and extract(month from e.entry_date)=${q.month} and e.entry_date<=${q.asOf}::date and ${notClosingEntry('e')} and ${projectFilter(b.config)} order by e.entry_date,e.entry_no,l.id limit 251`)
      ).rows;
      return {
        items: rows.slice(0, 250),
        truncated: rows.length > 250,
        currency: c.company.baseCurrency,
      };
    }),
  );
};
