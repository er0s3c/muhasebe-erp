import { TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { dec, todayIso } from '@erp/shared';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { cn } from '../../lib/cn';

interface Rep { contractedRevenue: string; revenue: string; actual: string; eac: string; projectedProfit: string; recognizedProfit: string }
interface Row { id: string; code: string; name: string; kind: 'own' | 'contract'; contractedRevenue: string; unsoldValue: string; revenue: string; actual: string; eac: string; projectedProfit: string; recognizedProfit: string; marginPct: string | null; reporting: Rep | null }
interface Data { asOf: string; baseCurrency: string; reportingCurrency: string | null; rows: Row[]; totals: Omit<Row, 'id' | 'code' | 'name' | 'kind'>; missingRate: number }

const Money = ({ v, cur, strong }: { v: string; cur: string; strong?: boolean }) => <span className={cn(strong && 'font-medium', dec(v).isNegative() && 'text-danger')}>{moneyIn(v, cur)}</span>;

export function ProfitabilityPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [asOf, setAsOf] = useState(todayIso());
  const [view, setView] = useState<'base' | 'reporting'>('base');
  const { data, isPending } = useCQuery<Data>(['projects', 'profitability', asOf], `/api/projects/profitability?asOf=${asOf}`);
  if (isPending || !data) return <PageLoading />;
  const repOk = !!data.reportingCurrency && data.reportingCurrency !== data.baseCurrency && data.rows.every((r) => r.reporting) && data.totals.reporting;
  const useRep = view === 'reporting' && repOk;
  const cur = useRep ? data.reportingCurrency! : data.baseCurrency;
  const pick = (r: Row | Data['totals']) => {
    const rp = useRep ? (r as { reporting: Rep | null }).reporting : null;
    return rp ? { contracted: rp.contractedRevenue, revenue: rp.revenue, actual: rp.actual, eac: rp.eac, projected: rp.projectedProfit, recognized: rp.recognizedProfit } : { contracted: r.contractedRevenue, revenue: r.revenue, actual: r.actual, eac: r.eac, projected: r.projectedProfit, recognized: r.recognizedProfit };
  };
  const tot = pick(data.totals);
  return (
    <>
      <PageHeader title={t('profitability.title')} description={t('profitability.subtitle')} actions={<ExportMenu exportKey="project-profitability" params={{ asOf }} />} />
      <PrintHeader subtitle={`${t('profitability.asOf')}: ${asOf.split('-').reverse().join('.')} · ${cur}`} />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <Field label={t('profitability.asOf')}>{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />}</Field>
        {repOk && (
          <SegmentedTabs
            items={[{ key: 'base', label: t('profitability.view.base', { cur: data.baseCurrency }) }, { key: 'reporting', label: t('profitability.view.reporting', { cur: data.reportingCurrency }) }]}
            value={view}
            onChange={setView}
          />
        )}
      </div>
      {data.missingRate > 0 && <div className="mb-4"><Callout tone="warning">{t('profitability.noRate', { n: data.missingRate })}</Callout></div>}
      {!repOk && data.reportingCurrency && data.rows.length > 0 && <div className="mb-4"><Callout tone="info">{t('profitability.noReporting')}</Callout></div>}
      {data.rows.length === 0 ? (
        <Card><EmptyState icon={<TrendingUp className="size-5" />} title={t('profitability.empty')} /></Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('profitability.cols.project')}</Th>
                <Th num>{t('profitability.cols.contracted')}</Th>
                <Th num>{t('profitability.cols.revenue')}</Th>
                <Th num>{t('profitability.cols.actual')}</Th>
                <Th num>{t('profitability.cols.eac')}</Th>
                <Th num>{t('profitability.cols.projected')}</Th>
                <Th num className="w-20">{t('profitability.cols.margin')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const p = pick(r);
                return (
                  <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/projects/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/projects/${r.id}`)}>
                    <Td>
                      <div>{r.code} — {r.name}</div>
                      <div className="text-xs text-muted">{t(`profitability.kinds.${r.kind}`)}{r.kind === 'own' && Number(r.unsoldValue) > 0 ? ` · ${t('profitability.unsold', { value: moneyIn(r.unsoldValue, data.baseCurrency, 0) })}` : ''}</div>
                    </Td>
                    <Td num><Money v={p.contracted} cur={cur} /></Td>
                    <Td num><Money v={p.revenue} cur={cur} /></Td>
                    <Td num><Money v={p.actual} cur={cur} /></Td>
                    <Td num><Money v={p.eac} cur={cur} /></Td>
                    <Td num><Money v={p.projected} cur={cur} strong /></Td>
                    <Td num className={r.marginPct && Number(r.marginPct) < 0 ? 'text-danger' : ''}>{r.marginPct ? `%${r.marginPct}` : '—'}</Td>
                  </Tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="print-total">
                <Td className="font-medium">{t('profitability.total')}</Td>
                <Td num><Money v={tot.contracted} cur={cur} strong /></Td>
                <Td num><Money v={tot.revenue} cur={cur} strong /></Td>
                <Td num><Money v={tot.actual} cur={cur} strong /></Td>
                <Td num><Money v={tot.eac} cur={cur} strong /></Td>
                <Td num><Money v={tot.projected} cur={cur} strong /></Td>
                <Td num>{data.totals.marginPct ? `%${data.totals.marginPct}` : '—'}</Td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}
      <p className="mt-4 text-xs text-muted">{t('profitability.note')}</p>
    </>
  );
}
