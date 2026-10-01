import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Combobox } from '../../components/ui/Combobox';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { useToast } from '../../components/ui/Toast';
import { todayIso } from '@erp/shared';
import { errorMessage } from '../../lib/errors';
import { moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import { Plus, Trash2 } from 'lucide-react';
import { formatDateTR } from '../../lib/format';
import type { MaterialIssueRow, SubcontractBalances, SubcontractDetail } from '../../lib/types';
import { STOCK_INVALIDATE, qtyText, useItemOptions, useWarehouses } from '../inventory/common';
import { useProjectOptions } from '../projects/common';
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
  const receivable = sc.direction === 'receivable';

  const [mode, setMode] = useState<'advance' | 'release' | 'material' | null>(null);
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);

  // Taşerona malzeme (yalnızca taşeron sözleşmesi): depo + satırlar (kart, miktar, iş kalemi)
  const inventoryOn = useModuleEnabled('core.inventory');
  const canMaterial = !receivable && active && inventoryOn && can('subcontracts.manage') && can('inventory.move');
  const { data: whData } = useWarehouses();
  const warehouses = (whData?.warehouses ?? []).filter((w) => w.isActive !== false);
  const [warehouseId, setWarehouseId] = useState('');
  const { options: itemOptions } = useItemOptions(mode === 'material', warehouseId || undefined);
  const { byId: projectById } = useProjectOptions();
  const wbsOptions = (projectById.get(sc.projectId)?.wbs ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}`, keywords: `${w.code} ${w.name}` }));
  const [lines, setLines] = useState<{ key: string; itemId: string; quantity: string; wbsId: string }[]>([]);
  const { data: issuesData } = useCQuery<{ issues: MaterialIssueRow[] }>(['subcontract', sc.id, 'material-issues'], `/api/subcontracts/${sc.id}/material-issues`, { enabled: !receivable });
  const issues = issuesData?.issues ?? [];
  const giveMaterial = useCMutation(
    (_: void, call) =>
      call(`/api/subcontracts/${sc.id}/material-issues`, {
        method: 'POST',
        body: { date, warehouseId, ...(note.trim() ? { note: note.trim() } : {}), lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity.replace(',', '.'), wbsId: l.wbsId })) },
      }),
    [...SUBCONTRACT_INVALIDATE, ...STOCK_INVALIDATE, ['journal']],
  );
  const materialValid = !!warehouseId && !!date && lines.length > 0 && lines.every((l) => l.itemId && l.wbsId && Number(l.quantity.replace(',', '.')) > 0);

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
  const open = (m: 'advance' | 'release' | 'material') => {
    if (m === 'material') {
      setWarehouseId(warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? '');
      setLines([{ key: crypto.randomUUID(), itemId: '', quantity: '', wbsId: wbsOptions.length === 1 ? wbsOptions[0]!.value : '' }]);
    }
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
        {!receivable && (
          <Stat label={t('subcontracts.balances.materialBalance')} sub={t('subcontracts.balances.materialSub', { given: moneyIn(b?.materialGiven ?? '0', cur), recouped: moneyIn(b?.materialRecouped ?? '0', cur) })}>
            {moneyIn(b?.materialBalance ?? '0', cur)}
          </Stat>
        )}
      </div>
      <Card>
        <CardHeader title={t('subcontracts.balances.actionsTitle')} description={t('subcontracts.balances.actionsDesc')} />
        <div className="flex flex-wrap gap-3 p-4">
          {can('subcontracts.approve') && active && treasuryOn && <Button onClick={() => open('advance')}>{receivable ? t('subcontracts.employer.receiveAdvance') : t('subcontracts.balances.giveAdvance')}</Button>}
          {canMaterial && <Button onClick={() => open('material')}>{t('subcontracts.balances.giveMaterial')}</Button>}
          {can('subcontracts.approve') && Number(b?.retentionBalance ?? 0) > 0 && <Button onClick={() => open('release')}>{t('subcontracts.balances.releaseRetention')}</Button>}
          {!can('subcontracts.approve') && <p className="text-sm text-muted">{t('subcontracts.balances.noPermission')}</p>}
        </div>
      </Card>

      {!receivable && issues.length > 0 && (
        <Card>
          <CardHeader title={t('subcontracts.balances.materialTitle')} description={t('subcontracts.balances.materialDesc')} />
          <ul className="divide-y divide-border text-sm">
            {issues.map((i) => (
              <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-2.5">
                <span>
                  <span className="font-mono text-[13px] text-muted">{i.docNo}</span> · {formatDateTR(i.issueDate)}
                  {i.note ? <span className="text-muted"> — {i.note}</span> : null}
                </span>
                <span className="num">{moneyIn(i.amount, cur)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={mode === 'material'}
        onOpenChange={(o) => !o && setMode(null)}
        title={t('subcontracts.balances.giveMaterial')}
        description={t('subcontracts.balances.materialModalDesc')}
        footer={
          <>
            <Button onClick={() => setMode(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={giveMaterial.isPending}
              disabled={!materialValid}
              onClick={() => {
                setError(null);
                giveMaterial.mutate(undefined, { onSuccess: () => { toast.success(t('subcontracts.balances.materialGiven')); setMode(null); }, onError: setError });
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('subcontracts.balances.warehouse')} required>
              {(id) => (
                <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('common.date')} required>{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          </div>
          <div className="flex flex-col gap-2">
            {lines.map((l, i) => (
              <div key={l.key} className="grid grid-cols-[1fr_6rem_1fr_auto] items-center gap-2">
                <Combobox aria-label={`${t('subcontracts.balances.item')} ${i + 1}`} options={itemOptions} value={l.itemId || null} onChange={(v) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, itemId: v } : x)))} placeholder={t('subcontracts.balances.pickItem')} />
                <Input aria-label={`${t('subcontracts.balances.qty')} ${i + 1}`} inputMode="decimal" className="num text-right" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))} placeholder={qtyText('0') || '0'} />
                <Combobox aria-label={`${t('subcontracts.boq.cols.wbs')} ${i + 1}`} options={wbsOptions} value={l.wbsId || null} onChange={(v) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, wbsId: v } : x)))} placeholder={t('subcontracts.boq.pickWbs')} />
                <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40" disabled={lines.length === 1} aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
            ))}
            <div>
              <Button size="sm" onClick={() => setLines((ls) => [...ls, { key: crypto.randomUUID(), itemId: '', quantity: '', wbsId: '' }])}>
                <Plus className="size-4" aria-hidden />
                {t('subcontracts.balances.addMaterialLine')}
              </Button>
            </div>
          </div>
          <Field label={t('subcontracts.balances.note')}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field>
        </div>
      </Modal>

      <Modal
        open={mode === 'advance' || mode === 'release'}
        onOpenChange={(o) => !o && setMode(null)}
        title={mode === 'advance' ? (receivable ? t('subcontracts.employer.receiveAdvance') : t('subcontracts.balances.giveAdvance')) : t('subcontracts.balances.releaseRetention')}
        description={mode === 'advance' ? (receivable ? t('subcontracts.employer.advanceDesc', { currency: cur }) : t('subcontracts.balances.advanceDesc', { currency: cur })) : receivable ? t('subcontracts.employer.releaseDesc', { max: moneyIn(b?.retentionBalance ?? '0', cur) }) : t('subcontracts.balances.releaseDesc', { max: moneyIn(b?.retentionBalance ?? '0', cur) })}
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
