import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Field, Input } from '../../components/ui/Field';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, isZero, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { GeneralLedgerData } from '../../lib/types';
import { BalanceText } from '../parties/BalanceText';
import { PeriodFields, periodText, useReportPeriod } from './common';

const PAGE = 20;

/** Kebir (büyük defter): dönemde hareketi olan her hesap için devir, satırlar ve kapanış. */
export function GeneralLedgerPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const base = company.baseCurrency;
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const [prefix, setPrefix] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [from, to, prefix]);

  const qs = new URLSearchParams({ from, to, limit: String(PAGE), offset: String(offset) });
  if (prefix.trim()) qs.set('codePrefix', prefix.trim());
  const { data, isPending, error } = useCQuery<GeneralLedgerData>(['reports', 'general-ledger', qs.toString()], `/api/reports/general-ledger?${qs}`, {
    enabled: valid && /^[0-9A-Za-z.]*$/.test(prefix.trim()),
  });
  const last = data ? Math.min(offset + PAGE, data.total) : 0;

  return (
    <div className="print-wide">
      <PageHeader
        title={t('reports.generalLedger.title')}
        description={t('reports.generalLedger.subtitle')}
        actions={<ExportMenu exportKey="general-ledger" params={{ from, to, codePrefix: prefix.trim() }} disabled={!valid || !data || data.total === 0} />}
      />
      <PrintHeader subtitle={`${periodText(from, to)}${prefix.trim() ? ` · ${t('reports.generalLedger.prefixNote', { prefix: prefix.trim() })}` : ''}`} note={t('reports.print.internalNote')} />

      <div className="mb-5 flex flex-wrap items-start gap-4 print:hidden" data-testid="report-filters">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <Field label={t('reports.generalLedger.prefix')} hint={t('reports.generalLedger.prefixHint')}>
          {(id) => <Input id={id} value={prefix} onChange={(e) => setPrefix(e.target.value)} className="w-40" placeholder="120" maxLength={20} />}
        </Field>
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : data.accounts.length === 0 ? (
        <Card>
          <EmptyState title={t('reports.generalLedger.empty')} />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {data.accounts.map((a) => (
            <section key={a.accountId} aria-label={`${a.code} ${a.name}`} className="break-inside-avoid-page">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[15px]">
                  <span className="font-mono">{a.code}</span> · {a.name}
                </h2>
                <span className="text-sm text-muted">
                  {t('reports.generalLedger.closing')}: <BalanceText value={a.closing} currency={base} />
                </span>
              </div>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-28">{t('common.date')}</Th>
                      <Th className="w-40">{t('ledger.accountLedger.entryNo')}</Th>
                      <Th>{t('common.description')}</Th>
                      <Th num>{t('common.debit')}</Th>
                      <Th num>{t('common.credit')}</Th>
                      <Th num>{t('common.balance')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="bg-surface-2/60">
                      <Td colSpan={5}>{t('reports.generalLedger.opening')}</Td>
                      <Td num>
                        <BalanceText value={a.opening} />
                      </Td>
                    </tr>
                    {a.lines.map((l, i) => (
                      <Tr key={`${l.entryId}-${i}`}>
                        <Td>{formatDateTR(l.entryDate)}</Td>
                        <Td>
                          <Link to={`/accounting/journal?open=${l.entryId}`} className="font-mono text-[13px] link">
                            {l.entryNo}
                          </Link>
                        </Td>
                        <Td className="max-w-md truncate">{l.description}</Td>
                        <Td num>{isZero(l.debitBase) ? '' : money(l.debitBase)}</Td>
                        <Td num>{isZero(l.creditBase) ? '' : money(l.creditBase)}</Td>
                        <Td num>
                          <BalanceText value={l.balance} />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surface-2">
                      <Td colSpan={3}>{t('reports.generalLedger.accountTotal')}</Td>
                      <Td num>{money(a.debit)}</Td>
                      <Td num>{money(a.credit)}</Td>
                      <Td num>
                        <BalanceText value={a.closing} />
                      </Td>
                    </tr>
                  </tfoot>
                </Table>
              </TableWrap>
            </section>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted print:hidden">
            <span>{t('reports.generalLedger.range', { from: offset + 1, to: last, total: data.total })}</span>
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
        </div>
      )}
    </div>
  );
}
