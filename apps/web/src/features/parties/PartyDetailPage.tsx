import { ArrowLeft, Pencil, Power, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, isZero, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { OpenItem, OpenItemsData, PartyDetail, PartyStatementData } from '../../lib/types';
import { BalanceText } from './BalanceText';
import { PartyFormSheet } from './PartyFormSheet';

type Tab = 'statement' | 'openItems' | 'card';

function Kpi({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{children}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </Card>
  );
}

export function PartyDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const canManage = useCan()('parties.manage');
  const company = useCompany();
  const { data, isPending, error } = useCQuery<PartyDetail>(['party', id], id ? `/api/parties/${id}` : null);
  const [tab, setTab] = useState<Tab>('statement');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleActive = useCMutation((v: { isActive: boolean }, call) => call(`/api/parties/${id}`, { method: 'PATCH', body: v }), [['party'], ['parties']]);
  const remove = useCMutation((_: void, call) => call(`/api/parties/${id}`, { method: 'DELETE' }), [['parties']]);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t('errors.NOT_FOUND' as never, { defaultValue: 'Cari bulunamadı' })}
        action={
          <Link to="/parties">
            <Button>{t('parties.detail.back')}</Button>
          </Link>
        }
      />
    );
  }
  if (isPending || !data) return <PageLoading />;

  const { party, summary } = data;
  const balance = Number(summary.balance);
  const limit = party.creditLimit ? Number(party.creditLimit) : null;
  const overLimit = limit !== null && limit > 0 && balance > limit;

  return (
    <>
      <Link to="/parties" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden />
        {t('parties.detail.back')}
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{party.name}</h1>
            <Badge tone={party.kind === 'customer' ? 'brand' : party.kind === 'supplier' ? 'warning' : 'neutral'}>{t(`parties.kinds.${party.kind}`)}</Badge>
            {!party.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
            {overLimit && <Badge tone="danger">{t('parties.detail.limitExceeded')}</Badge>}
          </div>
          <p className="mt-1 font-mono text-sm text-muted">{party.code}</p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              {t('common.edit')}
            </Button>
          </div>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Kpi
          label={t('parties.detail.balance')}
          sub={
            <>
              {isZero(summary.balance) ? t('parties.detail.settled') : balance > 0 ? t('parties.detail.owesUs') : t('parties.detail.weOwe')}
              {/* Dövizli bakiye yalnızca defter para biriminden farklıysa anlamlıdır */}
              {summary.byCurrency.some((c) => c.currency !== company.baseCurrency) && (
                <span className="block">
                  {t('parties.detail.currencyBalances')}: {summary.byCurrency.map((c) => `${money(c.balance)} ${c.currency}`).join(' · ')}
                </span>
              )}
              {limit ? (
                <span className="block">
                  {t('parties.detail.limit')}: {money(party.creditLimit)}
                </span>
              ) : null}
            </>
          }
        >
          <span className={cn(balance > 0 && 'text-text', balance < 0 && 'text-warning')}>
            <BalanceText value={summary.balance} />
          </span>
        </Kpi>
        <Kpi label={t('parties.detail.totalDebit')} sub={t('parties.detail.movements', { count: summary.movements })}>
          {money(summary.debit)}
        </Kpi>
        <Kpi label={t('parties.detail.totalCredit')}>{money(summary.credit)}</Kpi>
      </div>

      <div role="tablist" className="mb-5 inline-flex rounded-lg border border-border bg-surface p-1">
        {(['statement', 'openItems', 'card'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn('rounded-md px-4 py-1.5 text-sm font-medium text-muted transition-colors', tab === k && 'bg-brand-soft text-brand')}
          >
            {t(`parties.detail.tabs.${k}`)}
          </button>
        ))}
      </div>

      {tab === 'statement' && <StatementTab partyId={party.id} />}
      {tab === 'openItems' && <OpenItemsTab partyId={party.id} />}
      {tab === 'card' && (
        <Card>
          <CardHeader
            title={t('parties.detail.tabs.card')}
            action={
              canManage ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    loading={toggleActive.isPending}
                    onClick={() =>
                      toggleActive.mutate(
                        { isActive: !party.isActive },
                        { onSuccess: () => toast.success(t('parties.updated')), onError: (e) => toast.error(errorMessage(e)) },
                      )
                    }
                  >
                    <Power className="size-3.5" aria-hidden />
                    {party.isActive ? t('parties.detail.deactivate') : t('parties.detail.activate')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="size-3.5 text-danger" aria-hidden />
                    {t('parties.detail.delete')}
                  </Button>
                </div>
              ) : undefined
            }
          />
          <dl className="grid gap-x-8 gap-y-5 p-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {(
              [
                ['form.phone', party.phone],
                ['form.email', party.email],
                ['form.taxNumber', party.taxNumber],
                ['form.taxOffice', party.taxOffice],
                ['form.address', party.address],
                ['form.currency', party.currencyCode],
                ['form.creditLimit', party.creditLimit ? money(party.creditLimit) : null],
                ['form.paymentTerm', String(party.paymentTermDays)],
                ['form.notes', party.notes],
              ] as const
            ).map(([key, value]) => (
              <div key={key}>
                <dt className="text-muted">{t(`parties.${key}` as never)}</dt>
                <dd className="mt-0.5 font-medium">{value || <span className="font-normal text-muted">{t('parties.detail.notProvided')}</span>}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <PartyFormSheet open={editing} onOpenChange={setEditing} party={party} onSaved={() => undefined} />

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('parties.detail.delete')}
        description={t('parties.detail.deleteConfirm')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('parties.deleted'));
                    navigate('/parties', { replace: true });
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
  );
}

function StatementTab({ partyId }: { partyId: string }) {
  const { t } = useTranslation();
  const company = useCompany();
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const { data, isPending, error } = useCQuery<PartyStatementData>(
    ['party', partyId, 'statement', from, to],
    `/api/parties/${partyId}/statement?${new URLSearchParams({ from, to })}`,
    { enabled: Boolean(from && to) },
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
      </div>
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
                <Th className="w-40">{t('ledger.accountLedger.entryNo')}</Th>
                <Th>{t('common.description')}</Th>
                <Th className="w-28">{t('parties.detail.dueDate')}</Th>
                <Th num>{t('ledger.accountLedger.fx')}</Th>
                <Th num>{t('common.debit')}</Th>
                <Th num>{t('common.credit')}</Th>
                <Th num>
                  {t('common.balance')} ({company.baseCurrency})
                </Th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-surface-2/60 font-medium">
                <Td colSpan={7}>{t('ledger.accountLedger.opening')}</Td>
                <Td num>
                  <BalanceText value={data.opening} />
                </Td>
              </tr>
              {data.lines.length === 0 && (
                <tr>
                  <Td colSpan={8} className="py-8 text-center text-muted">
                    {t('parties.detail.statementEmpty')}
                  </Td>
                </tr>
              )}
              {data.lines.map((l, i) => (
                <Tr key={`${l.entryId}-${i}`}>
                  <Td>{formatDateTR(l.entryDate)}</Td>
                  <Td className="font-mono text-[13px]">{l.entryNo}</Td>
                  <Td>{l.description}</Td>
                  <Td className="text-muted">{l.dueDate ? formatDateTR(l.dueDate) : ''}</Td>
                  <Td num className="text-muted">
                    {l.currencyCode !== company.baseCurrency ? `${money(Number(l.debit) > 0 ? l.debit : l.credit)} ${l.currencyCode}` : ''}
                  </Td>
                  <Td num>{isZero(l.debitBase) ? '' : money(l.debitBase)}</Td>
                  <Td num>{isZero(l.creditBase) ? '' : money(l.creditBase)}</Td>
                  <Td num>
                    <BalanceText value={l.balance} />
                  </Td>
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2 font-semibold">
                <Td colSpan={5}>{t('ledger.accountLedger.totals')}</Td>
                <Td num>{money(data.totals.debitBase)}</Td>
                <Td num>{money(data.totals.creditBase)}</Td>
                <Td num>
                  <span className="sr-only">{t('ledger.accountLedger.closing')}: </span>
                  <BalanceText value={data.closing} />
                </Td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}

function BucketBadge({ item }: { item: OpenItem }) {
  const { t } = useTranslation();
  if (item.bucket === 'notDue') return <Badge>{t('parties.detail.notDue')}</Badge>;
  const tone = item.bucket === 'd1_30' ? 'warning' : 'danger';
  return <Badge tone={tone}>{t('parties.detail.days', { count: item.daysOverdue })}</Badge>;
}

function OpenItemsTab({ partyId }: { partyId: string }) {
  const { t } = useTranslation();
  const company = useCompany();
  const [asOf, setAsOf] = useState(todayIso());
  const { data, isPending, error } = useCQuery<OpenItemsData>(
    ['party', partyId, 'open-items', asOf],
    `/api/parties/${partyId}/open-items?${new URLSearchParams({ asOf })}`,
    { enabled: Boolean(asOf) },
  );

  const sections = (['receivable', 'payable'] as const)
    .map((type) => ({ type, result: data?.[type] }))
    .filter((s) => s.result && (s.result.items.length > 0 || !isZero(s.result.unapplied)));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <Field label={t('parties.detail.asOf')}>{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />}</Field>
        <p className="pb-2 text-sm text-muted">{t('parties.detail.fifoNote')}</p>
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : sections.length === 0 ? (
        <Card>
          <EmptyState title={t('parties.detail.noOpenItems')} />
        </Card>
      ) : (
        sections.map(({ type, result }) => (
          <section key={type}>
            <h2 className="mb-3 text-[15px] font-semibold">{type === 'receivable' ? t('parties.detail.receivables') : t('parties.detail.payables')}</h2>
            {result && !isZero(result.unapplied) && (
              <div className="mb-3">
                <Callout>{t('parties.detail.unapplied', { amount: money(result.unapplied) })}</Callout>
              </div>
            )}
            {result && result.items.length > 0 && (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-28">{t('parties.detail.dueDate')}</Th>
                      <Th className="w-40">{t('ledger.accountLedger.entryNo')}</Th>
                      <Th>{t('common.description')}</Th>
                      <Th num>{t('parties.detail.amount')}</Th>
                      <Th num>
                        {t('parties.detail.remaining')} ({company.baseCurrency})
                      </Th>
                      <Th className="w-40">{t('parties.detail.overdue')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.items.map((it) => (
                      <Tr key={it.lineId}>
                        <Td>{formatDateTR(it.dueDate)}</Td>
                        <Td className="font-mono text-[13px]">{it.entryNo}</Td>
                        <Td>{it.description}</Td>
                        <Td num className="text-muted">
                          {money(it.amount)} {it.currencyCode}
                        </Td>
                        <Td num className="font-medium">
                          {money(it.remainingBase)}
                        </Td>
                        <Td>
                          <BucketBadge item={it} />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </section>
        ))
      )}
    </div>
  );
}
