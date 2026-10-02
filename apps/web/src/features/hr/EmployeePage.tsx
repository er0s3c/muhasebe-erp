import { ArrowLeft, Eye, EyeOff, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { EmployeeRow, SensitiveField } from '../../lib/types';
import { EmployeeFormSheet } from './EmployeeFormSheet';
import { EmployeeStatusBadge, HR_INVALIDATE } from './common';

const FIELDS: { field: SensitiveField; masked: (e: EmployeeRow) => string | null; has: (e: EmployeeRow) => boolean }[] = [
  { field: 'id_number', masked: (e) => e.idMasked, has: (e) => e.hasId },
  { field: 'birth_date', masked: (e) => e.birthDateMasked, has: (e) => e.hasBirthDate },
  { field: 'iban', masked: (e) => e.ibanMasked, has: (e) => e.hasIban },
];

/** Personel kartı: hassas alanlar maskeli; "Göster" gerekçe ister, erişim günlüğüne yazar ve değeri yalnızca bu oturumda gösterir. */
export function EmployeePage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const { data, isPending, error } = useCQuery<{ employee: EmployeeRow }>(['employee', id], id ? `/api/employees/${id}` : null);
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState<Partial<Record<SensitiveField, string>>>({});
  const [askField, setAskField] = useState<SensitiveField | null>(null);
  const [reason, setReason] = useState('');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveDate, setLeaveDate] = useState(todayIso());
  const [actionError, setActionError] = useState<Error | null>(null);

  const reveal = useCMutation((v: { field: SensitiveField; reason: string }, call) => call<{ field: SensitiveField; value: string }>(`/api/employees/${id}/reveal`, { method: 'POST', body: v }), [['privacy']]);
  const terminate = useCMutation((_: void, call) => call(`/api/employees/${id}/terminate`, { method: 'POST', body: { leaveDate } }), HR_INVALIDATE);
  const ledgerOn = useModuleEnabled('hr.employee_ledger');
  const openParty = useCMutation((_: void, call) => call(`/api/employee-ledger/employees/${id}/open-party`, { method: 'POST', body: {} }), [...HR_INVALIDATE, ['employee-ledger']]);
  const rehire = useCMutation((_: void, call) => call(`/api/employees/${id}/rehire`, { method: 'POST', body: {} }), HR_INVALIDATE);

  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState title={t('hr.notFound')} action={<Button onClick={() => navigate('/hr/employees')}><ArrowLeft className="size-4" aria-hidden />{t('hr.back')}</Button>} />;
  }
  if (isPending || !data) return <PageLoading />;
  const e = data.employee;
  const canManage = can('hr.manage');

  const ask = (f: SensitiveField) => {
    setReason('');
    setActionError(null);
    setAskField(f);
  };
  const row = (label: string, value: string | null | undefined) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{value || '—'}</dd>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/hr/employees" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {t('hr.back')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-3 text-2xl">
              <span className="font-mono text-[15px] text-muted">{e.code}</span>
              {e.fullName}
              <EmployeeStatusBadge status={e.status} />
            </h1>
            <p className="mt-1 text-sm text-muted">
              {[e.jobTitle, e.department].filter(Boolean).join(' · ') || '—'}
              {e.projectCode ? ` · ${e.projectCode}` : ''}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden />
                {t('common.edit')}
              </Button>
              {e.status === 'active' ? (
                <Button variant="danger" onClick={() => { setLeaveDate(todayIso()); setActionError(null); setLeaveOpen(true); }}>{t('hr.terminate')}</Button>
              ) : (
                <Button loading={rehire.isPending} onClick={() => rehire.mutate(undefined, { onSuccess: () => toast.success(t('hr.rehired')), onError: setActionError })}>{t('hr.rehire')}</Button>
              )}
            </div>
          )}
        </div>
      </div>

      {actionError && !askField && !leaveOpen && <Callout tone="danger">{errorMessage(actionError)}</Callout>}

      <Card>
        <CardHeader title={t('hr.card.sensitiveTitle')} description={t('hr.card.sensitiveDesc')} />
        <dl className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          {FIELDS.map(({ field, masked, has }) => {
            const shown = revealed[field];
            return (
              <div key={field} className="flex flex-col gap-1">
                <dt className="text-xs text-muted">
                  {t(`hr.fields.${field}`)}
                  {field === 'id_number' && e.idKind ? ` (${t(`hr.idKinds.${e.idKind}`)})` : ''}
                </dt>
                <dd className="flex items-center gap-2 text-sm">
                  <span className="font-mono">{shown ?? masked(e) ?? '—'}</span>
                  {has(e) &&
                    can('hr.sensitive') &&
                    (shown ? (
                      <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label={t('hr.hide')} onClick={() => setRevealed((r) => { const n = { ...r }; delete n[field]; return n; })}>
                        <EyeOff className="size-4" aria-hidden />
                      </button>
                    ) : (
                      <button type="button" className="rounded p-1 text-muted hover:bg-surface-2" aria-label={`${t('hr.show')}: ${t(`hr.fields.${field}`)}`} onClick={() => ask(field)}>
                        <Eye className="size-4" aria-hidden />
                      </button>
                    ))}
                </dd>
              </div>
            );
          })}
        </dl>
        {!can('hr.sensitive') && <p className="px-4 pb-4 text-xs text-muted">{t('hr.card.noSensitive')}</p>}
      </Card>

      <Card>
        <CardHeader title={t('hr.card.generalTitle')} />
        <dl className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          {row(t('hr.form.nationality'), e.nationality)}
          {row(t('hr.form.hireDate'), e.hireDate ? formatDateTR(e.hireDate) : null)}
          {row(t('hr.form.leaveDate'), e.leaveDate ? formatDateTR(e.leaveDate) : null)}
          {row(t('hr.form.phone'), e.phone)}
          {row(t('hr.form.email'), e.email)}
          {row(t('hr.form.address'), e.address)}
          {row(t('hr.form.note'), e.note)}
        </dl>
      </Card>

      {ledgerOn && can('hr.payroll') && (
        <Card>
          <CardHeader title={t('employeeLedger.card.title')} description={t('employeeLedger.card.desc')} />
          <div className="flex flex-wrap items-center gap-3 p-4">
            {e.partyId ? (
              <Link to={`/hr/employee-ledger/${e.id}`} className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2">
                {t('employeeLedger.card.open')}
              </Link>
            ) : can('hr.payroll_manage') ? (
              <Button loading={openParty.isPending} onClick={() => openParty.mutate(undefined, { onSuccess: () => toast.success(t('employeeLedger.card.opened')), onError: setActionError })}>
                {t('employeeLedger.card.openParty')}
              </Button>
            ) : (
              <span className="text-sm text-muted">{t('employeeLedger.card.noParty')}</span>
            )}
          </div>
        </Card>
      )}

      <EmployeeFormSheet open={editing} onOpenChange={setEditing} edit={e} onSaved={() => undefined} />

      <Modal
        open={askField !== null}
        onOpenChange={(o) => !o && setAskField(null)}
        title={askField ? t('hr.reveal.title', { field: t(`hr.fields.${askField}`) }) : ''}
        description={t('hr.reveal.desc')}
        footer={
          <>
            <Button onClick={() => setAskField(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={reveal.isPending}
              disabled={reason.trim().length < 3}
              onClick={() =>
                askField &&
                reveal.mutate(
                  { field: askField, reason: reason.trim() },
                  { onSuccess: (r) => { setRevealed((s) => ({ ...s, [r.field]: r.value })); setAskField(null); }, onError: setActionError },
                )
              }
            >
              {t('hr.show')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {actionError && <Callout tone="danger">{errorMessage(actionError)}</Callout>}
          <Field label={t('hr.reveal.reason')} required hint={t('hr.reveal.hint')}>
            {(fid) => <Input id={fid} value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={300} />}
          </Field>
        </div>
      </Modal>

      <Modal
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title={t('hr.terminate')}
        description={t('hr.terminateDesc')}
        footer={
          <>
            <Button onClick={() => setLeaveOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={terminate.isPending} disabled={!leaveDate} onClick={() => terminate.mutate(undefined, { onSuccess: () => { toast.success(t('hr.terminated')); setLeaveOpen(false); }, onError: setActionError })}>
              {t('hr.terminate')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {actionError && <Callout tone="danger">{errorMessage(actionError)}</Callout>}
          <Field label={t('hr.form.leaveDate')} required>{(fid) => <Input id={fid} type="date" value={leaveDate} onChange={(ev) => setLeaveDate(ev.target.value)} />}</Field>
        </div>
      </Modal>
    </div>
  );
}
