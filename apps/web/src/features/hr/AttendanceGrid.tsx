import { ATTENDANCE_DAY_TYPES, type AttendanceDayType } from '@erp/shared';
import { PaintBucket, Save, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout, EmptyState } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useCMutation } from '../../lib/queries';
import type { AttendanceEmployee, AttendanceSheetData } from '../../lib/types';
import { ProjectWbsFields } from '../projects/common';
import {
  ATTENDANCE_INVALIDATE,
  CostCodeSelect,
  DAY_TONE,
  dayTypeAllowsHours,
  draftOf,
  entryBody,
  hoursText,
  inEmploymentRange,
  monthDays,
  sameDraft,
  validEntry,
  type EntryDraft,
} from './attendance-common';

type BrushMode = AttendanceDayType | 'erase';
const key = (employeeId: string, date: string) => `${employeeId}|${date}`;
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/**
 * Aylık çizelge (personel × gün). Önce "fırça" seçilir (gün türü + saatler + isteğe bağlı proje etiketi), sonra hücrelere
 * tıklanarak boyanır; gün başlığı o günü tüm personele, personel yanındaki düğme satırı tüm çalışma aralığına uygular.
 * Değişiklikler taslakta tutulur ve "Kaydet" ile tek işlemde yazılır. Kapalı ayda çizelge salt okunurdur.
 */
