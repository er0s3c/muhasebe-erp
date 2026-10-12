import { BookUser, Download, Plus, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { DirContact } from '../../lib/types';
import { ImportWizard } from '../imports/ImportWizard';
import { ContactFormSheet } from './ContactFormSheet';
import { useOrgOptions } from './common';

/** Kişi rehberi: arama, etiket/kurum süzgeci, arşiv; vCard/CSV/Excel dışa aktarma ve içe aktarma. */
export function ContactsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const company = useCompany();
  const can = useCan();
  const canManage = can('directory.manage');
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [archived, setArchived] = useState<'active' | 'archived'>('active');
  const [adding, setAdding] = useState(params.get('new') === '1');
  const [importing, setImporting] = useState(false);
  const { orgs } = useOrgOptions();
  const { data: tagData } = useCQuery<{ tags: string[] }>(['directory', 'tags'], '/api/directory/contacts/tags');

  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ archived });
    if (q) p.set('q', q);
    if (tag) p.set('tag', tag);
    if (organizationId) p.set('organizationId', organizationId);
    return p.toString();
  }, [q, tag, organizationId, archived]);
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ contacts: DirContact[] }>(['directory', 'contacts', qs], `/api/directory/contacts?${qs}`);
  const rows = data?.contacts ?? [];
  const filtered = !!(q || tag || organizationId || archived === 'archived');

  const downloadVcf = async () => {
    try {
      const { blob, filename } = await apiBlob(`/api/directory/contacts/export.vcf?${qs}`, { companyId: company.id });
      saveBlob(blob, filename ?? 'rehber.vcf');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const closeAdd = (o: boolean) => {
    setAdding(o);
    if (!o && params.get('new')) setParams({}, { replace: true });
  };
  const addButton = canManage && (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden />
      {t('directory.contacts.add')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('directory.contacts.title')}
        description={t('directory.contacts.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManage && (
              <>
                <Button onClick={() => setImporting(true)}><Upload className="size-4" aria-hidden />{t('imports.button')}</Button>
                <Button onClick={downloadVcf} disabled={rows.length === 0}><Download className="size-4" aria-hidden />{t('directory.contacts.vcf')}</Button>
                <ExportMenu exportKey="directory-contacts" params={{ q, tag, organizationId, archived }} print={false} disabled={rows.length === 0} />
              </>
            )}
            {addButton}
          </div>
        }
      />
      <div className="mb-4"><Callout tone="info">{t('directory.privacyBanner')}</Callout></div>
      {queryError ? (<ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card><EmptyState icon={<BookUser className="size-5" />} title={t('directory.contacts.empty')} description={t('directory.contacts.emptyDesc')} action={addButton || undefined} /></Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input aria-label={t('directory.contacts.search')} placeholder={t('directory.contacts.search')} value={text} onChange={(e) => setText(e.target.value)} className="w-64" />
            <Select aria-label={t('directory.contacts.tag')} value={tag} onChange={(e) => setTag(e.target.value)} className="w-44">
              <option value="">{t('directory.contacts.allTags')}</option>
              {(tagData?.tags ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
            <Select aria-label={t('directory.contact.organization')} value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} className="w-52">
              <option value="">{t('directory.contacts.allOrgs')}</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
            <Select aria-label={t('common.status')} value={archived} onChange={(e) => setArchived(e.target.value as 'active' | 'archived')} className="w-40">
              <option value="active">{t('directory.contacts.active')}</option>
              <option value="archived">{t('directory.contacts.archived')}</option>
            </Select>
          </div>
          {rows.length === 0 ? (
            <Card><EmptyState title={t('common.noResults')} /></Card>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('directory.contact.fullName')}</Th>
                    <Th>{t('directory.contact.title')}</Th>
                    <Th>{t('directory.contact.organization')}</Th>
                    <Th>{t('directory.contact.phone')}</Th>
                    <Th>{t('directory.contact.email')}</Th>
                    <Th>{t('directory.contact.tags')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <Tr key={c.id} clickable tabIndex={0} onClick={() => navigate(`/directory/contacts/${c.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/directory/contacts/${c.id}`)}>
                      <Td>{c.fullName}{c.anonymizedAt ? <Badge className="ml-2">{t('directory.contact.anonymized')}</Badge> : c.mergedIntoId ? <Badge className="ml-2">{t('directory.contact.merged')}</Badge> : null}</Td>
                      <Td className="text-muted">{c.title ?? '—'}</Td>
                      <Td className="text-muted">{c.organizationName ?? '—'}</Td>
                      <Td className="text-muted">{c.phone ?? '—'}</Td>
                      <Td className="text-muted">{c.email ?? '—'}</Td>
                      <Td>{c.tags.map((x) => <Badge key={x} className="mr-1">{x}</Badge>)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      )}
      <ContactFormSheet
        open={adding}
        onOpenChange={closeAdd}
        defaults={{ partyId: params.get('partyId') ?? undefined, projectId: params.get('projectId') ?? undefined, organizationId: params.get('organizationId') ?? undefined }}
        onSaved={(id) => navigate(`/directory/contacts/${id}`)}
      />
      <ImportWizard kind="directory_contacts" open={importing} onOpenChange={setImporting} />
    </>
  );
}
