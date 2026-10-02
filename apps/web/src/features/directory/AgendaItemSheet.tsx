import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation } from '../../lib/queries';
import type { AgendaItem } from '../../lib/types';
import { DIRECTORY_INVALIDATE, useContactOptions } from './common';

const NONE = '';
const REMINDERS = ['', '0', '15', '30', '60', '120', '1440', '2880'] as const;

interface Defaults {
  contactId?: string;
  organizationId?: string;
  partyId?: string;
  projectId?: string;
}

/** Ajanda kalemi (görev/hatırlatma ya da randevu). Hatırlatma ofseti yalnızca veridir; bildirim gönderilmez. */
export function AgendaItemSheet({ open, onOpenChange, edit, defaults, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; edit?: AgendaItem; defaults?: Defaults; onSaved?: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const canManage = can('directory.manage');
  const { options: contactOptions } = useContactOptions(open);
  const [f, setF] = useState({ kind: 'task', title: '', description: '', dueDate: todayIso(), allDay: true, startTime: '09:00', endTime: '', remind: '', owner: 'me', contactId: '' });
  const [error, setError] = useState<Error | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!open) return;
    setF({
      kind: edit?.kind ?? 'task',
      title: edit?.title ?? '',
      description: edit?.description ?? '',
      dueDate: edit?.dueDate ?? todayIso(),
      allDay: edit?.allDay ?? true,
      startTime: edit?.startTime ?? '09:00',
      endTime: edit?.endTime ?? '',
      remind: edit?.remindBeforeMinutes != null ? String(edit.remindBeforeMinutes) : '',
      owner: edit ? (edit.ownerId === null ? 'company' : 'keep') : 'me',
      contactId: edit?.contactId ?? defaults?.contactId ?? '',
    });
    setError(null);
  }, [open, edit, defaults?.contactId]);

  const body = () => ({
    kind: f.kind,
    title: f.title.trim(),
    description: f.description.trim() || null,
    dueDate: f.dueDate,
    allDay: f.allDay,
    startTime: f.allDay ? null : f.startTime,
    endTime: f.allDay || !f.endTime ? null : f.endTime,
    remindBeforeMinutes: f.remind === '' ? null : Number(f.remind),
    contactId: f.contactId || null,
    ...(f.owner === 'company' ? { ownerId: null } : {}),
    ...(!edit ? { organizationId: defaults?.organizationId ?? null, partyId: defaults?.partyId ?? null, projectId: defaults?.projectId ?? null } : {}),
  });
  const save = useCMutation(
    (_: void, call) => (edit ? call(`/api/agenda/${edit.id}`, { method: 'PATCH', body: body() }) : call('/api/agenda', { method: 'POST', body: body() })),
    DIRECTORY_INVALIDATE,
  );
  const canSave = f.title.trim().length >= 1 && f.dueDate !== '' && (f.allDay || f.startTime !== '');

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t('agenda.form.editTitle') : t('agenda.form.newTitle')}
      description={t('agenda.form.desc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!canSave}
            onClick={() => { setError(null); save.mutate(undefined, { onSuccess: () => { toast.success(t('agenda.form.saved')); onSaved?.(); onOpenChange(false); }, onError: setError }); }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('agenda.form.kind')}>
            {(id) => (
              <Select id={id} value={f.kind} onChange={(e) => set('kind', e.target.value)}>
                <option value="task">{t('agenda.kinds.task')}</option>
                <option value="appointment">{t('agenda.kinds.appointment')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('agenda.form.date')} required>{(id) => <Input id={id} type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} />}</Field>
        </div>
        <Field label={t('agenda.form.title')} required>{(id) => <Input id={id} value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={200} />}</Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.allDay} onChange={(e) => set('allDay', e.target.checked)} />
          {t('agenda.form.allDay')}
        </label>
        {!f.allDay && (
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('agenda.form.start')} required>{(id) => <Input id={id} type="time" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} />}</Field>
            <Field label={t('agenda.form.end')}>{(id) => <Input id={id} type="time" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} />}</Field>
          </div>
        )}
        <Field label={t('agenda.form.remind')} hint={t('agenda.form.remindHint')}>
          {(id) => (
            <Select id={id} value={f.remind} onChange={(e) => set('remind', e.target.value)}>
              {REMINDERS.map((m) => <option key={m} value={m}>{m === '' ? t('agenda.form.noRemind') : t('agenda.form.minutesBefore', { minutes: m })}</option>)}
            </Select>
          )}
        </Field>
        <Field label={t('agenda.form.contact')}>
          {(id) => <Combobox id={id} options={[{ value: NONE, label: t('agenda.form.noContact') }, ...contactOptions]} value={f.contactId} onChange={(v) => set('contactId', v)} />}
        </Field>
        {canManage && (
          <Field label={t('agenda.form.owner')}>
            {(id) => (
              <Select id={id} value={f.owner === 'keep' ? 'keep' : f.owner} onChange={(e) => set('owner', e.target.value)}>
                {edit && f.owner === 'keep' && <option value="keep">{edit.ownerName ?? ''}</option>}
                {(!edit || f.owner !== 'keep') && <option value="me">{t('agenda.form.ownerMe')}</option>}
                <option value="company">{t('agenda.form.ownerCompany')}</option>
              </Select>
            )}
          </Field>
        )}
        <Field label={t('agenda.form.description')}>{(id) => <Textarea id={id} rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} />}</Field>
      </form>
    </Sheet>
  );
}
