import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCompanyApi } from '../../lib/queries';
import type { DirContact, DirDuplicate } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { DIRECTORY_INVALIDATE, useAllPartyOptions, useOrgOptions } from './common';

const NONE = '';

interface Defaults {
  partyId?: string;
  projectId?: string;
  organizationId?: string;
}

/**
 * Rehber kişisi formu. Kimlik no ve doğum tarihi rehberde YOKTUR (kapsam dışı). Telefon/e-posta alanından çıkınca aynı telefon/e-posta
 * taşıyan başka kişi varsa uyarılır (yalnızca ipucu; kayıt engellenmez).
 */
export function ContactFormSheet({ open, onOpenChange, edit, defaults, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; edit?: DirContact; defaults?: Defaults; onSaved: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { call } = useCompanyApi();
  const { options: orgOptions } = useOrgOptions();
  const { enabled: partiesOn, options: partyOptions } = useAllPartyOptions();
  const { allowed: projectsOn, projects } = useProjectOptions();
  const [f, setF] = useState({ fullName: '', title: '', organizationId: '', phone: '', phone2: '', email: '', email2: '', address: '', partyId: '', projectId: '', tags: '', note: '' });
  const [error, setError] = useState<Error | null>(null);
  const [dups, setDups] = useState<DirDuplicate[]>([]);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setF({
      fullName: edit?.fullName ?? '',
      title: edit?.title ?? '',
      organizationId: edit?.organizationId ?? defaults?.organizationId ?? '',
      phone: edit?.phone ?? '',
      phone2: edit?.phone2 ?? '',
      email: edit?.email ?? '',
      email2: edit?.email2 ?? '',
      address: edit?.address ?? '',
      partyId: edit?.partyId ?? defaults?.partyId ?? '',
      projectId: edit?.projectId ?? defaults?.projectId ?? '',
      tags: (edit?.tags ?? []).join(', '),
      note: edit?.note ?? '',
    });
    setError(null);
    setDups([]);
  }, [open, edit, defaults?.partyId, defaults?.projectId, defaults?.organizationId]);

  const checkDuplicates = () => {
    const qs = new URLSearchParams();
    if (f.phone.trim()) qs.set('phone', f.phone.trim());
    else if (f.email.trim()) qs.set('email', f.email.trim());
    if (![...qs.keys()].length) return setDups([]);
    if (edit) qs.set('excludeId', edit.id);
    call<{ duplicates: DirDuplicate[] }>(`/api/directory/contacts/duplicates?${qs}`).then((r) => setDups(r.duplicates), () => setDups([]));
  };

  const body = () => {
    const nz = (v: string) => (v.trim() ? v.trim() : null);
    return {
      fullName: f.fullName.trim(),
      title: nz(f.title),
      organizationId: nz(f.organizationId),
      phone: nz(f.phone),
      phone2: nz(f.phone2),
      email: nz(f.email),
      email2: nz(f.email2),
      address: nz(f.address),
      partyId: nz(f.partyId),
      projectId: nz(f.projectId),
      tags: f.tags.split(/[,;]/).map((x) => x.trim()).filter(Boolean),
      note: nz(f.note),
    };
  };
  const save = useCMutation(
    (_: void, call) =>
      edit
        ? call<{ contact: DirContact; duplicates: DirDuplicate[] }>(`/api/directory/contacts/${edit.id}`, { method: 'PATCH', body: body() })
        : call<{ contact: DirContact; duplicates: DirDuplicate[] }>('/api/directory/contacts', { method: 'POST', body: body() }),
    DIRECTORY_INVALIDATE,
  );
  const canSave = f.fullName.trim().length >= 2;
  const submit = () => {
    setError(null);
    save.mutate(undefined, {
      onSuccess: (r) => {
        toast.success(t('directory.contact.saved'));
        if (r.duplicates.length > 0) toast.success(t('directory.contact.dupSaved', { count: r.duplicates.length }));
        onSaved(r.contact.id);
        onOpenChange(false);
      },
      onError: setError,
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t('directory.contact.editTitle') : t('directory.contact.newTitle')}
      description={t('directory.contact.formDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={submit}>{t('common.save')}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (canSave) submit(); }}>
        <Callout tone="info">{t('directory.contact.privacyNote')}</Callout>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('directory.contact.fullName')} required>{(id) => <Input id={id} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} maxLength={200} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('directory.contact.title')}>{(id) => <Input id={id} value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={100} />}</Field>
          <Field label={t('directory.contact.organization')}>
            {(id) => <Combobox id={id} options={[{ value: NONE, label: t('directory.contact.noOrganization') }, ...orgOptions]} value={f.organizationId} onChange={(v) => set('organizationId', v)} />}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('directory.contact.phone')}>{(id) => <Input id={id} value={f.phone} onChange={(e) => set('phone', e.target.value)} onBlur={checkDuplicates} maxLength={40} />}</Field>
          <Field label={t('directory.contact.phone2')}>{(id) => <Input id={id} value={f.phone2} onChange={(e) => set('phone2', e.target.value)} maxLength={40} />}</Field>
          <Field label={t('directory.contact.email')}>{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} onBlur={checkDuplicates} maxLength={200} />}</Field>
          <Field label={t('directory.contact.email2')}>{(id) => <Input id={id} type="email" value={f.email2} onChange={(e) => set('email2', e.target.value)} maxLength={200} />}</Field>
        </div>
        {dups.length > 0 && (
          <Callout tone="warning" title={t('directory.contact.dupTitle')}>
            <ul className="list-disc pl-5">
              {dups.map((d) => (
                <li key={d.id}><Link className="underline" to={`/directory/contacts/${d.id}`} target="_blank">{d.fullName}</Link> ({t(`directory.contact.dupOn.${d.matchedOn}`)})</li>
              ))}
            </ul>
          </Callout>
        )}
        <Field label={t('directory.contact.address')}>{(id) => <Textarea id={id} rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={300} />}</Field>
        <Field label={t('directory.contact.tags')} hint={t('directory.contact.tagsHint')}>{(id) => <Input id={id} value={f.tags} onChange={(e) => set('tags', e.target.value)} />}</Field>
        {partiesOn && (
          <Field label={t('directory.contact.party')}>
            {(id) => <Combobox id={id} options={[{ value: NONE, label: t('directory.contact.noParty') }, ...partyOptions]} value={f.partyId} onChange={(v) => set('partyId', v)} />}
          </Field>
        )}
        {projectsOn && projects.length > 0 && (
          <Field label={t('directory.contact.project')}>
            {(id) => <Combobox id={id} options={[{ value: NONE, label: t('directory.contact.noProject') }, ...projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, keywords: p.code }))]} value={f.projectId} onChange={(v) => set('projectId', v)} />}
          </Field>
        )}
        <Field label={t('directory.contact.note')}>{(id) => <Textarea id={id} rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={1000} />}</Field>
      </form>
    </Sheet>
  );
}
