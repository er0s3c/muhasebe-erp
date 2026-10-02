import { ATTENDANCE_DAY_TYPES, todayIso, type AttendanceDayType } from '@erp/shared';
import { ChevronLeft, ChevronRight, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout, EmptyState } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCMutation } from '../../lib/queries';
import type { AttendanceEmployee, AttendanceEntryRow, AttendanceSheetData } from '../../lib/types';
import { ProjectWbsFields, useProjectOptions } from '../projects/common';
import { ATTENDANCE_INVALIDATE, CostCodeSelect, dayTypeAllowsHours, entryBody, inEmploymentRange, sameDraft, validEntry, type EntryDraft } from './attendance-common';

/** Satır durumu: gün türü boşsa o gün için kayıt yok demektir. */
type RowState = Omit<EntryDraft, 'dayType'> & { dayType: AttendanceDayType | '' };

const EMPTY: RowState = { dayType: '', normalHours: '', overtimeHours: '', projectId: '', wbsId: '', costCodeId: '', note: null };
const rowOf = (e: AttendanceEntryRow | undefined): RowState =>
  e
    ? {
        dayType: e.dayType,
        normalHours: Number(e.normalHours) ? String(Number(e.normalHours)) : '',
        overtimeHours: Number(e.overtimeHours) ? String(Number(e.overtimeHours)) : '',
        projectId: e.projectId ?? '',
        wbsId: e.wbsId ?? '',
        costCodeId: e.costCodeId ?? '',
        note: e.note,
      }
    : EMPTY;
const same = (a: RowState, b: RowState) => a.dayType === b.dayType && (a.dayType === '' || sameDraft(a as EntryDraft, b as EntryDraft));

/** Günlük giriş: seçilen günde çalışma aralığında olan her personel için bir satır (gün türü, saatler, işçilik etiketi, not). */
export function AttendanceDaySheet({ sheet, canEdit, dataKey }: { sheet: AttendanceSheetData; canEdit: boolean; dataKey: number }) {
  const { t } = useTranslation();
  const today = todayIso();
  const [date, setDate] = useState(today >= sheet.start && today <= sheet.end ? today : sheet.start);
  const step = (delta: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    const next = d.toISOString().slice(0, 10);
    if (next >= sheet.start && next <= sheet.end) setDate(next);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Button aria-label={t('attendance.day.prev')} onClick={() => step(-1)} disabled={date <= sheet.start}>
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Field label={t('attendance.day.date')} className="w-44">
          {(id) => <Input id={id} type="date" min={sheet.start} max={sheet.end} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />}
        </Field>
        <Button aria-label={t('attendance.day.next')} onClick={() => step(1)} disabled={date >= sheet.end}>
          <ChevronRight className="size-4" aria-hidden />
        </Button>
        <span className="pb-2.5 text-sm text-muted">{formatDateTR(date)}</span>
      </div>
      <DayRows key={`${date}|${dataKey}`} sheet={sheet} date={date} canEdit={canEdit} />
    </div>
  );
}

