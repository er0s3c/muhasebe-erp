import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation } from '../../lib/queries';
import type { EmployeeRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { HR_INVALIDATE } from './common';

/**
 * Personel kartı formu. Kimlik no, doğum tarihi ve IBAN yalnızca girilir (yanıtta maskelidir): alan boşsa değişmez;
 * değiştirmek için yeni değer girilir. Bu alanları girebilmek için `hr.sensitive` gerekmez, okumak için gerekir.
 */
export function EmployeeFormSheet({ open, onOpenChange, edit, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; edit?: EmployeeRow; onSaved: (id: string) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const { projects } = useProjectOptions();
  const left = edit?.status === 'left';
  const [f, setF] = useState({ fullName: '', nationality: '', idKind: 'national_id', idNumber: '', birthDate: '', iban: '', phone: '', email: '', address: '', hireDate: '', department: '', jobTitle: '', projectId: '', note: '' });
  const [error, setError] = useState<Error | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setF({
      fullName: edit?.fullName ?? '',
      nationality: edit?.nationality ?? '',
      idKind: edit?.idKind ?? 'national_id',
      idNumber: '',
      birthDate: '',
      iban: '',
      phone: edit?.phone ?? '',
      email: edit?.email ?? '',
      address: edit?.address ?? '',
      hireDate: edit?.hireDate ?? '',
      department: edit?.department ?? '',
      jobTitle: edit?.jobTitle ?? '',
      projectId: edit?.projectId ?? '',
      note: edit?.note ?? '',
    });
    setError(null);
  }, [open, edit]);

  const body = () => {
    const nz = (v: string) => (v.trim() ? v.trim() : null);
    return {
      fullName: f.fullName.trim(),
      nationality: nz(f.nationality),
      phone: nz(f.phone),
      email: nz(f.email),
      address: nz(f.address),
      hireDate: nz(f.hireDate),
      department: nz(f.department),
      jobTitle: nz(f.jobTitle),
      projectId: nz(f.projectId),
      note: nz(f.note),
      // Hassas alanlar: boşsa gönderilmez (mevcut değer korunur)
      ...(f.idNumber.trim() ? { idKind: f.idKind, idNumber: f.idNumber.trim() } : {}),
      ...(f.birthDate ? { birthDate: f.birthDate } : {}),
      ...(f.iban.trim() ? { iban: f.iban.trim() } : {}),
    };
  };
  const save = useCMutation(
    (_: void, call) =>
      edit
        ? call<{ employee: EmployeeRow }>(`/api/employees/${edit.id}`, { method: 'PATCH', body: body() })
        : call<{ employee: EmployeeRow }>('/api/employees', { method: 'POST', body: body() }),
    HR_INVALIDATE,
  );
  const canSave = f.fullName.trim().length >= 2;
  const submit = () => {
    setError(null);
    save.mutate(undefined, { onSuccess: (r) => { toast.success(t('hr.form.saved')); onSaved(r.employee.id); onOpenChange(false); }, onError: setError });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t('hr.form.editTitle') : t('hr.form.newTitle')}
      description={t('hr.form.desc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={submit}>{t('common.save')}</Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (canSave) submit(); }}>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('hr.form.fullName')} required>{(id) => <Input id={id} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} maxLength={200} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('hr.form.nationality')}>{(id) => <Input id={id} value={f.nationality} onChange={(e) => set('nationality', e.target.value)} maxLength={80} />}</Field>
          <Field label={t('hr.form.hireDate')}>{(id) => <Input id={id} type="date" value={f.hireDate} onChange={(e) => set('hireDate', e.target.value)} />}</Field>
        </div>
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4" disabled={left}>
          <legend className="px-1 text-[13px] text-muted">{t('hr.form.sensitive')}</legend>
          <p className="text-xs text-muted">{left ? t('hr.form.leftLocked') : edit ? t('hr.form.sensitiveEditHint') : t('hr.form.sensitiveHint')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('hr.form.idKind')}>
              {(id) => (
                <Select id={id} value={f.idKind} onChange={(e) => set('idKind', e.target.value)}>
                  <option value="national_id">{t('hr.idKinds.national_id')}</option>
                  <option value="passport">{t('hr.idKinds.passport')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('hr.form.idNumber')}>{(id) => <Input id={id} value={f.idNumber} onChange={(e) => set('idNumber', e.target.value)} autoComplete="off" placeholder={edit?.idMasked ?? ''} />}</Field>
            <Field label={t('hr.form.birthDate')}>{(id) => <Input id={id} type="date" value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} />}</Field>
            <Field label={t('hr.form.iban')}>{(id) => <Input id={id} value={f.iban} onChange={(e) => set('iban', e.target.value)} autoComplete="off" placeholder={edit?.ibanMasked ?? ''} />}</Field>
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('hr.form.phone')}>{(id) => <Input id={id} value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} />}</Field>
          <Field label={t('hr.form.email')}>{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} maxLength={200} />}</Field>
        </div>
        <Field label={t('hr.form.address')}>{(id) => <Textarea id={id} rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={300} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('hr.form.department')}>{(id) => <Input id={id} value={f.department} onChange={(e) => set('department', e.target.value)} maxLength={100} />}</Field>
          <Field label={t('hr.form.jobTitle')}>{(id) => <Input id={id} value={f.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} maxLength={100} />}</Field>
        </div>
        {can('projects.read') && projects.length > 0 && (
          <Field label={t('hr.form.project')}>
            {(id) => (
              <Select id={id} value={f.projectId} onChange={(e) => set('projectId', e.target.value)}>
                <option value="">{t('hr.form.noProject')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('hr.form.note')}>{(id) => <Textarea id={id} rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={500} />}</Field>
      </form>
    </Sheet>
  );
}
