import { PAY_BASES, PAYROLL_LIABILITIES, PAYROLL_PARAM_KEYS, PAYROLL_PARAM_META, todayIso, type PayrollParamKey } from '@erp/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Switch } from '../../components/ui/Switch';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { EmployeeRow, PayrollItemRow, PayrollParamRow, PayTermRow } from '../../lib/types';
import { formatParamValue, PAYROLL_INVALIDATE, UnverifiedBadge } from './payroll-common';

/** Bordro ayarları: tarihli parametreler (varsayılan kapalı, doğrulanmamış), ücret şartları ve ek ödeme/kesinti kalemleri. */
export function PayrollSettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('payroll.settings.title')} description={t('payroll.settings.subtitle')} />
      <div className="flex flex-col gap-6">
        <ParamsCard />
        <TermsCard />
        <ItemsCard />
      </div>
    </>
  );
}

function ParamsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const manage = useCan()('hr.payroll_manage');
  const { data } = useCQuery<{ params: PayrollParamRow[] }>(['payroll', 'params'], '/api/payroll/params');
  const [key, setKey] = useState<PayrollParamKey>('overtime_multiplier');
  const [value, setValue] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [source, setSource] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [verifying, setVerifying] = useState<PayrollParamRow | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation(
    (_: void, call) => call('/api/payroll/params', { method: 'POST', body: { key, value: value.replace(',', '.'), effectiveFrom: from, enabled, ...(source.trim() ? { sourceNote: source.trim() } : {}) } }),
    PAYROLL_INVALIDATE,
  );
  const toggle = useCMutation((v: { id: string; enabled: boolean }, call) => call(`/api/payroll/params/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }), PAYROLL_INVALIDATE);
  const verify = useCMutation((_: void, call) => call(`/api/payroll/params/${verifying!.id}/verify`, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} }), PAYROLL_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/payroll/params/${id}`, { method: 'DELETE' }), PAYROLL_INVALIDATE);
  const rows = data?.params ?? [];
  const unit = PAYROLL_PARAM_META[key].unit;

  return (
    <Card>
      <CardHeader title={t('payroll.params.title')} description={t('payroll.params.desc')} />
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="warning">{t('payroll.params.legal')}</Callout>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('payroll.params.empty')}</p>
        ) : (
          <TableWrap>
            <Table aria-label={t('payroll.params.title')}>
              <thead>
                <tr>
                  <Th>{t('payroll.params.key')}</Th>
                  <Th num className="w-28">{t('payroll.params.value')}</Th>
                  <Th className="w-28">{t('payroll.params.from')}</Th>
                  <Th>{t('payroll.params.source')}</Th>
                  <Th className="w-24">{t('payroll.params.enabled')}</Th>
                  <Th className="w-44">{t('payroll.params.verification')}</Th>
                  {manage && <Th className="w-32"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td>{t(`payroll.params.keys.${r.key}`)}</Td>
                    <Td num>{formatParamValue(PAYROLL_PARAM_META[r.key].unit, r.value)}</Td>
                    <Td className="text-muted">{formatDateTR(r.effectiveFrom)}</Td>
                    <Td className="text-muted">{r.sourceNote ?? '—'}</Td>
                    <Td>
                      <Switch checked={r.enabled} disabled={!manage} loading={toggle.isPending} label={t('payroll.params.enableLabel', { key: t(`payroll.params.keys.${r.key}`) })} onChange={(next) => toggle.mutate({ id: r.id, enabled: next }, { onError: setError })} />
                    </Td>
                    <Td>{r.verifiedAt ? <Badge tone="success">{t('payroll.params.verifiedBy', { by: r.verifiedBy })}</Badge> : <UnverifiedBadge />}</Td>
                    {manage && (
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => { setNote(''); setError(null); setVerifying(r); }}>{t('payroll.params.verify')}</Button>
                          <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t('common.delete')} onClick={() => remove.mutate(r.id, { onError: setError })}>
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
        {manage && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1.4fr_8rem_10rem_1fr_auto_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setValue(''); setSource(''); setEnabled(false); toast.success(t('payroll.params.added')); }, onError: setError });
            }}
          >
            <Field label={t('payroll.params.key')}>
              {(id) => (
                <Select id={id} value={key} onChange={(e) => setKey(e.target.value as PayrollParamKey)}>
                  {PAYROLL_PARAM_KEYS.map((k) => (
                    <option key={k} value={k}>{t(`payroll.params.keys.${k}`)}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={`${t('payroll.params.value')} (${t(`payroll.params.units.${unit}`)})`}>{(id) => <Input id={id} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
            <Field label={t('payroll.params.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label={t('payroll.params.source')}>{(id) => <Input id={id} maxLength={500} value={source} onChange={(e) => setSource(e.target.value)} />}</Field>
            <Field label={t('payroll.params.enabled')}>
              {() => <Switch checked={enabled} label={t('payroll.params.enabledNew')} onChange={setEnabled} />}
            </Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!/^\d{1,13}([.,]\d{1,6})?$/.test(value.trim()) || !from}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
      <Modal
        open={!!verifying}
        onOpenChange={(o) => !o && setVerifying(null)}
        title={t('payroll.params.verifyTitle')}
        description={t('payroll.params.verifyDesc')}
        footer={
          <>
            <Button onClick={() => setVerifying(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: () => { setVerifying(null); toast.success(t('payroll.params.verifiedToast')); }, onError: setError })}>
              {t('payroll.params.verify')}
            </Button>
          </>
        }
      >
        <Field label={t('payroll.params.source')} hint={t('payroll.params.verifyHint')}>{(id) => <Input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </Modal>
    </Card>
  );
}

function TermsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const manage = useCan()('hr.payroll_manage');
  const { data } = useCQuery<{ terms: PayTermRow[] }>(['payroll', 'terms'], '/api/payroll/pay-terms');
  const { data: emps } = useCQuery<{ employees: EmployeeRow[] }>(['employees', 'list', ''], '/api/employees?');
  const [employeeId, setEmployeeId] = useState('');
  const [basis, setBasis] = useState<(typeof PAY_BASES)[number]>('monthly');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation((_: void, call) => call('/api/payroll/pay-terms', { method: 'POST', body: { employeeId, payBasis: basis, amount: amount.replace(',', '.'), effectiveFrom: from } }), PAYROLL_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/payroll/pay-terms/${id}`, { method: 'DELETE' }), PAYROLL_INVALIDATE);
  const rows = data?.terms ?? [];

  return (
    <Card>
      <CardHeader title={t('payroll.terms.title')} description={t('payroll.terms.desc')} />
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="info">{t('payroll.terms.privacy')}</Callout>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('payroll.terms.empty')}</p>
        ) : (
          <TableWrap>
            <Table aria-label={t('payroll.terms.title')}>
              <thead>
                <tr>
                  <Th>{t('payroll.line.employee')}</Th>
                  <Th className="w-28">{t('payroll.params.from')}</Th>
                  <Th className="w-32">{t('payroll.line.basis')}</Th>
                  <Th num className="w-36">{t('payroll.terms.amount')}</Th>
                  {manage && <Th className="w-16"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td><span className="font-mono text-[12px] text-muted">{r.employeeCode}</span> {r.employeeName}</Td>
                    <Td className="text-muted">{formatDateTR(r.effectiveFrom)}</Td>
                    <Td>{t(`payroll.basis.${r.payBasis}`)}</Td>
                    <Td num>{money(r.amount)}</Td>
                    {manage && (
                      <Td>
                        <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t('common.delete')} onClick={() => remove.mutate(r.id, { onError: setError })}>
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        {manage && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1.4fr_9rem_9rem_10rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setAmount(''); toast.success(t('payroll.terms.added')); }, onError: setError });
            }}
          >
            <Field label={t('payroll.line.employee')}>
              {(id) => (
                <Select id={id} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                  <option value="">{t('payroll.terms.pick')}</option>
                  {(emps?.employees ?? []).map((e) => (
                    <option key={e.id} value={e.id}>{e.code} — {e.fullName}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('payroll.line.basis')}>
              {(id) => (
                <Select id={id} value={basis} onChange={(e) => setBasis(e.target.value as (typeof PAY_BASES)[number])}>
                  {PAY_BASES.map((b) => (
                    <option key={b} value={b}>{t(`payroll.basis.${b}`)}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('payroll.terms.amount')}>{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
            <Field label={t('payroll.params.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!employeeId || !/^\d{1,15}([.,]\d{1,4})?$/.test(amount.trim()) || !from}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function ItemsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const manage = useCan()('hr.payroll_manage');
  const { data } = useCQuery<{ items: PayrollItemRow[] }>(['payroll', 'items'], '/api/payroll/items');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'earning' | 'deduction'>('earning');
  const [social, setSocial] = useState(false);
  const [tax, setTax] = useState(false);
  const [liability, setLiability] = useState<(typeof PAYROLL_LIABILITIES)[number]>('other');
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation(
    (_: void, call) => call('/api/payroll/items', { method: 'POST', body: { code: code.trim(), name: name.trim(), kind, affectsSocialBase: social, affectsTaxBase: tax, liability } }),
    PAYROLL_INVALIDATE,
  );
  const toggle = useCMutation((v: { id: string; isActive: boolean }, call) => call(`/api/payroll/items/${v.id}`, { method: 'PATCH', body: { isActive: v.isActive } }), PAYROLL_INVALIDATE);
  const rows = data?.items ?? [];

  return (
    <Card>
      <CardHeader title={t('payroll.items.title')} description={t('payroll.items.desc')} />
      <div className="flex flex-col gap-4 p-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('payroll.items.empty')}</p>
        ) : (
          <TableWrap>
            <Table aria-label={t('payroll.items.title')}>
              <thead>
                <tr>
                  <Th className="w-24">{t('payroll.items.code')}</Th>
                  <Th>{t('payroll.items.name')}</Th>
                  <Th className="w-28">{t('payroll.items.kind')}</Th>
                  <Th className="w-28">{t('payroll.items.socialBase')}</Th>
                  <Th className="w-28">{t('payroll.items.taxBase')}</Th>
                  <Th className="w-36">{t('payroll.items.liability')}</Th>
                  <Th className="w-24">{t('common.status')}</Th>
                  {manage && <Th className="w-28"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id} className={r.isActive ? undefined : 'opacity-60'}>
                    <Td className="font-mono text-[13px]">{r.code}</Td>
                    <Td>{r.name}</Td>
                    <Td>{t(`payroll.items.kinds.${r.kind}`)}</Td>
                    <Td>{r.kind === 'earning' ? (r.affectsSocialBase ? t('common.yes') : t('common.no')) : '—'}</Td>
                    <Td>{r.kind === 'earning' ? (r.affectsTaxBase ? t('common.yes') : t('common.no')) : '—'}</Td>
                    <Td className="text-muted">{r.kind === 'deduction' ? t(`payroll.items.liabilities.${r.liability}`) : '—'}</Td>
                    <Td>{r.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</Td>
                    {manage && (
                      <Td>
                        <Button size="sm" onClick={() => toggle.mutate({ id: r.id, isActive: !r.isActive }, { onError: setError })}>
                          {r.isActive ? t('constructionSettings.deactivate') : t('constructionSettings.activate')}
                        </Button>
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        {manage && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[7rem_1fr_9rem_auto_auto_9rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setCode(''); setName(''); toast.success(t('payroll.items.added')); }, onError: setError });
            }}
          >
            <Field label={t('payroll.items.code')}>{(id) => <Input id={id} maxLength={30} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <Field label={t('payroll.items.name')}>{(id) => <Input id={id} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label={t('payroll.items.kind')}>
              {(id) => (
                <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as 'earning' | 'deduction')}>
                  <option value="earning">{t('payroll.items.kinds.earning')}</option>
                  <option value="deduction">{t('payroll.items.kinds.deduction')}</option>
                </Select>
              )}
            </Field>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" className="size-4" checked={social} disabled={kind !== 'earning'} onChange={(e) => setSocial(e.target.checked)} />
              {t('payroll.items.socialBase')}
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" className="size-4" checked={tax} disabled={kind !== 'earning'} onChange={(e) => setTax(e.target.checked)} />
              {t('payroll.items.taxBase')}
            </label>
            <Field label={t('payroll.items.liability')}>
              {(id) => (
                <Select id={id} value={liability} disabled={kind !== 'deduction'} onChange={(e) => setLiability(e.target.value as (typeof PAYROLL_LIABILITIES)[number])}>
                  {PAYROLL_LIABILITIES.map((l) => (
                    <option key={l} value={l}>{t(`payroll.items.liabilities.${l}`)}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!code.trim() || !name.trim()}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
        <p className="text-xs text-muted">{t('payroll.items.flagsNote')}</p>
      </div>
    </Card>
  );
}
