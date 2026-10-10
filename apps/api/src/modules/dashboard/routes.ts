import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CURRENCY_CODES, todayIso, toDbAmount } from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { treasurySummary } from '../treasury/accounts';
import { partyAging } from '../parties/service';
import { invoiceSummary } from '../invoices/reports';
import { deliverySummary } from '../deliveries/service';
import { inventorySummary } from '../inventory/reports';
import { listJournalEntries } from '../ledger/journal';
import { lookupRate } from '../settings/rates';

/**
 * Pano özeti: eskiden panonun ayrı ayrı attığı 13+ isteği (iki tanesi KPI için 200'er yevmiye kaydı çekiyordu) tek istekte toplar.
 * Her bölüm yalnız modülü açık ve izni olan kullanıcıya, kendi kaydetme noktasında (savepoint) hesaplanır: bir bölümün hatası
 * diğerlerini düşürmez, o bölüm `errors` listesinde döner. Sayılar sunucuda COUNT/SUM ile hesaplanır.
 */
const SECTIONS = ['treasury', 'aging', 'invoices', 'salesTrend', 'deliveries', 'inventory', 'ledger', 'balance', 'rates'] as const;
type Section = (typeof SECTIONS)[number];

const querySchema = z.object({
  sections: z
    .string()
    .optional()
    .transform(v => (v ? v.split(',').filter((s): s is Section => (SECTIONS as readonly string[]).includes(s)) : [...SECTIONS])),
});

function allowed(c: TenantCtx, section: Section): boolean {
  const on = (m: string) => c.enabledModules.has(m);
  switch (section) {
    case 'treasury':
      return on('core.treasury') && c.can('treasury.read');
    case 'aging':
      return on('core.parties') && c.can('parties.read');
    case 'invoices':
    case 'salesTrend':
      return on('core.invoices') && c.can('invoices.read');
    case 'deliveries':
      return on('core.invoices') && c.can('deliveries.read');
    case 'inventory':
      return on('core.inventory') && c.can('inventory.read');
    case 'ledger':
      return on('core.ledger') && c.can('ledger.read');
    case 'balance':
      return on('core.ledger') && c.can('reports.read');
    case 'rates':
      return true;
  }
}

/** Son 6 ayın (bu ay dahil) kesinleşmiş net satış/alış toplamı; eksik aylar 0 ile doldurulur. */
async function salesTrend(tx: Tx, today: string) {
  const months: string[] = [];
  const [y, m] = today.split('-').map(Number) as [number, number];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const rows = (
    await tx.execute<{ month: string; sales: string; purchases: string }>(sql`
      select to_char(date_trunc('month', i.invoice_date), 'YYYY-MM') as month,
        coalesce(sum(case i.type when 'sales' then i.net_total_base when 'sales_return' then -i.net_total_base else 0 end), 0) as sales,
        coalesce(sum(case when i.type in ('purchase', 'expense') then i.net_total_base when i.type = 'purchase_return' then -i.net_total_base else 0 end), 0) as purchases
      from invoices i
      where i.status = 'posted' and i.invoice_date >= ${`${months[0]}-01`}::date and i.invoice_date <= ${today}::date
      group by 1`)
  ).rows;
  const byMonth = new Map(rows.map(r => [r.month, r]));
  return months.map(month => ({
    month,
    sales: toDbAmount(byMonth.get(month)?.sales ?? '0'),
    purchases: toDbAmount(byMonth.get(month)?.purchases ?? '0'),
  }));
}

async function ledgerStats(tx: Tx, today: string) {
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const [counts] = (
    await tx.execute<{ posted: number; drafts: number }>(sql`
      select count(*) filter (where status = 'posted' and entry_date >= ${yearStart}::date)::int as posted,
             count(*) filter (where status = 'draft')::int as drafts
        from journal_entries`)
  ).rows;
  const recent = await listJournalEntries(tx, { status: 'posted', limit: 6, offset: 0 });
  return { postedThisYear: counts?.posted ?? 0, drafts: counts?.drafts ?? 0, recent };
}

async function ledgerBalance(tx: Tx, today: string) {
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const [row] = (
    await tx.execute<{ difference: string }>(sql`
      select coalesce(sum(l.debit_base), 0) - coalesce(sum(l.credit_base), 0) as difference
        from journal_lines l join journal_entries e on e.id = l.entry_id
       where e.status = 'posted' and e.entry_date between ${yearStart}::date and ${today}::date`)
  ).rows;
  return { difference: toDbAmount(row?.difference ?? '0'), balanced: Number(row?.difference ?? 0) === 0 };
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/dashboard/summary',
    tenantRoute(app, { module: 'core.dashboard', permission: 'workspace.use' }, async (c) => {
      const { sections } = querySchema.parse(c.req.query);
      const today = todayIso();
      const ledgerCtx = { companyId: c.company.id, userId: c.user.id, baseCurrency: c.company.baseCurrency, reportingCurrency: c.company.reportingCurrency };
      const compute: Record<Section, () => Promise<unknown>> = {
        treasury: () => treasurySummary(c.tx, ledgerCtx, today),
        aging: async () => {
          const [receivable, payable] = [await partyAging(c.tx, { type: 'receivable', asOf: today }), await partyAging(c.tx, { type: 'payable', asOf: today })];
          return { receivable: receivable.totals, payable: payable.totals };
        },
        invoices: () => invoiceSummary(c.tx),
        salesTrend: () => salesTrend(c.tx, today),
        deliveries: () => deliverySummary(c.tx),
        inventory: () => inventorySummary(c.tx, today),
        ledger: () => ledgerStats(c.tx, today),
        balance: () => ledgerBalance(c.tx, today),
        rates: async () => {
          const out: { currency: string; rate: string | null; rateDate: string | null; source: string | null }[] = [];
          for (const currency of CURRENCY_CODES.filter(code => code !== c.company.baseCurrency)) {
            const r = await lookupRate(c.tx, currency, c.company.baseCurrency, today, c.company.baseCurrency, { legacyInverse: true });
            out.push({ currency, rate: r.rate, rateDate: r.rateDate, source: r.source });
          }
          return out;
        },
      };
      const data: Partial<Record<Section, unknown>> = {};
      const errors: Section[] = [];
      for (const section of sections) {
        if (!allowed(c, section)) continue;
        try {
          data[section] = await c.tx.transaction(() => compute[section]());
        } catch (err) {
          errors.push(section);
          c.req.log.warn({ err: err instanceof Error ? err.message : String(err), section }, 'pano bölümü hesaplanamadı');
        }
      }
      return { today, baseCurrency: c.company.baseCurrency, sections: data, errors };
    }),
  );
};
