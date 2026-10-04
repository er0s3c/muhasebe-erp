import { useQueries } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CURRENCY_CODES, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Card';
import { cn } from '../../lib/cn';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCQuery, useCompanyApi, useModuleEnabled } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { AgingReport, DeliverySummary, InventorySummary, InvoiceSummary, JournalListItem, Member, TaxRate, TrialBalanceData, TreasurySummary } from '../../lib/types';

interface Step {
  key: string;
  title: string;
  description: string;
  done: boolean;
  to: string;
}

interface Metric {
  key: string;
  label: string;
  value: ReactNode;
  to?: string;
  /** Dikkat gerektiren değer (koyu zeminde okunur uyarı/hata rengi) */
  tone?: 'warning' | 'danger';
}

/**
 * Sayaç şeridi: tema yüzeyinde (açık temada beyaz, koyu temada koyu) tek şerit; 10px büyük harf etiket, 28px tek ağırlıklı değer.
 * Bağlantılı göstergeler tıklanabilir.
 */
function CounterBand({ metrics, label }: { metrics: Metric[]; label: string }) {
  return (
    <section aria-label={label} className="overflow-hidden rounded-2xl border border-border bg-surface text-text">
      <ul className="flex flex-wrap">
        {metrics.map((m) => {
          const body = (
            <>
              <p className="text-caption uppercase tracking-[0.05em] text-muted">{m.label}</p>
              <p className={cn('mt-2 truncate text-heading', m.tone === 'warning' && 'text-warning', m.tone === 'danger' && 'text-danger')}>{m.value}</p>
            </>
          );
          const cell = 'block h-full p-5';
          return (
            <li key={m.key} className="-ml-px -mt-px grow basis-[200px] border-l border-t border-border">
              {m.to ? (
                <Link to={m.to} aria-label={m.label} className={cn(cell, 'transition-colors hover:bg-surface-2')}>
                  {body}
                </Link>
              ) : (
                <div className={cell}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const can = useCan();
  const { company, call } = useCompanyApi();
  const today = todayIso();
  const year = today.slice(0, 4);
  const foreign = CURRENCY_CODES.filter((c) => c !== company.baseCurrency);

  // Kapalı modülün uçları 403 verir ve kartları anlamsızdır: sorgu da kart da modül açıkken çalışır.
  const ledgerOn = useModuleEnabled('core.ledger');
  const partiesOn = useModuleEnabled('core.parties');
  const inventoryOn = useModuleEnabled('core.inventory');
  const invoicesOn = useModuleEnabled('core.invoices');
  const treasuryOn = useModuleEnabled('core.treasury');
  const canLedger = can('ledger.read') && ledgerOn;
  const canReports = can('reports.read') && ledgerOn;
  const canMembers = can('members.manage');
  const canParties = can('parties.read') && partiesOn;
  const canInventory = can('inventory.read') && inventoryOn;
  const { data: stockSummary } = useCQuery<InventorySummary>(['dashboard', 'stock'], '/api/inventory/summary', { enabled: canInventory });
  const canInvoices = can('invoices.read') && invoicesOn;
  const { data: invSummary } = useCQuery<InvoiceSummary>(['dashboard', 'invoices'], '/api/invoices/summary', { enabled: canInvoices });
  const canDeliveries = can('deliveries.read') && invoicesOn;
  const { data: delSummary } = useCQuery<DeliverySummary>(['dashboard', 'deliveries'], '/api/delivery-notes/summary', { enabled: canDeliveries });
  const unbilled = delSummary ? delSummary.sales.openCount + delSummary.purchases.openCount : null;
  const canTreasury = can('treasury.read') && treasuryOn;
  const { data: treasury } = useCQuery<TreasurySummary>(['dashboard', 'treasury'], '/api/treasury/summary', { enabled: canTreasury });

  const { data: posted } = useCQuery<{ entries: JournalListItem[] }>(['dashboard', 'posted'], `/api/journal-entries?status=posted&limit=200&from=${year}-01-01`, { enabled: canLedger });
  const { data: drafts } = useCQuery<{ entries: JournalListItem[] }>(['dashboard', 'drafts'], '/api/journal-entries?status=draft&limit=200', { enabled: canLedger });
  const { data: tb } = useCQuery<TrialBalanceData>(['dashboard', 'tb'], `/api/reports/trial-balance?from=${year}-01-01&to=${today}&currency=base`, { enabled: canReports });
  const { data: recv } = useCQuery<AgingReport>(['dashboard', 'recv'], `/api/reports/party-aging?type=receivable&asOf=${today}`, { enabled: canParties });
  const { data: pay } = useCQuery<AgingReport>(['dashboard', 'pay'], `/api/reports/party-aging?type=payable&asOf=${today}`, { enabled: canParties });
  const { data: taxes } = useCQuery<{ taxRates: TaxRate[] }>(['dashboard', 'tax'], '/api/tax-rates');
  const { data: members } = useCQuery<{ members: Member[] }>(['dashboard', 'members'], '/api/company/members', { enabled: canMembers });

  const rateQueries = useQueries({
    queries: foreign.map((cur) => ({
      queryKey: [company.id, 'dashboard', 'rate', cur, today],
      queryFn: () => call<{ rate: string | null }>(`/api/exchange-rates/lookup?from=${cur}&to=${company.baseCurrency}&date=${today}`),
    })),
  });
  const ratesLoaded = rateQueries.every((q) => q.data !== undefined);
  const ratesDone = ratesLoaded && rateQueries.every((q) => q.data?.rate);

  const steps: Step[] = [];
  if (can('rates.manage')) {
    steps.push({ key: 'rates', title: t('dashboard.stepRates'), description: t('dashboard.stepRatesDesc'), done: ratesDone, to: '/settings/currencies' });
  }
  if (can('settings.manage')) {
    steps.push({
      key: 'vat',
      title: t('dashboard.stepVat'),
      description: t('dashboard.stepVatDesc'),
      done: !!taxes && taxes.taxRates.every((r) => r.verifiedAt),
      to: '/settings/tax-rates',
    });
  }
  if (can('ledger.post') && ledgerOn) {
    steps.push({ key: 'journal', title: t('dashboard.stepJournal'), description: t('dashboard.stepJournalDesc'), done: (posted?.entries.length ?? 0) > 0, to: '/accounting/journal?new=1' });
  }
  if (canMembers) {
    steps.push({ key: 'team', title: t('dashboard.stepTeam'), description: t('dashboard.stepTeamDesc'), done: (members?.members.length ?? 0) > 1, to: '/settings/members' });
  }
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = steps.length > 0 && doneCount === steps.length;

  const balanced = tb ? Number(tb.totals.difference) === 0 : null;

  return (
    <>
      <div className="mb-8">
        <h1 className="text-heading-lg">{t('dashboard.greeting', { name: user?.fullName.split(' ')[0] ?? '' })}</h1>
        <p className="mt-2 text-sm text-muted">{t('dashboard.subtitle', { company: company.name })}</p>
      </div>

      <div className="flex flex-col gap-6">
        <CounterBand
          label={t('dashboard.summary')}
          metrics={[
            ...(canLedger
              ? [
                  { key: 'posted', label: t('dashboard.postedEntries'), value: posted ? posted.entries.length : '—' },
                  { key: 'drafts', label: t('dashboard.draftEntries'), value: drafts ? drafts.entries.length : '—', tone: drafts && drafts.entries.length > 0 ? ('warning' as const) : undefined },
                ]
              : []),
            ...(canLedger && canReports
              ? [{ key: 'balance', label: t('dashboard.ledgerBalance'), value: balanced === null ? '—' : balanced ? t('dashboard.balanced') : t('dashboard.unbalanced'), tone: balanced === false ? ('danger' as const) : undefined }]
              : []),
            ...(canParties
              ? [
                  { key: 'recv', label: t('dashboard.receivables'), value: recv ? moneyIn(recv.totals.total, company.baseCurrency) : '—', to: '/parties/aging' },
                  { key: 'pay', label: t('dashboard.payables'), value: pay ? moneyIn(pay.totals.total, company.baseCurrency) : '—', to: '/parties/aging' },
                ]
              : []),
            ...(canTreasury
              ? [{ key: 'treasury', label: t('dashboard.treasuryBalance'), value: treasury ? moneyIn(treasury.equivalent, company.baseCurrency) : '—', to: '/treasury/accounts' }]
              : []),
            ...(canInvoices
              ? [
                  { key: 'monthSales', label: t('dashboard.monthSales'), value: invSummary ? moneyIn(invSummary.salesNet, company.baseCurrency) : '—', to: '/invoices/sales' },
                  { key: 'monthPurchases', label: t('dashboard.monthPurchases'), value: invSummary ? moneyIn(invSummary.purchasesNet, company.baseCurrency) : '—', to: '/invoices/purchases' },
                  { key: 'draftInvoices', label: t('dashboard.draftInvoices'), value: invSummary ? invSummary.draftCount : '—', to: '/invoices/sales', tone: invSummary && invSummary.draftCount > 0 ? ('warning' as const) : undefined },
                ]
              : []),
            ...(canDeliveries
              ? [
                  {
                    key: 'unbilled',
                    label: t('dashboard.unbilledDeliveries'),
                    value: unbilled === null ? '—' : unbilled,
                    to: delSummary && delSummary.sales.openCount === 0 && delSummary.purchases.openCount > 0 ? '/delivery-notes/purchases?invoicing=open' : '/delivery-notes/sales?invoicing=open',
                    tone: unbilled ? ('warning' as const) : undefined,
                  },
                ]
              : []),
            ...(canInventory
              ? [
                  { key: 'stock', label: t('dashboard.stockValue'), value: stockSummary ? moneyIn(stockSummary.stockValue, company.baseCurrency) : '—', to: '/inventory/status' },
                  { key: 'low', label: t('dashboard.lowStock'), value: stockSummary ? stockSummary.lowCount : '—', to: '/inventory/status?low=1', tone: stockSummary && stockSummary.lowCount > 0 ? ('warning' as const) : undefined },
                ]
              : []),
          ]}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {steps.length > 0 && !allDone && (
            <Card>
              <CardHeader
                title={t('dashboard.setupTitle')}
                action={
                  <span className="text-sm text-muted">
                    {doneCount}/{steps.length}
                  </span>
                }
              />
              <div className="h-1 bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
                <div className="h-full bg-brand transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
              </div>
              <ul>
                {steps.map((s) => (
                  <li key={s.key} className="border-b border-border last:border-b-0">
                    <Link to={s.to} className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-surface-2/60">
                      {s.done ? <CheckCircle2 className="size-5 shrink-0 text-success" aria-label={t('dashboard.setupDone')} /> : <Circle className="size-5 shrink-0 text-border-strong" aria-hidden />}
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-sm', s.done && 'text-muted line-through')}>{s.title}</span>
                        <span className="block text-[13px] text-muted">{s.description}</span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {canLedger && (
            <Card className={cn(steps.length === 0 || allDone ? 'lg:col-span-2' : '')}>
              <CardHeader
                title={t('dashboard.recentEntries')}
                action={
                  <Link to="/accounting/journal" className="text-sm link">
                    {t('dashboard.viewAll')}
                  </Link>
                }
              />
              {!posted?.entries.length ? (
                <p className="px-5 py-8 text-center text-sm text-muted">{t('dashboard.noEntries')}</p>
              ) : (
                <ul>
                  {posted.entries.slice(0, 6).map((e) => (
                    <li key={e.id} className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{e.description}</p>
                        <p className="text-xs text-muted">
                          {formatDateTR(e.entryDate)} · <span className="font-mono">{e.entryNo}</span>
                        </p>
                      </div>
                      {e.reversalOfId ? <Badge>{t('ledger.journal.reversal')}</Badge> : e.reversedById ? <Badge tone="danger">{t('ledger.journal.reversed')}</Badge> : null}
                      <span className="num text-sm">{money(e.totalBase)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        {foreign.length > 0 && ratesLoaded && (
          <Card>
            <CardHeader title={t('dashboard.todayRates')} action={<Link to="/settings/currencies" className="text-sm link">{t('settings.currencies.quickEntry')}</Link>} />
            <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
              {foreign.map((cur, i) => {
                const rate = rateQueries[i]?.data?.rate;
                return (
                  <div key={cur} className="bg-surface p-5">
                    <p className="text-sm text-muted">
                      {currencySymbol(cur)}/{currencySymbol(company.baseCurrency)}
                    </p>
                    <p className="mt-1 text-heading">{rate ? money(rate, 4) : <span className="text-base text-warning">{t('dashboard.rateMissing')}</span>}</p>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
