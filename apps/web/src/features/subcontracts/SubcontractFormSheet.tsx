import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ContractDirection, ProjectDetail, SubcontractDetail } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { useProjectOptions } from '../projects/common';
import { SUBCONTRACT_INVALIDATE } from './common';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Verilirse mevcut sözleşme düzenlenir (proje, taşeron, para birimi değişmez). */
  edit?: SubcontractDetail['subcontract'];
  defaultProjectId?: string;
  /** payable: taşeron; receivable: işveren sözleşmesi (contract projesi, müşteri cari). */
  direction?: ContractDirection;
  onSaved: (id: string) => void;
}

/** Taşeron sözleşmesi başlığı. Yüzdeler boş bırakılırsa tarihte geçerli inşaat parametresinden kopyalanır. */
export function SubcontractFormSheet({ open, onOpenChange, edit, defaultProjectId, direction = 'payable', onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const base = useCompany().baseCurrency;
  const { projects } = useProjectOptions();
  const receivable = (edit?.direction ?? direction) === 'receivable';
  const { options: partyOptions } = usePartyOptions(receivable ? 'customer' : 'supplier', open);

  const [projectId, setProjectId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [title, setTitle] = useState('');
  const [currencyCode, setCurrencyCode] = useState(base);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [paymentDays, setPaymentDays] = useState('30');
  const [retention, setRetention] = useState('');
  const [advance, setAdvance] = useState('');
  const [withholding, setWithholding] = useState('');
  const [penaltyNote, setPenaltyNote] = useState('');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open) return;
    setProjectId(edit?.projectId ?? defaultProjectId ?? '');
    setPartyId(edit?.partyId ?? '');
    setTitle(edit?.title ?? '');
    setCurrencyCode(edit?.currencyCode ?? base);
    setStartDate(edit?.startDate ?? '');
    setEndDate(edit?.endDate ?? '');
    setPaymentDays(String(edit?.paymentDays ?? 30));
    setRetention(edit ? String(Number(edit.retentionPct)) : '');
    setAdvance(edit ? String(Number(edit.advanceRecoupPct)) : '');
    setWithholding(edit ? String(Number(edit.withholdingPct)) : '');
    setPenaltyNote(edit?.penaltyNote ?? '');
    setError(null);
  }, [open, edit, defaultProjectId, base]);

  // İşveren sözleşmesinde cari projenin işvereni olmalıdır: proje seçilince kendiliğinden gelir
  const { data: chosen } = useCQuery<{ project: ProjectDetail }>(['project', projectId], receivable && projectId && !edit ? `/api/projects/${projectId}` : null);
  useEffect(() => {
    if (receivable && !edit && chosen?.project.clientPartyId) setPartyId(chosen.project.clientPartyId);
  }, [receivable, edit, chosen]);

  const pctLocked = !!edit && edit.status !== 'draft';
  const pct = (v: string) => (v.trim() === '' ? undefined : v.trim().replace(',', '.'));

  const save = useCMutation((_: void, call) => {
    const common = {
      title: title.trim(),
      startDate: startDate || null,
      endDate: endDate || null,
      paymentDays: Number(paymentDays) || 0,
      penaltyNote: penaltyNote.trim() || null,
    };
    if (edit) {
      return call<SubcontractDetail>(`/api/subcontracts/${edit.id}`, {
        method: 'PATCH',
        body: { ...common, ...(pctLocked ? {} : { retentionPct: pct(retention) ?? '0', advanceRecoupPct: pct(advance) ?? '0', withholdingPct: pct(withholding) ?? '0' }) },
      });
    }
    return call<SubcontractDetail>('/api/subcontracts', {
      method: 'POST',
      body: { ...common, direction, projectId, partyId, currencyCode, retentionPct: pct(retention), advanceRecoupPct: pct(advance), withholdingPct: pct(withholding) },
    });
  }, SUBCONTRACT_INVALIDATE);

  const dateBad = !!startDate && !!endDate && endDate < startDate;
  const canSave = title.trim().length >= 2 && (!!edit || (!!projectId && !!partyId)) && !dateBad;
  const submit = () => {
    setError(null);
    save.mutate(undefined, {
      onSuccess: (d) => {
        toast.success(t('subcontracts.form.saved'));
        onSaved(d.subcontract.id);
        onOpenChange(false);
      },
      onError: (e) => setError(e),
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={edit ? t('subcontracts.form.editTitle') : receivable ? t('subcontracts.employer.newTitle') : t('subcontracts.form.newTitle')}
      description={edit ? undefined : t('subcontracts.form.newDesc')}
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
        {!edit && (
          <>
            <Field label={t('subcontracts.form.project')} required>
              {(id) => (
                <Combobox
                  id={id}
                  options={projects.filter((p) => p.status !== 'completed' && p.status !== 'cancelled' && (!receivable || p.kind === 'contract')).map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, keywords: `${p.code} ${p.name}` }))}
                  value={projectId || null}
                  onChange={setProjectId}
                  placeholder={t('subcontracts.form.projectPlaceholder')}
                />
              )}
            </Field>
            <Field label={receivable ? t('subcontracts.employer.party') : t('subcontracts.form.party')} required hint={receivable ? t('subcontracts.employer.partyHint') : t('subcontracts.form.partyHint')}>
              {(id) => <Combobox id={id} options={partyOptions} value={partyId || null} onChange={setPartyId} placeholder={t('subcontracts.form.partyPlaceholder')} />}
            </Field>
          </>
        )}
        <Field label={t('subcontracts.form.title')} required>
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus placeholder={t('subcontracts.form.titlePlaceholder')} />}
        </Field>
        {!edit && (
          <Field label={t('subcontracts.form.currency')} hint={t('subcontracts.form.currencyHint')}>
            {(id) => (
              <Select id={id} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
                <CurrencyOptions wide />
              </Select>
            )}
          </Field>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('subcontracts.form.startDate')}>{(id) => <Input id={id} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />}</Field>
          <Field label={t('subcontracts.form.endDate')} error={dateBad ? t('subcontracts.form.endBeforeStart') : undefined}>
            {(id) => <Input id={id} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
          </Field>
        </div>
        <Field label={t('subcontracts.form.paymentDays')} hint={t('subcontracts.form.paymentDaysHint')}>
          {(id) => <Input id={id} inputMode="numeric" value={paymentDays} onChange={(e) => setPaymentDays(e.target.value.replace(/\D/g, ''))} className="w-32" />}
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4" disabled={pctLocked}>
          <legend className="px-1 text-[13px] text-muted">{t('subcontracts.form.deductions')}</legend>
          <p className="text-xs text-muted">{pctLocked ? t('subcontracts.form.pctLocked') : t('subcontracts.form.deductionsHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('subcontracts.form.retention')}>{(id) => <Input id={id} inputMode="decimal" value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="—" />}</Field>
            <Field label={t('subcontracts.form.advance')}>{(id) => <Input id={id} inputMode="decimal" value={advance} onChange={(e) => setAdvance(e.target.value)} placeholder="—" />}</Field>
            <Field label={t('subcontracts.form.withholding')}>{(id) => <Input id={id} inputMode="decimal" value={withholding} onChange={(e) => setWithholding(e.target.value)} placeholder="—" />}</Field>
          </div>
        </fieldset>

        <Field label={t('subcontracts.form.penaltyNote')}>
          {(id) => <Textarea id={id} value={penaltyNote} onChange={(e) => setPenaltyNote(e.target.value)} rows={3} maxLength={1000} />}
        </Field>
      </form>
    </Sheet>
  );
}
