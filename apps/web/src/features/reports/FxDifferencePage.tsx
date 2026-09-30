import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, isZero, money, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { FxDifferenceData } from '../../lib/types';
import { TxnTypeBadge } from '../treasury/common';
import { PeriodFields, periodText, useReportPeriod } from './common';

/** Gerçekleşen kambiyo (kur farkı) kârı ve zararı: tahsilat, ödeme ve döviz satışı hareketleri. */
export function FxDifferencePage() {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const { data, isPending, error } = useCQuery<FxDifferenceData>(
    ['reports', 'fx-differences', from, to],
    `/api/reports/fx-differences?${new URLSearchParams({ from, to })}`,
    { enabled: valid },
  );
  const net = (v: string, withSymbol = false) => <span className={Number(v) > 0 ? 'text-success' : Number(v) < 0 ? 'text-danger' : undefined}>{withSymbol ? moneyIn(v, base) : money(v)}</span>;

  return (
    <div className="print-wide">
      <PageHeader
        title={t('reports.fx.title')}
        description={t('reports.fx.subtitle')}
        actions={<ExportMenu exportKey="fx-differences" params={{ from, to }} disabled={!valid || !data || data.rows.length === 0} />}
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
          <EmptyState title={t('reports.fx.empty')} description={t('reports.fx.emptyDesc')} />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Stat label={t('reports.fx.gain')}>{moneyIn(data.totals.gain, base)}</Stat>
            <Stat label={t('reports.fx.loss')}>{moneyIn(data.totals.loss, base)}</Stat>
            <Stat label={t('reports.fx.net')}>{net(data.totals.net, true)}</Stat>
          </div>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('common.date')}</Th>
                  <Th className="w-44">{t('treasury.txn.number')}</Th>
                  <Th className="w-36">{t('treasury.txn.type')}</Th>
                  <Th>{t('reports.fx.account')}</Th>
                  <Th>{t('reports.fx.party')}</Th>
                  <Th num>{t('reports.fx.gain')} ({currencySymbol(base)})</Th>
                  <Th num>{t('reports.fx.loss')} ({currencySymbol(base)})</Th>
                  <Th num>{t('reports.fx.net')} ({currencySymbol(base)})</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Tr key={r.transactionId}>
                    <Td>{formatDateTR(r.txnDate)}</Td>
                    <Td>
                      <Link to={`/treasury/transactions?open=${r.transactionId}`} className="font-mono text-[13px] link">
                        {r.txnNo}
                      </Link>
                    </Td>
                    <Td>
                      <TxnTypeBadge type={r.type} />
                    </Td>
                    <Td>
                      {r.accountName} <span className="text-xs text-muted">{currencySymbol(r.currencyCode)}</span>
                    </Td>
                    <Td className="text-muted">{r.partyName}</Td>
                    <Td num>{isZero(r.gain) ? '' : money(r.gain)}</Td>
                    <Td num>{isZero(r.loss) ? '' : money(r.loss)}</Td>
                    <Td num>{net(r.net)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2">
                  <Td colSpan={5}>{t('reports.sales.total')}</Td>
                  <Td num>{money(data.totals.gain)}</Td>
                  <Td num>{money(data.totals.loss)}</Td>
                  <Td num>{net(data.totals.net)}</Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
          <p className="text-xs text-muted">{t('reports.fx.note')}</p>
        </div>
      )}
    </div>
  );
}
