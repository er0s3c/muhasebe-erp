import { CompanySavedViews } from '../../components/layout/CompanySavedViews';
import { SearchInput } from '../../components/ui/SearchInput';
import { ListToolbar, ResultFooter } from '../../components/ui/ListTools';
import { ChevronRight, Contact, Plus, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, ErrorState, ListSkeleton } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useCan, useCanOperation, useCQuery } from '../../lib/queries';
import type { PartyKind, PartyListRow } from '../../lib/types';
import { ImportWizard } from '../imports/ImportWizard';
import { BalanceText } from './BalanceText';
import { PartyFormSheet } from './PartyFormSheet';

const PAGE = 100;

export function PartiesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const canOperation = useCanOperation();
  const canManage = can('parties.manage') && canOperation('core.parties', 'create');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<PartyKind | ''>('');
  const [onlyBalance, setOnlyBalance] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  // Yazarken her tuşta istek atmamak için kısa gecikme
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setLimit(PAGE), [query, kind, onlyBalance, showInactive]);

  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set('query', query);
  if (kind) params.set('kind', kind);
  if (onlyBalance) params.set('hasBalance', 'true');
  if (!showInactive) params.set('active', 'true');

  const { data, isPending, error, refetch, isFetching } = useCQuery<{ parties: PartyListRow[]; total: number }>(
    ['parties', 'list', params.toString()],
    `/api/parties?${params}`,
  );

  return (
    <>
      <PageHeader
        title={t('parties.title')}
        description={t('parties.subtitle')}
        actions={
          canManage && (
            <>
              <Button onClick={() => setImporting(true)}>
                <Upload className="size-4" aria-hidden />
                {t('imports.button')}
              </Button>
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus className="size-4" aria-hidden />
                {t('parties.add')}
              </Button>
            </>
          )
        }
      />

      <ListToolbar onReset={() => { setText(''); setKind(''); setOnlyBalance(false); setShowInactive(false); setLimit(PAGE); }}>
        <CompanySavedViews page={`parties`} filters={{ kind, onlyBalance, showInactive }} onApply={(v) => { setText(''); setKind(v.kind as PartyKind | ''); setOnlyBalance(Boolean(v.onlyBalance)); setShowInactive(Boolean(v.showInactive)); setLimit(PAGE); }} />
        <SearchInput placeholder={t('parties.searchPlaceholder')} value={text} onChange={setText} aria-label={t('common.search')} />
        <Select className="w-52" value={kind} onChange={(e) => setKind(e.target.value as PartyKind | '')} aria-label={t('parties.kind')}>
          <option value="">{t('parties.allKinds')}</option>
          <option value="customer">{t('parties.kinds.customer')}</option>
          <option value="supplier">{t('parties.kinds.supplier')}</option>
        </Select>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={onlyBalance} onChange={(e) => setOnlyBalance(e.target.checked)} />
          {t('parties.onlyWithBalance')}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('parties.showInactive')}
        </label>
      </ListToolbar>

      {isPending ? (
        <ListSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : !data?.parties.length ? (
        <Card>
          <EmptyState
            icon={<Contact className="size-5" />}
            title={query || kind || onlyBalance ? t('common.noResults') : t('parties.noParties')}
            description={query || kind || onlyBalance ? undefined : t('parties.noPartiesDesc')}
            action={
              canManage && !query && !kind && !onlyBalance ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus className="size-4" aria-hidden />
                  {t('parties.add')}
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
                  <Th className="w-32">{t('parties.code')}</Th>
                  <Th>{t('parties.party')}</Th>
                  <Th className="w-44">{t('parties.kind')}</Th>
                  <Th num className="w-44">
                    {t('parties.balance')}
                  </Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {data.parties.map((p) => (
                  <Tr
                    key={p.id}
                    clickable
                    tabIndex={0}
                    onClick={() => navigate(`/parties/${p.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/parties/${p.id}`);
                    }}
                    className={p.isActive ? undefined : 'opacity-60'}
                  >
                    <Td className="font-mono text-[13px]">{p.code}</Td>
                    <Td>
                      <span>{p.name}</span>
                      {!p.isActive && <Badge tone="danger" className="ml-2">{t('common.inactive')}</Badge>}
                      {(p.phone || p.taxNumber) && (
                        <span className="block text-xs text-muted">{[p.phone, p.taxNumber && `VN ${p.taxNumber}`].filter(Boolean).join(' · ')}</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={p.kind === 'customer' ? 'brand' : p.kind === 'supplier' ? 'warning' : 'neutral'}>{t(`parties.kinds.${p.kind}`)}</Badge>
                    </Td>
                    <Td num>
                      <BalanceText value={p.balance} />
                    </Td>
                    <Td>
                      <ChevronRight className="size-4 text-muted" aria-hidden />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <ResultFooter shown={data.parties.length} total={data.total} loading={isFetching} onMore={() => setLimit((l) => l + PAGE)}><span>{t('parties.balanceLegend')}</span></ResultFooter>
        </>
      )}

      <PartyFormSheet open={adding} onOpenChange={setAdding} onSaved={(p) => navigate(`/parties/${p.id}`)} />
      <ImportWizard kind="parties" open={importing} onOpenChange={setImporting} />
    </>
  );
}
