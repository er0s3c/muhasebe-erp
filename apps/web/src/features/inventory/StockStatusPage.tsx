import { Boxes, Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { formatTR, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { isZero, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { StockStatusReport } from '../../lib/types';
import { qtyText, useCategories, useUnitLabel, useWarehouses } from './common';

export function StockStatusPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const unitLabel = useUnitLabel();
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

  const exportCsv = () => {
    if (!data) return;
    const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;
    const head = [t('inventory.items.code'), t('inventory.status.item'), t('inventory.status.category'), t('inventory.form.unit'), t('inventory.status.onHand'), t('inventory.status.minLevel'), t('inventory.status.avgCost'), `${t('inventory.status.value')} (${company.baseCurrency})`];
    const lines = [
      head.map(esc).join(';'),
      ...data.rows.map((r) =>
        [r.code, r.name, r.categoryName ?? '', unitLabel(r.unit), qtyText(r.onHand) || '0', qtyText(r.minLevel), r.avgCost ? formatTR(r.avgCost) : '', formatTR(r.value)].map(esc).join(';'),
      ),
      [t('inventory.status.total'), '', '', '', '', '', '', formatTR(data.totals.value)].map(esc).join(';'),
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stok-durumu-${asOf}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const ledger = data?.ledger;
  const reconciled = ledger ? isZero(ledger.difference) : null;

  return (
    <>
      <PageHeader
        title={t('inventory.status.title')}
        description={t('inventory.status.subtitle')}
        actions={
          <Button onClick={exportCsv} disabled={!data || data.rows.length === 0}>
            <Download className="size-4" aria-hidden />
            {t('common.export')}
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
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
            <dl className="mb-3 grid gap-4 text-sm sm:grid-cols-3">
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
                <dd className={cn('mt-0.5 tabular-nums', !reconciled && 'text-warning')}>{money(ledger.difference)}</dd>
              </div>
            </dl>
            <Callout tone={reconciled ? 'info' : 'warning'}>{reconciled ? t('inventory.status.reconcileOk') : t('inventory.status.reconcileOff')}</Callout>
          </Card>
        )}
      </div>
    </>
  );
}
