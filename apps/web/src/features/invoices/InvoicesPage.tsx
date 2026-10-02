import { Layers, Plus, Receipt, Search, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { invoiceTypesOf, todayIso, type InvoiceSide } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { cn } from '../../lib/cn';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { InvoiceListRow, InvoiceStatus, InvoiceType } from '../../lib/types';
import { ImportWizard } from '../imports/ImportWizard';
import { InvoiceStatusBadge, InvoiceTypeBadge } from './common';

const PAGE = 100;

export const SalesInvoicesPage = () => <InvoicesPage side="sales" />;
export const PurchaseInvoicesPage = () => <InvoicesPage side="purchases" />;

function InvoicesPage({ side }: { side: InvoiceSide }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('invoices.manage');
  const [importing, setImporting] = useState(false);
  const year = todayIso().slice(0, 4);
  const types = invoiceTypesOf(side);
  const [type, setType] = useState<InvoiceType | ''>('');
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setLimit(PAGE), [side, type, status, from, to, query]);
  useEffect(() => setType(''), [side]);

  const qs = new URLSearchParams({ side, from, to, limit: String(limit) });
  if (type) qs.set('type', type);
  if (status) qs.set('status', status);
  if (query) qs.set('query', query);
  const { data, isPending } = useCQuery<{ invoices: InvoiceListRow[]; total: number }>(['invoices', 'list', qs.toString()], `/api/invoices?${qs}`);
  const filtered = !!(type || status || query);

  const newButtons = types.map((k, i) => (
    <Button key={k} variant={i === 0 ? 'primary' : 'secondary'} onClick={() => navigate(`/invoices/new?type=${k}`)}>
      <Plus className="size-4" aria-hidden />
      {t(`invoices.newType.${k}`)}
    </Button>
  ));

  return (
    <>
      <PageHeader
        title={t(`invoices.${side}.title`)}
        description={t(`invoices.${side}.subtitle`)}
        actions={
          canManage && (
            <>
              <Button variant="secondary" onClick={() => setImporting(true)}>
                <Upload className="size-4" aria-hidden />
                {t('invoices.importExcel')}
              </Button>
              {side === 'sales' && (
                <Link to="/invoices/batch">
                  <Button variant="secondary" tabIndex={-1}>
                    <Layers className="size-4" aria-hidden />
                    {t('batch.title')}
                  </Button>
                </Link>
              )}
              {newButtons}
            </>
          )
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <SegmentedTabs
          value={type}
          onChange={setType}
          items={[{ key: '' as const, label: t('invoices.allTypes') }, ...types.map((k) => ({ key: k, label: t(`invoices.types.${k}`) }))]}
        />
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.status')}>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')} className="w-40">
              <option value="">{t('invoices.allStatuses')}</option>
              {(['draft', 'posted', 'cancelled'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`invoices.status.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" aria-hidden />
          <Input className="pl-9" placeholder={t('invoices.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('common.search')} />
        </div>
      </div>

      {isPending ? (
        <PageLoading />
      ) : !data?.invoices.length ? (
        <Card>
          <EmptyState
            icon={<Receipt className="size-5" />}
            title={filtered ? t('common.noResults') : t(`invoices.${side}.empty`)}
            description={filtered ? undefined : t(`invoices.${side}.emptyDesc`)}
            action={canManage && !filtered ? newButtons[0] : undefined}
          />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('common.date')}</Th>
                  <Th className="w-44">{t('invoices.number')}</Th>
                  <Th>{t('invoices.party')}</Th>
                  <Th className="w-28">{t('invoices.dueDate')}</Th>
                  <Th num>{t('invoices.grossTotal')}</Th>
                  <Th className="w-28">{t('common.status')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((r) => (
                  <Tr
                    key={r.id}
                    clickable
                    tabIndex={0}
                    onClick={() => navigate(`/invoices/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/invoices/${r.id}`);
                    }}
                  >
                    <Td>{formatDateTR(r.invoiceDate)}</Td>
                    <Td>
                      <span className="font-mono text-[13px]">{r.invoiceNo ?? '—'}</span>
                      {!type && (
                        <span className="ml-2">
                          <InvoiceTypeBadge type={r.type} />
                        </span>
                      )}
                      {r.externalNo && <span className="block text-xs text-muted">{r.externalNo}</span>}
                    </Td>
                    <Td className="max-w-xs">
                      <span className="block truncate">{r.partyName}</span>
                      {r.description && <span className="block truncate text-xs text-muted">{r.description}</span>}
                    </Td>
                    <Td className="text-muted">{r.dueDate ? formatDateTR(r.dueDate) : '—'}</Td>
                    <Td num className={cn(r.status === 'cancelled' && 'text-muted line-through')}>
                      {moneyIn(r.grossTotal, r.currencyCode)}
                    </Td>
                    <Td>
                      <InvoiceStatusBadge status={r.status} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          {data.total > data.invoices.length && (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => setLimit((l) => l + PAGE)}>{t('common.loadMore')}</Button>
            </div>
          )}
        </>
      )}
      <ImportWizard kind={side === 'sales' ? 'sales_invoices' : 'purchase_invoices'} open={importing} onOpenChange={setImporting} />
    </>
  );
}
