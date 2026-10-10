import { Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { dec } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { FormGuard, markFormSaved } from '../../components/ui/UnsavedChanges';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { StockCountDetail } from '../../lib/types';
import { STOCK_INVALIDATE, qtyText, useItemOptions, useUnitLabel } from './common';
import { MovementDetailSheet } from './MovementDetailSheet';

/** "12.0000" -> "12"; "7.5000" -> "7.5" (MoneyInput kanonik değeri) */
const canon = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

interface Row {
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  counted: string;
}

export function CountEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const unitLabel = useUnitLabel();
  const canMove = useCan()('inventory.move');
  const { data, isPending, error } = useCQuery<StockCountDetail>(['stock-count', id], id ? `/api/stock-counts/${id}` : null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [confirmPost, setConfirmPost] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [zeroCost, setZeroCost] = useState<string[]>([]);
  const draft = data?.count.status === 'draft';
  const editable = draft && canMove;
  const { options, byId } = useItemOptions(!!editable, data?.count.warehouseId);

  // Sunucudan gelen satırlarla yerel düzenlemeyi eşle (kaydedilmemiş değişiklik yoksa)
  useEffect(() => {
    if (data && !dirty) {
      setRows(
        data.lines.map((l) => ({
          itemId: l.itemId,
          itemCode: l.itemCode,
          itemName: l.itemName,
          unit: l.unit,
          counted: l.countedQty === null ? '' : canon(l.countedQty),
        })),
      );
    }
    // dirty kasıtlı olarak bağımlılık dışında: kullanıcı düzenlerken sunucu verisi ezmemeli
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const stored = new Map((data?.lines ?? []).map((l) => [l.itemId, l.systemQty]));
  /** Taslakta sistem miktarı canlıdır (sunucu), sonradan eklenen kart için depo miktarı kart listesinden gelir. */
  const systemFor = (itemId: string): string | null => stored.get(itemId) ?? (draft ? (byId.get(itemId)?.onHand ?? '0') : null);

  const save = useCMutation(
    (_: void, call) =>
      call<StockCountDetail>(`/api/stock-counts/${id}`, {
        method: 'PUT',
        body: { lines: rows.map((r) => ({ itemId: r.itemId, countedQty: r.counted === '' ? null : r.counted })) },
      }),
    STOCK_INVALIDATE,
  );
  const post = useCMutation((_: void, call) => call<StockCountDetail>(`/api/stock-counts/${id}/post`, { method: 'POST' }), [...STOCK_INVALIDATE, ['dashboard']]);
  const remove = useCMutation((_: void, call) => call(`/api/stock-counts/${id}`, { method: 'DELETE' }), STOCK_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t('errors.NOT_FOUND' as never, { defaultValue: 'Sayım bulunamadı' })}
        action={
          <Link to="/inventory/counts">
            <Button>{t('inventory.count.back')}</Button>
          </Link>
        }
      />
    );
  }
  if (isPending || !data) return <PageLoading />;
  const { count, summary } = data;

  const saveNow = () =>
    save.mutate(undefined, {
      onSuccess: () => {
        setDirty(false);
        markFormSaved(document.querySelector('[data-form-guard-scope="CountEditorPage"]'));
        toast.success(t('inventory.count.saved'));
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const postNow = async () => {
    if (save.isPending || post.isPending || remove.isPending) return;
    try {
      if (dirty) {
        await save.mutateAsync();
        setDirty(false);
      }
      const res = await post.mutateAsync();
      setConfirmPost(false);
      markFormSaved(document.querySelector('[data-form-guard-scope="CountEditorPage"]'));
      toast.success(t('inventory.count.posted', { no: res.count.countNo }));
      if (res.warnings?.zeroCostItems.length) setZeroCost(res.warnings.zeroCostItems);
    } catch (e) {
      setConfirmPost(false);
      toast.error(errorMessage(e));
    }
  };

  const patchRow = (itemId: string, counted: string) => {
    setDirty(true);
    setRows((cur) => cur.map((r) => (r.itemId === itemId ? { ...r, counted } : r)));
  };
  const addItem = (itemId: string) => {
    const it = byId.get(itemId);
    if (!it || rows.some((r) => r.itemId === itemId)) return;
    setDirty(true);
    setRows((cur) => [...cur, { itemId, itemCode: it.code, itemName: it.name, unit: it.unit, counted: '' }]);
  };

  const diffOf = (r: Row): { text: string; tone: 'muted' | 'success' | 'danger' } => {
    if (r.counted === '') return { text: '', tone: 'muted' };
    const diff = dec(r.counted).minus(systemFor(r.itemId) ?? 0);
    if (diff.isZero()) return { text: '0', tone: 'muted' };
    return { text: `${diff.gt(0) ? '+' : '−'}${qtyText(diff.abs().toFixed(4))}`, tone: diff.gt(0) ? 'success' : 'danger' };
  };

  return (<FormGuard captureAll scopeKey="CountEditorPage" pending={save.isPending || post.isPending || remove.isPending}>{(
    <>
      <PageHeader
        title={count.countNo ?? t('inventory.count.draftTitle')}
        helpKey="count-editor"
        back={{ to: '/inventory/counts', label: t('inventory.count.back') }}
        recent={{ kind: 'Sayım' }}
        sticky={editable}
        meta={<Badge tone={draft ? 'warning' : 'success'}>{t(draft ? 'inventory.counts.draft' : 'inventory.counts.posted')}</Badge>}
        description={`${count.warehouseName} · ${formatDateTR(count.countDate)}${count.description ? ` · ${count.description}` : ''}`}
        actions={editable && (
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4 text-danger" aria-hidden />
              {t('inventory.count.delete')}
            </Button>
            <Button loading={save.isPending} disabled={!dirty} onClick={saveNow}>
              <Save className="size-4" aria-hidden />
              {t('inventory.count.save')}
            </Button>
            <Button variant="primary" disabled={rows.every((r) => r.counted === '')} onClick={() => setConfirmPost(true)}>
              {t('inventory.count.post')}
            </Button>
          </>
        )}
      />

      {zeroCost.length > 0 && (
        <div className="mb-4">
          <Callout tone="warning">{t('inventory.count.zeroCost', { codes: zeroCost.join(', ') })}</Callout>
        </div>
      )}

      {!draft && (
        <div className="mb-4 flex flex-col gap-3">
          {count.documentId ? (
            <Callout>
              {t('inventory.count.document')}:{' '}
              <button className="link" onClick={() => setOpenDoc(count.documentId)}>
                {count.documentNo}
              </button>
            </Callout>
          ) : (
            <Callout>{t('inventory.count.noDifference')}</Callout>
          )}
        </div>
      )}

      <p className="mb-3 text-sm text-muted">{t('inventory.count.summary', { counted: summary.counted, lines: summary.lines, surplus: summary.surplus, shortage: summary.shortage })}</p>

      {editable && (
        <div className="mb-4 max-w-md">
          <Combobox options={options.filter((o) => !rows.some((r) => r.itemId === o.value))} value={null} placeholder={t('inventory.count.pickItem')} aria-label={t('inventory.count.addItem')} onChange={addItem} />
        </div>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState title={t('inventory.count.emptyLines')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('inventory.count.item')}</Th>
                <Th num>{t('inventory.count.system')}</Th>
                <Th num className="w-44">
                  {t('inventory.count.counted')}
                </Th>
                <Th num>{t('inventory.count.diff')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const diff = diffOf(r);
                const sys = systemFor(r.itemId);
                return (
                  <Tr key={r.itemId}>
                    <Td>
                      <span>{r.itemName}</span>
                      <span className="ml-2 whitespace-nowrap font-mono text-xs text-muted">{r.itemCode}</span>
                    </Td>
                    <Td num className="text-muted">
                      {sys === null || sys === undefined ? '—' : `${qtyText(sys) || '0'} ${unitLabel(r.unit)}`}
                    </Td>
                    <Td num>
                      {editable ? (
                        <MoneyInput value={r.counted} decimals={0} maxDecimals={4} aria-label={`${t('inventory.count.counted')}: ${r.itemName}`} onChange={(v) => patchRow(r.itemId, v)} className="text-right" />
                      ) : (
                        <span>{r.counted === '' ? '—' : qtyText(r.counted)}</span>
                      )}
                    </Td>
                    <Td num className={cn('', diff.tone === 'success' && 'text-success', diff.tone === 'danger' && 'text-danger', diff.tone === 'muted' && 'text-muted')}>
                      {diff.text}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {editable && (
        <p className="mt-3 text-xs text-muted">
          {t('inventory.count.uncountedNote')} {t('inventory.count.systemNote')}
        </p>
      )}

      <MovementDetailSheet id={openDoc} onClose={() => setOpenDoc(null)} onOpen={setOpenDoc} />

      <Modal
        open={confirmPost}
        onOpenChange={setConfirmPost}
        title={t('inventory.count.postTitle')}
        description={t('inventory.count.postConfirm')}
        footer={
          <>
            <Button onClick={() => setConfirmPost(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={post.isPending || save.isPending} onClick={() => void postNow()}>
              {t('inventory.count.post')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('inventory.count.delete')}
        description={t('inventory.count.deleteConfirm')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('inventory.count.deleted'));
                    navigate('/inventory/counts', { replace: true });
                  },
                  onError: (e) => {
                    setConfirmDelete(false);
                    toast.error(errorMessage(e));
                  },
                })
              }
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  )}</FormGuard>);
}
