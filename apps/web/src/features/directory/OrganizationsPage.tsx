import { errorMessage } from '../../lib/errors';
import { Building2, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useCan, useCQuery } from '../../lib/queries';
import type { DirOrg } from '../../lib/types';
import { OrganizationFormSheet } from './OrganizationFormSheet';

export function OrganizationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('directory.manage');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState<'active' | 'archived'>('active');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ archived });
    if (q) p.set('q', q);
    return p.toString();
  }, [q, archived]);
  const lim = useListLimit(qs);
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ organizations: DirOrg[] } & { truncated?: boolean }>(['directory', 'orgs', qs, lim.limit], `/api/directory/organizations?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const rows = data?.organizations ?? [];
  const addButton = canManage && (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden />
      {t('directory.org.add')}
    </Button>
  );
  return (
    <>
      <PageHeader
        title={t('directory.org.title')}
        description={t('directory.org.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage && <ExportMenu exportKey="directory-organizations" params={{ q, archived }} print={false} disabled={rows.length === 0} />}
            {addButton}
          </div>
        }
      />
      {queryError ? (<ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !q && archived === 'active' ? (
        <Card><EmptyState icon={<Building2 className="size-5" />} title={t('directory.org.empty')} description={t('directory.org.emptyDesc')} action={addButton || undefined} /></Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input aria-label={t('directory.org.search')} placeholder={t('directory.org.search')} value={text} onChange={(e) => setText(e.target.value)} className="w-64" />
            <Select aria-label={t('common.status')} value={archived} onChange={(e) => setArchived(e.target.value as 'active' | 'archived')} className="w-40">
              <option value="active">{t('directory.contacts.active')}</option>
              <option value="archived">{t('directory.contacts.archived')}</option>
            </Select>
          </div>
          {rows.length === 0 ? (
            <Card><EmptyState title={t('common.noResults')} /></Card>
          ) : (
            <>
              <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('directory.org.name')}</Th>
                    <Th>{t('directory.org.category')}</Th>
                    <Th>{t('directory.org.phone')}</Th>
                    <Th>{t('directory.org.email')}</Th>
                    <Th num>{t('directory.org.contactCount')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <Tr key={o.id} clickable tabIndex={0} onClick={() => navigate(`/directory/organizations/${o.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/directory/organizations/${o.id}`)}>
                      <Td>{o.name}</Td>
                      <Td><Badge>{o.category}</Badge></Td>
                      <Td className="text-muted">{o.phone ?? '—'}</Td>
                      <Td className="text-muted">{o.email ?? '—'}</Td>
                      <Td num>{o.contactCount}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
              <TruncatedNote truncated={data?.truncated} shown={rows.length} onMore={lim.more} atMax={lim.atMax} />
            </>
          )}
        </div>
      )}
      <OrganizationFormSheet open={adding} onOpenChange={setAdding} onSaved={(id) => navigate(`/directory/organizations/${id}`)} />
    </>
  );
}
