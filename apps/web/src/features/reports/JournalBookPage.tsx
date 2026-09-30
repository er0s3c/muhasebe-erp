import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, isZero, money, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { JournalBookData } from '../../lib/types';
import { PeriodFields, periodText, useReportPeriod } from './common';

const PAGE = 500;

/** Yevmiye defteri: kaydedilmiş fişlerin tüm satırları, tarih ve fiş sırasıyla (sayfalı; dosya dışa aktarma sayfasızdır). */
export function JournalBookPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const base = company.baseCurrency;
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [from, to]);

  const { data, isPending, error } = useCQuery<JournalBookData>(
    ['reports', 'journal-book', from, to, offset],
    `/api/reports/journal-book?${new URLSearchParams({ from, to, limit: String(PAGE), offset: String(offset) })}`,
    { enabled: valid },
  );
  const last = data ? Math.min(offset + PAGE, data.total) : 0;

  return (
    <div className="print-wide">
      <PageHeader
        title={t('reports.journalBook.title')}
        description={t('reports.journalBook.subtitle')}
        actions={<ExportMenu exportKey="journal-book" params={{ from, to }} disabled={!valid || !data || data.total === 0} />}
      />
      <PrintHeader subtitle={periodText(from, to)} note={t('reports.print.internalNote')} />

      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('common.date')}</Th>
                  <Th className="w-40">{t('ledger.accountLedger.entryNo')}</Th>
                  <Th>{t('reports.journalBook.account')}</Th>
                  <Th>{t('common.description')}</Th>
                  <Th num>{t('common.debit')} ({currencySymbol(base)})</Th>
                  <Th num>{t('common.credit')} ({currencySymbol(base)})</Th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr>
                    <Td colSpan={6} className="py-8 text-center text-muted">
                      {t('reports.journalBook.empty')}
                    </Td>
                  </tr>
                )}
                {data.lines.map((l) => (
                  <Tr key={`${l.entryId}-${l.lineNo}`}>
                    <Td>{formatDateTR(l.entryDate)}</Td>
                    <Td>
                      <Link to={`/accounting/journal?open=${l.entryId}`} className="font-mono text-[13px] link">
                        {l.entryNo}
                      </Link>
                    </Td>
                    <Td className="max-w-xs">
                      <span className="font-mono text-[13px]">{l.accountCode}</span> <span className="text-muted">{l.accountName}</span>
                      {l.partyName && <span className="block text-xs text-muted">{l.partyName}</span>}
                    </Td>
                    <Td className="max-w-sm">
                      <span className="block truncate">{l.description ?? l.entryDescription}</span>
                      {l.currencyCode !== base && (
                        <span className="block text-xs text-muted">
                          {moneyIn(Number(l.debit) > 0 ? l.debit : l.credit, l.currencyCode)} · {money(l.fxRate, 4)}
                        </span>
                      )}
                    </Td>
                    <Td num>{isZero(l.debitBase) ? '' : money(l.debitBase)}</Td>
                    <Td num>{isZero(l.creditBase) ? '' : money(l.creditBase)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2">
                  <Td colSpan={4}>{t('reports.journalBook.total')}</Td>
                  <Td num>{money(data.totals.debitBase)}</Td>
                  <Td num>{money(data.totals.creditBase)}</Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted print:hidden">
            <span>{data.total > 0 ? t('reports.journalBook.range', { from: offset + 1, to: last, total: data.total }) : ''}</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                <ChevronLeft className="size-4" aria-hidden />
                {t('reports.prev')}
              </Button>
              <Button size="sm" disabled={last >= data.total} onClick={() => setOffset(offset + PAGE)}>
                {t('reports.next')}
                <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
          {data.total > PAGE && <p className="mt-2 text-xs text-muted print:hidden">{t('reports.journalBook.printHint', { page: PAGE })}</p>}
        </>
      )}
    </div>
  );
}
