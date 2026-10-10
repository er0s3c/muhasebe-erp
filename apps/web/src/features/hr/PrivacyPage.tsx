import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { SegmentedTabs, TabPanel } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { AccessLogRow, DirContact, DsrRow, EmployeeRow, InventoryRow } from '../../lib/types';
import { HR_INVALIDATE } from './common';
import { fmtDate } from '../../lib/license';

type Tab = 'inventory' | 'requests' | 'log';

/** Veri koruma (89/2007): işleme envanteri, ilgili kişi talepleri ve hassas veri erişim günlüğü. */
export function PrivacyPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('inventory');
  return (
    <>
      <PageHeader title={t('privacy.title')} description={t('privacy.subtitle')} />
      <div className="mb-4">
        <Callout tone="warning">{t('privacy.legal')}</Callout>
      </div>
      <div className="mb-4">
        <SegmentedTabs id="hr-privacypage-tabs" panelId={() => 'hr-privacypage-tabs-panel'}
          value={tab}
          onChange={setTab}
          items={[
            { key: 'inventory', label: t('privacy.tabs.inventory') },
            { key: 'requests', label: t('privacy.tabs.requests') },
            { key: 'log', label: t('privacy.tabs.log') },
          ]}
        />
      </div>
      <TabPanel id="hr-privacypage-tabs-panel" labelledBy={`hr-privacypage-tabs-${tab}`}>
      {tab === 'inventory' && <InventoryTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'log' && <LogTab />}
      </TabPanel>
    </>
  );
}

function InventoryTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ inventory: InventoryRow[] }>(['privacy', 'inventory'], '/api/privacy/inventory');
  const [edit, setEdit] = useState<InventoryRow | null>(null);
  const [purpose, setPurpose] = useState('');
  const [basis, setBasis] = useState('');
  const [retention, setRetention] = useState('');
  const [abroad, setAbroad] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const save = useCMutation((_: void, call) => call(`/api/privacy/inventory/${edit!.id}`, { method: 'PATCH', body: { purpose: purpose.trim(), legalBasis: basis.trim(), retention: retention.trim() || null, transferAbroad: abroad } }), [['privacy']]);
  const verify = useCMutation((id: string, call) => call(`/api/privacy/inventory/${id}/verify`, { method: 'POST', body: {} }), [['privacy']]);
  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending || !data) return <PageLoading />;
  const open = (r: InventoryRow) => {
    setEdit(r);
    setPurpose(r.purpose);
    setBasis(r.legalBasis);
    setRetention(r.retention ?? '');
    setAbroad(r.transferAbroad);
    setError(null);
  };
  return (
    <>
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{t('privacy.inv.field')}</Th>
              <Th>{t('privacy.inv.purpose')}</Th>
              <Th>{t('privacy.inv.basis')}</Th>
              <Th>{t('privacy.inv.retention')}</Th>
              <Th className="w-40">{t('privacy.inv.verification')}</Th>
              <Th className="w-40"><span className="sr-only">{t('common.edit')}</span></Th>
            </tr>
          </thead>
          <tbody>
            {data.inventory.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <div className="font-mono text-[13px]">{r.tableName}.{r.fieldName}</div>
                  <div className="mt-1 flex gap-1">
                    <Badge tone="neutral">{t(`privacy.categories.${r.category}`)}</Badge>
                    {r.isSensitive && <Badge tone="warning">{t('privacy.inv.sensitive')}</Badge>}
                    {r.transferAbroad && <Badge tone="danger">{t('privacy.inv.abroad')}</Badge>}
                  </div>
                </Td>
                <Td>{r.purpose}</Td>
                <Td className="text-muted">{r.legalBasis}</Td>
                <Td className="text-muted">{r.retention ?? '—'}</Td>
                <Td>{r.verifiedAt ? <Badge tone="success">{t('privacy.inv.verified', { by: r.verifiedBy })}</Badge> : <Badge tone="warning">{t('privacy.inv.unverified')}</Badge>}</Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => open(r)}>{t('common.edit')}</Button>
                    {!r.verifiedAt && <Button size="sm" loading={verify.isPending} onClick={() => verify.mutate(r.id, { onSuccess: () => toast.success(t('privacy.inv.verifiedToast')) })}>{t('privacy.inv.verify')}</Button>}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      <Modal
        open={edit !== null}
        onOpenChange={(o) => !o && setEdit(null)}
        title={edit ? `${edit.tableName}.${edit.fieldName}` : ''}
        description={t('privacy.inv.editDesc')}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={save.isPending} disabled={purpose.trim().length < 3 || basis.trim().length < 3} onClick={() => save.mutate(undefined, { onSuccess: () => { toast.success(t('privacy.inv.saved')); setEdit(null); }, onError: setError })}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('privacy.inv.purpose')} required>{(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} />}</Field>
          <Field label={t('privacy.inv.basis')} required>{(id) => <Input id={id} value={basis} onChange={(e) => setBasis(e.target.value)} maxLength={300} />}</Field>
          <Field label={t('privacy.inv.retention')}>{(id) => <Input id={id} value={retention} onChange={(e) => setRetention(e.target.value)} maxLength={200} />}</Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={abroad} onChange={(e) => setAbroad(e.target.checked)} />
            {t('privacy.inv.abroadLabel')}
          </label>
        </div>
      </Modal>
    </>
  );
}

