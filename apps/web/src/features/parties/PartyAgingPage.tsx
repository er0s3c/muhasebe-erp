import { Download, Hourglass } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatTR, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { isZero, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { AgingReport, AgingRow } from '../../lib/types';

type Type = 'receivable' | 'payable';
const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;

const cell = (v: string) => (isZero(v) ? <span className="text-muted">—</span> : money(v));

export function PartyAgingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const company = useCompany();
  const [type, setType] = useState<Type>('receivable');
  const [asOf, setAsOf] = useState(todayIso());

  const { data, isPending, error } = useCQuery<AgingReport>(
    ['party-aging', type, asOf],
    `/api/reports/party-aging?${new URLSearchParams({ type, asOf })}`,
    { enabled: Boolean(asOf) },
  );

  const exportCsv = () => {
    if (!data) return;
    const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;
    const head = [t('partyAging.party'), ...BUCKETS.map((b) => t(`partyAging.${b}`)), t('partyAging.unapplied'), t('partyAging.total')];
    const line = (r: Pick<AgingRow, 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus' | 'unapplied' | 'total'>, name: string) =>
      [name, ...BUCKETS.map((b) => formatTR(r[b])), formatTR(r.unapplied), formatTR(r.total)].map(esc).join(';');
    const lines = [head.map(esc).join(';'), ...data.rows.map((r) => line(r, `${r.partyCode} ${r.partyName}`)), line(data.totals, t('partyAging.grandTotal'))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `yaslandirma-${type}-${asOf}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <PageHeader
        title={t('partyAging.title')}
        description={t('partyAging.subtitle')}
        actions={
          <Button onClick={exportCsv} disabled={!data || data.rows.length === 0}>
            <Download className="size-4" aria-hidden />
            {t('common.export')}
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div role="tablist" className="inline-flex rounded-lg border border-border bg-surface p-1">
          {(['receivable', 'payable'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={type === k}
              onClick={() => setType(k)}
              className={cn('rounded-md px-4 py-1.5 text-sm font-medium text-muted transition-colors', type === k && 'bg-brand-soft text-brand')}
            >
              {t(`partyAging.${k}`)}
            </button>
          ))}
        </div>
        <Field label={t('partyAging.asOf')}>{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />}</Field>
      </div>

      <div className="flex flex-col gap-4">
        <Callout>{t('partyAging.info')}</Callout>
        {error ? (
          <Callout tone="danger">{errorMessage(error)}</Callout>
        ) : isPending || !data ? (
          <PageLoading />
        ) : data.rows.length === 0 ? (
          <Card>
            <EmptyState icon={<Hourglass className="size-5" />} title={t('partyAging.empty')} />
          </Card>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('partyAging.party')}</Th>
                  {BUCKETS.map((b) => (
                    <Th key={b} num>
                      {t(`partyAging.${b}`)}
                    </Th>
                  ))}
                  <Th num>{t('partyAging.unapplied')}</Th>
                  <Th num>
                    {t('partyAging.total')} ({company.baseCurrency})
                  </Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Tr
                    key={r.partyId}
                    clickable
                    tabIndex={0}
                    onClick={() => navigate(`/parties/${r.partyId}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/parties/${r.partyId}`);
                    }}
                  >
                    <Td>
                      <span className="font-medium">{r.partyName}</span>
                      <span className="ml-2 whitespace-nowrap font-mono text-xs text-muted">{r.partyCode}</span>
                    </Td>
                    <Td num>{cell(r.notDue)}</Td>
                    <Td num className={cn(!isZero(r.d1_30) && 'text-warning')}>{cell(r.d1_30)}</Td>
                    <Td num className={cn(!isZero(r.d31_60) && 'text-warning')}>{cell(r.d31_60)}</Td>
                    <Td num className={cn(!isZero(r.d61_90) && 'text-danger')}>{cell(r.d61_90)}</Td>
                    <Td num className={cn(!isZero(r.d90plus) && 'font-medium text-danger')}>{cell(r.d90plus)}</Td>
                    <Td num>{cell(r.unapplied)}</Td>
                    <Td num className="font-semibold">{money(r.total)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2 font-semibold">
                  <Td>{t('partyAging.grandTotal')}</Td>
                  {BUCKETS.map((b) => (
                    <Td key={b} num>
                      {money(data.totals[b])}
                    </Td>
                  ))}
                  <Td num>{money(data.totals.unapplied)}</Td>
                  <Td num>{money(data.totals.total)}</Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
        )}
      </div>
    </>
  );
}
