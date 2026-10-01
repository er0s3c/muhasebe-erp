import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { useToast } from '../../components/ui/Toast';
import { todayIso } from '@erp/shared';
import { errorMessage } from '../../lib/errors';
import { moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { SubcontractBalances, SubcontractDetail } from '../../lib/types';
import { SUBCONTRACT_INVALIDATE } from './common';

interface TreasuryAccountRow {
  id: string;
  name: string;
  kind: string;
  currencyCode?: string;
  currency?: string;
}

/** Avans (verilen / mahsup / kalan) ve teminat (tutulan / iade / kalan); iki eylem: avans ver, teminat iade et. */
export function BalancesTab({ detail }: { detail: SubcontractDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const treasuryOn = useModuleEnabled('core.treasury');
  const sc = detail.subcontract;
  const cur = sc.currencyCode;
  const { data } = useCQuery<{ balances: SubcontractBalances }>(['subcontract', sc.id, 'balances'], `/api/subcontracts/${sc.id}/balances`);
  const b = data?.balances;
  const active = sc.status === 'active';

  const [mode, setMode] = useState<'advance' | 'release' | null>(null);
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);

  const { data: accountsData } = useCQuery<{ accounts: TreasuryAccountRow[] }>(['treasury', 'accounts', 'picker'], '/api/treasury/accounts', { enabled: treasuryOn && mode === 'advance' });
  const accounts = (accountsData?.accounts ?? []).filter((a) => (a.currencyCode ?? a.currency) === cur);

  const submit = useCMutation(
    (_: void, call) =>
      call(mode === 'advance' ? `/api/subcontracts/${sc.id}/advances` : `/api/subcontracts/${sc.id}/retention-releases`, {
        method: 'POST',
        body: { date, amount: amount.replace(',', '.'), ...(note.trim() ? { note: note.trim() } : {}), ...(mode === 'advance' ? { accountId } : {}) },
      }),
    [...SUBCONTRACT_INVALIDATE, ['treasury']],
  );
  const open = (m: 'advance' | 'release') => {
    setMode(m);
    setAmount('');
    setNote('');
    setDate(todayIso());
    setError(null);
  };
  const canSubmit = Number(amount.replace(',', '.')) > 0 && !!date && (mode !== 'advance' || !!accountId);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('subcontracts.balances.certified')} sub={t('subcontracts.balances.certifiedSub')}>{moneyIn(b?.certifiedGross ?? '0', cur)}</Stat>
        <Stat label={t('subcontracts.balances.advanceBalance')} sub={t('subcontracts.balances.advanceSub', { given: moneyIn(b?.advanceGiven ?? '0', cur), recouped: moneyIn(b?.advanceRecouped ?? '0', cur) })}>
          {moneyIn(b?.advanceBalance ?? '0', cur)}
        </Stat>
        <Stat label={t('subcontracts.balances.retentionBalance')} sub={t('subcontracts.balances.retentionSub', { held: moneyIn(b?.retentionHeld ?? '0', cur), released: moneyIn(b?.retentionReleased ?? '0', cur) })}>
          {moneyIn(b?.retentionBalance ?? '0', cur)}
        </Stat>
      </div>
      <Card>
        <CardHeader title={t('subcontracts.balances.actionsTitle')} description={t('subcontracts.balances.actionsDesc')} />
        <div className="flex flex-wrap gap-3 p-4">
          {can('subcontracts.approve') && active && treasuryOn && <Button onClick={() => open('advance')}>{t('subcontracts.balances.giveAdvance')}</Button>}
          {can('subcontracts.approve') && Number(b?.retentionBalance ?? 0) > 0 && <Button onClick={() => open('release')}>{t('subcontracts.balances.releaseRetention')}</Button>}
          {!can('subcontracts.approve') && <p className="text-sm text-muted">{t('subcontracts.balances.noPermission')}</p>}
        </div>
      </Card>

      <Modal
        open={mode !== null}
        onOpenChange={(o) => !o && setMode(null)}
        title={mode === 'advance' ? t('subcontracts.balances.giveAdvance') : t('subcontracts.balances.releaseRetention')}
        description={mode === 'advance' ? t('subcontracts.balances.advanceDesc', { currency: cur }) : t('subcontracts.balances.releaseDesc', { max: moneyIn(b?.retentionBalance ?? '0', cur) })}
        footer={
          <>
            <Button onClick={() => setMode(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={submit.isPending}
              disabled={!canSubmit}
              onClick={() => {
                setError(null);
                submit.mutate(undefined, { onSuccess: () => { toast.success(t('subcontracts.balances.done')); setMode(null); }, onError: setError });
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          {mode === 'advance' && (
            <Field label={t('subcontracts.balances.account')} required hint={accounts.length === 0 ? t('subcontracts.balances.noAccount', { currency: cur }) : undefined}>
              {(id) => (
                <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">{t('subcontracts.balances.pickAccount')}</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('common.date')} required>{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            <Field label={t('subcontracts.balances.amount')} required>{(id) => <Input id={id} inputMode="decimal" className="num text-right" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          </div>
          <Field label={t('subcontracts.balances.note')}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field>
        </div>
      </Modal>
    </div>
  );
}
