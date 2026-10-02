import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Select } from '../../components/ui/Field';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ExpenseGroup, ExpenseReport } from '../../lib/types';
import { PeriodFields, periodText, useReportPeriod } from '../reports/common';
import { useExpenseCards } from './common';

type Group = 'card' | 'month' | 'project' | 'party' | 'top';
const GROUPS: readonly Group[] = ['card', 'month', 'project', 'party', 'top'];

/** Gider raporları: kayıtlı gider fişleri (iptaller hariç) kart, ay, proje, cari ve en yüksek giderler kırılımında. */
export function ExpenseReportPage() {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const [group, setGroup] = useState<Group>('card');
  const [cardId, setCardId] = useState('');
  const { data: cards } = useExpenseCards(true);
  const qs = new URLSearchParams({ from, to });
  if (cardId) qs.set('cardId', cardId);
  const { data, isPending, error } = useCQuery<ExpenseReport>(['expense-report', qs.toString()], `/api/expense-entries/report?${qs}`, { enabled: valid });
  const sym = currencySymbol(base);

  const amountHead = (
    <>
      <Th num>{t('expenses.report.count')}</Th>
      <Th num>{t('expenses.report.net')} ({sym})</Th>
      <Th num>{t('expenses.report.vat')} ({sym})</Th>
      <Th num>{t('expenses.report.withholding')} ({sym})</Th>
      <Th num>{t('expenses.report.gross')} ({sym})</Th>
    </>
  );
  const amounts = (g: ExpenseGroup) => (
    <>
      <Td num className="text-muted">{g.count}</Td>
      <Td num>{money(g.net)}</Td>
      <Td num className="text-muted">{money(g.vat)}</Td>
      <Td num className="text-muted">{money(g.withholding)}</Td>
      <Td num>{money(g.gross)}</Td>
    </>
  );
  const footer = (cols: number) =>
    data && (
      <tfoot>
        <tr className="bg-surface-2">
          <Td colSpan={cols}>{t('expenses.report.total')}</Td>
          {amounts(data.totals)}
        </tr>
      </tfoot>
    );

  return (
    <div className="print-wide">
      <PageHeader
        title={t('expenses.report.title')}
        description={t('expenses.report.subtitle')}
        actions={<ExportMenu exportKey="expense-report" params={{ from, to, cardId }} disabled={!valid || !data || data.totals.count === 0} />}
      />
      <PrintHeader subtitle={`${periodText(from, to)} · ${t(`expenses.report.groups.${group}`)}`} note={t('expenses.notice')} />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <Field label={t('expenses.report.cardFilter')}>
          {(id) => (
            <Select id={id} value={cardId} onChange={(e) => setCardId(e.target.value)} className="w-52">
              <option value="">{t('expenses.report.allCards')}</option>
              {(cards?.cards ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <SegmentedTabs value={group} onChange={setGroup} items={GROUPS.map((g) => ({ key: g, label: t(`expenses.report.groups.${g}`) }))} />
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : data.totals.count === 0 ? (
        <Card>
          <EmptyState title={t('expenses.report.empty')} />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              {group === 'top' ? (
                <>
                  <thead>
                    <tr>
                      <Th>{t('expenses.report.entry')}</Th>
                      <Th>{t('expenses.report.date')}</Th>
                      <Th>{t('expenses.report.card')}</Th>
                      <Th>{t('expenses.report.description')}</Th>
                      <Th>{t('expenses.report.party')}</Th>
                      <Th num>{t('expenses.report.net')} ({sym})</Th>
                      <Th num>{t('expenses.report.gross')} ({sym})</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top.map((e) => (
                      <Tr key={e.id}>
                        <Td className="font-mono text-[13px]">{e.entryNo}</Td>
                        <Td>{formatDateTR(e.entryDate)}</Td>
                        <Td>{e.cardName}</Td>
                        <Td className="max-w-xs truncate">{e.description}</Td>
                        <Td>{e.partyName}</Td>
                        <Td num>{money(e.net)}</Td>
                        <Td num>{money(e.gross)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </>
              ) : (
                <>
                  <thead>
                    <tr>
                      <Th>{t(`expenses.report.${group === 'card' ? 'card' : group === 'month' ? 'month' : group === 'project' ? 'project' : 'party'}`)}</Th>
                      {amountHead}
                    </tr>
                  </thead>
                  <tbody>
                    {group === 'card' &&
                      data.byCard.map((r) => (
                        <Tr key={r.cardId}>
                          <Td>
                            <span className="mr-2 font-mono text-xs text-muted">{r.cardCode}</span>
                            {r.cardName}
                          </Td>
                          {amounts(r)}
                        </Tr>
                      ))}
                    {group === 'month' &&
                      data.byMonth.map((r) => (
                        <Tr key={r.month}>
                          <Td>{r.month}</Td>
                          {amounts(r)}
                        </Tr>
                      ))}
                    {group === 'project' &&
                      data.byProject.map((r) => (
                        <Tr key={r.projectId ?? 'none'}>
                          <Td>{r.projectId ? `${r.projectCode} — ${r.projectName}` : t('expenses.report.noProject')}</Td>
                          {amounts(r)}
                        </Tr>
                      ))}
                    {group === 'party' &&
                      data.byParty.map((r) => (
                        <Tr key={r.partyId ?? 'none'}>
                          <Td>{r.partyName ?? t('expenses.report.noParty')}</Td>
                          {amounts(r)}
                        </Tr>
                      ))}
                  </tbody>
                  {footer(1)}
                </>
              )}
            </Table>
          </TableWrap>
          <p className="mt-3 text-xs text-muted">{t('expenses.report.note')}</p>
        </>
      )}
    </div>
  );
}
