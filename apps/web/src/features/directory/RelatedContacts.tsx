import { errorMessage } from '../../lib/errors';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { EmptyState, ErrorState, PageLoading } from '../../components/ui/Feedback';
import { useCan, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { DirContact } from '../../lib/types';

/** Cari ve proje kartlarında "rehberde ilgili kişiler" kısayolu. Rehber modülü kapalıysa ya da izin yoksa hiçbir şey göstermez. */
export function RelatedContacts({ partyId, projectId }: { partyId?: string; projectId?: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const on = useModuleEnabled('core.directory') && can('directory.read');
  const qs = partyId ? `partyId=${partyId}` : `projectId=${projectId}`;
  const { data , error: queryError, isPending: loadingQuery, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ contacts: DirContact[] }>(['directory', 'contacts', `related-${qs}`], `/api/directory/contacts?${qs}`, { enabled: on });
  if (!on) return null;
  const contacts = data?.contacts ?? [];
  if (queryError) return <ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />;
  if (loadingQuery) return <PageLoading />;
  return (
    <Card>
      <CardHeader
        title={t('directory.related.title')}
        description={t('directory.related.desc')}
        action={can('directory.manage') && <Link to={`/directory/contacts?new=1&${qs}`}><Button><Plus className="size-4" aria-hidden />{t('directory.related.add')}</Button></Link>}
      />
      {contacts.length === 0 ? (
        <EmptyState title={t('directory.related.empty')} />
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
  );
}
