import { ChevronRight, ClipboardCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { StockCountDetail, StockCountListRow } from '../../lib/types';
import { STOCK_INVALIDATE, useWarehouses } from './common';

export function CountsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const canMove = useCan()('inventory.move');
  const { data: wh } = useWarehouses();
  const { data, isPending } = useCQuery<{ counts: StockCountListRow[]; total: number }>(['stock-counts', 'list'], '/api/stock-counts?limit=200');
  const [creating, setCreating] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [prefill, setPrefill] = useState<'in_stock' | 'empty'>('in_stock');
  const [error, setError] = useState<string | null>(null);
  const warehouses = (wh?.warehouses ?? []).filter((w) => w.isActive);

  const openCreateModal = () => {
    setDate(todayIso());
    setDescription('');
    setPrefill('in_stock');
    setError(null);
    setWarehouseId((cur) => cur || (warehouses.find((w) => w.isDefault) ?? warehouses[0])?.id || '');
    setCreating(true);
  };

  const create = useCMutation(
    (_: void, call) =>
      call<StockCountDetail>('/api/stock-counts', {
        method: 'POST',
        body: { warehouseId, countDate: date, prefill, ...(description.trim() ? { description: description.trim() } : {}) },
      }),
    STOCK_INVALIDATE,
  );

  const submit = () =>
    create.mutate(undefined, {
      onSuccess: (res) => {
        toast.success(t('inventory.counts.created'));
        setCreating(false);
        navigate(`/inventory/counts/${res.count.id}`);
      },
      onError: (e) => setError(errorMessage(e)),
    });

  return (
    <>
      <PageHeader
        title={t('inventory.counts.title')}
        description={t('inventory.counts.subtitle')}
        actions={
          canMove && (
            <Button variant="primary" onClick={openCreateModal}>
              <Plus className="size-4" aria-hidden />
              {t('inventory.counts.add')}
            </Button>
          )
        }
      />

      {isPending ? (
        <PageLoading />
      ) : !data?.counts.length ? (
        <Card>
          <EmptyState
            icon={<ClipboardCheck className="size-5" />}
            title={t('inventory.counts.empty')}
            description={t('inventory.counts.emptyDesc')}
            action={
              canMove ? (
                <Button variant="primary" onClick={openCreateModal}>
                  <Plus className="size-4" aria-hidden />
                  {t('inventory.counts.add')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('inventory.counts.date')}</Th>
                  <Th className="w-40">{t('inventory.counts.no')}</Th>
                  <Th>{t('inventory.counts.warehouse')}</Th>
                  <Th num>{t('inventory.counts.progress')}</Th>
                  <Th className="w-32">{t('inventory.counts.status')}</Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {data.counts.map((c) => (
                  <Tr
                    key={c.id}
                    clickable
                    tabIndex={0}
                    onClick={() => navigate(`/inventory/counts/${c.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/inventory/counts/${c.id}`);
                    }}
                  >
                    <Td className="whitespace-nowrap">{formatDateTR(c.countDate)}</Td>
                    <Td className="whitespace-nowrap font-mono text-[13px]">{c.countNo ?? <span className="font-sans text-muted">{t('inventory.counts.draft')}</span>}</Td>
                    <Td>
                      <span>{c.warehouseName}</span>
                      {c.description && <span className="block truncate text-xs text-muted">{c.description}</span>}
                    </Td>
                    <Td num className="text-muted">
                      {c.countedCount}/{c.lineCount}
                    </Td>
                    <Td>
                      <Badge tone={c.status === 'posted' ? 'success' : 'warning'}>{t(c.status === 'posted' ? 'inventory.counts.posted' : 'inventory.counts.draft')}</Badge>
                    </Td>
                    <Td>
                      <ChevronRight className="size-4 text-muted" aria-hidden />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <div className="mt-3 text-sm text-muted">{t('inventory.counts.total', { count: data.total })}</div>
        </>
      )}

      <Modal
        open={creating}
        onOpenChange={setCreating}
        title={t('inventory.counts.newTitle')}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending} disabled={!warehouseId || !date} onClick={submit}>
              {t('inventory.counts.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Callout tone="danger">{error}</Callout>}
          <Field label={t('inventory.counts.warehouse')} required>
            {(id) => (
              <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('inventory.counts.date')} required>
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label={t('inventory.counts.description')}>
            {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />}
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-[13px]">{t('inventory.counts.prefill')}</legend>
            <div className="flex flex-col gap-2 text-sm">
              {(['in_stock', 'empty'] as const).map((k) => (
                <label key={k} className="flex cursor-pointer items-center gap-2">
                  <input type="radio" name="prefill" className="size-4" checked={prefill === k} onChange={() => setPrefill(k)} />
                  {k === 'in_stock' ? t('inventory.counts.prefillStock') : t('inventory.counts.prefillEmpty')}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Modal>
    </>
  );
}
