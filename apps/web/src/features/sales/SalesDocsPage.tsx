import { FileText, PackageCheck, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { SALES_DOC_STATUSES, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { SalesDocKind, SalesDocListRow, SalesDocStatus } from '../../lib/types';
import { FulfilmentBadges, SalesStatusBadge } from './common';

const PAGE = 100;
const STATUSES_OF: Record<SalesDocKind, readonly SalesDocStatus[]> = {
  quote: SALES_DOC_STATUSES.filter((s) => ['draft', 'sent', 'accepted', 'rejected', 'converted', 'cancelled'].includes(s)),
  order: SALES_DOC_STATUSES.filter((s) => ['draft', 'confirmed', 'closed', 'cancelled'].includes(s)),
};

export const SalesQuotesPage = () => <SalesDocsPage kind="quote" />;
export const SalesOrdersPage = () => <SalesDocsPage kind="order" />;

function SalesDocsPage({ kind }: { kind: SalesDocKind }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('invoices.manage');
  const year = todayIso().slice(0, 4);
  const [status, setStatus] = useState<SalesDocStatus | ''>('');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    setLimit(PAGE);
    setStatus('');
  }, [kind]);
  useEffect(() => setLimit(PAGE), [status, from, to, query]);

  const qs = new URLSearchParams({ kind, from, to, limit: String(limit) });
  if (status) qs.set('status', status);
  if (query) qs.set('query', query);
  const { data, isPending } = useCQuery<{ docs: SalesDocListRow[]; total: number }>(['sales-docs', 'list', qs.toString()], `/api/sales-docs?${qs}`);
  const filtered = !!(status || query);

  const newButton = (
    <Button variant="primary" onClick={() => navigate(`/sales/docs/new?kind=${kind}`)}>
      <Plus className="size-4" aria-hidden />
      {t(`sales.new.${kind}`)}
    </Button>
  );


  return (
    <>
      <PageHeader
        title={t(`sales.${kind}.title`)}
        description={t(`sales.${kind}.subtitle`)}
        actions={
          <>
            <ExportMenu exportKey="sales-docs" params={{ kind, from, to, status, query }} print={false} />
            {canManage && newButton}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.status')}>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as SalesDocStatus | '')} className="w-44">
              <option value="">{t('sales.allStatuses')}</option>
              {STATUSES_OF[kind].map((s) => (
                <option key={s} value={s}>
                  {t(`sales.status.${kind}.${s}` as never)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" aria-hidden />
          <Input className="pl-9" placeholder={t('sales.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('common.search')} />
        </div>
      </div>

      {isPending ? (
        <PageLoading />
      ) : !data?.docs.length ? (
        <Card>
          <EmptyState
            icon={kind === 'quote' ? <FileText className="size-5" /> : <PackageCheck className="size-5" />}
            title={filtered ? t('common.noResults') : t(`sales.${kind}.empty`)}
            description={filtered ? undefined : t(`sales.${kind}.emptyDesc`)}
            action={canManage && !filtered ? newButton : undefined}
          />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('common.date')}</Th>
                  <Th className="w-40">{t('sales.number')}</Th>
                  <Th>{t('sales.party')}</Th>
                  <Th className="w-28">{kind === 'quote' ? t('sales.validUntil') : t('sales.deliveryDate')}</Th>
                  <Th num>{t('sales.gross')}</Th>
                  <Th className="w-56">{kind === 'order' ? t('sales.progress') : t('common.status')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.docs.map((r) => (
                  <Tr
                    key={r.id}
                    clickable
                    tabIndex={0}
                    onClick={() => navigate(`/sales/docs/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/sales/docs/${r.id}`);
                    }}
                  >
                    <Td>{formatDateTR(r.docDate)}</Td>
                    <Td>
                      <span className="font-mono text-[13px]">{r.docNo ?? '—'}</span>
                    </Td>
                    <Td className="max-w-xs">
                      <span className="block truncate">{r.partyName}</span>
                    </Td>
                    <Td className="text-muted">{(kind === 'quote' ? r.validUntil : r.deliveryDate) ? formatDateTR((kind === 'quote' ? r.validUntil : r.deliveryDate)!) : '—'}</Td>
                    <Td num>{moneyIn(r.grossTotal, r.currencyCode)}</Td>
                    <Td>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <SalesStatusBadge status={r.status} kind={r.kind} expired={r.expired} />
                        {r.status === 'confirmed' && <FulfilmentBadges f={r.fulfilment} />}
                      </span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          {data.total > data.docs.length && (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => setLimit((l) => l + PAGE)}>{t('common.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
