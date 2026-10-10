import { ArrowDownToLine, ArrowUpFromLine, Pencil, Power, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Stat } from '../../components/ui/Stat';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { SegmentedTabs, TabPanel } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCanOperation, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ItemDetail, ItemStatementData } from '../../lib/types';
import { DocTypeBadge, STOCK_INVALIDATE, qtyText, useUnitLabel, useWarehouses } from './common';
import { ItemFormSheet } from './ItemFormSheet';
import { MovementDetailSheet } from './MovementDetailSheet';
import { MovementFormSheet, type MovementType } from './MovementFormSheet';

type Tab = 'statement' | 'warehouses' | 'card';

export function ItemDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const company = useCompany();
  const unitLabel = useUnitLabel();
  const can = useCan();
  const canOperation = useCanOperation();
  const canManage = can('inventory.manage') && canOperation('core.inventory', 'update');
  const canMove = can('inventory.move');
  const { data, isPending, error } = useCQuery<ItemDetail>(['item', id], id ? `/api/items/${id}` : null);
  const [tab, setTab] = useState<Tab>('statement');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [move, setMove] = useState<MovementType | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);

  const toggleActive = useCMutation((v: { isActive: boolean }, call) => call(`/api/items/${id}`, { method: 'PATCH', body: v }), STOCK_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/items/${id}`, { method: 'DELETE' }), STOCK_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t('errors.NOT_FOUND' as never, { defaultValue: 'Stok kartı bulunamadı' })}
        action={
          <Link to="/inventory/items">
            <Button>{t('inventory.detail.back')}</Button>
          </Link>
        }
      />
    );
  }
  if (isPending || !data) return <PageLoading />;

  const { item, stock } = data;
  const goods = item.kind === 'goods';
  const unit = unitLabel(item.unit);

  return (
    <>
      <PageHeader
        title={item.name}
        helpKey="item-detail"
        back={{ to: '/inventory/items', label: t('inventory.detail.back') }}
        recent={{ kind: 'Stok kartı' }}
        eyebrow={
          <span className="normal-case tracking-normal">
            <span className="font-mono">{item.code}</span>
            {item.categoryName && <span> · {item.categoryName}</span>}
          </span>
        }
        meta={
          <>
            {!goods && <Badge>{t('inventory.kinds.service')}</Badge>}
            {item.tracksSerial && (
              <Link to={`/inventory/serials?itemId=${item.id}`} aria-label={t('serials.tracked')}>
                <Badge tone="brand">{t('serials.tracked')}</Badge>
              </Link>
            )}
            {!item.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
            {stock.isLow && <Badge tone="warning" dot>{t('inventory.detail.lowBadge')}</Badge>}
          </>
        }
        actions={
          <>
          {canMove && goods && item.isActive && (
            <>
              <Button onClick={() => setMove('receipt')}>
                <ArrowDownToLine className="size-4" aria-hidden />
                {t('inventory.detail.quickIn')}
              </Button>
              <Button onClick={() => setMove('issue')}>
                <ArrowUpFromLine className="size-4" aria-hidden />
                {t('inventory.detail.quickOut')}
              </Button>
            </>
          )}
          {canManage && (
            <Button onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              {t('common.edit')}
            </Button>
          )}
          </>
        }
      />

      {goods && (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <Stat
            label={t('inventory.detail.onHand')}
            sub={item.minLevel ? t('inventory.detail.minLevel', { level: qtyText(item.minLevel), unit }) : undefined}
          >
            <span className={cn(stock.isLow && 'text-warning')}>
              {qtyText(stock.qty) || '0'} {unit}
            </span>
          </Stat>
          <Stat label={t('inventory.detail.avgCost')}>{stock.avgCost ? moneyIn(stock.avgCost, company.baseCurrency) : '—'}</Stat>
          <Stat label={t('inventory.detail.value')}>
            {moneyIn(stock.value, company.baseCurrency)}
          </Stat>
        </div>
      )}

      <SegmentedTabs id="inventory-ItemDetailPage-0" panelId={() => 'inventory-ItemDetailPage-0-panel'}
        className="mb-5"
        value={goods ? tab : 'card'}
        onChange={setTab}
        items={(goods ? (['statement', 'warehouses', 'card'] as const) : (['card'] as const)).map((k) => ({ key: k, label: t(`inventory.detail.tabs.${k}`) }))}
      />

      <TabPanel id="inventory-ItemDetailPage-0-panel" labelledBy={"inventory-ItemDetailPage-0-" + (goods ? tab : 'card')}>
{goods && tab === 'statement' && <StatementTab itemId={item.id} unit={unit} onOpenDoc={setOpenDoc} />}
      {goods && tab === 'warehouses' && (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('inventory.detail.warehouse')}</Th>
                <Th num>{t('inventory.detail.warehouseQty')}</Th>
              </tr>
            </thead>
            <tbody>
              {stock.byWarehouse.map((w) => (
                <Tr key={w.warehouseId}>
                  <Td>
                    <span>{w.name}</span>
                    <span className="ml-2 font-mono text-xs text-muted">{w.code}</span>
                  </Td>
                  <Td num>
                    {qtyText(w.qty) || '0'} {unit}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {(tab === 'card' || !goods) && (
        <Card>
          <CardHeader
            title={t('inventory.detail.tabs.card')}
            action={
              canManage ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    loading={toggleActive.isPending}
                    onClick={() =>
                      toggleActive.mutate({ isActive: !item.isActive }, { onSuccess: () => toast.success(t('inventory.items.updated')), onError: (e) => toast.error(errorMessage(e)) })
                    }
                  >
                    <Power className="size-3.5" aria-hidden />
                    {item.isActive ? t('inventory.detail.deactivate') : t('inventory.detail.activate')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="size-3.5 text-danger" aria-hidden />
                    {t('inventory.detail.delete')}
                  </Button>
                </div>
              ) : undefined
            }
          />
          <dl className="grid gap-x-8 gap-y-5 p-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                [t('inventory.form.kind'), t(`inventory.kinds.${item.kind}`)],
                [t('inventory.form.unit'), unit],
                [t('inventory.form.barcode'), item.barcode],
                [t('inventory.form.vatCode'), item.vatCode],
                [t('inventory.form.purchasePrice'), item.purchasePrice ? moneyIn(item.purchasePrice, item.purchaseCurrency, 2) : null],
                [t('inventory.form.salePrice'), item.salePrice ? moneyIn(item.salePrice, item.saleCurrency, 2) : null],
                [t('inventory.form.minLevel'), item.minLevel ? `${qtyText(item.minLevel)} ${unit}` : null],
                [t('inventory.form.notes'), item.notes],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="mt-0.5">{value || <span className="font-normal text-muted">{t('inventory.detail.notProvided')}</span>}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <ItemFormSheet open={editing} onOpenChange={setEditing} item={item} onSaved={() => undefined} />
      <MovementFormSheet open={!!move} onOpenChange={(o) => !o && setMove(null)} initialType={move ?? 'receipt'} initialItemId={item.id} onSaved={(doc) => setOpenDoc(doc.document.id)} />
      <MovementDetailSheet id={openDoc} onClose={() => setOpenDoc(null)} onOpen={setOpenDoc} />

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('inventory.detail.delete')}
        description={t('inventory.detail.deleteConfirm')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('inventory.items.deleted'));
                    navigate('/inventory/items', { replace: true });
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
</TabPanel>
    </>
  );
}

function StatementTab({ itemId, unit, onOpenDoc }: { itemId: string; unit: string; onOpenDoc: (id: string) => void }) {
  const { t } = useTranslation();
  const company = useCompany();
  const { data: wh } = useWarehouses();
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [warehouseId, setWarehouseId] = useState('');
  const qs = new URLSearchParams({ from, to });
  if (warehouseId) qs.set('warehouseId', warehouseId);
  const { data, isPending, error } = useCQuery<ItemStatementData>(['item', itemId, 'statement', qs.toString()], `/api/items/${itemId}/movements?${qs}`, { enabled: Boolean(from && to) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
        <Field label={t('inventory.detail.warehouse')}>
          {(id) => (
            <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-52">
              <option value="">{t('inventory.detail.allWarehouses')}</option>
              {wh?.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="ml-auto">
          <ExportMenu exportKey="item-card" params={{ itemId, from, to, warehouseId }} print={false} disabled={!data} />
        </div>
      </div>
      {warehouseId && <Callout>{t('inventory.detail.valueNote')}</Callout>}
      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('common.date')}</Th>
                <Th>{t('inventory.detail.document')}</Th>
                <Th>{t('inventory.detail.warehouse')}</Th>
                <Th num>{t('inventory.detail.in')}</Th>
                <Th num>{t('inventory.detail.out')}</Th>
                <Th num>{t('inventory.detail.balanceQty')}</Th>
                <Th num>
                  {t('inventory.detail.balanceValue')} ({currencySymbol(company.baseCurrency)})
                </Th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-surface-2/60">
                <Td colSpan={5}>{t('inventory.detail.opening')}</Td>
                <Td num>
                  {qtyText(data.openingQty) || '0'} {unit}
                </Td>
                <Td num>{data.openingValue === null ? '' : money(data.openingValue)}</Td>
              </tr>
              {data.lines.length === 0 && (
                <tr>
                  <Td colSpan={7} className="py-8 text-center text-muted">
                    {t('inventory.detail.statementEmpty')}
                  </Td>
                </tr>
              )}
              {data.lines.map((l, i) => {
                const qty = Number(l.qty);
                return (
                  <Tr key={`${l.documentId}-${i}`} clickable onClick={() => onOpenDoc(l.documentId)}>
                    <Td className="whitespace-nowrap">{formatDateTR(l.date)}</Td>
                    <Td>
                      <span className="mr-2 font-mono text-[13px]">{l.docNo}</span>
                      {l.kind === 'cost_adjust' ? <Badge tone="warning">{t('inventory.detail.costAdjust')}</Badge> : <DocTypeBadge type={l.type} />}
                      {l.isReversal && <Badge className="ml-1">{t('inventory.detail.reversalTag')}</Badge>}
                    </Td>
                    <Td className="text-muted">{l.warehouseName}</Td>
                    <Td num>{qty > 0 ? qtyText(l.qty) : ''}</Td>
                    <Td num>{qty < 0 ? qtyText(String(Math.abs(qty))) : ''}</Td>
                    <Td num>
                      {qtyText(l.balanceQty) || '0'}
                    </Td>
                    <Td num>{l.balanceValue === null ? '' : money(l.balanceValue)}</Td>
                  </Tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2">
                <Td colSpan={5}>{t('inventory.detail.closing')}</Td>
                <Td num>
                  {qtyText(data.closingQty) || '0'} {unit}
                </Td>
                <Td num>{data.closingValue === null ? '' : money(data.closingValue)}</Td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
