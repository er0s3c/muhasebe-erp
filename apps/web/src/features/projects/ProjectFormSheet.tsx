import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation } from '../../lib/queries';
import type { ProjectDetail, ProjectKind, ProjectListRow } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { PROJECT_INVALIDATE } from './common';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Verilirse mevcut proje düzenlenir (tür ve kod değişmez). */
  project?: Pick<ProjectDetail, 'id' | 'name' | 'kind' | 'clientPartyId' | 'startDate' | 'endDate' | 'location' | 'description'>;
  onSaved: (project: Pick<ProjectListRow, 'id' | 'code'>) => void;
}

/** Proje kartı: tür (kendi / işverene yapılan iş), işveren, tarihler, konum. */
export function ProjectFormSheet({ open, onOpenChange, project, onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const editing = !!project;

  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('own');
  const [clientPartyId, setClientPartyId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? '');
    setKind(project?.kind ?? 'own');
    setClientPartyId(project?.clientPartyId ?? '');
    setStartDate(project?.startDate ?? '');
    setEndDate(project?.endDate ?? '');
    setLocation(project?.location ?? '');
    setDescription(project?.description ?? '');
    setError(null);
  }, [open, project]);

  const { options: clientOptions } = usePartyOptions('customer', open && kind === 'contract');

  const save = useCMutation((_: void, call) => {
    const common = {
      name: name.trim(),
      startDate: startDate || null,
      endDate: endDate || null,
      location: location.trim() || null,
      description: description.trim() || null,
    };
    if (project) {
      return call<{ project: ProjectDetail }>(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: { ...common, ...(kind === 'contract' ? { clientPartyId } : {}) },
      });
    }
    return call<{ project: ProjectDetail }>('/api/projects', {
      method: 'POST',
      body: { ...common, kind, ...(kind === 'contract' ? { clientPartyId } : {}) },
    });
  }, PROJECT_INVALIDATE);

  const canSave = name.trim().length >= 2 && (kind !== 'contract' || !!clientPartyId) && (!startDate || !endDate || endDate >= startDate);
  const submit = () => {
    setError(null);
    save.mutate(undefined, {
      onSuccess: ({ project: saved }) => {
        toast.success(t('projects.form.saved'));
        onSaved(saved);
        onOpenChange(false);
      },
      onError: (e) => setError(e),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t('projects.form.editTitle') : t('projects.form.newTitle')}
      description={editing ? undefined : t('projects.form.newDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) submit();
        }}
      >
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}

        <Field label={t('projects.form.name')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} autoFocus placeholder={t('projects.form.namePlaceholder')} />}
        </Field>

        <div>
          <span className="mb-1.5 block text-sm">{t('projects.form.kind')}</span>
          {editing ? (
            <p className="text-sm text-muted">{t(`projects.kinds.${kind}`)} — {t('projects.form.kindLocked')}</p>
          ) : (
            <SegmentedTabs
              value={kind}
              onChange={setKind}
              items={[
                { key: 'own', label: t('projects.kinds.own') },
                { key: 'contract', label: t('projects.kinds.contract') },
              ]}
            />
          )}
          <p className="mt-1.5 text-xs text-muted">{t(`projects.form.kindHint.${kind}`)}</p>
        </div>

        {kind === 'contract' && (
          <Field label={t('projects.form.client')} required hint={t('projects.form.clientHint')}>
            {(id) => <Combobox id={id} options={clientOptions} value={clientPartyId || null} onChange={setClientPartyId} placeholder={t('projects.form.clientPlaceholder')} />}
          </Field>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('projects.form.startDate')}>{(id) => <Input id={id} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />}</Field>
          <Field label={t('projects.form.endDate')} error={startDate && endDate && endDate < startDate ? t('projects.form.endBeforeStart') : undefined}>
            {(id) => <Input id={id} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
          </Field>
        </div>

        <Field label={t('projects.form.location')} hint={t('projects.form.locationHint')}>
          {(id) => <Input id={id} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} />}
        </Field>

        <Field label={t('projects.form.description')}>
          {(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />}
        </Field>
      </form>
    </Sheet>
  );
}
