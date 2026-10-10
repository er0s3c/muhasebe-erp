import { CompanySavedViews } from '../../components/layout/CompanySavedViews';
import { SearchInput } from '../../components/ui/SearchInput';
import { ListToolbar, ResultFooter } from '../../components/ui/ListTools';
import { Landmark, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, ErrorState, ListSkeleton } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { TreasuryTxnListRow, TreasuryTxnStatus, TreasuryTxnType } from '../../lib/types';
import { TXN_TYPES, TxnStatusBadge, TxnTypeBadge, accountLabel, useTreasuryAccounts } from './common';
import { TransactionDetailSheet } from './TransactionDetailSheet';
import { TransactionSheet } from './TransactionSheet';
import { FinancialDraftList } from '../settings/DocumentApprovalsPage';

const PAGE = 100;

export function TransactionsPage() {
  const { t } = useTranslation();
  const canPost = useCan()('treasury.post');
  const [params, setParams] = useSearchParams();
  const year = todayIso().slice(0, 4);

  const [type, setType] = useState<TreasuryTxnType | ''>('');
  const [status, setStatus] = useState<TreasuryTxnStatus | ''>('');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  // `?new=receipt&party=…&account=…` (cari/hesap sayfalarından) ve `?open=…` (bağlantılar) derin bağlantıları
  const [creating, setCreating] = useState<{ type: TreasuryTxnType; partyId: string; accountId: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const n = params.get('new');
    const o = params.get('open');
    if (n && (TXN_TYPES as readonly string[]).includes(n) && canPost) {
      setCreating({ type: n as TreasuryTxnType, partyId: params.get('party') ?? '', accountId: params.get('account') ?? '' });
    }
    if (o) setOpenId(o);
    if (n || o) setParams({}, { replace: true });
    // yalnızca ilk açılışta okunur
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setLimit(PAGE), [type, status, accountId, from, to, query]);

  const { data: accData } = useTreasuryAccounts();
  const qs = new URLSearchParams({ limit: String(limit) });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (type) qs.set('type', type);
  if (status) qs.set('status', status);
  if (accountId) qs.set('accountId', accountId);
  if (query) qs.set('query', query);
  const { data, isPending, error, refetch, isFetching } = useCQuery<{ transactions: TreasuryTxnListRow[]; total: number }>(['treasury', 'txns', qs.toString()], `/api/treasury/transactions?${qs}`);
  const filtered = !!(type || status || accountId || query);

  const newButton = canPost && (
    <Button variant="primary" onClick={() => setCreating({ type: 'receipt', partyId: '', accountId: '' })}>
      <Plus className="size-4" aria-hidden />
      {t('treasury.txn.new')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('treasury.txn.title')} description={t('treasury.txn.subtitle')} actions={newButton} />
      <FinancialDraftList type="payment"/>

      <ListToolbar onReset={() => { setText(''); setType(''); setStatus(''); setAccountId(''); setFrom(`${year}-01-01`); setTo(`${year}-12-31`); setLimit(PAGE); }}>
        <CompanySavedViews page={`treasury-transactions`} filters={{ type, status, accountId, from, to }} onApply={(v) => { setText(''); setType(v.type as TreasuryTxnType | ''); setStatus(v.status as TreasuryTxnStatus | ''); setAccountId(String(v.accountId)); setFrom(String(v.from)); setTo(String(v.to)); setLimit(PAGE); }} />
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />}</Field>
        <Field label={t('treasury.txn.type')}>
          {(id) => (
            <Select id={id} value={type} onChange={(e) => setType(e.target.value as TreasuryTxnType | '')} className="w-48">
              <option value="">{t('treasury.txn.allTypes')}</option>
              {TXN_TYPES.map((k) => (
                <option key={k} value={k}>
                  {t(`treasury.types.${k}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('treasury.txn.account')}>
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-52">
              <option value="">{t('treasury.txn.allAccounts')}</option>
              {(accData?.accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('common.status')}>
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as TreasuryTxnStatus | '')} className="w-40">
              <option value="">{t('treasury.txn.allStatuses')}</option>
              {(['posted', 'cancelled'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`treasury.status.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <SearchInput placeholder={t('treasury.txn.searchPlaceholder')} value={text} onChange={setText} aria-label={t('common.search')} />
      </ListToolbar>

      {isPending ? (
        <ListSkeleton />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : !data?.transactions.length ? (
        <Card>
          <EmptyState
            icon={<Landmark className="size-5" />}
            title={filtered ? t('common.noResults') : t('treasury.txn.empty')}
            description={filtered ? undefined : t('treasury.txn.emptyDesc')}
            action={!filtered ? newButton || undefined : undefined}
          />
        </Card>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-28">{t('common.date')}</Th>
                  <Th className="w-44">{t('treasury.txn.number')}</Th>
                  <Th className="w-40">{t('treasury.txn.type')}</Th>
                  <Th>{t('treasury.txn.detail')}</Th>
                  <Th num>{t('common.amount')}</Th>
                  <Th className="w-28">{t('common.status')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((r) => (
                  <Tr
                    key={r.id}
                    clickable
                    tabIndex={0}
                    className={r.status === 'cancelled' ? 'opacity-60' : undefined}
                    onClick={() => setOpenId(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setOpenId(r.id);
                    }}
                  >
                    <Td>{formatDateTR(r.txnDate)}</Td>
                    <Td className="font-mono text-[13px]">{r.txnNo}</Td>
                    <Td>
                      <TxnTypeBadge type={r.type} />
                    </Td>
                    <Td className="max-w-sm">
                      <span className="block truncate">
                        {r.toAccountName ? `${r.accountName} → ${r.toAccountName}` : r.partyName ? `${r.partyName} · ${r.accountName}` : r.glAccountCode ? `${r.glAccountCode} ${r.glAccountName} · ${r.accountName}` : r.accountName}
                      </span>
                      {r.description && <span className="block truncate text-xs text-muted">{r.description}</span>}
                    </Td>
                    <Td num>
                      {r.type === 'exchange' && r.counterAmount ? (
                        <>
                          <span className="block">
                            −{moneyIn(r.amount, r.currencyCode)}
                          </span>
                          <span className="block text-xs text-muted">
                            +{moneyIn(r.counterAmount, r.toCurrencyCode ?? r.currencyCode)}
                          </span>
                        </>
                      ) : (
                        <>
                          {r.type === 'receipt' || r.type === 'other_receipt' ? '+' : r.type === 'transfer' ? '' : '−'}
                          {moneyIn(r.amount, r.currencyCode)}
                        </>
                      )}
                    </Td>
                    <Td>
                      <TxnStatusBadge status={r.status} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <ResultFooter shown={data.transactions.length} total={data.total} loading={isFetching} onMore={() => setLimit((l) => l + PAGE)} />
        </>
      )}

      <TransactionSheet
        open={creating !== null}
        onOpenChange={(o) => !o && setCreating(null)}
        initialType={creating?.type ?? 'receipt'}
        initialPartyId={creating?.partyId ?? ''}
        initialAccountId={creating?.accountId ?? ''}
        onSaved={(res) => setOpenId(res.transaction.id)}
      />
      <TransactionDetailSheet id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
