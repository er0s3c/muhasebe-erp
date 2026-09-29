import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { SalesReportData, SalesReportGroup } from '../../lib/types';
import { qtyText } from '../inventory/common';
import { PeriodFields, periodText, useReportPeriod } from './common';
import { useState } from 'react';

const GROUPS: readonly SalesReportGroup[] = ['party', 'item', 'month', 'invoice'];
const INVOICE_TYPES = ['sales', 'purchase', 'expense', 'sales_return', 'purchase_return'] as const;

export const SalesReportPage = () => <SalesOrPurchaseReport side="sales" />;
export const PurchaseReportPage = () => <SalesOrPurchaseReport side="purchases" />;

/** Satış ya da alış raporu: cari, stok kartı, ay ya da fatura kırılımı; iadeler düşülmüş, iptal ve taslak hariç. */
function SalesOrPurchaseReport({ side }: { side: 'sales' | 'purchases' }) {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const [groupBy, setGroupBy] = useState<SalesReportGroup>('party');
  const endpoint = side === 'sales' ? 'sales-report' : 'purchase-report';

  const { data, isPending, error } = useCQuery<SalesReportData>(
    ['reports', endpoint, from, to, groupBy],
    `/api/reports/${endpoint}?${new URLSearchParams({ from, to, groupBy })}`,
    { enabled: valid },
  );

  const partyLabel = side === 'sales' ? t('reports.sales.customer') : t('reports.sales.supplier');
  const amountHead = (
    <>
      <Th num>{t('reports.sales.net')} ({base})</Th>
      <Th num>{t('reports.sales.vat')} ({base})</Th>
      <Th num>{t('reports.sales.gross')} ({base})</Th>
    </>
  );

  return (
    <div className="print-wide">
      <PageHeader
        title={t(`reports.${side}.title`)}
        description={t(`reports.${side}.subtitle`)}
        actions={<ExportMenu exportKey={endpoint} params={{ from, to, groupBy }} disabled={!valid || !data || data.rows.length === 0} />}
      />
      <PrintHeader subtitle={`${periodText(from, to)} · ${t(`reports.sales.groups.${groupBy}`)}`} />

      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <SegmentedTabs value={groupBy} onChange={setGroupBy} items={GROUPS.map((g) => ({ key: g, label: t(`reports.sales.groups.${g}`) }))} />
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : data.rows.length === 0 ? (
        <Card>
          <EmptyState title={t('reports.sales.empty')} />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  {groupBy === 'invoice' && <Th className="w-28">{t('common.date')}</Th>}
                  {groupBy === 'item' && <Th className="w-28">{t('inventory.items.code')}</Th>}
                  {groupBy === 'invoice' && <Th className="w-40">{t('reports.sales.invoiceNo')}</Th>}
                  <Th>{groupBy === 'party' || groupBy === 'invoice' ? partyLabel : groupBy === 'item' ? t('reports.sales.item') : t('reports.sales.month')}</Th>
                  {groupBy === 'invoice' && <Th className="w-36">{t('reports.sales.type')}</Th>}
                  {(groupBy === 'party' || groupBy === 'month') && <Th num>{t('reports.sales.docCount')}</Th>}
                  {groupBy === 'item' && <Th num>{t('reports.sales.qty')}</Th>}
                  {amountHead}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Tr key={r.key}>
                    {groupBy === 'invoice' && <Td>{r.date ? formatDateTR(r.date) : ''}</Td>}
                    {groupBy === 'item' && <Td className="font-mono text-[13px]">{r.code}</Td>}
                    {groupBy === 'invoice' && (
                      <Td>
                        {r.invoiceId ? (
                          <Link to={`/invoices/${r.invoiceId}`} className="font-mono text-[13px] link">
                            {r.code}
                          </Link>
                        ) : null}
                        {r.externalNo && <span className="block text-xs text-muted">{r.externalNo}</span>}
                      </Td>
                    )}
                    <Td className="max-w-sm truncate">
                      {groupBy === 'party' && r.code && <span className="mr-2 font-mono text-xs text-muted">{r.code}</span>}
                      {r.label}
                    </Td>
                    {groupBy === 'invoice' && <Td className="text-muted">{r.type && (INVOICE_TYPES as readonly string[]).includes(r.type) ? t(`invoices.types.${r.type as (typeof INVOICE_TYPES)[number]}`) : r.type}</Td>}
                    {(groupBy === 'party' || groupBy === 'month') && <Td num className="text-muted">{r.docCount}</Td>}
                    {groupBy === 'item' && <Td num className="text-muted">{r.qty ? qtyText(r.qty) : ''}</Td>}
                    <Td num>{money(r.net)}</Td>
                    <Td num className="text-muted">{money(r.vat)}</Td>
                    <Td num>{money(r.gross)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2">
                  <Td colSpan={groupBy === 'invoice' ? 4 : groupBy === 'item' ? 2 : 1}>{t('reports.sales.total')}</Td>
                  {groupBy === 'invoice' && <Td />}
                  {groupBy === 'item' && <Td />}
                  {(groupBy === 'party' || groupBy === 'month') && <Td num>{data.totals.docCount}</Td>}
                  <Td num>{money(data.totals.net)}</Td>
                  <Td num>{money(data.totals.vat)}</Td>
                  <Td num>{money(data.totals.gross)}</Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
          <p className="mt-3 text-xs text-muted">{t('reports.sales.note')}</p>
        </>
      )}
    </div>
  );
}
