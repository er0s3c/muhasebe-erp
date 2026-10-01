import { useTranslation } from 'react-i18next';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, money, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ItemProfitData } from '../../lib/types';
import { qtyText, useUnitLabel } from '../inventory/common';
import { PeriodFields, periodText, useReportPeriod } from './common';

/** Stok kartı bazında satış, maliyet ve kâr (satış faturaları eksi iadeler). */
export function ItemProfitPage() {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const unitLabel = useUnitLabel();
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const { data, isPending, error } = useCQuery<ItemProfitData>(
    ['reports', 'item-profitability', from, to],
    `/api/reports/item-profitability?${new URLSearchParams({ from, to })}`,
    { enabled: valid },
  );
  const margin = (v: string | null) => (v === null ? '—' : `${money(v)} %`);
  const tone = (v: string) => (Number(v) < 0 ? 'text-danger' : undefined);

  return (
    <div className="print-wide">
      <PageHeader
        title={t('reports.itemProfit.title')}
        description={t('reports.itemProfit.subtitle')}
        actions={<ExportMenu exportKey="item-profitability" params={{ from, to }} disabled={!valid || !data || data.rows.length === 0} />}
      />
      <PrintHeader subtitle={periodText(from, to)} />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : data.rows.length === 0 ? (
        <Card>
          <EmptyState title={t('reports.itemProfit.empty')} />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Stat label={t('reports.itemProfit.sales')}>{moneyIn(data.totals.sales, base)}</Stat>
            <Stat label={t('reports.itemProfit.cost')}>{moneyIn(data.totals.cost, base)}</Stat>
            <Stat label={t('reports.itemProfit.profit')}>
              <span className={cn(tone(data.totals.profit))}>{moneyIn(data.totals.profit, base)}</span>
            </Stat>
            <Stat label={t('reports.itemProfit.margin')}>{margin(data.totals.marginPct)}</Stat>
          </div>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('inventory.items.code')}</Th>
                  <Th>{t('reports.itemProfit.item')}</Th>
                  <Th num>{t('reports.itemProfit.qty')}</Th>
                  <Th num>{t('reports.itemProfit.sales')} ({currencySymbol(base)})</Th>
                  <Th num>{t('reports.itemProfit.cost')} ({currencySymbol(base)})</Th>
                  <Th num>{t('reports.itemProfit.profit')} ({currencySymbol(base)})</Th>
                  <Th num>{t('reports.itemProfit.margin')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Tr key={r.itemId ?? 'none'}>
                    <Td className="font-mono text-[13px]">{r.code}</Td>
                    <Td>{r.itemId === null ? t('reports.itemProfit.noItem') : r.name}</Td>
                    <Td num className="text-muted">{r.qty ? `${qtyText(r.qty)} ${r.unit ? unitLabel(r.unit) : ''}` : ''}</Td>
                    <Td num>{money(r.sales)}</Td>
                    <Td num className="text-muted">{money(r.cost)}</Td>
                    <Td num className={tone(r.profit)}>{money(r.profit)}</Td>
                    <Td num className="text-muted">{margin(r.marginPct)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2">
                  <Td colSpan={3}>{t('reports.sales.total')}</Td>
                  <Td num>{money(data.totals.sales)}</Td>
                  <Td num>{money(data.totals.cost)}</Td>
                  <Td num className={tone(data.totals.profit)}>{money(data.totals.profit)}</Td>
                  <Td num>{margin(data.totals.marginPct)}</Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
          <p className="text-xs text-muted">{t('reports.itemProfit.note')}</p>
        </div>
      )}
    </div>
  );
}
