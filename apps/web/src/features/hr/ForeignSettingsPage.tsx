import { CURRENCY_CODES, FOREIGN_PARAM_KEYS, todayIso, type ForeignParamKey } from '@erp/shared';
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
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { ForeignDocTypeRow, ForeignParamRow } from '../../lib/types';
import { FOREIGN_INVALIDATE, ForeignUnverifiedBadge } from './foreign-common';
import { MoneyInput } from '../../components/ui/MoneyInput';

/** Yabancı işçi ayarları: belge türü kataloğu ve tarihli parametreler (uyarı günü, teminat tutarı; varsayılan kapalı, doğrulanmadı). */
export function ForeignSettingsPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('foreign.settings.title')} description={t('foreign.settings.subtitle')} />
      <div className="mb-4">
        <Callout tone="warning">{t('foreign.settings.legal')}</Callout>
      </div>
      <div className="flex flex-col gap-6">
        <TypesCard />
        <ParamsCard />
      </div>
    </>
  );
}

function TypesCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const manage = useCan()('hr.manage');
  const { data } = useCQuery<{ types: ForeignDocTypeRow[] }>(['foreign', 'types'], '/api/foreign-workers/doc-types');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const add = useCMutation((_: void, call) => call('/api/foreign-workers/doc-types', { method: 'POST', body: { code: code.trim(), name: name.trim() } }), FOREIGN_INVALIDATE);
  const toggle = useCMutation((v: { id: string; active: boolean }, call) => call(`/api/foreign-workers/doc-types/${v.id}`, { method: 'PATCH', body: { active: v.active } }), FOREIGN_INVALIDATE);
  const rows = data?.types ?? [];
  return (
    <Card>
      <CardHeader title={t('foreign.settings.types.title')} description={t('foreign.settings.types.desc')} />
      <div className="flex flex-col gap-4 p-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <TableWrap>
          <Table aria-label={t('foreign.settings.types.title')}>
            <thead>
              <tr>
                <Th className="w-44">{t('foreign.settings.types.code')}</Th>
                <Th>{t('foreign.settings.types.name')}</Th>
                <Th className="w-24">{t('foreign.settings.types.active')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-mono text-[13px]">{r.code}</Td>
                  <Td>{r.name}</Td>
                  <Td>
                    <Switch checked={r.active} disabled={!manage} loading={toggle.isPending} label={t('foreign.settings.types.activeLabel', { name: r.name })} onChange={(next) => toggle.mutate({ id: r.id, active: next }, { onError: setError })} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {manage && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[10rem_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setCode(''); setName(''); toast.success(t('foreign.settings.types.added')); }, onError: setError });
            }}
          >
            <Field label={t('foreign.settings.types.code')}>{(id) => <Input id={id} maxLength={30} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <Field label={t('foreign.settings.types.name')}>{(id) => <Input id={id} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!code.trim() || !name.trim()}>
              <Plus className="size-4" aria-hidden />
              {t('foreign.settings.types.add')}
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
  const manage = useCan()('hr.manage');
  const { data } = useCQuery<{ params: ForeignParamRow[] }>(['foreign', 'params'], '/api/foreign-workers/params');
  const [key, setKey] = useState<ForeignParamKey>('expiry_warning_days');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState<string>('EUR');
  const [from, setFrom] = useState(todayIso());
  const [source, setSource] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [verifying, setVerifying] = useState<ForeignParamRow | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const isAmount = key === 'guarantee_amount';
  const add = useCMutation(
    (_: void, call) =>
      call('/api/foreign-workers/params', {
        method: 'POST',
        body: { key, value: value, effectiveFrom: from, enabled, ...(isAmount ? { currency } : {}), ...(source.trim() ? { sourceNote: source.trim() } : {}) },
      }),
    FOREIGN_INVALIDATE,
  );
  const toggle = useCMutation((v: { id: string; enabled: boolean }, call) => call(`/api/foreign-workers/params/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }), FOREIGN_INVALIDATE);
  const verify = useCMutation((_: void, call) => call(`/api/foreign-workers/params/${verifying!.id}/verify`, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} }), FOREIGN_INVALIDATE);
  const remove = useCMutation((id: string, call) => call(`/api/foreign-workers/params/${id}`, { method: 'DELETE' }), FOREIGN_INVALIDATE);
  const rows = data?.params ?? [];
  const valid = isAmount ? /^\d{1,13}([.,]\d{1,4})?$/.test(value.trim()) : /^\d{1,4}$/.test(value.trim());

  return (
    <Card>
      <CardHeader title={t('foreign.settings.params.title')} description={t('foreign.settings.params.desc')} />
      <div className="flex flex-col gap-4 p-4">
        {error && !verifying && <Callout tone="danger">{errorMessage(error)}</Callout>}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('foreign.settings.params.empty')}</p>
        ) : (
          <TableWrap>
            <Table aria-label={t('foreign.settings.params.title')}>
              <thead>
                <tr>
                  <Th>{t('foreign.settings.params.key')}</Th>
                  <Th num className="w-32">{t('foreign.settings.params.value')}</Th>
                  <Th className="w-28">{t('foreign.settings.params.from')}</Th>
                  <Th>{t('foreign.settings.params.source')}</Th>
                  <Th className="w-20">{t('foreign.settings.params.enabled')}</Th>
                  <Th className="w-44">{t('foreign.settings.params.verification')}</Th>
                  {manage && <Th className="w-32"><span className="sr-only">{t('common.actions')}</span></Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td>{t(`foreign.settings.params.keys.${r.key}`)}</Td>
                    <Td num>{Number(r.value).toLocaleString('tr-TR', { maximumFractionDigits: 4 })} {r.currency ?? t('foreign.settings.params.days')}</Td>
                    <Td className="text-muted">{formatDateTR(r.effectiveFrom)}</Td>
                    <Td className="text-muted">{r.sourceNote ?? '—'}</Td>
                    <Td>
                      <Switch checked={r.enabled} disabled={!manage} loading={toggle.isPending} label={t('foreign.settings.params.enableLabel', { key: t(`foreign.settings.params.keys.${r.key}`), date: formatDateTR(r.effectiveFrom) })} onChange={(next) => toggle.mutate({ id: r.id, enabled: next }, { onError: setError })} />
                    </Td>
                    <Td>{r.verifiedAt ? <Badge tone="success">{t('foreign.settings.params.verifiedBy', { by: r.verifiedBy })}</Badge> : <ForeignUnverifiedBadge />}</Td>
                    {manage && (
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => { setNote(''); setError(null); setVerifying(r); }}>{t('foreign.settings.params.verify')}</Button>
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
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1.4fr_8rem_7rem_9rem_7rem]"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              add.mutate(undefined, { onSuccess: () => { setValue(''); setSource(''); setEnabled(false); toast.success(t('foreign.settings.params.added')); }, onError: setError });
            }}
          >
            <Field label={t('foreign.settings.params.key')}>
              {(id) => (
                <Select id={id} value={key} onChange={(e) => setKey(e.target.value as ForeignParamKey)}>
                  {FOREIGN_PARAM_KEYS.map((k) => <option key={k} value={k}>{t(`foreign.settings.params.keys.${k}`)}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('foreign.settings.params.value')}>{(id) => <MoneyInput id={id} value={value} onChange={(v) => setValue(v)} decimals={0} maxDecimals={6} />}</Field>
            {isAmount ? (
              <Field label={t('foreign.settings.params.currency')}>
                {(id) => (
                  <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                )}
              </Field>
            ) : (
              <span />
            )}
            <Field label={t('foreign.settings.params.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label={t('foreign.settings.params.enabled')}>{() => <Switch checked={enabled} label={t('foreign.settings.params.newOn')} onChange={setEnabled} />}</Field>
            <Field label={t('foreign.settings.params.source')} className="sm:col-span-4">{(id) => <Input id={id} maxLength={500} value={source} onChange={(e) => setSource(e.target.value)} />}</Field>
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!valid || !from}>
              <Plus className="size-4" aria-hidden />
              {t('foreign.settings.params.add')}
            </Button>
          </form>
        )}
      </div>
      <Modal
        open={!!verifying}
        onOpenChange={(o) => !o && setVerifying(null)}
        title={t('foreign.settings.params.verifyTitle')}
        description={t('foreign.settings.params.verifyDesc')}
        footer={
          <>
            <Button onClick={() => setVerifying(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: () => { setVerifying(null); toast.success(t('foreign.settings.params.verifiedToast')); }, onError: setError })}>
              {t('foreign.settings.params.verify')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('foreign.settings.params.source')} hint={t('foreign.settings.params.verifyHint')}>{(id) => <Input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
      </Modal>
    </Card>
  );
}
