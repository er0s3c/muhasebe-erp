import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FEE_BASES, FEE_SIDES, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { FeeSchedule } from '../../lib/types';
import { MoneyInput } from '../../components/ui/MoneyInput';

const INV = [['fee-schedules'], ['sales-summary'], ['fee-estimate']];

/** Altyapı fonu/harç tarifeleri: tarihli, kaynak notlu, doğrulama alanlı (kodda sabit değer yok). */
export function FeeSchedulesCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('realestate.approve');
  const { data } = useCQuery<{ feeSchedules: FeeSchedule[] }>(['fee-schedules'], '/api/fee-schedules');
  const [f, setF] = useState({ code: '', name: '', side: 'buyer', basis: 'per_unit', amount: '', currencyCode: 'GBP', validFrom: todayIso(), sourceNote: '' });
  const [verifying, setVerifying] = useState<FeeSchedule | null>(null);
  const [verifiedBy, setVerifiedBy] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const pct = f.basis === 'pct_of_price';
  const add = useCMutation(
    (_: void, call) => call('/api/fee-schedules', { method: 'POST', body: { code: f.code.trim(), name: f.name.trim(), side: f.side, basis: f.basis, amount: f.amount, currencyCode: pct ? null : f.currencyCode, validFrom: f.validFrom, sourceNote: f.sourceNote.trim() || null } }),
    INV,
  );
  const verify = useCMutation((_: void, call) => call(`/api/fee-schedules/${verifying!.id}/verify`, { method: 'POST', body: { verifiedBy: verifiedBy.trim() } }), INV);
  const remove = useCMutation((id: string, call) => call(`/api/fee-schedules/${id}`, { method: 'DELETE' }), INV);
  const rows = data?.feeSchedules ?? [];

  return (
    <Card>
      <CardHeader title={t('feeSchedules.title')} description={t('feeSchedules.desc')} />
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="warning">{t('feeSchedules.legal')}</Callout>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('feeSchedules.empty')}</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-24">{t('feeSchedules.code')}</Th>
                  <Th>{t('feeSchedules.name')}</Th>
                  <Th className="w-32">{t('feeSchedules.side')}</Th>
                  <Th className="w-36">{t('feeSchedules.basis')}</Th>
                  <Th num className="w-32">{t('feeSchedules.amount')}</Th>
                  <Th className="w-28">{t('feeSchedules.from')}</Th>
                  <Th className="w-40">{t('feeSchedules.verification')}</Th>
                  {canManage && <Th className="w-40" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-mono text-[13px]">{r.code}</Td>
                    <Td>{r.name}{r.sourceNote ? <span className="block text-xs text-muted">{r.sourceNote}</span> : null}</Td>
                    <Td>{t(`feeSchedules.sides.${r.side}`)}</Td>
                    <Td>{t(`feeSchedules.bases.${r.basis}`)}</Td>
                    <Td num>{r.basis === 'pct_of_price' ? `%${money(r.amount, 2)}` : `${money(r.amount, 2)} ${r.currencyCode}`}</Td>
                    <Td className="text-muted">{formatDateTR(r.validFrom)}</Td>
                    <Td>{r.verifiedAt ? <Badge tone="success">{t('feeSchedules.verified', { by: r.verifiedBy })}</Badge> : <Badge tone="warning">{t('feeSchedules.unverified')}</Badge>}</Td>
                    {canManage && (
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => { setVerifiedBy(''); setVerifying(r); }}>{t('feeSchedules.verify')}</Button>
                          <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${r.code}`} onClick={() => remove.mutate(r.id, { onError: setError })}>
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </div>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        {canManage && (
          <form
            className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setF((x) => ({ ...x, code: '', name: '', amount: '', sourceNote: '' })); toast.success(t('feeSchedules.added')); }, onError: setError });
            }}
          >
            <Field label={t('feeSchedules.code')}>{(id) => <Input id={id} value={f.code} onChange={(e) => set('code', e.target.value)} maxLength={30} />}</Field>
            <Field label={t('feeSchedules.name')}>{(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />}</Field>
            <Field label={t('feeSchedules.side')}>
              {(id) => <Select id={id} value={f.side} onChange={(e) => set('side', e.target.value)}>{FEE_SIDES.map((s) => <option key={s} value={s}>{t(`feeSchedules.sides.${s}`)}</option>)}</Select>}
            </Field>
            <Field label={t('feeSchedules.basis')}>
              {(id) => <Select id={id} value={f.basis} onChange={(e) => set('basis', e.target.value)}>{FEE_BASES.map((b) => <option key={b} value={b}>{t(`feeSchedules.bases.${b}`)}</option>)}</Select>}
            </Field>
            <Field label={pct ? t('feeSchedules.percent') : t('feeSchedules.amount')}>{(id) => <MoneyInput id={id} className="text-right" value={f.amount} onChange={(v) => set('amount', v)} decimals={pct ? 0 : 2} maxDecimals={4} />}</Field>
            <Field label={t('feeSchedules.currency')}>
              {(id) => <Select id={id} value={f.currencyCode} disabled={pct} onChange={(e) => set('currencyCode', e.target.value)}><CurrencyOptions wide /></Select>}
            </Field>
            <Field label={t('feeSchedules.from')}>{(id) => <Input id={id} type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} />}</Field>
            <Field label={t('feeSchedules.source')}>{(id) => <Input id={id} value={f.sourceNote} onChange={(e) => set('sourceNote', e.target.value)} maxLength={300} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!f.code.trim() || !f.name.trim() || !f.amount.trim()}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
      <Modal
        open={!!verifying}
        onOpenChange={(o) => !o && setVerifying(null)}
        title={t('feeSchedules.verifyTitle')}
        description={t('feeSchedules.verifyDesc')}
        footer={
          <>
            <Button onClick={() => setVerifying(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={verify.isPending} disabled={verifiedBy.trim().length < 2} onClick={() => verify.mutate(undefined, { onSuccess: () => setVerifying(null), onError: setError })}>{t('feeSchedules.verify')}</Button>
          </>
        }
      >
        <Field label={t('feeSchedules.verifiedByLabel')} required>{(id) => <Input id={id} value={verifiedBy} onChange={(e) => setVerifiedBy(e.target.value)} maxLength={120} />}</Field>
      </Modal>
    </Card>
  );
}
