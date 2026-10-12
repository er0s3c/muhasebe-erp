import { SUPPORT_MODES, SUPPORT_TARGETS, todayIso } from '@erp/shared';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout, ErrorState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Switch } from '../../components/ui/Switch';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { EmployeeRow, SocialProfileRow, SupportEligibilityRow, SupportRuleRow } from '../../lib/types';
import { SOCIAL_INVALIDATE, SocialUnverifiedBadge } from './social-common';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { markFormSaved } from '../../components/ui/UnsavedChanges';
import { Link } from 'react-router-dom';
import { useCompany } from '../../lib/session';

/** Sosyal güvenlik ayarları: tarihli personel profilleri, prim desteği kuralları (varsayılan kapalı, doğrulanmamış) ve uygunluk beyanları. */
export function SocialSettingsPage() {
  const { t } = useTranslation();
  const company = useCompany();
  return (
    <>
      <PageHeader title={t('social.settings.title')} description={t('social.settings.subtitle')} />
      <div className="mb-4">
        <Callout tone="warning">{t('social.settings.legal')}</Callout>
        {company.jurisdiction && <div className="mt-3"><Callout tone="info">{company.jurisdiction === 'TR' ? 'Türkiye SGK ve işsizlik' : 'KKTC sigorta, ihtiyat ve istihdam katkısı'} hesapları, bordronun kayıtlı ülke kuralından alınır. İhtiyat sigorta primi toplamına eklenmez. Oranları, çalışan rejimini ve önizlemeyi <Link to="/hr/payroll/settings" className="underline">Bordro ayarlarında</Link> yönetin.</Callout></div>}
      </div>
      <div className="flex flex-col gap-6">
        <ProfilesCard />
        <RulesCard />
        <EligibilityCard />
      </div>
    </>
  );
}

function useEmployees() {
  return useCQuery<{ employees: EmployeeRow[] }>(['employees', 'list', ''], '/api/employees?');
}

function ProfilesCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const manage = can('hr.payroll_manage');
  const { data , error: queryError, isPending: loadingQuery, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ profiles: SocialProfileRow[] }>(['social', 'profiles'], '/api/social-security/profiles');
  const { data: emps } = useEmployees();
  const [employeeId, setEmployeeId] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [type, setType] = useState('');
  const [insStart, setInsStart] = useState('');
  const [insEnd, setInsEnd] = useState('');
  const [ssn, setSsn] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState<SocialProfileRow | null>(null);
  const [reason, setReason] = useState('');
  const add = useCMutation(
    (_: void, call) =>
      call('/api/social-security/profiles', {
        method: 'POST',
        body: { employeeId, effectiveFrom: from, ...(type.trim() ? { payrollTypeCode: type.trim() } : {}), ...(insStart ? { insuranceStart: insStart } : {}), ...(insEnd ? { insuranceEnd: insEnd } : {}), ...(ssn.trim() ? { socialSecurityNo: ssn.trim() } : {}) },
      }),
    SOCIAL_INVALIDATE,
  );
  const remove = useCMutation((id: string, call) => call(`/api/social-security/profiles/${id}`, { method: 'DELETE' }), SOCIAL_INVALIDATE);
  const reveal = useCMutation((v: { id: string; reason: string }, call) => call<{ value: string }>(`/api/social-security/profiles/${v.id}/reveal`, { method: 'POST', body: { reason: v.reason } }), [['privacy']]);
  const rows = data?.profiles ?? [];

  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (loadingQuery) return <PageLoading />;
  return (
    <Card>
      <CardHeader title={t('social.profiles.title')} description={t('social.profiles.desc')} />
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="info">{t('social.profiles.privacy')}</Callout>
        {error && !ask && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('social.profiles.empty')}</p>
        ) : (
          <TableWrap>
            <Table aria-label={t('social.profiles.title')}>
              <thead>
                <tr>
                  <Th>{t('social.profiles.employee')}</Th>
                  <Th className="w-28">{t('social.profiles.from')}</Th>
                  <Th>{t('social.profiles.type')}</Th>
                  <Th className="w-28">{t('social.profiles.insStart')}</Th>
                  <Th className="w-28">{t('social.profiles.insEnd')}</Th>
                  <Th className="w-44">{t('social.profiles.ssn')}</Th>
                  {manage && <Th className="w-16"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const shown = revealed[r.id];
                  return (
                    <Tr key={r.id}>
                      <Td><span className="font-mono text-[12px] text-muted">{r.employeeCode}</span> {r.employeeName}</Td>
                      <Td className="text-muted">{formatDateTR(r.effectiveFrom)}</Td>
                      <Td>{r.payrollTypeCode ?? '—'}</Td>
                      <Td className="text-muted">{r.insuranceStart ? formatDateTR(r.insuranceStart) : '—'}</Td>
                      <Td className="text-muted">{r.insuranceEnd ? formatDateTR(r.insuranceEnd) : '—'}</Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[13px]">{shown ?? r.ssnMasked ?? '—'}</span>
                          {r.hasSsn &&
                            can('hr.sensitive') &&
                            (shown ? (
                              <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label={t('social.profiles.hide')} onClick={() => setRevealed((s) => { const n = { ...s }; delete n[r.id]; return n; })}>
                                <EyeOff className="size-4" aria-hidden />
                              </button>
                            ) : (
                              <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label={t('social.profiles.show')} onClick={() => { setError(null); setReason(''); setAsk(r); }}>
                                <Eye className="size-4" aria-hidden />
                              </button>
                            ))}
                        </span>
                      </Td>
                      {manage && (
                        <Td>
                          <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={t('common.delete')} onClick={() => remove.mutate(r.id, { onError: setError })}>
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </Td>
                      )}
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
        {manage && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1.4fr_9rem_1fr_9rem_9rem_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              setError(null);
              add.mutate(undefined, { onSuccess: () => { markFormSaved(form); setSsn(''); setType(''); toast.success(t('social.profiles.added')); }, onError: setError });
            }}
          >
            <Field label={t('social.profiles.employee')}>
              {(id) => (
                <Select id={id} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                  <option value="">{t('social.profiles.pick')}</option>
                  {(emps?.employees ?? []).map((e) => (
                    <option key={e.id} value={e.id}>{e.code} — {e.fullName}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('social.profiles.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label={t('social.profiles.type')} hint={t('social.profiles.typeHint')}>{(id) => <Input id={id} maxLength={40} value={type} onChange={(e) => setType(e.target.value)} />}</Field>
            <Field label={t('social.profiles.insStart')}>{(id) => <Input id={id} type="date" value={insStart} onChange={(e) => setInsStart(e.target.value)} />}</Field>
            <Field label={t('social.profiles.insEnd')}>{(id) => <Input id={id} type="date" value={insEnd} onChange={(e) => setInsEnd(e.target.value)} />}</Field>
            <Field label={t('social.profiles.ssn')}>{(id) => <Input id={id} maxLength={40} autoComplete="off" value={ssn} onChange={(e) => setSsn(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!employeeId || !from}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
      <Modal
        open={!!ask}
        onOpenChange={(o) => !o && setAsk(null)}
        title={t('social.profiles.revealTitle')}
        description={t('social.profiles.revealDesc')}
        footer={
          <>
            <Button onClick={() => setAsk(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={reveal.isPending}
              disabled={reason.trim().length < 3}
              onClick={() => ask && reveal.mutate({ id: ask.id, reason: reason.trim() }, { onSuccess: (r) => { setRevealed((s) => ({ ...s, [ask.id]: r.value })); setAsk(null); }, onError: setError })}
            >
              {t('social.profiles.show')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('social.profiles.reason')} required hint={t('social.profiles.reasonHint')}>{(id) => <Input id={id} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
      </Modal>
    </Card>
  );
}

function RulesCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const manage = useCan()('hr.payroll_manage');
  const { data , error: queryError, isPending: loadingQuery, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ rules: SupportRuleRow[] }>(['social', 'rules'], '/api/social-security/support-rules');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState('');
  const [target, setTarget] = useState<(typeof SUPPORT_TARGETS)[number]>('employer');
  const [mode, setMode] = useState<(typeof SUPPORT_MODES)[number]>('percent_of_premium');
  const [value, setValue] = useState('');
  const [source, setSource] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [verifying, setVerifying] = useState<SupportRuleRow | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation(
    (_: void, call) =>
      call('/api/social-security/support-rules', {
        method: 'POST',
        body: { code: code.trim(), name: name.trim(), effectiveFrom: from, ...(to ? { effectiveTo: to } : {}), target, mode, value: value, enabled, ...(source.trim() ? { sourceNote: source.trim() } : {}) },
      }),
    SOCIAL_INVALIDATE,
  );
  const toggle = useCMutation((v: { id: string; enabled: boolean }, call) => call(`/api/social-security/support-rules/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }), SOCIAL_INVALIDATE);
  const verify = useCMutation((_: void, call) => call(`/api/social-security/support-rules/${verifying!.id}/verify`, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} }), SOCIAL_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/social-security/support-rules/${id}`, { method: 'DELETE' }), SOCIAL_INVALIDATE);
  const rows = data?.rules ?? [];

  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (loadingQuery) return <PageLoading />;
  return (
    <Card>
      <CardHeader title={t('social.rules.title')} description={t('social.rules.desc')} />
      <div className="flex flex-col gap-4 p-4">
        {error && !verifying && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('social.rules.empty')}</p>
        ) : (
          <TableWrap>
            <Table aria-label={t('social.rules.title')}>
              <thead>
                <tr>
                  <Th className="w-24">{t('social.rules.code')}</Th>
                  <Th>{t('social.rules.name')}</Th>
                  <Th className="w-28">{t('social.rules.from')}</Th>
                  <Th className="w-28">{t('social.rules.to')}</Th>
                  <Th>{t('social.rules.target')}</Th>
                  <Th>{t('social.rules.mode')}</Th>
                  <Th num className="w-24">{t('social.rules.value')}</Th>
                  <Th>{t('social.rules.source')}</Th>
                  <Th className="w-20">{t('social.rules.enabled')}</Th>
                  <Th className="w-44">{t('social.rules.verification')}</Th>
                  {manage && <Th className="w-32"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-mono text-[13px]">{r.code}</Td>
                    <Td>{r.name}</Td>
                    <Td className="text-muted">{formatDateTR(r.effectiveFrom)}</Td>
                    <Td className="text-muted">{r.effectiveTo ? formatDateTR(r.effectiveTo) : '—'}</Td>
                    <Td>{t(`social.rules.targets.${r.target}`)}</Td>
                    <Td>{t(`social.rules.modes.${r.mode}`)}</Td>
                    <Td num>{Number(r.value).toLocaleString('tr-TR', { maximumFractionDigits: 6 })}{r.mode === 'percent_of_premium' ? ' %' : ''}</Td>
                    <Td className="text-muted">{r.sourceNote ?? '—'}</Td>
                    <Td>
                      <Switch checked={r.enabled} disabled={!manage} loading={toggle.isPending} label={t('social.rules.enableLabel', { code: r.code })} onChange={(next) => toggle.mutate({ id: r.id, enabled: next }, { onError: setError })} />
                    </Td>
                    <Td>{r.verifiedAt ? <Badge tone="success">{t('social.rules.verifiedBy', { by: r.verifiedBy })}</Badge> : <SocialUnverifiedBadge />}</Td>
                    {manage && (
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => { setNote(''); setError(null); setVerifying(r); }}>{t('social.rules.verify')}</Button>
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
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[6rem_1fr_9rem_9rem_9rem_9rem_7rem]"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              setError(null);
              add.mutate(undefined, { onSuccess: () => { markFormSaved(form); setCode(''); setName(''); setValue(''); setSource(''); setEnabled(false); toast.success(t('social.rules.added')); }, onError: setError });
            }}
          >
            <Field label={t('social.rules.code')}>{(id) => <Input id={id} maxLength={30} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <Field label={t('social.rules.name')}>{(id) => <Input id={id} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label={t('social.rules.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label={t('social.rules.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            <Field label={t('social.rules.target')}>
              {(id) => (
                <Select id={id} value={target} onChange={(e) => setTarget(e.target.value as (typeof SUPPORT_TARGETS)[number])}>
                  {SUPPORT_TARGETS.map((x) => <option key={x} value={x}>{t(`social.rules.targets.${x}`)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('social.rules.mode')}>
              {(id) => (
                <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as (typeof SUPPORT_MODES)[number])}>
                  {SUPPORT_MODES.map((x) => <option key={x} value={x}>{t(`social.rules.modes.${x}`)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={`${t('social.rules.value')} (${mode === 'percent_of_premium' ? t('social.rules.valueHintPercent') : t('social.rules.valueHintAmount')})`}>
              {(id) => <MoneyInput id={id} value={value} onChange={(v) => setValue(v)} decimals={0} maxDecimals={6} />}
            </Field>
            <Field label={t('social.rules.source')} className="sm:col-span-5">{(id) => <Input id={id} maxLength={500} value={source} onChange={(e) => setSource(e.target.value)} />}</Field>
            <Field label={t('social.rules.enabled')}>{() => <Switch checked={enabled} label={t('social.rules.enableLabel', { code: code || '—' })} onChange={setEnabled} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!code.trim() || !name.trim() || !from || !/^\d{1,13}([.,]\d{1,6})?$/.test(value.trim())}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
      <Modal
        open={!!verifying}
        onOpenChange={(o) => !o && setVerifying(null)}
        title={t('social.rules.verifyTitle')}
        description={t('social.rules.verifyDesc')}
        footer={
          <>
            <Button onClick={() => setVerifying(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: () => { setVerifying(null); toast.success(t('social.rules.verifiedToast')); }, onError: setError })}>
              {t('social.rules.verify')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('social.rules.source')} hint={t('social.rules.verifyHint')}>{(id) => <Input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
      </Modal>
    </Card>
  );
}

function EligibilityCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const manage = useCan()('hr.payroll_manage');
  const { data , error: queryError, isPending: loadingQuery, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ eligibility: SupportEligibilityRow[] }>(['social', 'eligibility'], '/api/social-security/eligibility');
  const { data: rules } = useCQuery<{ rules: SupportRuleRow[] }>(['social', 'rules'], '/api/social-security/support-rules');
  const { data: emps } = useEmployees();
  const [employeeId, setEmployeeId] = useState('');
  const [ruleCode, setRuleCode] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation((_: void, call) => call('/api/social-security/eligibility', { method: 'POST', body: { employeeId, ruleCode, validFrom: from, ...(to ? { validTo: to } : {}) } }), SOCIAL_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/social-security/eligibility/${id}`, { method: 'DELETE' }), SOCIAL_INVALIDATE);
  const rows = data?.eligibility ?? [];
  const codes = [...new Set((rules?.rules ?? []).map((r) => r.code))];

  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (loadingQuery) return <PageLoading />;
  return (
    <Card>
      <CardHeader title={t('social.eligibility.title')} description={t('social.eligibility.desc')} />
      <div className="flex flex-col gap-4 p-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('social.eligibility.empty')}</p>
        ) : (
          <TableWrap>
            <Table aria-label={t('social.eligibility.title')}>
              <thead>
                <tr>
                  <Th>{t('social.eligibility.employee')}</Th>
                  <Th className="w-28">{t('social.eligibility.rule')}</Th>
                  <Th className="w-28">{t('social.eligibility.from')}</Th>
                  <Th className="w-28">{t('social.eligibility.to')}</Th>
                  {manage && <Th className="w-16"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td><span className="font-mono text-[12px] text-muted">{r.employeeCode}</span> {r.employeeName}</Td>
                    <Td className="font-mono text-[13px]">{r.ruleCode}</Td>
                    <Td className="text-muted">{formatDateTR(r.validFrom)}</Td>
                    <Td className="text-muted">{r.validTo ? formatDateTR(r.validTo) : '—'}</Td>
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
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1.4fr_10rem_9rem_9rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              setError(null);
              add.mutate(undefined, { onSuccess: () => { markFormSaved(form); toast.success(t('social.eligibility.added')); }, onError: setError });
            }}
          >
            <Field label={t('social.eligibility.employee')}>
              {(id) => (
                <Select id={id} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                  <option value="">{t('social.profiles.pick')}</option>
                  {(emps?.employees ?? []).map((e) => (
                    <option key={e.id} value={e.id}>{e.code} — {e.fullName}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('social.eligibility.rule')}>
              {(id) => (
                <Select id={id} value={ruleCode} onChange={(e) => setRuleCode(e.target.value)}>
                  <option value="">{t('social.eligibility.pick')}</option>
                  {codes.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('social.eligibility.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label={t('social.eligibility.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!employeeId || !ruleCode || !from}>
              <Plus className="size-4" aria-hidden />
              {t('common.add')}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
