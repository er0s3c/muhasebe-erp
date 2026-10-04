import { Ban } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { dec, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { TreasuryTxnDetail } from '../../lib/types';
import { TREASURY_INVALIDATE, TxnStatusBadge, TxnTypeBadge } from './common';
import { fmtDate } from '../../lib/license';

interface Props {
  /** Açılacak hareket; null ise kapalı */
  id: string | null;
  onClose: () => void;
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/** Hareket ayrıntısı: yevmiye bağlantısı, kapatılan kalemler, kur farkı ve iptal (ters kayıt). */
export function TransactionDetailSheet({ id, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const base = company.baseCurrency;
  const canPost = useCan()('treasury.post');
  const { data, error } = useCQuery<TreasuryTxnDetail>(['treasury', 'txn', id], id ? `/api/treasury/transactions/${id}` : null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelDate, setCancelDate] = useState(todayIso());
  const [reason, setReason] = useState('');

  useEffect(() => {
    setCancelling(false);
    setReason('');
    setCancelDate(todayIso());
  }, [id]);

  const cancel = useCMutation(
    (v: { date: string; reason: string }, call) => call<TreasuryTxnDetail>(`/api/treasury/transactions/${id}/cancel`, { method: 'POST', body: v }),
    TREASURY_INVALIDATE,
  );

  const tx = data?.transaction;
  const fxNet = dec(data?.fxNet ?? 0);

  return (
    <>
      <Sheet
        wide
        open={!!id}
        onOpenChange={(o) => !o && onClose()}
        title={tx ? tx.txnNo : t('treasury.view.title')}
        description={tx ? formatDateTR(tx.txnDate) : undefined}
        footer={
          tx && tx.status === 'posted' && canPost ? (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              <Ban className="size-4" aria-hidden />
              {t('treasury.view.cancel')}
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <Callout tone="danger">{errorMessage(error)}</Callout>
        ) : !data || !tx ? (
          <PageLoading />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <TxnTypeBadge type={tx.type} />
              <TxnStatusBadge status={tx.status} />
            </div>

            {tx.status === 'cancelled' && (
              <Callout tone="danger" title={t('treasury.view.cancelledTitle', { date: tx.cancelledAt ? fmtDate(tx.cancelledAt) : '' })}>
                {tx.cancelReason}
                {tx.cancelJournalEntryId && (
                  <>
                    {' · '}
                    <Link to={`/accounting/journal?open=${tx.cancelJournalEntryId}`} className="link">
                      {tx.cancelJournalEntryNo}
                    </Link>
                  </>
                )}
              </Callout>
            )}

            <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
              <Item label={tx.type === 'transfer' || tx.type === 'exchange' ? t('treasury.view.fromAccount') : t('treasury.view.account')}>
                <Link to={`/treasury/accounts/${tx.accountId}`} className="link" onClick={onClose}>
                  {tx.accountName}
                </Link>
              </Item>
              {tx.toAccountId && (
                <Item label={t('treasury.view.toAccount')}>
                  <Link to={`/treasury/accounts/${tx.toAccountId}`} className="link" onClick={onClose}>
                    {tx.toAccountName}
                  </Link>
                </Item>
              )}
              <Item label={t('treasury.view.amount')}>
                <span className="num">
                  {moneyIn(tx.amount, tx.currencyCode)}
                </span>
              </Item>
              {tx.counterAmount && tx.toCurrencyCode && (
                <Item label={t('treasury.view.counterAmount')}>
                  <span className="num">
                    {moneyIn(tx.counterAmount, tx.toCurrencyCode)}
                  </span>
                </Item>
              )}
              {tx.partyId && (
                <Item label={t('treasury.view.party')}>
                  <Link to={`/parties/${tx.partyId}`} className="link" onClick={onClose}>
                    {tx.partyName}
                  </Link>
                </Item>
              )}
              {tx.glAccountCode && (
                <Item label={t('treasury.view.glAccount')}>
                  {tx.glAccountCode} — {tx.glAccountName}
                </Item>
              )}
              {tx.fxRate && (
                <Item label={t('treasury.view.rate')}>
                  <span className="num">{money(tx.fxRate, 4)}</span>
                </Item>
              )}
              {!fxNet.isZero() && (
                <Item label={fxNet.gt(0) ? t('treasury.view.fxGain') : t('treasury.view.fxLoss')}>
                  <span className={fxNet.gt(0) ? 'text-success' : 'text-danger'}>
                    <span className="num">
                      {moneyIn(fxNet.abs().toFixed(2), base)}
                    </span>
                  </span>
                </Item>
              )}
              <Item label={t('treasury.view.journal')}>
                <Link to={`/accounting/journal?open=${tx.journalEntryId}`} className="link" onClick={onClose}>
                  {tx.journalEntryNo}
                </Link>
              </Item>
              {tx.description && (
                <div className="sm:col-span-2">
                  <dt className="text-muted">{t('common.description')}</dt>
                  <dd className="mt-0.5">{tx.description}</dd>
                </div>
              )}
            </dl>

            {data.allocations.length > 0 && (
              <section>
                <h3 className="mb-2 text-[15px]">{t('treasury.view.allocations')}</h3>
                <TableWrap>
                  <Table>
                    <thead>
                      <tr>
                        <Th className="w-28">{t('common.date')}</Th>
                        <Th>{t('common.description')}</Th>
                        <Th num>{t('treasury.view.closed')}</Th>
                        <Th num>{t('treasury.view.settled', { currency: currencySymbol(tx.currencyCode) })}</Th>
                        <Th num>{t('treasury.view.carried', { currency: currencySymbol(base) })}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.allocations.map((a) => (
                        <Tr key={a.lineId}>
                          <Td>{formatDateTR(a.entryDate)}</Td>
                          <Td>
                            <span className="block">{a.description}</span>
                            <Link to={`/accounting/journal?open=${a.entryId}`} className="font-mono text-xs link" onClick={onClose}>
                              {a.entryNo}
                            </Link>
                          </Td>
                          <Td num>
                            {moneyIn(a.amount, a.currencyCode)}
                          </Td>
                          <Td num className="text-muted">
                            {money(a.settleAmount)}
                          </Td>
                          <Td num>{money(a.amountBase)}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              </section>
            )}
            {tx.partyId && data.allocations.length === 0 && <p className="text-sm text-muted">{t('treasury.view.advanceOnly')}</p>}
          </div>
        )}
      </Sheet>

      <Modal
        open={cancelling}
        onOpenChange={setCancelling}
        title={t('treasury.view.cancelTitle')}
        description={t('treasury.view.cancelDesc')}
        footer={
          <>
            <Button onClick={() => setCancelling(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={cancel.isPending}
              disabled={reason.trim().length < 3 || !cancelDate}
              onClick={() =>
                cancel.mutate(
                  { date: cancelDate, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      toast.success(t('treasury.view.cancelledMsg'));
                      setCancelling(false);
                    },
                    onError: (e) => {
                      setCancelling(false);
                      toast.error(errorMessage(e));
                    },
                  },
                )
              }
            >
              {t('treasury.view.cancel')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('treasury.view.cancelDate')}>{(fid) => <Input id={fid} type="date" value={cancelDate} min={tx?.txnDate} onChange={(e) => setCancelDate(e.target.value)} />}</Field>
          <Field label={t('treasury.view.cancelReason')} required>
            {(fid) => <Input id={fid} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </>
  );
}
