import { Barcode } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { SerialLookup, SerialRow, SerialStatus } from '../../lib/types';
import { useWarehouses } from './common';

const TONE: Record<SerialStatus, 'success' | 'warning' | 'danger' | 'neutral'> = { in_stock: 'success', issued: 'warning', returned: 'neutral', scrapped: 'danger', void: 'neutral' };

export function SerialStatusBadge({ status }: { status: SerialStatus }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[status]}>{t(`serials.status.${status}`)}</Badge>;
}

/** Seri no sorgula: sicil listesi (kart/depo/durum süzgeçli) ve seçilen seri için tedarikçiden müşteriye tam geçmiş. */
export function SerialsPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const itemId = params.get('itemId') ?? '';
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const [status, setStatus] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [open, setOpen] = useState<SerialRow | null>(null);
  const { data: wh } = useWarehouses();

  const qs = new URLSearchParams({ limit: '200' });
  if (query.trim()) qs.set('query', query.trim());
  if (status) qs.set('status', status);
  if (warehouseId) qs.set('warehouseId', warehouseId);
  if (itemId) qs.set('itemId', itemId);
  const list = useCQuery<{ serials: SerialRow[]; total: number }>(['serials', qs.toString()], `/api/serials?${qs}`);
  const lookup = useCQuery<SerialLookup>(['serial', open?.serialNo, open?.itemId], open ? `/api/serials/lookup?serialNo=${encodeURIComponent(open.serialNo)}&itemId=${open.itemId}` : null);

  return (
    <>
      <PageHeader
        title={t('serials.title')}
        description={t('serials.subtitle')}
        actions={<ExportMenu exportKey="serials" params={{ query: query.trim(), status, warehouseId, itemId }} print={false} />}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label={t('serials.search')}>
          {(id) => <Input id={id} value={text} placeholder={t('serials.searchPlaceholder')} onChange={(e) => setText(e.target.value)} autoFocus />}
        </Field>
        <Field label={t('serials.statusLabel')}>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('serials.allStatuses')}</option>
              {(['in_stock', 'issued', 'returned', 'scrapped'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`serials.status.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('serials.warehouse')}>
          {(id) => (
            <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">{t('serials.allWarehouses')}</option>
              {(wh?.warehouses ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {itemId && (
        <p className="mb-3 text-sm text-muted">
          {t('serials.itemFiltered')}{' '}
          <Link to="/inventory/serials" className="link">
            {t('serials.clearItem')}
          </Link>
        </p>
      )}
      {list.isPending ? (
        <PageLoading />
      ) : !list.data?.serials.length ? (
        <Card>
          <EmptyState icon={<Barcode className="size-5" />} title={t('serials.empty')} description={t('serials.emptyHint')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('serials.serialNo')}</Th>
                <Th>{t('serials.item')}</Th>
                <Th>{t('serials.statusLabel')}</Th>
                <Th>{t('serials.warehouse')}</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.serials.map((s) => (
                <Tr key={s.id} clickable onClick={() => setOpen(s)}>
                  <Td className="font-mono text-[13px]">
                    <button className="link" onClick={() => setOpen(s)}>
                      {s.serialNo}
                    </button>
                  </Td>
                  <Td>
                    <span className="font-mono text-[13px]">{s.itemCode}</span> {s.itemName}
                  </Td>
                  <Td>
                    <SerialStatusBadge status={s.status} />
                  </Td>
                  <Td className="text-muted">{s.warehouseName ?? '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {list.data && list.data.total > list.data.serials.length && <p className="mt-2 text-sm text-muted">{t('serials.more', { shown: list.data.serials.length, total: list.data.total })}</p>}

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open ? t('serials.historyTitle', { no: open.serialNo }) : ''} wide>
        {!lookup.data ? (
          <PageLoading />
        ) : (
          lookup.data.serials.map((reg) => (
            <Card key={reg.id}>
              <CardHeader title={`${reg.itemCode} — ${reg.itemName}`} description={reg.warehouseName ? `${t('serials.warehouse')}: ${reg.warehouseName}` : undefined} action={<SerialStatusBadge status={reg.status} />} />
              <dl className="grid gap-4 p-5 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted">{t('serials.supplier')}</dt>
                  <dd>{reg.supplier ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t('serials.customer')}</dt>
                  <dd>{reg.customer ?? '—'}</dd>
                </div>
              </dl>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>{t('serials.hist.date')}</Th>
                      <Th>{t('serials.hist.event')}</Th>
                      <Th>{t('serials.hist.warehouse')}</Th>
                      <Th>{t('serials.hist.party')}</Th>
                      <Th>{t('serials.hist.document')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {reg.history.map((h) => (
                      <Tr key={h.id}>
                        <Td>{formatDateTR(h.docDate)}</Td>
                        <Td>{t(`serials.events.${h.event}` as never)}</Td>
                        <Td className="text-muted">{[h.fromWarehouse, h.toWarehouse].filter(Boolean).join(' → ') || '—'}</Td>
                        <Td>{h.partyName ?? '—'}</Td>
                        <Td className="text-muted">
                          {h.sourceNo ?? h.stockDocumentNo}
                          {h.sourceNo ? ` (${h.stockDocumentNo})` : ''}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            </Card>
          ))
        )}
      </Sheet>
    </>
  );
}
