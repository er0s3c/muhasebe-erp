import { ArrowLeft, ArrowLeftRight, Landmark, Pencil, Plus, Power, Repeat, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, isZero, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { TreasuryAccount, TreasuryStatementData, TreasuryTxnType } from '../../lib/types';
import { AccountFormSheet } from './AccountFormSheet';
import { TREASURY_INVALIDATE, TxnTypeBadge } from './common';
import { TransactionDetailSheet } from './TransactionDetailSheet';
import { TransactionSheet } from './TransactionSheet';

export function AccountDetailPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const base = company.baseCurrency;
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const canManage = can('treasury.manage');
  const canPost = can('treasury.post');
  const { data, isPending, error } = useCQuery<{ account: TreasuryAccount }>(['treasury', 'account', id], id ? `/api/treasury/accounts/${id}` : null);

  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const statement = useCQuery<TreasuryStatementData>(
    ['treasury', 'statement', id, from, to],
    id ? `/api/treasury/accounts/${id}/statement?${new URLSearchParams({ from, to })}` : null,
    { enabled: Boolean(from && to) },
  );

  const [editing, setEditing] = useState(false);
  const [newType, setNewType] = useState<TreasuryTxnType | null>(null);
  const [openTxn, setOpenTxn] = useState<string | null>(null);
  const toggleActive = useCMutation((v: { isActive: boolean }, call) => call(`/api/treasury/accounts/${id}`, { method: 'PATCH', body: v }), TREASURY_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={t('treasury.detail.notFound')}
        action={
          <Link to="/treasury/accounts">
            <Button>{t('treasury.detail.back')}</Button>
          </Link>
        }
      />
    );
  }
  if (isPending || !data) return <PageLoading />;

  const a = data.account;
  const foreign = a.currencyCode !== base;
  const Icon = a.kind === 'cash' ? Wallet : Landmark;
  const st = statement.data;

  return (
    <>
      <Link to="/treasury/accounts" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden />
        {t('treasury.detail.back')}
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-2">
            <Icon className="size-5" aria-hidden />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-heading">{a.name}</h1>
              <Badge tone="brand">{t(`treasury.kinds.${a.kind}`)}</Badge>
              <Badge>{a.currencyCode}</Badge>
              {!a.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">
              <span className="font-mono">{a.accountCode}</span>
              {a.bankName ? ` · ${a.bankName}` : ''}
              {a.branch ? ` · ${a.branch}` : ''}
              {a.iban ? ` · ${a.iban}` : ''}
              {a.accountNo ? ` · ${a.accountNo}` : ''}
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              {t('common.edit')}
            </Button>
            <Button
              loading={toggleActive.isPending}
              onClick={() =>
                toggleActive.mutate(
                  { isActive: !a.isActive },
                  { onSuccess: () => toast.success(t('treasury.form.saved')), onError: (e) => toast.error(errorMessage(e)) },
                )
              }
            >
              <Power className="size-4" aria-hidden />
              {a.isActive ? t('treasury.detail.deactivate') : t('treasury.detail.activate')}
            </Button>
          </div>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label={t('treasury.detail.balance')}>
          {money(a.balance)} {a.currencyCode}
        </Stat>
        {foreign ? (
          <>
            <Stat label={t('treasury.detail.cost')} sub={t('treasury.detail.costHint')}>
              {money(a.balanceBase)} {base}
            </Stat>
            <Stat label={t('treasury.detail.equivalent')} sub={a.equivalent === null ? t('treasury.accounts.noRate') : t('treasury.detail.equivalentHint')}>
              {a.equivalent === null ? '—' : `${money(a.equivalent)} ${base}`}
            </Stat>
          </>
        ) : (
          <Stat label={t('treasury.detail.lastActivity')}>{a.lastActivity ? formatDateTR(a.lastActivity) : '—'}</Stat>
        )}
      </div>

      {canPost && a.isActive && (
        <div className="mb-6 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setNewType('receipt')}>
            <Plus className="size-4" aria-hidden />
            {t('treasury.types.receipt')}
          </Button>
          <Button onClick={() => setNewType('payment')}>{t('treasury.types.payment')}</Button>
          <Button onClick={() => setNewType('transfer')}>
            <ArrowLeftRight className="size-4" aria-hidden />
            {t('treasury.types.transfer')}
          </Button>
          <Button onClick={() => setNewType('exchange')}>
            <Repeat className="size-4" aria-hidden />
            {t('treasury.types.exchange')}
          </Button>
          <Button onClick={() => setNewType('other_payment')}>{t('treasury.detail.otherPayment')}</Button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <h2 className="mr-auto text-[15px]">{t('treasury.detail.statement')}</h2>
        <Field label={t('common.from')}>{(fid) => <Input id={fid} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(fid) => <Input id={fid} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
        <ExportMenu exportKey="treasury-statement" params={{ accountId: a.id, from, to }} print={false} disabled={!st} />
      </div>

      {statement.error ? (
        <Callout tone="danger">{errorMessage(statement.error)}</Callout>
      ) : !st ? (
        <PageLoading />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('common.date')}</Th>
                <Th className="w-40">{t('ledger.accountLedger.entryNo')}</Th>
                <Th>{t('common.description')}</Th>
                <Th num>{t('treasury.detail.in')}</Th>
                <Th num>{t('treasury.detail.out')}</Th>
                <Th num>
                  {t('common.balance')} ({a.currencyCode})
                </Th>
                {foreign && (
                  <Th num>
                    {t('common.balance')} ({base})
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              <tr className="bg-surface-2/60">
                <Td colSpan={5}>{t('ledger.accountLedger.opening')}</Td>
                <Td num>{money(st.openingDoc)}</Td>
                {foreign && <Td num>{money(st.openingBase)}</Td>}
              </tr>
              {st.lines.length === 0 && (
                <tr>
                  <Td colSpan={foreign ? 7 : 6} className="py-8 text-center text-muted">
                    {t('treasury.detail.statementEmpty')}
                  </Td>
                </tr>
              )}
              {st.lines.map((l, i) => (
                <Tr key={`${l.entryId}-${i}`}>
                  <Td>{formatDateTR(l.entryDate)}</Td>
                  <Td>
                    <Link to={`/accounting/journal?open=${l.entryId}`} className="font-mono text-[13px] link">
                      {l.entryNo}
                    </Link>
                  </Td>
                  <Td>
                    <span className="block">{l.description}</span>
                    {l.txnId && l.txnType && (
                      <button className="mt-1 inline-flex items-center gap-2 text-xs link" onClick={() => setOpenTxn(l.txnId)}>
                        <TxnTypeBadge type={l.txnType} />
                        <span className="font-mono">{l.txnNo}</span>
                        {l.txnStatus === 'cancelled' && <span className="text-danger">{t('treasury.status.cancelled')}</span>}
                      </button>
                    )}
                  </Td>
                  <Td num>{isZero(l.debit) ? '' : money(l.debit)}</Td>
                  <Td num>{isZero(l.credit) ? '' : money(l.credit)}</Td>
                  <Td num>{money(l.balanceDoc)}</Td>
                  {foreign && <Td num className="text-muted">{money(l.balanceBase)}</Td>}
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2">
                <Td colSpan={3}>{t('ledger.accountLedger.totals')}</Td>
                <Td num>{money(st.totals.debit)}</Td>
                <Td num>{money(st.totals.credit)}</Td>
                <Td num>
                  <span className="sr-only">{t('ledger.accountLedger.closing')}: </span>
                  {money(st.closingDoc)}
                </Td>
                {foreign && <Td num>{money(st.closingBase)}</Td>}
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}

      <AccountFormSheet open={editing} onOpenChange={setEditing} account={a} onSaved={() => undefined} />
      <TransactionSheet
        open={newType !== null}
        onOpenChange={(o) => !o && setNewType(null)}
        initialType={newType ?? 'receipt'}
        initialAccountId={a.id}
        onSaved={(res) => setOpenTxn(res.transaction.id)}
      />
      <TransactionDetailSheet id={openTxn} onClose={() => setOpenTxn(null)} />
    </>
  );
}
