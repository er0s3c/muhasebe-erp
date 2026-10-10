import { CompanySavedViews } from '../../components/layout/CompanySavedViews';
import { SearchInput } from '../../components/ui/SearchInput';
import { ListToolbar, ResultFooter } from '../../components/ui/ListTools';
import { ChevronRight, Package, Plus, Tags, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Stat } from '../../components/ui/Stat';
import { EmptyState, ErrorState, ListSkeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { currencySymbol, money, moneyIn } from '../../lib/format';
import { useCan, useCanOperation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { InventorySummary, ItemKind, ItemListRow } from '../../lib/types';
import { ImportWizard } from '../imports/ImportWizard';
import { CategoriesSheet } from './CategoriesSheet';
import { qtyText, useCategories, useUnitLabel } from './common';
import { ItemFormSheet } from './ItemFormSheet';

const PAGE = 100;

export function ItemsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const company = useCompany();
  const unitLabel = useUnitLabel();
  const can = useCan();
  const canOperation = useCanOperation();
  const canManage = can('inventory.manage') && canOperation('core.inventory', 'create');
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [kind, setKind] = useState<ItemKind | ''>('');
  const [showInactive, setShowInactive] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [categories, setCategories] = useState(false);
  const [importing, setImporting] = useState(false);
  const onlyLow = params.get('low') === '1';

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setLimit(PAGE), [query, categoryId, kind, showInactive, onlyLow]);

  const qs = new URLSearchParams({ limit: String(limit) });
  if (query) qs.set('query', query);
  if (categoryId) qs.set('categoryId', categoryId);
  if (kind) qs.set('kind', kind);
  if (onlyLow) qs.set('lowStock', 'true');
  if (!showInactive) qs.set('active', 'true');

  const { data, isPending, error, refetch, isFetching } = useCQuery<{ items: ItemListRow[]; total: number }>(['items', 'list', qs.toString()], `/api/items?${qs}`);
  const { data: summary } = useCQuery<InventorySummary>(['inventory-summary'], '/api/inventory/summary');
  const { data: cats } = useCategories();
  const filtered = !!(query || categoryId || kind || onlyLow);

  const setLow = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('low', '1');
    else next.delete('low');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('inventory.items.title')}
        description={t('inventory.items.subtitle')}
        actions={
          canManage && (
            <>
              <Button onClick={() => setCategories(true)}>
                <Tags className="size-4" aria-hidden />
                {t('inventory.items.categories.button')}
              </Button>
              <Button onClick={() => setImporting(true)}>
                <Upload className="size-4" aria-hidden />
                {t('imports.button')}
              </Button>
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden />
                {t('inventory.items.add')}
              </Button>
            </>
          )
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label={t('inventory.items.kpiItems')}>{summary ? summary.itemCount : '—'}</Stat>
        <Stat label={t('inventory.items.kpiValue')}>{summary ? moneyIn(summary.stockValue, company.baseCurrency) : '—'}</Stat>
        <button type="button" className="group rounded-2xl text-left" onClick={() => setLow(!onlyLow)} aria-pressed={onlyLow}>
          <Stat label={t('inventory.items.kpiLow')} className={cn('transition-colors group-hover:border-text', onlyLow && 'border-text')}>
            <span className={cn(summary && summary.lowCount > 0 && 'text-warning')}>{summary ? summary.lowCount : '—'}</span>
          </Stat>
        </button>
      </div>

      <ListToolbar onReset={() => { setText(''); setCategoryId(''); setKind(''); setLow(false); setShowInactive(false); setLimit(PAGE); }}>
        <CompanySavedViews page={`items`} filters={{ categoryId, kind, onlyLow, showInactive }} onApply={(v) => { setText(''); setCategoryId(String(v.categoryId)); setKind(v.kind as ItemKind | ''); setLow(Boolean(v.onlyLow)); setShowInactive(Boolean(v.showInactive)); setLimit(PAGE); }} />
        <SearchInput placeholder={t('inventory.items.searchPlaceholder')} value={text} onChange={setText} aria-label={t('common.search')} />
        <Select className="w-48" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label={t('inventory.items.category')}>
          <option value="">{t('inventory.items.allCategories')}</option>
          {cats?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select className="w-44" value={kind} onChange={(e) => setKind(e.target.value as ItemKind | '')} aria-label={t('inventory.form.kind')}>
          <option value="">{t('inventory.items.allKinds')}</option>
          <option value="goods">{t('inventory.kinds.goods')}</option>
          <option value="service">{t('inventory.kinds.service')}</option>
        </Select>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={onlyLow} onChange={(e) => setLow(e.target.checked)} />
          {t('inventory.items.onlyLow')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('inventory.items.showInactive')}
        </label>
      </ListToolbar>

      {isPending ? (
        <ListSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            icon={<Package className="size-5" />}
            title={filtered ? t('common.noResults') : t('inventory.items.empty')}
            description={filtered ? undefined : t('inventory.items.emptyDesc')}
            action={
              canManage && !filtered ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus className="size-4" aria-hidden />
                  {t('inventory.items.add')}
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
                  <Th className="w-32">{t('inventory.items.code')}</Th>
                  <Th>{t('inventory.items.item')}</Th>
                  <Th num>{t('inventory.items.onHand')}</Th>
                  <Th num>{t('inventory.items.avgCost')}</Th>
                  <Th num>
                    {t('inventory.items.value')} ({currencySymbol(company.baseCurrency)})
                  </Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <Tr
                    key={i.id}
                    clickable
                    tabIndex={0}
                    onClick={() => navigate(`/inventory/items/${i.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/inventory/items/${i.id}`);
                    }}
                    className={i.isActive ? undefined : 'opacity-60'}
                  >
                    <Td className="whitespace-nowrap font-mono text-[13px]">{i.code}</Td>
                    <Td>
                      <span>{i.name}</span>
                      {!i.isActive && <Badge tone="danger" className="ml-2">{t('common.inactive')}</Badge>}
                      {i.kind === 'service' && <Badge className="ml-2">{t('inventory.kinds.service')}</Badge>}
                      <span className="block text-xs text-muted">{[i.categoryName ?? t('inventory.items.noCategory'), i.barcode].filter(Boolean).join(' · ')}</span>
                    </Td>
                    <Td num>
                      {i.kind === 'service' ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <>
                          <span className={cn('', i.isLow && 'text-warning')}>
                            {qtyText(i.onHand) || '0'} {unitLabel(i.unit)}
                          </span>
                          {i.isLow && <Badge tone="warning" className="ml-2">{t('inventory.items.low')}</Badge>}
                        </>
                      )}
                    </Td>
                    <Td num className="text-muted">{i.avgCost ? money(i.avgCost) : '—'}</Td>
                    <Td num>{i.kind === 'service' ? '—' : money(i.value)}</Td>
                    <Td>
                      <ChevronRight className="size-4 text-muted" aria-hidden />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <ResultFooter shown={data.items.length} total={data.total} loading={isFetching} onMore={() => setLimit((l) => l + PAGE)} />
        </>
      )}

      <ItemFormSheet open={adding} onOpenChange={setAdding} onSaved={(item) => navigate(`/inventory/items/${item.id}`)} />
      <CategoriesSheet open={categories} onOpenChange={setCategories} />
      <ImportWizard kind="items" open={importing} onOpenChange={setImporting} />
    </>
  );
}
