import { Boxes } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { isZero, money } from '../../lib/format';
import { useCQuery, useModuleEnabled } from '../../lib/queries';
import type { StockStatusReport } from '../../lib/types';
import { qtyText, useCategories, useUnitLabel, useWarehouses } from './common';

/** İrsaliye modülü (fatura modülüyle birlikte) kapalıysa bağlantı yerine düz metin. */
function PendingLink({ enabled, to, children }: { enabled: boolean; to: string; children: ReactNode }) {
  return enabled ? (
    <Link to={to} className="link">
      {children}
    </Link>
  ) : (
    <span>{children}</span>
  );
}

export function StockStatusPage() {
  const { t } = useTranslation();
  const unitLabel = useUnitLabel();
  const invoicesOn = useModuleEnabled('core.invoices');
  const [params, setParams] = useSearchParams();
  const [asOf, setAsOf] = useState(todayIso());
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [includeZero, setIncludeZero] = useState(false);
  const lowOnly = params.get('low') === '1';
  const { data: wh } = useWarehouses();
  const { data: cats } = useCategories();

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);

  const qs = new URLSearchParams({ asOf });
  if (warehouseId) qs.set('warehouseId', warehouseId);
  if (categoryId) qs.set('categoryId', categoryId);
  if (query) qs.set('query', query);
  if (lowOnly) qs.set('lowOnly', 'true');
  if (includeZero) qs.set('includeZero', 'true');
  const { data, isPending, error } = useCQuery<StockStatusReport>(['stock-status', qs.toString()], `/api/reports/stock-status?${qs}`, { enabled: Boolean(asOf) });

  const setLow = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('low', '1');
    else next.delete('low');
    setParams(next, { replace: true });
  };

  const ledger = data?.ledger;
  const reconciled = ledger ? isZero(ledger.difference) : null;
  // Fark varsa ama tamamı faturalanmamış irsaliyelerden geliyorsa sorun değil, bekleyen kayıttır
  const pendingOnly = ledger ? !reconciled && isZero(ledger.unexplained) : false;

  return (
    <div className="print-wide">
      <PageHeader
        title={t('inventory.status.title')}
        description={t('inventory.status.subtitle')}
        actions={
          <ExportMenu
            exportKey="stock-status"
            params={{ asOf, warehouseId, categoryId, query, lowOnly: lowOnly ? 'true' : undefined, includeZero: includeZero ? 'true' : undefined }}
            disabled={!data || data.rows.length === 0}
          />
        }
      />
      <PrintHeader subtitle={`${asOf.split('-').reverse().join('.')}`} />

      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <Field label={t('inventory.status.asOf')}>{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />}</Field>
        <Field label={t('inventory.status.warehouse')}>
          {(id) => (
            <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-48">
              <option value="">{t('inventory.status.allWarehouses')}</option>
              {wh?.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('inventory.status.category')}>
          {(id) => (
            <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-48">
              <option value="">{t('inventory.status.allCategories')}</option>
              {cats?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Input className="w-56" placeholder={t('inventory.items.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('common.search')} />
        <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
          <input type="checkbox" className="size-4" checked={lowOnly} onChange={(e) => setLow(e.target.checked)} />
          {t('inventory.status.onlyLow')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
          <input type="checkbox" className="size-4" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
          {t('inventory.status.includeZero')}
        </label>
      </div>

      <div className="flex flex-col gap-4">
        {warehouseId && <Callout>{t('inventory.status.warehouseNote')}</Callout>}
        {error ? (
          <Callout tone="danger">{errorMessage(error)}</Callout>
        ) : isPending || !data ? (
          <PageLoading />
        ) : data.rows.length === 0 ? (
          <Card>
            <EmptyState icon={<Boxes className="size-5" />} title={t('inventory.status.empty')} />
          </Card>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('inventory.status.item')}</Th>
                  <Th num>{t('inventory.status.onHand')}</Th>
                  <Th num>{t('inventory.status.minLevel')}</Th>
                  <Th num>{t('inventory.status.avgCost')}</Th>
                  <Th num>
                    {t('inventory.status.value')} ({data.baseCurrency})
                  </Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Tr key={r.id} className={r.isActive ? undefined : 'opacity-60'}>
                    <Td>
                      <Link to={`/inventory/items/${r.id}`} className="underline-offset-4 hover:underline">
                        {r.name}
                      </Link>
                      <span className="ml-2 whitespace-nowrap font-mono text-xs text-muted">{r.code}</span>
                      {r.categoryName && <span className="block text-xs text-muted">{r.categoryName}</span>}
                    </Td>
                    <Td num>
                      <span className={cn('', r.isLow && 'text-warning')}>
                        {qtyText(r.onHand) || '0'} {unitLabel(r.unit)}
                      </span>
                      {r.isLow && <Badge tone="warning" className="ml-2">{t('inventory.status.lowBadge')}</Badge>}
                    </Td>
                    <Td num className="text-muted">{r.minLevel ? qtyText(r.minLevel) : '—'}</Td>
                    <Td num className="text-muted">{r.avgCost ? money(r.avgCost) : '—'}</Td>
                    <Td num>{money(r.value)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2">
                  <Td colSpan={4}>{t('inventory.status.total')}</Td>
                  <Td num>{money(data.totals.value)}</Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
        )}

        {data && data.totals.reportingValue && (
          <p className="text-sm text-muted">
            {t('inventory.status.reporting', { currency: data.totals.reportingCurrency })}: <span className="num text-text">{money(data.totals.reportingValue)}</span>
          </p>
        )}

        {ledger && (
          <Card className="p-5">
            <h2 className="mb-3 text-[15px]">{t('inventory.status.reconcileTitle')}</h2>
            <dl className="mb-3 grid gap-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
              <div>
                <dt className="text-muted">{t('inventory.status.reconcileStock')}</dt>
                <dd className="mt-0.5 tabular-nums">{money(ledger.stockValue)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('inventory.status.reconcileLedger')}</dt>
                <dd className="mt-0.5 tabular-nums">{money(ledger.accountsBalance)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('inventory.status.reconcileDiff')}</dt>
                <dd className={cn('mt-0.5 tabular-nums', !reconciled && !pendingOnly && 'text-warning')}>{money(ledger.difference)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('inventory.status.reconcilePending')}</dt>
                <dd className="mt-0.5 tabular-nums">{money(ledger.pendingDeliveries.total)}</dd>
                {!isZero(ledger.pendingDeliveries.total) && (
                  <dd className="mt-0.5 text-xs text-muted">
                    {!isZero(ledger.pendingDeliveries.sales) && (
                      <PendingLink enabled={invoicesOn} to="/delivery-notes/sales?invoicing=open">
                        {t('inventory.status.reconcilePendingSales')}: {money(ledger.pendingDeliveries.sales)}
                      </PendingLink>
                    )}
                    {!isZero(ledger.pendingDeliveries.sales) && !isZero(ledger.pendingDeliveries.purchases) && <br />}
                    {!isZero(ledger.pendingDeliveries.purchases) && (
                      <PendingLink enabled={invoicesOn} to="/delivery-notes/purchases?invoicing=open">
                        {t('inventory.status.reconcilePendingPurchases')}: {money(ledger.pendingDeliveries.purchases)}
                      </PendingLink>
                    )}
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-muted">{t('inventory.status.reconcileUnexplained')}</dt>
                <dd className={cn('mt-0.5 tabular-nums', !isZero(ledger.unexplained) && 'text-warning')}>{money(ledger.unexplained)}</dd>
              </div>
            </dl>
            <Callout tone={reconciled || pendingOnly ? 'info' : 'warning'}>
              {reconciled ? t('inventory.status.reconcileOk') : pendingOnly ? t('inventory.status.reconcilePendingOnly') : t('inventory.status.reconcileOff')}
            </Callout>
          </Card>
        )}
      </div>
    </div>
  );
}