function DayRows({ sheet, date, canEdit }: { sheet: AttendanceSheetData; date: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { byId } = useProjectOptions();
  const employees = useMemo(() => sheet.employees.filter((e) => inEmploymentRange(e, date)), [sheet.employees, date]);
  const initial = useMemo(() => {
    const byEmp = new Map(sheet.entries.filter((e) => e.workDate === date).map((e) => [e.employeeId, e]));
    return new Map(employees.map((e) => [e.id, rowOf(byEmp.get(e.id))]));
  }, [sheet.entries, employees, date]);
  const [rows, setRows] = useState<Map<string, RowState>>(() => new Map(initial));
  const [error, setError] = useState<Error | null>(null);
  const save = useCMutation((body: { entries: unknown[]; clear: unknown[] }, call) => call('/api/attendance/entries', { method: 'PUT', body }), ATTENDANCE_INVALIDATE);

  const patch = (emp: AttendanceEmployee, p: Partial<RowState>) =>
    setRows((prev) => {
      const next = new Map(prev);
      const cur = prev.get(emp.id) ?? EMPTY;
      let r: RowState = { ...cur, ...p };
      if (p.dayType !== undefined) {
        if (p.dayType === '' || !dayTypeAllowsHours(p.dayType)) r = { ...r, normalHours: '', overtimeHours: '', projectId: '', wbsId: '', costCodeId: '' };
        // Çalışılan güne personelin kayıtlı (açık) projesi varsayılan etiket olur
        else if (p.dayType === 'worked' && !r.projectId && emp.projectId && byId.has(emp.projectId)) r = { ...r, projectId: emp.projectId };
      }
      next.set(emp.id, r);
      return next;
    });

  const state = (id: string) => rows.get(id) ?? EMPTY;
  const dirty = employees.filter((e) => !same(state(e.id), initial.get(e.id) ?? EMPTY));
  const invalid = dirty.filter((e) => {
    const r = state(e.id);
    return r.dayType !== '' && !validEntry(r.dayType, r.normalHours, r.overtimeHours);
  });

  const submit = () => {
    setError(null);
    const entries: unknown[] = [];
    const clear: { employeeId: string; workDate: string }[] = [];
    for (const e of dirty) {
      const r = state(e.id);
      if (r.dayType === '') clear.push({ employeeId: e.id, workDate: date });
      else entries.push(entryBody(e.id, date, r as EntryDraft));
    }
    save.mutate({ entries, clear }, { onSuccess: () => toast.success(t('attendance.saved')), onError: setError });
  };

  if (employees.length === 0) {
    return (
      <Card>
        <EmptyState title={t('attendance.day.empty')} description={t('attendance.day.emptyDesc')} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-auto rounded-2xl border border-border bg-surface">
        <table className="w-full border-collapse text-sm" aria-label={t('attendance.tabs.day')}>
          <thead>
            <tr className="[&>th]:border-b [&>th]:border-border [&>th]:bg-surface-2 [&>th]:px-3 [&>th]:py-2.5 [&>th]:text-left [&>th]:text-[11px] [&>th]:font-normal [&>th]:uppercase [&>th]:tracking-[0.05em] [&>th]:text-muted">
              <th>{t('attendance.grid.employee')}</th>
              <th>{t('attendance.dayType')}</th>
              <th>{t('attendance.normalHours')}</th>
              <th>{t('attendance.overtimeHours')}</th>
              <th>{t('attendance.day.tag')}</th>
              <th>{t('attendance.costCode')}</th>
              <th>{t('attendance.note')}</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => {
              const r = state(emp.id);
              const hours = r.dayType !== '' && dayTypeAllowsHours(r.dayType);
              const bad = invalid.some((x) => x.id === emp.id);
              return (
                <tr key={emp.id} className="align-top [&>td]:border-b [&>td]:border-border/70 [&>td]:px-3 [&>td]:py-2">
                  <td className="min-w-44">
                    <div>{emp.fullName}</div>
                    <div className="font-mono text-[11px] text-muted">{emp.code}</div>
                  </td>
                  <td className="w-44">
                    <Select aria-label={`${t('attendance.dayType')} ${emp.fullName}`} value={r.dayType} disabled={!canEdit} onChange={(e) => patch(emp, { dayType: e.target.value as AttendanceDayType | '' })} aria-invalid={bad}>
                      <option value="">{t('attendance.day.none')}</option>
                      {ATTENDANCE_DAY_TYPES.map((d) => (
                        <option key={d} value={d}>
                          {t(`attendance.dayTypes.${d}`)}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="w-24">
                    <Input aria-label={`${t('attendance.normalHours')} ${emp.fullName}`} inputMode="decimal" value={r.normalHours} disabled={!canEdit || !hours} onChange={(e) => patch(emp, { normalHours: e.target.value })} aria-invalid={bad} />
                  </td>
                  <td className="w-24">
                    <Input aria-label={`${t('attendance.overtimeHours')} ${emp.fullName}`} inputMode="decimal" value={r.overtimeHours} disabled={!canEdit || !hours} onChange={(e) => patch(emp, { overtimeHours: e.target.value })} aria-invalid={bad} />
                  </td>
                  <td className="min-w-72">
                    {hours ? (
                      <ProjectWbsFields projectId={r.projectId} wbsId={r.wbsId} disabled={!canEdit} label={emp.fullName} compact onChange={(n) => patch(emp, { ...n, ...(n.projectId ? {} : { costCodeId: '' }) })} />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="w-48">{hours && r.projectId ? <CostCodeSelect value={r.costCodeId} disabled={!canEdit} label={`${t('attendance.costCode')} ${emp.fullName}`} onChange={(v) => patch(emp, { costCodeId: v })} /> : <span className="text-muted">—</span>}</td>
                  <td className="min-w-40">
                    <Input aria-label={`${t('attendance.note')} ${emp.fullName}`} value={r.note ?? ''} disabled={!canEdit || r.dayType === ''} maxLength={300} onChange={(e) => patch(emp, { note: e.target.value })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {invalid.length > 0 && <Callout tone="warning">{t('attendance.day.invalid', { count: invalid.length })}</Callout>}
      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {dirty.length > 0 && <span className="text-sm text-muted">{t('attendance.day.pending', { count: dirty.length })}</span>}
          <Button variant="primary" loading={save.isPending} disabled={dirty.length === 0 || invalid.length > 0} onClick={submit}>
            <Save className="size-4" aria-hidden />
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
