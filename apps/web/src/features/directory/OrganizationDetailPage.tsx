import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { DirContact, DirOrg } from '../../lib/types';
import { ContactFormSheet } from './ContactFormSheet';
import { DIRECTORY_INVALIDATE } from './common';
import { NotesPanel } from './NotesPanel';
import { OrganizationFormSheet } from './OrganizationFormSheet';

export function OrganizationDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const canManage = useCan()('directory.manage');
  const { data, isPending, error , refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ organization: DirOrg }>(['directory', 'org', id], id ? `/api/directory/organizations/${id}` : null);
  const { data: cdata } = useCQuery<{ contacts: DirContact[] }>(['directory', 'contacts', `org-${id}`], id ? `/api/directory/contacts?organizationId=${id}` : null);
  const [editing, setEditing] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const toggle = useCMutation((archive: boolean, call) => call(`/api/directory/organizations/${id}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' }), DIRECTORY_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState title={t('directory.org.notFound')} action={<Link to="/directory/organizations"><Button>{t('directory.org.back')}</Button></Link>} />;
  }
  if (error) return <ErrorState description={errorMessage(error)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (isPending || !data) return <PageLoading />;
  const o = data.organization;
  const contacts = cdata?.contacts ?? [];
  return (
    <>
      <Link to="/directory/organizations" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text"><ArrowLeft className="size-4" aria-hidden />{t('directory.org.back')}</Link>
      <PageHeader
        title={o.name}
        description={o.category}
        actions={
          canManage && (
            <div className="flex gap-2">
              <Button onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden />{t('common.edit')}</Button>
              <Button onClick={() => toggle.mutate(!o.isArchived, { onSuccess: () => toast.success(t('directory.archiveDone')), onError: (e) => toast.error(errorMessage(e)) })}>{o.isArchived ? t('directory.unarchive') : t('directory.archive')}</Button>
            </div>
          )
        }
      />
      <div className="flex flex-col gap-5">
        <Card>
          <dl className="grid gap-x-6 gap-y-3 p-5 text-sm sm:grid-cols-2">
            {([['phone', o.phone], ['email', o.email], ['web', o.web], ['address', o.address], ['party', o.partyName]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-muted">{t(`directory.org.${k}`)}</dt><dd>{v ?? '—'}</dd></div>
            ))}
            {o.isArchived && <div><Badge>{t('directory.contacts.archived')}</Badge></div>}
          </dl>
        </Card>
        <Card>
          <CardHeader title={t('directory.org.people')} action={canManage && !o.isArchived && <Button onClick={() => setAddingContact(true)}><Plus className="size-4" aria-hidden />{t('directory.contacts.add')}</Button>} />
          {contacts.length === 0 ? (
            <EmptyState title={t('directory.org.noPeople')} />
          ) : (
            <ul className="divide-y divide-border">
              {contacts.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <Link className="underline" to={`/directory/contacts/${c.id}`}>{c.fullName}</Link>
                  <span className="text-muted">{[c.title, c.phone, c.email].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <NotesPanel organizationId={o.id} frozen={o.isArchived} />
      </div>
      <OrganizationFormSheet open={editing} onOpenChange={setEditing} edit={o} onSaved={() => undefined} />
      <ContactFormSheet open={addingContact} onOpenChange={setAddingContact} defaults={{ organizationId: o.id }} onSaved={() => undefined} />
    </>
  );
}