const DSR_TONE = { open: 'warning', completed: 'success', rejected: 'neutral' } as const;

function RequestsTab() {
  const { t } = useTranslation();
  const toast = useToast();
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ requests: DsrRow[] }>(['privacy', 'requests'], '/api/privacy/requests');
  const { data: emps } = useCQuery<{ employees: EmployeeRow[] }>(['employees', 'list', ''], '/api/employees');
  const [adding, setAdding] = useState(false);
  const [resolving, setResolving] = useState<DsrRow | null>(null);
  const [exporting, setExporting] = useState<DsrRow | null>(null);
  const [kind, setKind] = useState('access');
  const [employeeId, setEmployeeId] = useState('');
  const [contactId, setContactId] = useState('');
  const dirModule = useModuleEnabled('core.directory');
  const can = useCan();
  const dirOn = dirModule && can('directory.manage');
  const { data: dirContacts } = useCQuery<{ contacts: DirContact[] }>(['directory', 'contacts', 'options'], '/api/directory/contacts', { enabled: dirOn });
  const [requester, setRequester] = useState('');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState<'completed' | 'rejected'>('completed');
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const create = useCMutation((_: void, call) => call('/api/privacy/requests', { method: 'POST', body: { kind, requesterName: requester.trim(), ...(employeeId ? { employeeId } : {}), ...(contactId ? { contactId } : {}), ...(description.trim() ? { description: description.trim() } : {}) } }), HR_INVALIDATE);
  const resolve = useCMutation((_: void, call) => call(`/api/privacy/requests/${resolving!.id}/resolve`, { method: 'POST', body: { outcome, resolutionNote: note.trim() } }), HR_INVALIDATE);
  const doExport = useCMutation((_: void, call) => call<unknown>(exporting!.contactId ? `/api/privacy/contacts/${exporting!.contactId}/export` : `/api/privacy/employees/${exporting!.employeeId}/export`, { method: 'POST', body: { reason: `Talep: ${exporting!.kind} (${exporting!.requesterName})` } }), HR_INVALIDATE);
  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending || !data) return <PageLoading />;
  const rows = data.requests;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" onClick={() => { setKind('access'); setEmployeeId(''); setContactId(''); setRequester(''); setDescription(''); setError(null); setAdding(true); }}>{t('privacy.req.add')}</Button>
      </div>
      {rows.length === 0 ? (
        <Card><EmptyState icon={<ShieldCheck className="size-5" />} title={t('privacy.req.empty')} description={t('privacy.req.emptyDesc')} /></Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('privacy.req.date')}</Th>
                <Th>{t('privacy.req.requester')}</Th>
                <Th>{t('privacy.req.kind')}</Th>
                <Th>{t('privacy.req.person')}</Th>
                <Th className="w-32">{t('privacy.req.status')}</Th>
                <Th><span className="sr-only">{t('common.edit')}</span></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="text-muted">{fmtDate(r.openedAt)}</Td>
                  <Td>{r.requesterName}{r.description ? <div className="text-xs text-muted">{r.description}</div> : null}</Td>
                  <Td>{t(`privacy.kinds.${r.kind}`)}</Td>
                  <Td>{r.employeeId ? <Link className="underline" to={`/hr/employees/${r.employeeId}`}>{r.employeeCode} {r.employeeName}</Link> : r.contactId ? <Link className="underline" to={`/directory/contacts/${r.contactId}`}>{r.contactName}</Link> : '—'}</Td>
                  <Td><Badge tone={DSR_TONE[r.status]}>{t(`privacy.reqStatus.${r.status}`)}</Badge>{r.resolutionNote ? <div className="text-xs text-muted">{r.resolutionNote}</div> : null}</Td>
                  <Td>
                    {r.status === 'open' && (
                      <div className="flex justify-end gap-2">
                        {(r.employeeId || r.contactId) && (r.kind === 'access' || r.kind === 'export') && <Button size="sm" onClick={() => { setExported(null); setError(null); setExporting(r); }}>{t('privacy.req.exportData')}</Button>}
                        <Button size="sm" onClick={() => { setOutcome('completed'); setNote(''); setError(null); setResolving(r); }}>{t('privacy.req.resolve')}</Button>
                      </div>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <Modal
        open={adding}
        onOpenChange={setAdding}
        title={t('privacy.req.add')}
        description={t('privacy.req.addDesc')}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending} disabled={requester.trim().length < 2} onClick={() => create.mutate(undefined, { onSuccess: () => { toast.success(t('privacy.req.created')); setAdding(false); }, onError: setError })}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('privacy.req.requester')} required>{(id) => <Input id={id} value={requester} onChange={(e) => setRequester(e.target.value)} maxLength={200} />}</Field>
          <Field label={t('privacy.req.kind')} required>
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                {(['access', 'export', 'correction', 'erasure'] as const).map((k) => <option key={k} value={k}>{t(`privacy.kinds.${k}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('privacy.req.person')}>
            {(id) => (
              <Select id={id} value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); if (e.target.value) setContactId(''); }}>
                <option value="">—</option>
                {(emps?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.code} {e.fullName}</option>)}
              </Select>
            )}
          </Field>
          {dirOn && (
            <Field label={t('privacy.req.contactPerson')}>
              {(id) => (
                <Select id={id} value={contactId} onChange={(e) => { setContactId(e.target.value); if (e.target.value) setEmployeeId(''); }}>
                  <option value="">—</option>
                  {(dirContacts?.contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
                </Select>
              )}
            </Field>
          )}
          {kind === 'erasure' && <Callout tone="info">{t('privacy.req.erasureNote')}</Callout>}
          <Field label={t('privacy.req.description')}>{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />}</Field>
        </div>
      </Modal>

      <Modal
        open={resolving !== null}
        onOpenChange={(o) => !o && setResolving(null)}
        title={t('privacy.req.resolve')}
        footer={
          <>
            <Button onClick={() => setResolving(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={resolve.isPending} disabled={note.trim().length < 3} onClick={() => resolve.mutate(undefined, { onSuccess: () => { toast.success(t('privacy.req.resolved')); setResolving(null); }, onError: setError })}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('privacy.req.outcome')}>
            {(id) => (
              <Select id={id} value={outcome} onChange={(e) => setOutcome(e.target.value as 'completed' | 'rejected')}>
                <option value="completed">{t('privacy.reqStatus.completed')}</option>
                <option value="rejected">{t('privacy.reqStatus.rejected')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('privacy.req.resolutionNote')} required>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}</Field>
        </div>
      </Modal>

      <Modal
        open={exporting !== null}
        onOpenChange={(o) => { if (!o) { setExporting(null); setExported(null); } }}
        title={t('privacy.req.exportData')}
        description={t('privacy.req.exportDesc')}
        footer={
          <>
            <Button onClick={() => { setExporting(null); setExported(null); }}>{t('common.close')}</Button>
            {!exported && <Button variant="primary" loading={doExport.isPending} onClick={() => doExport.mutate(undefined, { onSuccess: (d) => setExported(JSON.stringify(d, null, 2)), onError: setError })}>{t('privacy.req.exportRun')}</Button>}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          {exported && <Textarea aria-label={t('privacy.req.exportData')} readOnly rows={14} className="font-mono text-xs" value={exported} />}
        </div>
      </Modal>
    </>
  );
}

function LogTab() {
  const { t } = useTranslation();
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ log: AccessLogRow[] }>(['privacy', 'log'], '/api/privacy/access-log');
  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending || !data) return <PageLoading />;
  if (data.log.length === 0) return <Card><EmptyState icon={<ShieldCheck className="size-5" />} title={t('privacy.log.empty')} description={t('privacy.log.emptyDesc')} /></Card>;
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <Th className="w-44">{t('privacy.log.at')}</Th>
            <Th>{t('privacy.log.person')}</Th>
            <Th className="w-36">{t('privacy.log.field')}</Th>
            <Th>{t('privacy.log.reason')}</Th>
            <Th>{t('privacy.log.by')}</Th>
          </tr>
        </thead>
        <tbody>
          {data.log.map((l) => (
            <Tr key={l.id}>
              <Td className="text-muted">{fmtDate(l.at)} {l.at.slice(11, 16)}</Td>
              <Td>{l.employeeId ? <Link className="underline" to={`/hr/employees/${l.employeeId}`}>{l.employeeCode} {l.employeeName}</Link> : <Link className="underline" to={`/directory/contacts/${l.contactId}`}>{l.contactName}</Link>}</Td>
              <Td>{l.field === 'export' ? t('privacy.log.export') : l.field === 'directory_export' || l.field === 'directory_anonymize' ? t(`privacy.log.${l.field}`) : t(`hr.fields.${l.field}`)}</Td>
              <Td>{l.reason}</Td>
              <Td className="text-muted">{l.by}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}
