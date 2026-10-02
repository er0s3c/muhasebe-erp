import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { ComboOption } from '../../components/ui/Combobox';
import { useCan, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { DirContact, DirNoteKind, DirOrg } from '../../lib/types';

/** Rehber/ajanda/not değişince etkilenen sorgular (gizlilik talepleri ve günlük de tazelenir). */
export const DIRECTORY_INVALIDATE = [['directory'], ['agenda'], ['privacy']];

/** Kategori kullanıcı yönetimli serbest metindir; bunlar yalnızca öneridir. */
export const ORG_CATEGORY_HINTS = ['Banka', 'Kamu kurumu', 'Tedarikçi', 'Müşteri', 'Danışman', 'Diğer'];

export function useOrgOptions() {
  const { data } = useCQuery<{ organizations: DirOrg[] }>(['directory', 'orgs', 'options'], '/api/directory/organizations');
  const orgs = useMemo(() => data?.organizations ?? [], [data]);
  const options = useMemo<ComboOption[]>(() => orgs.map((o) => ({ value: o.id, label: o.name, keywords: o.category, hint: o.category })), [orgs]);
  return { orgs, options };
}

export function useContactOptions(enabled = true) {
  const { data } = useCQuery<{ contacts: DirContact[] }>(['directory', 'contacts', 'options'], '/api/directory/contacts', { enabled });
  const contacts = useMemo(() => data?.contacts ?? [], [data]);
  const options = useMemo<ComboOption[]>(() => contacts.map((c) => ({ value: c.id, label: c.fullName, keywords: `${c.organizationName ?? ''} ${c.phone ?? ''} ${c.email ?? ''}`, hint: c.organizationName ?? undefined })), [contacts]);
  return { contacts, options };
}

/** Cari seçimi (yalnızca cari modülü açık ve izin varsa). */
export function useAllPartyOptions() {
  const can = useCan();
  const moduleOn = useModuleEnabled('core.parties');
  const enabled = moduleOn && can('parties.read');
  const { data } = useCQuery<{ parties: { id: string; code: string; name: string; kind: string }[] }>(['parties', 'directory-options'], '/api/parties?limit=500&active=true', { enabled });
  const parties = useMemo(() => (data?.parties ?? []).filter((p) => p.kind !== 'employee'), [data]);
  const options = useMemo<ComboOption[]>(() => parties.map((p) => ({ value: p.id, label: p.name, keywords: p.code, hint: p.code })), [parties]);
  return { enabled, parties, options };
}

export function NoteKindBadge({ kind }: { kind: DirNoteKind }) {
  const { t } = useTranslation();
  return <Badge tone="neutral">{t(`directory.noteKinds.${kind}`)}</Badge>;
}
