import { AlertTriangle, ChevronRight, Package, Plus, Search, Tags, Wallet } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { money } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { InventorySummary, ItemKind, ItemListRow } from '../../lib/types';
import { CategoriesSheet } from './CategoriesSheet';
import { qtyText, useCategories, useUnitLabel } from './common';
import { ItemFormSheet } from './ItemFormSheet';

const PAGE = 100;

function Kpi({ icon, label, value, tone = 'brand' }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'brand' | 'warning' }) {
  const tones = { brand: 'bg-brand-soft text-brand', warning: 'bg-warning-soft text-warning' };
  return (
    <Card className="flex items-center gap-4 p-5">
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', tones[tone])}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="mt-0.5 truncate text-xl font-semibold tracking-tight">{value}</p>
      </div>
    </Card>
  );
}

export function ItemsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const company = useCompany();
  const unitLabel = useUnitLabel();
  const can = useCan();
  const canManage = can('inventory.manage');
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [kind, setKind] = useState<ItemKind | ''>('');
  const [showInactive, setShowInactive] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [categories, setCategories] = useState(false);
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

  const { data, isPending } = useCQuery<{ items: ItemListRow[]; total: number }>(['items', 'list', qs.toString()], `/api/items?${qs}`);
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
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden />
                {t('inventory.items.add')}
              </Button>
            </>
          )
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Kpi icon={<Package className="size-5" />} label={t('inventory.items.kpiItems')} value={summary ? summary.itemCount : '—'} />
        <Kpi icon={<Wallet className="size-5" />} label={t('inventory.items.kpiValue')} value={summary ? `${money(summary.stockValue)} ${company.baseCurrency}` : '—'} />
        <button type="button" className="rounded-xl text-left transition-shadow hover:shadow-pop" onClick={() => setLow(!onlyLow)} aria-pressed={onlyLow}>
          <Kpi icon={<AlertTriangle className="size-5" />} label={t('inventory.items.kpiLow')} value={summary ? summary.lowCount : '—'} tone={summary && summary.lowCount > 0 ? 'warning' : 'brand'} />
        </button>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-4">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" aria-hidden />
          <Input className="pl-9" placeholder={t('inventory.items.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('common.search')} />
        </div>
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
          <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={onlyLow} onChange={(e) => setLow(e.target.checked)} />
          {t('inventory.items.onlyLow')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('inventory.items.showInactive')}
        </label>
      </div>

      {isPending ? (
        <PageLoading />
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
                    {t('inventory.items.value')} ({company.baseCurrency})
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
                      <span className="font-medium">{i.name}</span>
                      {!i.isActive && <Badge tone="danger" className="ml-2">{t('common.inactive')}</Badge>}
                      {i.kind === 'service' && <Badge className="ml-2">{t('inventory.kinds.service')}</Badge>}
                      <span className="block text-xs text-muted">{[i.categoryName ?? t('inventory.items.noCategory'), i.barcode].filter(Boolean).join(' · ')}</span>
                    </Td>
                    <Td num>
                      {i.kind === 'service' ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <>
                          <span className={cn('font-medium', i.isLow && 'text-warning')}>
                            {qtyText(i.onHand) || '0'} {unitLabel(i.unit)}
                          </span>
                          {i.isLow && <Badge tone="warning" className="ml-2">{t('inventory.items.low')}</Badge>}
                        </>
                      )}
                    </Td>
                    <Td num className="text-muted">{i.avgCost ? money(i.avgCost) : '—'}</Td>
                    <Td num className="font-medium">{i.kind === 'service' ? '—' : money(i.value)}</Td>
                    <Td>
                      <ChevronRight className="size-4 text-muted" aria-hidden />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <div className="mt-3 text-sm text-muted">{t('inventory.items.total', { count: data.total })}</div>
          {data.items.length < data.total && (
            <div className="mt-3 text-center">
              <Button onClick={() => setLimit((l) => l + PAGE)}>{t('common.loadMore')}</Button>
            </div>
          )}
        </>
      )}

      <ItemFormSheet open={adding} onOpenChange={setAdding} onSaved={(item) => navigate(`/inventory/items/${item.id}`)} />
      <CategoriesSheet open={categories} onOpenChange={setCategories} />
    </>
  );
}