export function AttendanceGrid({ sheet, canEdit }: { sheet: AttendanceSheetData; canEdit: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const days = useMemo(() => monthDays(sheet.month), [sheet.month]);
  const weekdays = t('attendance.weekdays', { returnObjects: true }) as string[];
  const saved = useMemo(() => new Map(sheet.entries.map((e) => [key(e.employeeId, e.workDate), e])), [sheet.entries]);
  const [draft, setDraft] = useState<Map<string, EntryDraft | null>>(new Map());
  const [mode, setMode] = useState<BrushMode>('worked');
  const [brush, setBrush] = useState({ normal: '', overtime: '', projectId: '', wbsId: '', costCodeId: '' });
  const [error, setError] = useState<Error | null>(null);

  const hours = mode !== 'erase' && dayTypeAllowsHours(mode);
  const brushOk = mode === 'erase' || validEntry(mode, hours ? brush.normal : '0', hours ? brush.overtime : '0');

  const save = useCMutation((body: { entries: unknown[]; clear: unknown[] }, call) => call('/api/attendance/entries', { method: 'PUT', body }), ATTENDANCE_INVALIDATE);

  const viewOf = (k: string): EntryDraft | null => {
    if (draft.has(k)) return draft.get(k) ?? null;
    const e = saved.get(k);
    return e ? draftOf(e) : null;
  };

  const apply = (cells: { emp: AttendanceEmployee; date: string }[]) => {
    if (!canEdit || !brushOk) return;
    setDraft((prev) => {
      const next = new Map(prev);
      for (const { emp, date } of cells) {
        if (!inEmploymentRange(emp, date)) continue;
        const k = key(emp.id, date);
        const cur = saved.get(k);
        if (mode === 'erase') {
          if (cur) next.set(k, null);
          else next.delete(k);
          continue;
        }
        const d: EntryDraft = {
          dayType: mode,
          normalHours: hours ? brush.normal || '0' : '0',
          overtimeHours: hours ? brush.overtime || '0' : '0',
          projectId: hours ? brush.projectId : '',
          wbsId: hours ? brush.wbsId : '',
          costCodeId: hours ? brush.costCodeId : '',
          note: cur?.note ?? null,
        };
        if (cur && sameDraft(draftOf(cur), d)) next.delete(k);
        else next.set(k, d);
      }
      return next;
    });
  };

  const submit = () => {
    setError(null);
    const entries: unknown[] = [];
    const clear: { employeeId: string; workDate: string }[] = [];
    for (const [k, v] of draft) {
      const [employeeId, workDate] = k.split('|') as [string, string];
      if (v === null) clear.push({ employeeId, workDate });
      else entries.push(entryBody(employeeId, workDate, v));
    }
    save.mutate(
      { entries, clear },
      {
        onSuccess: () => {
          setDraft(new Map());
          toast.success(t('attendance.saved'));
        },
        onError: setError,
      },
    );
  };

  if (sheet.employees.length === 0) {
    return (
      <Card>
        <EmptyState title={t('attendance.grid.empty')} description={t('attendance.grid.emptyDesc')} />
      </Card>
    );
  }

  const cellLabel = (emp: AttendanceEmployee, date: string, v: EntryDraft | null) => {
    const day = Number(date.slice(8));
    if (!v) return `${emp.fullName}, ${day}: ${t('attendance.grid.blank')}`;
    const total = Number(v.normalHours || 0) + Number(v.overtimeHours || 0);
    return `${emp.fullName}, ${day}: ${t(`attendance.dayTypes.${v.dayType}`)}${total > 0 ? ` ${hoursText(total)} ${t('attendance.hoursUnit')}` : ''}`;
  };
  const cellText = (v: EntryDraft) => {
    if (v.dayType === 'worked') {
      const o = Number(v.overtimeHours || 0);
      return `${hoursText(v.normalHours || 0)}${o > 0 ? `+${hoursText(o)}` : ''}`;
    }
    return t(`attendance.short.${v.dayType}`);
  };

  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('attendance.grid.brush')} className="w-48">
              {(id) => (
                <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as BrushMode)}>
                  {ATTENDANCE_DAY_TYPES.map((d) => (
                    <option key={d} value={d}>
                      {t(`attendance.dayTypes.${d}`)}
                    </option>
                  ))}
                  <option value="erase">{t('attendance.grid.erase')}</option>
                </Select>
              )}
            </Field>
            {hours && (
              <>
                <Field label={t('attendance.normalHours')} className="w-28">
                  {(id) => <Input id={id} inputMode="decimal" value={brush.normal} onChange={(e) => setBrush((b) => ({ ...b, normal: e.target.value }))} placeholder="0" />}
                </Field>
                <Field label={t('attendance.overtimeHours')} className="w-32">
                  {(id) => <Input id={id} inputMode="decimal" value={brush.overtime} onChange={(e) => setBrush((b) => ({ ...b, overtime: e.target.value }))} placeholder="0" />}
                </Field>
                <div className="min-w-0 basis-full sm:min-w-72 sm:flex-1 sm:basis-0">
                  <ProjectWbsFields
                    projectId={brush.projectId}
                    wbsId={brush.wbsId}
                    onChange={(n) => setBrush((b) => ({ ...b, ...n, costCodeId: n.projectId ? b.costCodeId : '' }))}
                    label={t('attendance.grid.brush')}
                    compact
                  />
                </div>
                {brush.projectId && (
                  <div className="w-48">
                    <CostCodeSelect value={brush.costCodeId} onChange={(v) => setBrush((b) => ({ ...b, costCodeId: v }))} label={`${t('attendance.costCode')} (${t('attendance.grid.brush')})`} />
                  </div>
                )}
              </>
            )}
          </div>
          {!brushOk && (brush.normal || brush.overtime ? <p className="text-xs text-danger">{t('attendance.grid.brushInvalid')}</p> : <p className="text-xs text-muted">{t('attendance.grid.brushNeedHours')}</p>)}
          <p className="text-xs text-muted">{t('attendance.grid.hint')}</p>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {ATTENDANCE_DAY_TYPES.map((d) => (
          <span key={d} className="inline-flex items-center gap-1.5">
            <span className={cn('inline-flex h-5 min-w-6 items-center justify-center rounded px-1 text-[12px]', DAY_TONE[d])}>{d === 'worked' ? '8' : t(`attendance.short.${d}`)}</span>
            {t(`attendance.dayTypes.${d}`)}
          </span>
        ))}
      </div>

      <div className="overflow-auto rounded-2xl border border-border bg-surface">
        <table className="border-collapse text-sm" aria-label={t('attendance.tabs.grid')}>
          <thead>
            <tr>
              <th className="sticky left-0 z-20 min-w-48 border-b border-border bg-surface-2 px-3 py-2 text-left text-[12px] font-normal uppercase tracking-[0.05em] text-muted">{t('attendance.grid.employee')}</th>
              {days.map((date) => {
                const n = Number(date.slice(8));
                const head = (
                  <>
                    <span className="block text-[12px] leading-3 text-muted">{weekdays[weekday(date)]}</span>
                    <span className="block">{n}</span>
                  </>
                );
                return (
                  <th key={date} className="border-b border-border bg-surface-2 p-0 text-center text-xs font-normal">
                    {canEdit ? (
                      <button
                        type="button"
                        className="h-10 w-9 hover:bg-border/60 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!brushOk}
                        aria-label={t('attendance.grid.fillDay', { day: n })}
                        title={t('attendance.grid.fillDay', { day: n })}
                        onClick={() => apply(sheet.employees.map((emp) => ({ emp, date })))}
                      >
                        {head}
                      </button>
                    ) : (
                      <div className="h-10 w-9 pt-0.5">{head}</div>
                    )}
                  </th>
                );
              })}
              <th className="min-w-16 border-b border-border bg-surface-2 px-2 py-2 text-right text-[12px] font-normal uppercase tracking-[0.05em] text-muted">{t('attendance.grid.total')}</th>
            </tr>
          </thead>
          <tbody>
            {sheet.employees.map((emp) => {
              let total = 0;
              const cells = days.map((date) => {
                const k = key(emp.id, date);
                const v = viewOf(k);
                if (v) total += Number(v.normalHours || 0) + Number(v.overtimeHours || 0);
                const editable = canEdit && inEmploymentRange(emp, date);
                const dirty = draft.has(k);
                return (
                  <td key={date} className="border-b border-border/70 p-0.5 text-center">
                    <button
                      type="button"
                      disabled={!editable || !brushOk}
                      aria-label={cellLabel(emp, date, v)}
                      title={cellLabel(emp, date, v)}
                      onClick={() => apply([{ emp, date }])}
                      className={cn(
                        'h-8 w-9 rounded text-[12px] leading-none transition-colors',
                        v ? DAY_TONE[v.dayType] : inEmploymentRange(emp, date) ? 'bg-transparent text-muted hover:bg-surface-2' : 'bg-surface-2/60 text-muted/40',
                        dirty && 'outline outline-2 outline-text',
                        (!editable || !brushOk) && 'cursor-default',
                      )}
                    >
                      {v ? cellText(v) : '·'}
                    </button>
                  </td>
                );
              });
              return (
                <tr key={emp.id}>
                  <td className="sticky left-0 z-10 border-b border-border/70 bg-surface px-3 py-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate">{emp.fullName}</div>
                        <div className="font-mono text-[12px] text-muted">{emp.code}</div>
                      </div>
                      {canEdit && (
                        <button
                          type="button"
                          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
                          disabled={!brushOk}
                          aria-label={t('attendance.grid.fillRow', { name: emp.fullName })}
                          title={t('attendance.grid.fillRow', { name: emp.fullName })}
                          onClick={() => apply(days.map((date) => ({ emp, date })))}
                        >
                          <PaintBucket className="size-4" aria-hidden />
                        </button>
                      )}
                    </div>
                  </td>
                  {cells}
                  <td className="border-b border-border/70 px-2 text-right tabular-nums">{hoursText(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {draft.size > 0 && <span className="text-sm text-muted">{t('attendance.grid.pending', { count: draft.size })}</span>}
          <Button disabled={draft.size === 0} onClick={() => setDraft(new Map())}>
            <Undo2 className="size-4" aria-hidden />
            {t('attendance.grid.discard')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={draft.size === 0} onClick={submit}>
            <Save className="size-4" aria-hidden />
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
