import { ArrowLeft, Download, Merge, Pencil, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { ApiError, apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { AgendaItem, DirContact } from '../../lib/types';
import { AgendaRow } from './AgendaPage';
import { ContactFormSheet } from './ContactFormSheet';
import { DIRECTORY_INVALIDATE, useContactOptions } from './common';
import { NotesPanel } from './NotesPanel';
import { fmtDate } from '../../lib/license';

export function ContactDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const company = useCompany();
  const can = useCan();
  const canManage = can('directory.manage');
  const canPrivacy = canManage && can('privacy.manage');
  const { data, isPending, error , refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ contact: DirContact }>(['directory', 'contact', id], id ? `/api/directory/contacts/${id}` : null);
  const { data: agenda } = useCQuery<{ items: AgendaItem[] }>(['agenda', 'contact', id], id ? `/api/agenda?scope=all&contactId=${id}` : null);
  const { contacts } = useContactOptions(canManage);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeId, setMergeId] = useState('');
  const [anonymizing, setAnonymizing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reason, setReason] = useState('');
  const [exported, setExported] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  const archive = useCMutation((on: boolean, call) => call(`/api/directory/contacts/${id}/${on ? 'archive' : 'unarchive'}`, { method: 'POST' }), DIRECTORY_INVALIDATE);
  const merge = useCMutation((_: void, call) => call(`/api/directory/contacts/${id}/merge`, { method: 'POST', body: { mergeId } }), DIRECTORY_INVALIDATE);
  const anonymize = useCMutation((_: void, call) => call(`/api/directory/contacts/${id}/anonymize`, { method: 'POST', body: { reason: reason.trim() } }), DIRECTORY_INVALIDATE);
  const doExport = useCMutation((_: void, call) => call<unknown>(`/api/privacy/contacts/${id}/export`, { method: 'POST', body: { reason: reason.trim() } }), DIRECTORY_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState title={t('directory.contact.notFound')} action={<Link to="/directory/contacts"><Button>{t('directory.contact.back')}</Button></Link>} />;
  }
  if (error) return <ErrorState description={errorMessage(error)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending || !data) return <PageLoading />;
  const c = data.contact;
  const frozen = c.isArchived && (!!c.anonymizedAt || !!c.mergedIntoId);
  const open = (setter: (v: boolean) => void) => { setReason(''); setErr(null); setExported(null); setMergeId(''); setter(true); };

  const vcard = async () => {
    try {
      const { blob, filename } = await apiBlob(`/api/directory/contacts/${c.id}/vcard`, { companyId: company.id });
      saveBlob(blob, filename ?? 'kisi.vcf');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <Link to="/directory/contacts" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" aria-hidden />{t('directory.contact.back')}</Link>
      <PageHeader
        title={c.fullName}
        description={[c.title, c.organizationName].filter(Boolean).join(' · ') || undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {!c.anonymizedAt && <Button onClick={vcard}><Download className="size-4" aria-hidden />{t('directory.contact.vcard')}</Button>}
            {canManage && !frozen && (
              <>
                <Button onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden />{t('common.edit')}</Button>
                <Button onClick={() => archive.mutate(!c.isArchived, { onSuccess: () => toast.success(t('directory.archiveDone')), onError: (e) => toast.error(errorMessage(e)) })}>{c.isArchived ? t('directory.unarchive') : t('directory.archive')}</Button>
                {!c.isArchived && <Button onClick={() => open(setMerging)}><Merge className="size-4" aria-hidden />{t('directory.contact.merge')}</Button>}
              </>
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-5">
        {c.anonymizedAt && <Callout tone="warning">{t('directory.contact.anonymizedNote', { date: fmtDate(c.anonymizedAt) })}</Callout>}
        {c.mergedIntoId && <Callout tone="info">{t('directory.contact.mergedNote')} <Link className="underline" to={`/directory/contacts/${c.mergedIntoId}`}>{t('directory.contact.openMerged')}</Link></Callout>}
        {c.isArchived && !frozen && <Callout tone="info">{t('directory.contact.archivedNote')}</Callout>}
        <Card>
          <dl className="grid gap-x-6 gap-y-3 p-5 text-sm sm:grid-cols-2">
            {([['phone', c.phone], ['phone2', c.phone2], ['email', c.email], ['email2', c.email2], ['address', c.address]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-muted">{t(`directory.contact.${k}`)}</dt><dd>{v ?? '—'}</dd></div>
            ))}
            <div><dt className="text-muted">{t('directory.contact.organization')}</dt><dd>{c.organizationId ? <Link className="underline" to={`/directory/organizations/${c.organizationId}`}>{c.organizationName}</Link> : '—'}</dd></div>
            <div><dt className="text-muted">{t('directory.contact.party')}</dt><dd>{c.partyId ? <Link className="underline" to={`/parties/${c.partyId}`}>{c.partyCode} {c.partyName}</Link> : '—'}</dd></div>
            <div><dt className="text-muted">{t('directory.contact.project')}</dt><dd>{c.projectId ? <Link className="underline" to={`/projects/${c.projectId}`}>{c.projectCode}</Link> : '—'}</dd></div>
            <div><dt className="text-muted">{t('directory.contact.tags')}</dt><dd>{c.tags.length ? c.tags.map((x) => <Badge key={x} className="mr-1">{x}</Badge>) : '—'}</dd></div>
            {c.note && <div className="sm:col-span-2"><dt className="text-muted">{t('directory.contact.note')}</dt><dd className="whitespace-pre-wrap">{c.note}</dd></div>}
          </dl>
        </Card>
        <NotesPanel contactId={c.id} frozen={frozen} />
        <Card>
          <CardHeader title={t('directory.contact.agenda')} />
          {(agenda?.items ?? []).length === 0 ? <EmptyState title={t('directory.contact.noAgenda')} /> : <ul className="divide-y divide-border">{agenda!.items.map((i) => <AgendaRow key={i.id} item={i} compact />)}</ul>}
        </Card>
        {(canManage || canPrivacy) && !c.anonymizedAt && !c.mergedIntoId && (
          <Card>
            <CardHeader title={t('directory.privacy.title')} description={t('directory.privacy.desc')} />
            <div className="flex flex-wrap gap-2 px-5 pb-5">
              {canPrivacy && <Button onClick={() => open(setExporting)}>{t('directory.privacy.export')}</Button>}
              {canManage && <Button onClick={() => open(setAnonymizing)}><ShieldAlert className="size-4" aria-hidden />{t('directory.privacy.anonymize')}</Button>}
            </div>
          </Card>
        )}
      </div>
      <ContactFormSheet open={editing} onOpenChange={setEditing} edit={c} onSaved={() => undefined} />

      <Modal
        open={merging}
        onOpenChange={setMerging}
        title={t('directory.contact.mergeTitle')}
        description={t('directory.contact.mergeDesc')}
        footer={
          <>
            <Button onClick={() => setMerging(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={merge.isPending} disabled={!mergeId} onClick={() => { setErr(null); merge.mutate(undefined, { onSuccess: () => { toast.success(t('directory.contact.merged')); setMerging(false); navigate(`/directory/contacts/${c.id}`); }, onError: setErr }); }}>{t('directory.contact.mergeRun')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {err && <Callout tone="danger">{errorMessage(err)}</Callout>}
          <Field label={t('directory.contact.mergeWith')}>
            {(fid) => <Combobox id={fid} options={contacts.filter((x) => x.id !== c.id).map((x) => ({ value: x.id, label: x.fullName, keywords: `${x.phone ?? ''} ${x.email ?? ''}`, hint: x.organizationName ?? undefined }))} value={mergeId} onChange={setMergeId} placeholder={t('directory.contact.mergePick')} />}
          </Field>
        </div>
      </Modal>

      <Modal
        open={anonymizing}
        onOpenChange={setAnonymizing}
        title={t('directory.privacy.anonymizeTitle')}
        description={t('directory.privacy.anonymizeDesc')}
        footer={
          <>
            <Button onClick={() => setAnonymizing(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={anonymize.isPending} disabled={reason.trim().length < 3} onClick={() => { setErr(null); anonymize.mutate(undefined, { onSuccess: () => { toast.success(t('directory.privacy.anonymized')); setAnonymizing(false); }, onError: setErr }); }}>{t('directory.privacy.anonymizeRun')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Callout tone="warning">{t('directory.privacy.anonymizeWarn')}</Callout>
          {err && <Callout tone="danger">{errorMessage(err)}</Callout>}
          <Field label={t('directory.privacy.reason')} required>{(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
        </div>
      </Modal>

      <Modal
        open={exporting}
        onOpenChange={(o) => { setExporting(o); if (!o) setExported(null); }}
        title={t('directory.privacy.exportTitle')}
        description={t('directory.privacy.exportDesc')}
        footer={
          <>
            <Button onClick={() => setExporting(false)}>{t('common.close')}</Button>
            {!exported && <Button variant="primary" loading={doExport.isPending} disabled={reason.trim().length < 3} onClick={() => { setErr(null); doExport.mutate(undefined, { onSuccess: (d) => setExported(JSON.stringify(d, null, 2)), onError: setErr }); }}>{t('directory.privacy.exportRun')}</Button>}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {err && <Callout tone="danger">{errorMessage(err)}</Callout>}
          {!exported && <Field label={t('directory.privacy.reason')} required>{(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>}
          {exported && <Textarea aria-label={t('directory.privacy.exportTitle')} readOnly rows={14} className="font-mono text-xs" value={exported} />}
        </div>
      </Modal>
    </>
  );
}
