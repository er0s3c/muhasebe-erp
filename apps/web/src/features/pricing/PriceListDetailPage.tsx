import { ArrowLeft, Copy, Percent, Plus, Power, Star, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parseTR } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, formatMoney } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { PriceListItemRow, PriceListRow } from '../../lib/types';
import { qtyText } from '../inventory/common';
import { KindBadge, PRICING_INVALIDATE, trimNum, useAllItemOptions } from './common';

type Dialog = null | 'row' | 'copy' | 'adjust' | 'import' | 'delete';

/** Bir fiyat listesinin satırları: kalem × miktar kademesi × geçerlilik; kopyala, yüzde ayarı, yapıştırarak toplu giriş, dışa aktar. */
export function PriceListDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const canManage = useCan()('invoices.manage');
  const { data, isPending, error } = useCQuery<{ list: PriceListRow }>(['price-list', id], id ? `/api/price-lists/${id}` : null);
  const rows = useCQuery<{ items: PriceListItemRow[]; total: number }>(['price-list-items', id], id ? `/api/price-lists/${id}/items?limit=1000` : null);
  const { options } = useAllItemOptions(canManage);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [row, setRow] = useState({ itemId: '', minQty: '', price: '', validFrom: '', validTo: '' });
  const [copy, setCopy] = useState({ code: '', name: '', adjustPct: '' });
  const [adjustPct, setAdjustPct] = useState('');
  const [paste, setPaste] = useState('');

  const patchList = useCMutation((body: Record<string, unknown>, call) => call(`/api/price-lists/${id}`, { method: 'PUT', body }), PRICING_INVALIDATE);
  const addRow = useCMutation(
    (_: void, call) =>
      call(`/api/price-lists/${id}/items`, {
        method: 'POST',
        body: { itemId: row.itemId, price: row.price, minQty: row.minQty || '0', validFrom: row.validFrom || null, validTo: row.validTo || null },
      }),
    PRICING_INVALIDATE,
  );
  const delRow = useCMutation((rowId: string, call) => call(`/api/price-lists/${id}/items/${rowId}`, { method: 'DELETE' }), PRICING_INVALIDATE);
  const doCopy = useCMutation(
    (_: void, call) => call<{ list: PriceListRow }>(`/api/price-lists/${id}/copy`, { method: 'POST', body: { code: copy.code.trim(), name: copy.name.trim(), ...(copy.adjustPct ? { adjustPct: copy.adjustPct } : {}) } }),
    PRICING_INVALIDATE,
  );
  const doAdjust = useCMutation((_: void, call) => call<{ updated: number }>(`/api/price-lists/${id}/adjust`, { method: 'POST', body: { pct: adjustPct } }), PRICING_INVALIDATE);
  const doImport = useCMutation(
    (bodyRows: unknown[], call) => call<{ created: number; updated: number; unknown: string[] }>(`/api/price-lists/${id}/items/bulk`, { method: 'POST', body: { rows: bodyRows } }),
    PRICING_INVALIDATE,
  );
  const remove = useCMutation((_: void, call) => call(`/api/price-lists/${id}`, { method: 'DELETE' }), PRICING_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t('pricing.lists.notFound')}
        action={
          <Link to="/price-lists">
            <Button>{t('pricing.lists.back')}</Button>
          </Link>
        }
      />
    );
  }
  if (isPending || !data) return <PageLoading />;
  const list = data.list;
  const fail = (e: Error) => setFormError(errorMessage(e));
  const close = () => {
    setDialog(null);
    setFormError(null);
  };

  /** "STOK KODU; en az miktar; fiyat" satırları (miktar boş olabilir). Sayılar Türkçe yazılabilir ("1.250,50"); ayrıştırılamayan hücre olduğu gibi gider ve sunucu satır hatası döner. */
  const parsePaste = () =>
    paste
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(/[;\t]/).map((p) => p.trim());
        const n = (v: string | undefined) => (v === undefined || v === '' ? v : (parseTR(v) ?? v));
        const [code, a, b] = [parts[0], n(parts[1]), n(parts[2])];
        return b === undefined ? { itemCode: code!, price: a ?? '' } : { itemCode: code!, minQty: a || '0', price: b };
      });

  return (
    <>
      <Link to="/price-lists" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text print:hidden">
        <ArrowLeft className="size-4" aria-hidden />
        {t('pricing.lists.back')}
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-heading">{list.name}</h1>
            <KindBadge kind={list.kind} />
            <Badge>{list.currencyCode}</Badge>
            {list.isDefault && <Badge tone="brand">{t('pricing.lists.default')}</Badge>}
            {!list.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono">{list.code}</span> ·{' '}
            {list.validFrom || list.validTo ? `${list.validFrom ? formatDateTR(list.validFrom) : '…'} – ${list.validTo ? formatDateTR(list.validTo) : '…'}` : t('pricing.lists.always')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu exportKey="price-list-items" params={{ listId: list.id }} print={false} />
          {canManage && (
            <>
              <Button size="sm" onClick={() => setDialog('import')}>
                <Upload className="size-3.5" aria-hidden />
                {t('pricing.detail.import')}
              </Button>
              <Button size="sm" onClick={() => setDialog('adjust')}>
                <Percent className="size-3.5" aria-hidden />
                {t('pricing.detail.adjust')}
              </Button>
              <Button size="sm" onClick={() => setDialog('copy')}>
                <Copy className="size-3.5" aria-hidden />
                {t('pricing.detail.copy')}
              </Button>
              {list.isActive && !list.isDefault && (
                <Button size="sm" onClick={() => patchList.mutate({ isDefault: true }, { onSuccess: () => toast.success(t('pricing.lists.saved')), onError: (e) => toast.error(errorMessage(e)) })}>
                  <Star className="size-3.5" aria-hidden />
                  {t('pricing.lists.makeDefault')}
                </Button>
              )}
              <Button size="sm" onClick={() => patchList.mutate({ isActive: !list.isActive }, { onSuccess: () => toast.success(t('pricing.lists.saved')), onError: (e) => toast.error(errorMessage(e)) })}>
                <Power className="size-3.5" aria-hidden />
                {list.isActive ? t('pricing.detail.deactivate') : t('pricing.detail.activate')}
              </Button>
              <Button size="sm" variant="ghost" aria-label={t('pricing.detail.delete')} onClick={() => setDialog('delete')}>
                <Trash2 className="size-3.5 text-danger" aria-hidden />
              </Button>
            </>
          )}
        </div>
      </div>

      <Card>
        <CardHeader
          title={t('pricing.detail.rows')}
          description={t('pricing.detail.rowsHint')}
          action={
            canManage ? (
              <Button size="sm" variant="primary" onClick={() => { setRow({ itemId: '', minQty: '', price: '', validFrom: '', validTo: '' }); setDialog('row'); }}>
                <Plus className="size-3.5" aria-hidden />
                {t('pricing.detail.addRow')}
              </Button>
            ) : undefined
          }
        />
        {!rows.data?.items.length ? (
          <EmptyState title={t('pricing.detail.empty')} />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('pricing.detail.item')}</Th>
                  <Th num>{t('pricing.detail.minQty')}</Th>
                  <Th num>{t('pricing.detail.price')}</Th>
                  <Th>{t('pricing.detail.validity')}</Th>
                  {canManage && <Th className="w-12" />}
                </tr>
              </thead>
              <tbody>
                {rows.data.items.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      <span className="font-mono text-[13px]">{r.itemCode}</span> {r.itemName}
                    </Td>
                    <Td num>{qtyText(r.minQty) || '0'}</Td>
                    <Td num>{formatMoney(trimNum(r.price), list.currencyCode, 6)}</Td>
                    <Td className="text-muted">{r.validFrom || r.validTo ? `${r.validFrom ? formatDateTR(r.validFrom) : '…'} – ${r.validTo ? formatDateTR(r.validTo) : '…'}` : t('pricing.lists.always')}</Td>
                    {canManage && (
                      <Td>
                        <Button size="sm" variant="ghost" aria-label={`${t('pricing.detail.deleteRow')}: ${r.itemCode}`} onClick={() => delRow.mutate(r.id, { onError: (e) => toast.error(errorMessage(e)) })}>
                          <Trash2 className="size-3.5 text-danger" aria-hidden />
                        </Button>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={dialog === 'row'}
        onOpenChange={(o) => !o && close()}
        title={t('pricing.detail.addRow')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={addRow.isPending}
              disabled={!row.itemId || row.price === ''}
              onClick={() => addRow.mutate(undefined, { onSuccess: () => { toast.success(t('pricing.detail.rowAdded')); close(); }, onError: fail })}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && <Callout tone="danger">{formError}</Callout>}
          <Field label={t('pricing.detail.item')} required>
            {(fid) => <Combobox id={fid} options={options} value={row.itemId || null} placeholder={t('pricing.detail.pickItem')} onChange={(v) => setRow({ ...row, itemId: v })} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('pricing.detail.price')} required>
              {(fid) => <MoneyInput id={fid} value={row.price} maxDecimals={6} onChange={(v) => setRow({ ...row, price: v })} />}
            </Field>
            <Field label={t('pricing.detail.minQty')} hint={t('pricing.detail.minQtyHint')}>
              {(fid) => <MoneyInput id={fid} value={row.minQty} decimals={0} maxDecimals={4} onChange={(v) => setRow({ ...row, minQty: v })} />}
            </Field>
            <Field label={t('pricing.lists.validFrom')}>{(fid) => <Input id={fid} type="date" value={row.validFrom} onChange={(e) => setRow({ ...row, validFrom: e.target.value })} />}</Field>
            <Field label={t('pricing.lists.validTo')}>{(fid) => <Input id={fid} type="date" value={row.validTo} min={row.validFrom || undefined} onChange={(e) => setRow({ ...row, validTo: e.target.value })} />}</Field>
          </div>
        </div>
      </Modal>

      <Modal
        open={dialog === 'copy'}
        onOpenChange={(o) => !o && close()}
        title={t('pricing.detail.copy')}
        description={t('pricing.detail.copyHint')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={doCopy.isPending}
              disabled={!copy.code.trim() || copy.name.trim().length < 2}
              onClick={() => doCopy.mutate(undefined, { onSuccess: (res) => { toast.success(t('pricing.lists.created')); close(); navigate(`/price-lists/${res.list.id}`); }, onError: fail })}
            >
              {t('pricing.detail.copy')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && <Callout tone="danger">{formError}</Callout>}
          <Field label={t('pricing.lists.code')} required>{(fid) => <Input id={fid} value={copy.code} maxLength={20} onChange={(e) => setCopy({ ...copy, code: e.target.value })} />}</Field>
          <Field label={t('pricing.lists.name')} required>{(fid) => <Input id={fid} value={copy.name} maxLength={120} onChange={(e) => setCopy({ ...copy, name: e.target.value })} />}</Field>
          <Field label={t('pricing.detail.adjustPct')} hint={t('pricing.detail.adjustHint')}>
            {(fid) => <MoneyInput id={fid} value={copy.adjustPct} placeholder="10" onChange={(v) => setCopy({ ...copy, adjustPct: v })} decimals={0} maxDecimals={4} />}
          </Field>
        </div>
      </Modal>

      <Modal
        open={dialog === 'adjust'}
        onOpenChange={(o) => !o && close()}
        title={t('pricing.detail.adjust')}
        description={t('pricing.detail.adjustHint')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={doAdjust.isPending}
              disabled={!/^-?\d+(\.\d+)?$/.test(adjustPct)}
              onClick={() => doAdjust.mutate(undefined, { onSuccess: (res) => { toast.success(t('pricing.detail.adjusted', { n: res.updated })); close(); }, onError: fail })}
            >
              {t('pricing.detail.apply')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && <Callout tone="danger">{formError}</Callout>}
          <Field label={t('pricing.detail.adjustPct')}>
            {(fid) => <MoneyInput id={fid} value={adjustPct} placeholder="-5" onChange={(v) => setAdjustPct(v)} decimals={0} maxDecimals={4} />}
          </Field>
        </div>
      </Modal>

      <Modal
        open={dialog === 'import'}
        onOpenChange={(o) => !o && close()}
        title={t('pricing.detail.import')}
        description={t('pricing.detail.importHint')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={doImport.isPending}
              disabled={!paste.trim()}
              onClick={() =>
                doImport.mutate(parsePaste(), {
                  onSuccess: (res) => {
                    toast.success(t('pricing.detail.imported', { created: res.created, updated: res.updated }));
                    if (res.unknown.length) toast.error(t('pricing.detail.unknownItems', { list: res.unknown.join(', ') }));
                    setPaste('');
                    close();
                  },
                  onError: fail,
                })
              }
            >
              {t('pricing.detail.importRun')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {formError && <Callout tone="danger">{formError}</Callout>}
          <Textarea value={paste} rows={8} className="font-mono" aria-label={t('pricing.detail.import')} placeholder={'ST-000001; 125,50\nST-000002; 10; 99'} onChange={(e) => setPaste(e.target.value)} />
        </div>
      </Modal>

      <Modal
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && close()}
        title={t('pricing.detail.delete')}
        description={t('pricing.detail.deleteConfirm')}
        footer={
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => { toast.success(t('pricing.lists.deleted')); navigate('/price-lists', { replace: true }); }, onError: (e) => { close(); toast.error(errorMessage(e)); } })}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  );
}
