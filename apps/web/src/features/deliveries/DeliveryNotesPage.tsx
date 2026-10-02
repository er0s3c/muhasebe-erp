import { Plus, Search, Truck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { DeliveryInvoicing, DeliveryNoteListRow, DeliveryNoteStatus, DeliveryNoteType, DeliverySummary } from '../../lib/types';
import { DeliveryInvoicingBadge, DeliveryStatusBadge } from './common';
import { NOTE_LIST } from './DeliveryNoteForm';

const PAGE = 100;

export const SalesDeliveryNotesPage = () => <DeliveryNotesPage type="sales" />;
export const PurchaseDeliveryNotesPage = () => <DeliveryNotesPage type="purchase" />;
export const SalesReturnNotesPage = () => <DeliveryNotesPage type="sales_return" />;
export const PurchaseReturnNotesPage = () => <DeliveryNotesPage type="purchase_return" />;

const INVOICING_VALUES = ['open', 'partial', 'invoiced'] as const;

function DeliveryNotesPage({ type }: { type: DeliveryNoteType }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const company = useCompany();
  const canManage = useCan()('deliveries.manage');
  const [params] = useSearchParams();
  const year = todayIso().slice(0, 4);
  const initialInvoicing = (INVOICING_VALUES as readonly string[]).includes(params.get('invoicing') ?? '') ? (params.get('invoicing') as DeliveryInvoicing) : '';
  const side = NOTE_LIST[type].key;
  /** Bekleyen (faturalanmamış) özet yalnızca satış/alış irsaliyesi için; iade irsaliyelerinde yok. */
  const summarySide = type === 'sales' ? 'sales' : type === 'purchase' ? 'purchases' : null;
  const isReturn = type === 'sales_return' || type === 'purchase_return';

  const [status, setStatus] = useState<DeliveryNoteStatus | ''>('');
  const [invoicing, setInvoicing] = useState<DeliveryInvoicing | ''>(initialInvoicing);
  // Bekleyen (faturalanmamış) irsaliyeler yıl sınırı olmadan listelenir
  const [from, setFrom] = useState(initialInvoicing ? '' : `${year}-01-01`);
  const [to, setTo] = useState(initialInvoicing ? '' : `${year}-12-31`);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setLimit(PAGE), [type, status, invoicing, from, to, query]);

  const qs = new URLSearchParams({ type, limit: String(limit) });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (status) qs.set('status', status);
  if (invoicing) qs.set('invoicing', invoicing);
  if (query) qs.set('query', query);
  const { data, isPending } = useCQuery<{ notes: DeliveryNoteListRow[]; total: number }>(['delivery-notes', 'list', qs.toString()], `/api/delivery-notes?${qs}`);
  const { data: summary } = useCQuery<DeliverySummary>(['delivery-summary'], '/api/delivery-notes/summary');
  const filtered = !!(status || invoicing || query);
  const open = summarySide ? summary?.[summarySide] : undefined;

  const newButton = (
    <Button variant="primary" onClick={() => navigate(`/delivery-notes/new?type=${type}`)}>
      <Plus className="size-4" aria-hidden />
      {t(`deliveries.newType.${type}`)}
    </Button>
  );

  return (
    <>
      <PageHeader title={t(`deliveries.${side}.title`)} description={t(`deliveries.${side}.subtitle`)} actions={canManage && newButton} />

      {open && open.openCount > 0 && (
        <div className="mb-5">
          <Callout
            tone="warning"
            title={t('deliveries.pending.title')}
            action={
              invoicing !== 'open' ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setInvoicing('open');
                    setFrom('');
                    setTo('');
                    setStatus('');
                  }}
                >
                  {t('deliveries.pending.show')}
                </Button>
              ) : undefined
            }
          >
            {t('deliveries.pending.summary', { count: open.openCount, value: moneyIn(open.openValue.replace('-', ''), company.baseCurrency) })}
          </Callout>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.status')}>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as DeliveryNoteStatus | '')} className="w-40">
              <option value="">{t('deliveries.allStatuses')}</option>
              {(['draft', 'posted', 'cancelled'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`deliveries.status.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('deliveries.invoicingCol')}>
          {(id) => (
            <Select id={id} value={invoicing} onChange={(e) => setInvoicing(e.target.value as DeliveryInvoicing | '')} className="w-52">
              <option value="">{t('deliveries.allInvoicing')}</option>
              {INVOICING_VALUES.map((s) => (
                <option key={s} value={s}>
                  {t(`deliveries.invoicing.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" aria-hidden />
          <Input className="pl-9" placeholder={t('deliveries.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('common.search')} />
        </div>
      </div>

      {isPending ? (
        <PageLoading />
      ) : !data?.notes.length ? (
        <Card>
          <EmptyState
            icon={<Truck className="size-5" />}
            title={filtered ? t('common.noResults') : t(`deliveries.${side}.empty`)}
            description={filtered ? undefined : t(`deliveries.${side}.emptyDesc`)}
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
                  <Th className="w-44">{t('deliveries.number')}</Th>
                  <Th>{t('deliveries.party')}</Th>
                  <Th className="w-40">{t('deliveries.warehouse')}</Th>
                  <Th className="w-24" num>
                    {t('deliveries.lineCol')}
                  </Th>
                  <Th className="w-40">{isReturn ? t('deliveries.creditCol') : t('deliveries.invoicingCol')}</Th>
                  <Th className="w-28">{t('common.status')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.notes.map((r) => (
                  <Tr
                    key={r.id}
                    clickable
                    tabIndex={0}
                    onClick={() => navigate(`/delivery-notes/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/delivery-notes/${r.id}`);
                    }}
                  >
                    <Td>{formatDateTR(r.noteDate)}</Td>
                    <Td>
                      <span className="font-mono text-[13px]">{r.noteNo ?? '—'}</span>
                      {r.externalNo && <span className="block text-xs text-muted">{r.externalNo}</span>}
                    </Td>
                    <Td className="max-w-xs">
                      <span className="block truncate">{r.partyName}</span>
                      {r.description && <span className="block truncate text-xs text-muted">{r.description}</span>}
                    </Td>
                    <Td className="text-muted">{r.warehouseName}</Td>
                    <Td num className="text-muted">
                      {r.lineCount}
                    </Td>
                    <Td>
                      <DeliveryInvoicingBadge state={r.invoicing} />
                    </Td>
                    <Td>
                      <DeliveryStatusBadge status={r.status} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          {data.total > data.notes.length && (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => setLimit((l) => l + PAGE)}>{t('common.loadMore')}</Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
