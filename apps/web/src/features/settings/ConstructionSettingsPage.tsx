import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { COST_CODE_KINDS, CONSTRUCTION_PARAM_KINDS, ROLES, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { ApprovalRuleRow, ConstructionParam, CostCode } from '../../lib/types';

const INV = [['cost-codes'], ['construction-params'], ['approval-rules']];

/** Ayarlar > İnşaat: maliyet kodları, tarihli parametreler (teminat, stopaj, avans) ve onay kuralları. */
export function ConstructionSettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('constructionSettings.title')} description={t('constructionSettings.subtitle')} />
      <div className="flex flex-col gap-6">
        <CostCodesCard />
        <ParamsCard />
        <RulesCard />
      </div>
    </>
  );
}

function CostCodesCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('projects.manage');
  const { data } = useCQuery<{ costCodes: CostCode[] }>(['cost-codes'], '/api/cost-codes');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('other');
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation((_: void, call) => call('/api/cost-codes', { method: 'POST', body: { code: code.trim(), name: name.trim(), kind } }), INV);
  const toggle = useCMutation((v: { id: string; isActive: boolean }, call) => call(`/api/cost-codes/${v.id}`, { method: 'PATCH', body: { isActive: v.isActive } }), INV);

  return (
    <Card>
      <CardHeader title={t('constructionSettings.costCodes.title')} description={t('constructionSettings.costCodes.desc')} />
      <div className="flex flex-col gap-4 p-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-24">{t('constructionSettings.costCodes.code')}</Th>
                <Th>{t('constructionSettings.costCodes.name')}</Th>
                <Th className="w-40">{t('constructionSettings.costCodes.kind')}</Th>
                <Th className="w-28">{t('common.status')}</Th>
                {canManage && <Th className="w-28"><span className="sr-only">{t('common.actions')}</span></Th>}
              </tr>
            </thead>
            <tbody>
              {(data?.costCodes ?? []).map((c) => (
                <Tr key={c.id} className={c.isActive ? undefined : 'opacity-60'}>
                  <Td className="font-mono text-[13px]">{c.code}</Td>
                  <Td>{c.name}</Td>
                  <Td className="text-muted">{t(`constructionSettings.costCodes.kinds.${c.kind}`)}</Td>
                  <Td>{c.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</Td>
                  {canManage && (
                    <Td>
                      <Button size="sm" onClick={() => toggle.mutate({ id: c.id, isActive: !c.isActive }, { onError: setError })}>
                        {c.isActive ? t('constructionSettings.deactivate') : t('constructionSettings.activate')}
                      </Button>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {canManage && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[8rem_1fr_12rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setCode(''); setName(''); toast.success(t('constructionSettings.costCodes.added')); }, onError: setError });
            }}
          >
            <Field label={t('constructionSettings.costCodes.code')}>{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} maxLength={30} />}</Field>
            <Field label={t('constructionSettings.costCodes.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />}</Field>
            <Field label={t('constructionSettings.costCodes.kind')}>
              {(id) => (
                <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                  {COST_CODE_KINDS.map((k) => (
                    <option key={k} value={k}>{t(`constructionSettings.costCodes.kinds.${k}`)}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!code.trim() || name.trim().length < 1}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}

function ParamsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('subcontracts.approve');
  const { data } = useCQuery<{ params: ConstructionParam[] }>(['construction-params'], '/api/construction-params');
  const [kind, setKind] = useState<string>('retention_pct');
  const [value, setValue] = useState('');
  const [validFrom, setValidFrom] = useState(todayIso());
  const [sourceNote, setSourceNote] = useState('');
  const [verifying, setVerifying] = useState<ConstructionParam | null>(null);
  const [verifiedBy, setVerifiedBy] = useState('');
  const [error, setError] = useState<Error | null>(null);

  const add = useCMutation((_: void, call) => call('/api/construction-params', { method: 'POST', body: { kind, value: value.replace(',', '.'), validFrom, ...(sourceNote.trim() ? { sourceNote: sourceNote.trim() } : {}) } }), INV);
  const verify = useCMutation((_: void, call) => call(`/api/construction-params/${verifying!.id}/verify`, { method: 'POST', body: { verifiedBy: verifiedBy.trim() } }), INV);
  const remove = useCMutation((id: string, call) => call(`/api/construction-params/${id}`, { method: 'DELETE' }), INV);
  const rows = data?.params ?? [];

  return (
    <Card>
      <CardHeader title={t('constructionSettings.params.title')} description={t('constructionSettings.params.desc')} />
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="warning">{t('constructionSettings.params.legal')}</Callout>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('constructionSettings.params.empty')}</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('constructionSettings.params.kind')}</Th>
                  <Th num className="w-24">{t('constructionSettings.params.value')}</Th>
                  <Th className="w-28">{t('constructionSettings.params.from')}</Th>
                  <Th className="w-28">{t('constructionSettings.params.to')}</Th>
                  <Th>{t('constructionSettings.params.source')}</Th>
                  <Th className="w-40">{t('constructionSettings.params.verification')}</Th>
                  {canManage && <Th className="w-40"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td>{t(`constructionSettings.params.kinds.${r.kind}`)}</Td>
                    <Td num>%{money(r.value, 2)}</Td>
                    <Td className="text-muted">{formatDateTR(r.validFrom)}</Td>
                    <Td className="text-muted">{r.validTo ? formatDateTR(r.validTo) : '—'}</Td>
                    <Td className="text-muted">{r.sourceNote ?? '—'}</Td>
                    <Td>{r.verifiedAt ? <Badge tone="success">{t('constructionSettings.params.verified', { by: r.verifiedBy })}</Badge> : <Badge tone="warning">{t('constructionSettings.params.unverified')}</Badge>}</Td>
                    {canManage && (
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => { setVerifiedBy(''); setVerifying(r); }}>{t('constructionSettings.params.verify')}</Button>
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
        {canManage && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_7rem_10rem_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setValue(''); setSourceNote(''); toast.success(t('constructionSettings.params.added')); }, onError: setError });
            }}
          >
            <Field label={t('constructionSettings.params.kind')}>
              {(id) => (
                <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                  {CONSTRUCTION_PARAM_KINDS.map((k) => (
                    <option key={k} value={k}>{t(`constructionSettings.params.kinds.${k}`)}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('constructionSettings.params.value')}>{(id) => <Input id={id} inputMode="decimal" className="num text-right" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
            <Field label={t('constructionSettings.params.from')}>{(id) => <Input id={id} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />}</Field>
            <Field label={t('constructionSettings.params.source')}>{(id) => <Input id={id} value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} maxLength={500} placeholder={t('constructionSettings.params.sourcePlaceholder')} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!value.trim() || !validFrom}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
      <Modal
        open={!!verifying}
        onOpenChange={(o) => !o && setVerifying(null)}
        title={t('constructionSettings.params.verifyTitle')}
        description={t('constructionSettings.params.verifyDesc')}
        footer={
          <>
            <Button onClick={() => setVerifying(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={verify.isPending} disabled={verifiedBy.trim().length < 2} onClick={() => verify.mutate(undefined, { onSuccess: () => setVerifying(null), onError: setError })}>
              {t('constructionSettings.params.verify')}
            </Button>
          </>
        }
      >
        <Field label={t('constructionSettings.params.verifiedBy')} required>{(id) => <Input id={id} value={verifiedBy} onChange={(e) => setVerifiedBy(e.target.value)} maxLength={120} />}</Field>
      </Modal>
    </Card>
  );
}

function RulesCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const canManage = useCan()('subcontracts.approve');
  const { data } = useCQuery<{ rules: ApprovalRuleRow[] }>(['approval-rules'], '/api/approval-rules');
  const [docType, setDocType] = useState<'progress_payment' | 'employer_claim' | 'purchase_request'>('progress_payment');
  const [minAmount, setMinAmount] = useState('0');
  const [maxAmount, setMaxAmount] = useState('');
  const [separate, setSeparate] = useState(true);
  const [steps, setSteps] = useState<string[]>(['site_manager']);
  const [error, setError] = useState<Error | null>(null);

  const add = useCMutation(
    (_: void, call) =>
      call('/api/approval-rules', {
        method: 'POST',
        body: { docType, minAmount: minAmount.replace(',', '.') || '0', maxAmount: maxAmount.trim() ? maxAmount.replace(',', '.') : null, separateRequester: separate, steps: steps.map((role) => ({ role })) },
      }),
    INV,
  );
  const toggle = useCMutation((v: { id: string; isActive: boolean }, call) => call(`/api/approval-rules/${v.id}`, { method: 'PATCH', body: { isActive: v.isActive } }), INV);
  const remove = useCMutation((id: string, call) => call(`/api/approval-rules/${id}`, { method: 'DELETE' }), INV);
  const rules = data?.rules ?? [];

  return (
    <Card>
      <CardHeader title={t('constructionSettings.rules.title')} description={t('constructionSettings.rules.desc')} />
      <div className="flex flex-col gap-4 p-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rules.length === 0 ? (
          <Callout tone="info">{t('constructionSettings.rules.none')}</Callout>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th className="w-44">{t('constructionSettings.rules.docType')}</Th>
                  <Th>{t('constructionSettings.rules.range')}</Th>
                  <Th>{t('constructionSettings.rules.steps')}</Th>
                  <Th className="w-40">{t('constructionSettings.rules.separate')}</Th>
                  <Th className="w-24">{t('common.status')}</Th>
                  {canManage && <Th className="w-40"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <Tr key={r.id} className={r.isActive ? undefined : 'opacity-60'}>
                    <Td className="text-muted">{t(`subcontracts.approval.docTypes.${r.docType}`)}</Td>
                    <Td>{r.maxAmount ? t('constructionSettings.rules.rangeBetween', { min: money(r.minAmount), max: money(r.maxAmount) }) : t('constructionSettings.rules.rangeFrom', { min: money(r.minAmount) })}</Td>
                    <Td>{r.steps.map((s) => (s.approverRole ? t(`subcontracts.approval.roles.${s.approverRole}` as 'subcontracts.approval.roles.owner') : t('subcontracts.approval.userStep'))).join(' → ')}</Td>
                    <Td className="text-muted">{r.separateRequester ? t('common.yes') : t('common.no')}</Td>
                    <Td>{r.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</Td>
                    {canManage && (
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => toggle.mutate({ id: r.id, isActive: !r.isActive }, { onError: setError })}>{r.isActive ? t('constructionSettings.deactivate') : t('constructionSettings.activate')}</Button>
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
        {canManage && (
          <form
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { toast.success(t('constructionSettings.rules.added')); setSteps(['site_manager']); setMinAmount('0'); setMaxAmount(''); }, onError: setError });
            }}
          >
            <Field label={t('constructionSettings.rules.docType')}>
              {(id) => (
                <Select id={id} value={docType} onChange={(e) => setDocType(e.target.value as 'progress_payment' | 'employer_claim' | 'purchase_request')} className="w-64">
                  <option value="progress_payment">{t('subcontracts.approval.docTypes.progress_payment')}</option>
                  <option value="employer_claim">{t('subcontracts.approval.docTypes.employer_claim')}</option>
                  <option value="purchase_request">{t('subcontracts.approval.docTypes.purchase_request')}</option>
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('constructionSettings.rules.min')}>{(id) => <Input id={id} inputMode="decimal" className="num text-right" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />}</Field>
              <Field label={t('constructionSettings.rules.max')} hint={t('constructionSettings.rules.maxHint')}>{(id) => <Input id={id} inputMode="decimal" className="num text-right" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />}</Field>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
                {t('constructionSettings.rules.separate')}
              </label>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[13px]">{t('constructionSettings.rules.steps')}</span>
              {steps.map((role, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-6 text-sm text-muted">{i + 1}.</span>
                  <Select aria-label={`${t('constructionSettings.rules.step')} ${i + 1}`} value={role} onChange={(e) => setSteps((s) => s.map((x, j) => (j === i ? e.target.value : x)))} className="w-56">
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{t(`subcontracts.approval.roles.${r}`)}</option>
                    ))}
                  </Select>
                  {steps.length > 1 && (
                    <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${i + 1}`} onClick={() => setSteps((s) => s.filter((_, j) => j !== i))}>
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  )}
                </div>
              ))}
              <div>
                <Button size="sm" onClick={() => setSteps((s) => [...s, 'accountant'])}>
                  <Plus className="size-4" aria-hidden />
                  {t('constructionSettings.rules.addStep')}
                </Button>
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={add.isPending}>{t('constructionSettings.rules.add')}</Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
