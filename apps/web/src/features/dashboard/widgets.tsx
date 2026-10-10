import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { dec } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Card';
import { ListSkeleton } from '../../components/ui/Feedback';
import { Stat, type StatTrend } from '../../components/ui/Stat';
import { cn } from '../../lib/cn';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { Member, TaxRate } from '../../lib/types';
import { NotificationsCard } from '../notifications/NotificationsCard';
import { useAutoFxStatus } from '../settings/AutoFxCard';
import type { DashboardSummary, SummarySection } from './summary';

export type WidgetSize = 's' | 'm' | 'l';
export interface WidgetProps {
  data: DashboardSummary | undefined;
  size: WidgetSize;
}
export interface WidgetDef {
  id: string;
  title: string;
  /** Widget kataloğunda ve "i" rehberinde görünen açıklama. */
  help: string;
  sections: SummarySection[];
  /** Erişim varsa ayrıca istenen bölümler (widget onlarsız da çalışır). */
  extraSections?: SummarySection[];
  /** Ek erişim koşulu (özet bölümü dışındaki widget'lar için). */
  requires?: (can: (p: string) => boolean) => boolean;
  sizes: WidgetSize[];
  defaultSize: WidgetSize;
  render: (props: WidgetProps) => ReactNode;
}

const pct = (current: string, previous: string): number | null => {
  const p = Number(previous);
  if (!p) return null;
  return ((Number(current) - p) / Math.abs(p)) * 100;
};
const dash = '—';

