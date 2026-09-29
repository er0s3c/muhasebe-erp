import { useQueries } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Circle, FileEdit, FileCheck2, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CURRENCY_CODES, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { cn } from '../../lib/cn';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCQuery, useCompanyApi } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { AgingReport, JournalListItem, Member, TaxRate, TrialBalanceData } from '../../lib/types';

interface Step {
  key: string;
  title: string;
  description: string;
  done: boolean;
  to: string;
}

function Kpi({ icon, label, value, tone = 'brand' }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'brand' | 'success' | 'danger' | 'warning' }) {
  const tones = { brand: 'bg-brand-soft text-brand', success: 'bg-success-soft text-success', danger: 'bg-danger-soft text-danger', warning: 'bg-warning-soft text-warning' };
  return (
    <Card className="flex items-center gap-4 p-5">
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', tones[tone])}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="mt-0.5 truncate text-xl font-semibold tracking-tight">{value}</p>
      </div>
    </Card>
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

  const canLedger = can('ledger.read');
  const canReports = can('reports.read');
  const canMembers = can('members.manage');
  const canParties = can('parties.read');

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
  if (can('ledger.post')) {
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
      <PageHeader title={t('dashboard.greeting', { name: user?.fullName.split(' ')[0] ?? '' })} description={t('dashboard.subtitle', { company: company.name })} />

      <div className="flex flex-col gap-6">
        {canLedger && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Kpi icon={<FileCheck2 className="size-5" />} label={t('dashboard.postedEntries')} value={posted ? posted.entries.length : '—'} />
            <Kpi icon={<FileEdit className="size-5" />} label={t('dashboard.draftEntries')} value={drafts ? drafts.entries.length : '—'} tone={drafts && drafts.entries.length > 0 ? 'warning' : 'brand'} />
            {canReports && (
              <Kpi
                icon={<Scale className="size-5" />}
                label={t('dashboard.ledgerBalance')}
                value={balanced === null ? '—' : balanced ? t('dashboard.balanced') : t('dashboard.unbalanced')}
                tone={balanced === null ? 'brand' : balanced ? 'success' : 'danger'}
              />
            )}
          </div>
        )}

        {canParties && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Link to="/parties/aging" className="block rounded-xl transition-shadow hover:shadow-pop" aria-label={t('dashboard.receivables')}>
              <Kpi icon={<TrendingUp className="size-5" />} label={t('dashboard.receivables')} value={recv ? `${money(recv.totals.total)} ${company.baseCurrency}` : '—'} tone="success" />
            </Link>
            <Link to="/parties/aging" className="block rounded-xl transition-shadow hover:shadow-pop" aria-label={t('dashboard.payables')}>
              <Kpi icon={<TrendingDown className="size-5" />} label={t('dashboard.payables')} value={pay ? `${money(pay.totals.total)} ${company.baseCurrency}` : '—'} tone="warning" />
            </Link>
          </div>
        )}

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
                        <span className={cn('block text-sm font-medium', s.done && 'text-muted line-through')}>{s.title}</span>
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
                  <Link to="/accounting/journal" className="text-sm font-medium text-brand hover:underline">
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
                        <p className="truncate text-sm font-medium">{e.description}</p>
                        <p className="text-xs text-muted">
                          {formatDateTR(e.entryDate)} · <span className="font-mono">{e.entryNo}</span>
                        </p>
                      </div>
                      {e.reversalOfId ? <Badge>{t('ledger.journal.reversal')}</Badge> : e.reversedById ? <Badge tone="danger">{t('ledger.journal.reversed')}</Badge> : null}
                      <span className="num text-sm font-medium">{money(e.totalBase)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        {foreign.length > 0 && ratesLoaded && (
          <Card>
            <CardHeader title={t('dashboard.todayRates')} action={<Link to="/settings/currencies" className="text-sm font-medium text-brand hover:underline">{t('settings.currencies.quickEntry')}</Link>} />
            <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
              {foreign.map((cur, i) => {
                const rate = rateQueries[i]?.data?.rate;
                return (
                  <div key={cur} className="bg-surface p-5">
                    <p className="text-sm text-muted">
                      {cur}/{company.baseCurrency}
                    </p>
                    <p className="mt-1 text-xl font-semibold tracking-tight">{rate ? money(rate, 4) : <span className="text-base font-normal text-warning">{t('dashboard.rateMissing')}</span>}</p>
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
