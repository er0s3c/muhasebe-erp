import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, isZero, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ProjectDetail, ProjectTransactionsData, ProjectWbsRow } from '../../lib/types';

const PAGE = 50;
const UNASSIGNED = '__none__';

/** Hareketler sekmesi: projeye etiketli kaydedilmiş yevmiye satırları (iş kalemi ve tarih süzgeçli). */
export function TransactionsTab({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const [wbs, setWbs] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [wbs, from, to]);

  const { data: wbsData } = useCQuery<{ wbs: ProjectWbsRow[] }>(['project', project.id, 'wbs'], `/api/projects/${project.id}/wbs`);
  const qs = useMemo(() => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (wbs === UNASSIGNED) q.set('unassigned', 'true');
    else if (wbs) q.set('wbsId', wbs);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return q.toString();
  }, [wbs, from, to, limit]);
  const { data, isPending } = useCQuery<ProjectTransactionsData>(['project', project.id, 'transactions', qs], `/api/projects/${project.id}/transactions?${qs}`);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('projects.tx.wbs')}>
          {(id) => (
            <Select id={id} value={wbs} onChange={(e) => setWbs(e.target.value)} className="w-64">
              <option value="">{t('projects.tx.allWbs')}</option>
              <option value={UNASSIGNED}>{t('projects.tx.unassigned')}</option>
              {(wbsData?.wbs ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />}</Field>
      </div>

      {isPending || !data ? (
        <PageLoading />
      ) : data.total === 0 ? (
        <Card>
          <EmptyState title={t('projects.tx.empty')} description={t('projects.tx.emptyDesc')} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label={t('projects.tx.count')}>{data.total}</Stat>
            <Stat label={t('projects.tx.cost')} sub={base}>
              {money(data.costNet)}
            </Stat>
            <Stat label={t('projects.tx.revenue')} sub={base}>
              {money(data.revenueNet)}
            </Stat>
          </div>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('common.date')}</Th>
                  <Th className="w-36">{t('projects.tx.entry')}</Th>
                  <Th>{t('projects.tx.account')}</Th>
                  <Th>{t('projects.cols.wbs')}</Th>
                  <Th num>{t('common.debit')}</Th>
                  <Th num>{t('common.credit')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((x) => (
                  <Tr key={x.lineId}>
                    <Td className="text-muted">{formatDateTR(x.date)}</Td>
                    <Td>
                      <Link className="link font-mono text-[13px]" to={`/accounting/journal?open=${x.entryId}`}>
                        {x.entryNo ?? '—'}
                      </Link>
                      {x.reversalOfId && <Badge className="ml-2">{t('projects.tx.reversal')}</Badge>}
                    </Td>
                    <Td>
                      <span className="block truncate">
                        <span className="font-mono text-[13px] text-muted">{x.accountCode}</span> {x.accountName}
                      </span>
                      {x.description && <span className="block truncate text-xs text-muted">{x.description}</span>}
                    </Td>
                    <Td>{x.wbsCode ? <span className="font-mono text-[13px]">{x.wbsCode}</span> : <span className="text-warning">{t('projects.tx.unassigned')}</span>}</Td>
                    <Td num>{isZero(x.debitBase) ? '' : money(x.debitBase)}</Td>
                    <Td num>{isZero(x.creditBase) ? '' : money(x.creditBase)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          {data.transactions.length < data.total && (
            <div className="flex justify-center">
              <Button onClick={() => setLimit((l) => l + PAGE)}>{t('common.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
