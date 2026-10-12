import { CalendarPlus, Lock, Pencil, Plus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { NOTE_KINDS, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, EmptyState, ErrorState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { DirNote } from '../../lib/types';
import { DIRECTORY_INVALIDATE, NoteKindBadge } from './common';

/**
 * Görüşme notları (bir kişi ya da kurum için). Notlar silinmez; yazarı düzenler (geçmiş denetim izindedir). Özel not yalnızca yazarına
 * görünür, paylaşılan not rehber okuyan herkese. Notun yanındaki "Takip görevi" tek tıkla ajandaya görev açar.
 */
export function NotesPanel({ contactId, organizationId, frozen }: { contactId?: string; organizationId?: string; frozen?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const canManage = can('directory.manage');
  const qs = new URLSearchParams();
  if (contactId) qs.set('contactId', contactId);
  if (organizationId) qs.set('organizationId', organizationId);
  const { data , error: queryError, isPending: loadingQuery, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ notes: DirNote[] }>(['directory', 'notes', qs.toString()], `/api/directory/notes?${qs}`);
  const [editing, setEditing] = useState<DirNote | null>(null);
  const [adding, setAdding] = useState(false);
  const [followUp, setFollowUp] = useState<DirNote | null>(null);
  const notes = data?.notes ?? [];

  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (loadingQuery) return <PageLoading />;
  return (
    <Card>
      <CardHeader
        title={t('directory.notes.title')}
        description={t('directory.notes.desc')}
        action={canManage && !frozen && <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('directory.notes.add')}</Button>}
      />
      {notes.length === 0 ? (
        <EmptyState title={t('directory.notes.empty')} description={t('directory.notes.emptyDesc')} />
      ) : (
        <ul className="divide-y divide-border">
          {notes.map((n) => (
            <li key={n.id} className="flex flex-col gap-1.5 px-5 py-4" data-testid="note-row">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <NoteKindBadge kind={n.kind} />
                <span className="text-muted">{formatDateTR(n.noteDate)}</span>
                <span className="text-muted">· {n.authorName}</span>
                <Badge tone={n.visibility === 'private' ? 'warning' : 'success'}>
                  {n.visibility === 'private' ? <Lock className="mr-1 size-3" aria-hidden /> : <Users className="mr-1 size-3" aria-hidden />}
                  {t(`directory.visibility.${n.visibility}`)}
                </Badge>
                {n.editedAt && <Badge>{t('directory.notes.edited')}</Badge>}
                {n.projectCode && <Badge tone="brand">{n.projectCode}</Badge>}
                <span className="flex-1" />
                {!n.clearedAt && !frozen && (
                  <>
                    <Button size="sm" onClick={() => setFollowUp(n)}><CalendarPlus className="size-3.5" aria-hidden />{t('directory.notes.followUp')}</Button>
                    {n.mine && canManage && <Button size="sm" onClick={() => setEditing(n)}><Pencil className="size-3.5" aria-hidden />{t('common.edit')}</Button>}
                  </>
                )}
              </div>
              <p className={n.clearedAt ? 'whitespace-pre-wrap text-sm italic text-muted' : 'whitespace-pre-wrap text-sm'}>{n.summary}</p>
              {!contactId && n.contactName && <Link className="text-xs underline" to={`/directory/contacts/${n.contactId}`}>{n.contactName}</Link>}
            </li>
          ))}
        </ul>
      )}
      <NoteSheet open={adding || editing !== null} onOpenChange={(o) => { if (!o) { setAdding(false); setEditing(null); } }} edit={editing ?? undefined} contactId={contactId} organizationId={organizationId} />
      <FollowUpModal note={followUp} onClose={() => setFollowUp(null)} onDone={() => toast.success(t('directory.notes.followUpDone'))} />
    </Card>
  );
}

function NoteSheet({ open, onOpenChange, edit, contactId, organizationId }: { open: boolean; onOpenChange: (o: boolean) => void; edit?: DirNote; contactId?: string; organizationId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ kind: 'call', noteDate: todayIso(), summary: '', visibility: 'private' });
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!open) return;
    setF({ kind: edit?.kind ?? 'call', noteDate: edit?.noteDate ?? todayIso(), summary: edit?.summary ?? '', visibility: edit?.visibility ?? 'private' });
    setError(null);
  }, [open, edit]);
  const save = useCMutation(
    (_: void, call) =>
      edit
        ? call(`/api/directory/notes/${edit.id}`, { method: 'PATCH', body: { kind: f.kind, noteDate: f.noteDate, summary: f.summary.trim(), visibility: f.visibility } })
        : call('/api/directory/notes', { method: 'POST', body: { kind: f.kind, noteDate: f.noteDate, summary: f.summary.trim(), visibility: f.visibility, contactId: contactId ?? null, organizationId: contactId ? null : (organizationId ?? null) } }),
    DIRECTORY_INVALIDATE,
  );
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t('directory.notes.editTitle') : t('directory.notes.newTitle')}
      description={t('directory.notes.formDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={f.summary.trim().length < 1} onClick={() => { setError(null); save.mutate(undefined, { onSuccess: () => { toast.success(t('directory.notes.saved')); onOpenChange(false); }, onError: setError }); }}>{t('common.save')}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Callout tone="info">{t('directory.notes.freeTextWarning')}</Callout>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('directory.notes.kind')}>
            {(id) => (
              <Select id={id} value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))}>
                {NOTE_KINDS.map((k) => <option key={k} value={k}>{t(`directory.noteKinds.${k}`)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('directory.notes.date')}>{(id) => <Input id={id} type="date" value={f.noteDate} onChange={(e) => setF((x) => ({ ...x, noteDate: e.target.value }))} />}</Field>
        </div>
        <Field label={t('directory.notes.summary')} required>{(id) => <Textarea id={id} rows={6} value={f.summary} onChange={(e) => setF((x) => ({ ...x, summary: e.target.value }))} maxLength={4000} />}</Field>
        <Field label={t('directory.notes.visibility')} hint={t('directory.notes.visibilityHint')}>
          {(id) => (
            <Select id={id} value={f.visibility} onChange={(e) => setF((x) => ({ ...x, visibility: e.target.value }))}>
              <option value="private">{t('directory.visibility.private')}</option>
              <option value="shared">{t('directory.visibility.shared')}</option>
            </Select>
          )}
        </Field>
      </form>
    </Sheet>
  );
}

function FollowUpModal({ note, onClose, onDone }: { note: DirNote | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(todayIso());
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (!note) return;
    setTitle(`${t('directory.notes.followUpPrefix')} ${note.contactName ?? note.organizationName ?? ''}`.trim());
    setDue(todayIso());
    setError(null);
  }, [note, t]);
  const create = useCMutation((_: void, call) => call(`/api/directory/notes/${note!.id}/follow-up`, { method: 'POST', body: { title: title.trim() || undefined, dueDate: due } }), DIRECTORY_INVALIDATE);
  return (
    <Modal
      open={note !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t('directory.notes.followUpTitle')}
      description={t('directory.notes.followUpDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={due === ''} onClick={() => { setError(null); create.mutate(undefined, { onSuccess: () => { onDone(); onClose(); }, onError: setError }); }}>{t('directory.notes.followUpCreate')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('agenda.form.title')}>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
        <Field label={t('agenda.form.date')} required>{(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