function Value({ children, tone }: { children: ReactNode; tone?: 'warning' | 'danger' }) {
  return <span className={cn(tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger')}>{children}</span>;
}

interface KpiOut { value: ReactNode; to?: string; sub?: ReactNode; tone?: 'warning' | 'danger'; trend?: StatTrend; spark?: number[] }
function kpi(def: Omit<WidgetDef, 'sizes' | 'defaultSize' | 'render'> & { render: (data: DashboardSummary['sections'], base: string) => KpiOut }): WidgetDef {
  return {
    ...def,
    sizes: ['s', 'm'],
    defaultSize: 's',
    render: ({ data }) => {
      const out: KpiOut = data ? def.render(data.sections, data.baseCurrency) : { value: <span className="ui-skeleton inline-block h-7 w-28 rounded-md" aria-label="Yükleniyor" /> };
      return (
        <Stat label={def.title} help={def.help} to={out.to} sub={out.sub} trend={out.trend} spark={out.spark} className="h-full">
          <Value tone={out.tone}>{out.value}</Value>
        </Stat>
      );
    },
  };
}

function trendOf(series: { sales: string; purchases: string }[] | undefined, field: 'sales' | 'purchases', goodWhen: 'up' | 'down') {
  if (!series || series.length < 2) return {};
  const current = series[series.length - 1]![field];
  const previous = series[series.length - 2]![field];
  const change = pct(current, previous);
  return {
    spark: series.map(s => Number(s[field])),
    ...(change === null ? {} : { trend: { percent: change, goodWhen, label: 'geçen aya göre' } satisfies StatTrend }),
  };
}

export const WIDGETS: WidgetDef[] = [
  kpi({
    id: 'cash',
    title: 'Kasa ve banka',
    help: 'Tüm kasa ve banka hesaplarının bugünkü toplamı, ana para birimine çevrilmiş olarak. Güncel kuru olmayan hesaplar tarihsel maliyetle eklenir.',
    sections: ['treasury'],
    render: (s, base) => ({ value: s.treasury ? moneyIn(s.treasury.equivalent, base) : dash, to: '/treasury/accounts', sub: s.treasury ? `${s.treasury.accountCount} hesap${s.treasury.approximate ? ' · bazı kurlar eksik' : ''}` : undefined }),
  }),
  kpi({
    id: 'receivables',
    title: 'Açık alacaklar',
    help: 'Müşterilerden tahsil edilmemiş toplam alacak (bugün itibarıyla, ana para birimi).',
    sections: ['aging'],
    render: (s, base) => ({ value: s.aging ? moneyIn(s.aging.receivable.total, base) : dash, to: '/parties/aging' }),
  }),
  kpi({
    id: 'overdue',
    title: 'Geciken alacaklar',
    help: 'Vadesi geçmiş müşteri alacakları (1–30, 31–60, 61–90 ve 90+ gün toplamı).',
    sections: ['aging'],
    render: (s, base) => {
      if (!s.aging) return { value: dash };
      const t = s.aging.receivable;
      const overdue = dec(t.d1_30).plus(t.d31_60).plus(t.d61_90).plus(t.d90plus).toFixed(2);
      return { value: moneyIn(overdue, base), to: '/parties/aging', tone: dec(overdue).gt(0) ? 'warning' : undefined, sub: dec(t.d90plus).gt(0) ? `90+ gün: ${moneyIn(t.d90plus, base)}` : undefined };
    },
  }),
  kpi({
    id: 'payables',
    title: 'Açık borçlar',
    help: 'Tedarikçilere ödenmemiş toplam borç (bugün itibarıyla).',
    sections: ['aging'],
    render: (s, base) => ({ value: s.aging ? moneyIn(s.aging.payable.total, base) : dash, to: '/parties/aging' }),
  }),
  kpi({
    id: 'month-sales',
    title: 'Bu ay satış',
    help: 'Bu ay kesinleşmiş satış faturalarının KDV hariç net toplamı (iadeler düşülmüş). Mini grafik son 6 ayı gösterir.',
    sections: ['invoices', 'salesTrend'],
    render: (s, base) => ({ value: s.invoices ? moneyIn(s.invoices.salesNet, base) : dash, to: '/invoices/sales', ...trendOf(s.salesTrend, 'sales', 'up') }),
  }),
  kpi({
    id: 'month-purchases',
    title: 'Bu ay alış ve gider',
    help: 'Bu ay kesinleşmiş alış ve gider faturalarının net toplamı (iadeler düşülmüş).',
    sections: ['invoices', 'salesTrend'],
    render: (s, base) => ({ value: s.invoices ? moneyIn(s.invoices.purchasesNet, base) : dash, to: '/invoices/purchases', ...trendOf(s.salesTrend, 'purchases', 'down') }),
  }),
  kpi({
    id: 'draft-invoices',
    title: 'Taslak faturalar',
    help: 'Henüz kesinleştirilmemiş faturalar. Taslaklar cari, stok ve muhasebeyi etkilemez.',
    sections: ['invoices'],
    render: s => ({ value: s.invoices ? s.invoices.draftCount : dash, to: '/invoices/sales', tone: s.invoices && s.invoices.draftCount > 0 ? 'warning' : undefined }),
  }),
  kpi({
    id: 'unbilled',
    title: 'Faturalanmamış irsaliyeler',
    help: 'Kesinleşmiş ancak faturaya bağlanmamış satış ve alış irsaliyeleri.',
    sections: ['deliveries'],
    render: s => {
      if (!s.deliveries) return { value: dash };
      const n = s.deliveries.sales.openCount + s.deliveries.purchases.openCount;
      return { value: n, tone: n ? 'warning' : undefined, to: s.deliveries.sales.openCount === 0 && s.deliveries.purchases.openCount > 0 ? '/delivery-notes/purchases?invoicing=open' : '/delivery-notes/sales?invoicing=open', sub: n ? `Satış ${s.deliveries.sales.openCount} · Alış ${s.deliveries.purchases.openCount}` : undefined };
    },
  }),
  kpi({
    id: 'stock-value',
    title: 'Stok değeri',
    help: 'Depolardaki stokların bugünkü maliyet değeri.',
    sections: ['inventory'],
    render: (s, base) => ({ value: s.inventory ? moneyIn(s.inventory.stockValue, base) : dash, to: '/inventory/status', sub: s.inventory ? `${s.inventory.itemCount} stok kartı` : undefined }),
  }),
  kpi({
    id: 'low-stock',
    title: 'Kritik stok',
    help: 'Minimum seviyenin altına düşmüş stok kartı sayısı.',
    sections: ['inventory'],
    render: s => ({ value: s.inventory ? s.inventory.lowCount : dash, to: '/inventory/status?low=1', tone: s.inventory && s.inventory.lowCount > 0 ? 'warning' : undefined }),
  }),
  kpi({
    id: 'journal',
    title: 'Yevmiye kayıtları',
    help: 'Bu yıl kesinleşmiş yevmiye sayısı; alt satırda bekleyen taslaklar.',
    sections: ['ledger'],
    render: s => ({ value: s.ledger ? s.ledger.postedThisYear.toLocaleString('tr-TR') : dash, to: '/accounting/journal', sub: s.ledger ? (s.ledger.drafts ? <Value tone="warning">{s.ledger.drafts} taslak bekliyor</Value> : 'Bekleyen taslak yok') : undefined }),
  }),
  kpi({
    id: 'ledger-balance',
    title: 'Defter denkliği',
    help: 'Bu yılın kesinleşmiş kayıtlarında borç ve alacak toplamlarının eşit olup olmadığı.',
    sections: ['balance'],
    render: (s, base) => ({ value: !s.balance ? dash : s.balance.balanced ? 'Denk' : 'Denk değil', tone: s.balance && !s.balance.balanced ? 'danger' : undefined, sub: s.balance && !s.balance.balanced ? `Fark: ${moneyIn(s.balance.difference, base)}` : undefined, to: '/accounting/trial-balance' }),
  }),
  {
    id: 'sales-trend',
    title: 'Satış ve alış eğilimi',
    help: 'Son 6 ayın kesinleşmiş net satış ve alış/gider toplamları. Taslaklar dahil değildir.',
    sections: ['salesTrend'],
    sizes: ['m', 'l'],
    defaultSize: 'm',
    render: ({ data }) => <SalesTrendCard data={data} />,
  },
  {
    id: 'setup',
    title: 'Kurulum adımları',
    help: 'Şirketi kullanıma hazırlamak için önerilen adımlar. Tamamlananlar işaretlenir.',
    sections: ['rates'],
    extraSections: ['ledger'],
    sizes: ['m', 'l'],
    defaultSize: 'm',
    render: ({ data }) => <SetupCard data={data} />,
  },
  {
    id: 'notifications',
    title: 'Bildirimler',
    help: 'Onay bekleyen belgeler, yaklaşan vadeler ve kritik uyarılar.',
    sections: [],
    sizes: ['m', 'l'],
    defaultSize: 'l',
    render: () => <NotificationsCard />,
  },
  {
    id: 'recent-entries',
    title: 'Son yevmiye kayıtları',
    help: 'En son kesinleşen 6 yevmiye kaydı.',
    sections: ['ledger'],
    sizes: ['m', 'l'],
    defaultSize: 'm',
    render: ({ data }) => <RecentEntriesCard data={data} />,
  },
  {
    id: 'fx-rates',
    title: 'Bugünün kurları',
    help: 'Bugün geçerli döviz kurları ve otomatik resmî kur çekiminin durumu.',
    sections: ['rates'],
    sizes: ['m', 'l'],
    defaultSize: 'm',
    render: ({ data }) => <RatesCard data={data} />,
  },
];
export const WIDGET_BY_ID = new Map(WIDGETS.map(w => [w.id, w]));

function SalesTrendCard({ data }: { data: DashboardSummary | undefined }) {
  const series = data?.sections.salesTrend;
  const base = data?.baseCurrency ?? 'TRY';
  const max = Math.max(1, ...(series ?? []).flatMap(s => [Number(s.sales), Number(s.purchases)]));
  const monthLabel = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('tr-TR', { month: 'short' });
  return (
    <Card className="h-full">
      <CardHeader title="Satış ve alış eğilimi" help="Son 6 ayın kesinleşmiş net satış ve alış/gider toplamları. Taslaklar dahil değildir." action={<Link to="/reports/sales" className="link text-sm">Satış raporu</Link>} />
      {!series ? (
        <ListSkeleton rows={3} />
      ) : (
        <div className="px-5 py-4">
          <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-text bg-brand" aria-hidden />Satış</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-border-strong" aria-hidden />Alış ve gider</span>
          </div>
          <div className="flex h-40 items-end gap-3" aria-hidden>
            {series.map(s => (
              <div key={s.month} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <div className="flex h-32 w-full items-end justify-center gap-1">
                  <div title={`Satış: ${moneyIn(s.sales, base)}`} className="w-1/2 max-w-6 rounded-t-md border border-b-0 border-text bg-brand transition-[height]" style={{ height: `${Math.max(2, (Math.max(0, Number(s.sales)) / max) * 100)}%` }} />
                  <div title={`Alış: ${moneyIn(s.purchases, base)}`} className="w-1/2 max-w-6 rounded-t-md bg-border-strong transition-[height]" style={{ height: `${Math.max(2, (Math.max(0, Number(s.purchases)) / max) * 100)}%` }} />
                </div>
                <span className="text-[11px] text-muted">{monthLabel(s.month)}</span>
              </div>
            ))}
          </div>
          <table className="sr-only">
            <caption>Son 6 ay net satış ve alış</caption>
            <thead><tr><th>Ay</th><th>Satış</th><th>Alış ve gider</th></tr></thead>
            <tbody>{series.map(s => <tr key={s.month}><td>{s.month}</td><td>{moneyIn(s.sales, base)}</td><td>{moneyIn(s.purchases, base)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RecentEntriesCard({ data }: { data: DashboardSummary | undefined }) {
  const { t } = useTranslation();
  const ledger = data?.sections.ledger;
  return (
    <Card className="h-full">
      <CardHeader title={t('dashboard.recentEntries')} action={<Link to="/accounting/journal" className="link text-sm">{t('dashboard.viewAll')}</Link>} />
      {!ledger ? (
        <ListSkeleton rows={3} />
      ) : !ledger.recent.length ? (
        <p className="px-5 py-8 text-center text-sm text-muted">{t('dashboard.noEntries')}</p>
      ) : (
        <ul>
          {ledger.recent.map(e => (
            <li key={e.id} className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{e.description}</p>
                <p className="text-xs text-muted">{formatDateTR(e.entryDate)} · <span className="font-mono">{e.entryNo}</span></p>
              </div>
              {e.reversalOfId ? <Badge>{t('ledger.journal.reversal')}</Badge> : e.reversedById ? <Badge tone="danger">{t('ledger.journal.reversed')}</Badge> : null}
              <span className="num text-sm">{money(e.totalBase)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RatesCard({ data }: { data: DashboardSummary | undefined }) {
  const { t } = useTranslation();
  const rates = data?.sections.rates;
  const auto = useAutoFxStatus();
  const base = data?.baseCurrency ?? 'TRY';
  return (
    <Card className="h-full">
      <CardHeader
        title={t('dashboard.todayRates')}
        meta={auto.data?.enabled ? <Badge tone="success" dot>Otomatik</Badge> : undefined}
        action={<Link to="/settings/currencies" className="link text-sm">{t('settings.currencies.quickEntry')}</Link>}
      />
      {!rates ? (
        <ListSkeleton rows={2} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
            {rates.map(r => (
              <div key={r.currency} className="bg-surface p-5">
                <p className="text-sm text-muted">{currencySymbol(r.currency)}/{currencySymbol(base)}</p>
                <p className="mt-1 text-heading-sm font-semibold tabular-nums">{r.rate ? money(r.rate, 4) : <span className="text-base text-warning">{t('dashboard.rateMissing')}</span>}</p>
                {r.rate && r.rateDate && r.rateDate !== data?.today && <p className="mt-1 text-xs text-muted">{formatDateTR(r.rateDate)} kuru</p>}
              </div>
            ))}
          </div>
          {auto.data?.lastImport && (
            <p className="border-t border-border px-5 py-2.5 text-xs text-muted">
              Son resmî bülten: {auto.data.lastImport.source} · {formatDateTR(auto.data.lastImport.date)}
              {auto.data.enabled && auto.data.lastError && <span className="text-warning"> · son otomatik deneme başarısız</span>}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

interface Step {
  key: string;
  title: string;
  description: string;
  done: boolean;
  to: string;
}

function SetupCard({ data }: { data: DashboardSummary | undefined }) {
  const { t } = useTranslation();
  const can = useCan();
  const setup = useCQuery<{ steps: Step[] }>(['workspace-setup'], '/api/workspace/setup');
  const { data: taxes } = useCQuery<{ taxRates: TaxRate[] }>(['dashboard', 'tax'], can('settings.manage') ? '/api/tax-rates' : null);
  const { data: members } = useCQuery<{ members: Member[] }>(['dashboard', 'members'], can('members.manage') ? '/api/company/members' : null);
  const steps: Step[] = [...(setup.data?.steps ?? [])];
  const rates = data?.sections.rates;
  if (can('rates.manage')) steps.push({ key: 'rates', title: t('dashboard.stepRates'), description: t('dashboard.stepRatesDesc'), done: !!rates && rates.every(r => r.rate), to: '/settings/currencies' });
  if (can('settings.manage')) steps.push({ key: 'vat', title: t('dashboard.stepVat'), description: t('dashboard.stepVatDesc'), done: !!taxes && taxes.taxRates.every(r => r.verifiedAt), to: '/settings/tax-rates' });
  if (can('ledger.post') && data?.sections.ledger) steps.push({ key: 'journal', title: t('dashboard.stepJournal'), description: t('dashboard.stepJournalDesc'), done: data.sections.ledger.postedThisYear > 0, to: '/accounting/journal?new=1' });
  if (can('members.manage')) steps.push({ key: 'team', title: t('dashboard.stepTeam'), description: t('dashboard.stepTeamDesc'), done: (members?.members.length ?? 0) > 1, to: '/settings/members' });
  const doneCount = steps.filter(s => s.done).length;
  const allDone = steps.length > 0 && doneCount === steps.length;
  return (
    <Card className="h-full">
      <CardHeader title={t('dashboard.setupTitle')} action={<span className="text-sm tabular-nums text-muted">{doneCount}/{steps.length}</span>} />
      <div className="h-1 bg-surface-2" role="progressbar" aria-label="Kurulum ilerlemesi" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}>
        <div className="h-full bg-brand transition-all" style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }} />
      </div>
      {allDone ? (
        <p className="flex items-center gap-2 px-5 py-6 text-sm text-muted"><CheckCircle2 className="size-5 text-success" aria-hidden />Tüm kurulum adımları tamam. Bu widget’ı panodan kaldırabilirsiniz.</p>
      ) : (
        <ul>
          {steps.map(s => (
            <li key={s.key} className="border-b border-border last:border-b-0">
              <Link to={s.to} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-surface-2/60">
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
      )}
    </Card>
  );
}
