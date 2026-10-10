import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Callout, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Field, Input } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { EmployeeStatement } from '../../lib/types';
import { AdvanceStatusBadge } from './employee-ledger-common';

/** Personel cari ekstresi: açılış bakiyesi, hareketler (net ücret, maaş ödemesi, avans, kesinti, geri ödeme), kapanış ve açık avanslar. */
export function EmployeeStatementPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  // Bordro yevmiyesi ay sonu tarihlidir: varsayılan bitiş yıl sonu (bu ayın bordrosu ay bitmeden de görünür)
  const [to, setTo] = useState(`${new Date().getFullYear()}-12-31`);
  const { data, isPending, error , refetch: retryQuery, isFetching: retryingQuery } = useCQuery<EmployeeStatement>(['employee-ledger', 'statement', id, from, to], `/api/employee-ledger/employees/${id}/statement?from=${from}&to=${to}`);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        className="mb-0"
        title={t('employeeLedger.statement.title')}
        helpKey="employee-statement"
        back={{ to: '/hr/employee-ledger', label: t('employeeLedger.title') }}
        recent={data ? { kind: 'Personel ekstresi', title: data.employee.fullName } : false}
        meta={data && <span className="text-[15px] text-muted"><span className="font-mono">{data.employee.code}</span> {data.employee.fullName}</span>}
      />
      <Callout tone="warning">{t('employeeLedger.notice')}</Callout>
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div className="flex flex-wrap gap-3">
          <Field label={t('employeeLedger.statement.from')}>{(fid) => <Input id={fid} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label={t('employeeLedger.statement.to')}>{(fid) => <Input id={fid} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        <ExportMenu exportKey="employee-statement" params={{ employeeId: id, from, to }} disabled={!data} />
      </div>
      {error ? (<ErrorState description={errorMessage(error)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending ? (
        <PageLoading />
      ) : !data ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label={t('employeeLedger.statement.opening')}>{money(data.opening)}</Stat>
            <Stat label={t('employeeLedger.statement.debit')}>{money(data.totals.debit)}</Stat>
            <Stat label={t('employeeLedger.statement.credit')}>{money(data.totals.credit)}</Stat>
            <Stat label={t('employeeLedger.statement.closing')} sub={Number(data.closing) > 0 ? t('employeeLedger.weOwe') : Number(data.closing) < 0 ? t('employeeLedger.theyOwe') : undefined}>{money(data.closing)}</Stat>
          </div>
          <TableWrap>
            <Table aria-label={t('employeeLedger.statement.title')}>
              <thead>
                <tr>
                  <Th>{t('employeeLedger.cols.date')}</Th>
                  <Th>{t('employeeLedger.statement.kind')}</Th>
                  <Th>{t('employeeLedger.statement.ref')}</Th>
                  <Th>{t('employeeLedger.statement.description')}</Th>
                  <Th num>{t('employeeLedger.statement.debit')}</Th>
                  <Th num>{t('employeeLedger.statement.credit')}</Th>
                  <Th num>{t('employeeLedger.statement.balance')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr>
                    <Td colSpan={7} className="text-muted">{t('employeeLedger.statement.empty')}</Td>
                  </tr>
                )}
                {data.lines.map((l, i) => (
                  <Tr key={i}>
                    <Td>{formatDateTR(l.date)}</Td>
                    <Td>{t(`employeeLedger.kinds.${l.kind}`)}</Td>
                    <Td className="font-mono text-[13px]">{l.ref}</Td>
                    <Td>{l.description}</Td>
                    <Td num>{Number(l.debit) ? money(l.debit) : ''}</Td>
                    <Td num>{Number(l.credit) ? money(l.credit) : ''}</Td>
                    <Td num>{money(l.balance)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <Card>
            <CardHeader title={t('employeeLedger.statement.openAdvances')} />
            {data.openAdvances.length === 0 ? (
              <p className="p-4 text-sm text-muted">{t('employeeLedger.statement.noOpenAdvances')}</p>
            ) : (
              <TableWrap>
                <Table aria-label={t('employeeLedger.statement.openAdvances')}>
                  <thead>
                    <tr>
                      <Th>{t('employeeLedger.cols.number')}</Th>
                      <Th>{t('employeeLedger.cols.date')}</Th>
                      <Th>{t('employeeLedger.cols.purpose')}</Th>
                      <Th num>{t('employeeLedger.cols.amount')}</Th>
                      <Th num>{t('employeeLedger.cols.open')}</Th>
                      <Th num>{t('employeeLedger.cols.age')}</Th>
                      <Th>{t('employeeLedger.cols.status')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.openAdvances.map((a) => (
                      <Tr key={a.id}>
                        <Td className="font-mono text-[13px]">{a.number}</Td>
                        <Td>{formatDateTR(a.advanceDate)}</Td>
                        <Td>{a.purpose}</Td>
                        <Td num>{money(a.amount)}</Td>
                        <Td num>{money(a.open)}</Td>
                        <Td num>{a.ageDays}</Td>
                        <Td><AdvanceStatusBadge status={a.status} /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
