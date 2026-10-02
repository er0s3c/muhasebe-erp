import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation } from '../../lib/queries';
import type { DirOrg } from '../../lib/types';
import { DIRECTORY_INVALIDATE, ORG_CATEGORY_HINTS, useAllPartyOptions } from './common';

const NONE = '';

export function OrganizationFormSheet({ open, onOpenChange, edit, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; edit?: DirOrg; onSaved: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { enabled: partiesOn, options: partyOptions } = useAllPartyOptions();
  const [f, setF] = useState({ name: '', category: 'Diğer', address: '', phone: '', email: '', web: '', partyId: '', note: '' });
  const [error, setError] = useState<Error | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    if (!open) return;
    setF({ name: edit?.name ?? '', category: edit?.category ?? 'Diğer', address: edit?.address ?? '', phone: edit?.phone ?? '', email: edit?.email ?? '', web: edit?.web ?? '', partyId: edit?.partyId ?? '', note: edit?.note ?? '' });
    setError(null);
  }, [open, edit]);
  const body = () => {
    const nz = (v: string) => (v.trim() ? v.trim() : null);
    return { name: f.name.trim(), category: f.category.trim() || 'Diğer', address: nz(f.address), phone: nz(f.phone), email: nz(f.email), web: nz(f.web), partyId: nz(f.partyId), note: nz(f.note) };
  };
  const save = useCMutation(
    (_: void, call) => (edit ? call<{ organization: DirOrg }>(`/api/directory/organizations/${edit.id}`, { method: 'PATCH', body: body() }) : call<{ organization: DirOrg }>('/api/directory/organizations', { method: 'POST', body: body() })),
    DIRECTORY_INVALIDATE,
  );
  const canSave = f.name.trim().length >= 2;
  const submit = () => {
    setError(null);
    save.mutate(undefined, { onSuccess: (r) => { toast.success(t('directory.org.saved')); onSaved(r.organization.id); onOpenChange(false); }, onError: setError });
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t('directory.org.editTitle') : t('directory.org.newTitle')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={submit}>{t('common.save')}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (canSave) submit(); }}>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('directory.org.name')} required>{(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={200} />}</Field>
        <Field label={t('directory.org.category')} hint={t('directory.org.categoryHint')}>
          {(id) => (
            <>
              <Input id={id} list="org-category-hints" value={f.category} onChange={(e) => set('category', e.target.value)} maxLength={60} />
              <datalist id="org-category-hints">{ORG_CATEGORY_HINTS.map((c) => <option key={c} value={c} />)}</datalist>
            </>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('directory.org.phone')}>{(id) => <Input id={id} value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} />}</Field>
          <Field label={t('directory.org.email')}>{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} maxLength={200} />}</Field>
        </div>
        <Field label={t('directory.org.web')}>{(id) => <Input id={id} value={f.web} onChange={(e) => set('web', e.target.value)} maxLength={200} />}</Field>
        <Field label={t('directory.org.address')}>{(id) => <Textarea id={id} rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={300} />}</Field>
        {partiesOn && (
          <Field label={t('directory.org.party')}>
            {(id) => <Combobox id={id} options={[{ value: NONE, label: t('directory.contact.noParty') }, ...partyOptions]} value={f.partyId} onChange={(v) => set('partyId', v)} />}
          </Field>
        )}
        <Field label={t('directory.org.note')}>{(id) => <Textarea id={id} rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={1000} />}</Field>
      </form>
    </Sheet>
  );
}
