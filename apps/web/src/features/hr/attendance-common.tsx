import { dayTypeAllowsHours, monthBounds, MAX_HOURS_PER_DAY, type AttendanceDayType } from '@erp/shared';
import { useTranslation } from 'react-i18next';
import { Select } from '../../components/ui/Field';
import { useProjectOptions } from '../projects/common';
import { useCostCodes } from '../subcontracts/common';
import type { AttendanceEmployee, AttendanceEntryRow } from '../../lib/types';

export { dayTypeAllowsHours, monthBounds };

/** Puantaj değişince etkilenen sorgular (çizelge, günlük giriş, özet, işçilik; bordro puantaj kilidini ve girdisini buradan alır). */
export const ATTENDANCE_INVALIDATE = [['attendance'], ['payroll']];

/** Hücre görünümü: gün türüne göre renk (renk tek başına taşıyıcı değildir; kısaltma ve ipucu da vardır). */
export const DAY_TONE: Record<AttendanceDayType, string> = {
  worked: 'bg-success-soft text-success',
  absent: 'bg-danger-soft text-danger',
  annual_leave: 'bg-warning-soft text-warning',
  sick_leave: 'bg-warning-soft text-warning',
  unpaid_leave: 'bg-surface-2 text-text',
  public_holiday: 'border border-border-strong text-text',
  weekly_rest: 'bg-surface-2 text-muted',
};

/** "2026-03" -> ["2026-03-01", ..., "2026-03-31"] */
export function monthDays(month: string): string[] {
  const { days } = monthBounds(month);
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export function shiftMonth(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const isMonth = (v: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** Tarih personelin işe giriş..çıkış aralığında mı (işe giriş tarihi olmayan personel puantaj alamaz). */
export function inEmploymentRange(e: Pick<AttendanceEmployee, 'hireDate' | 'leaveDate'>, date: string): boolean {
  return !!e.hireDate && date >= e.hireDate && (!e.leaveDate || date <= e.leaveDate);
}

/** Kullanıcı girdisini ("7,5") API biçimine ("7.5") çevirir; geçersizse null, boşsa "0". */
export function parseHours(v: string): string | null {
  const s = v.trim().replace(',', '.');
  if (s === '') return '0';
  return /^\d{1,2}(\.\d{1,2})?$/.test(s) ? s : null;
}

/** Saatler ve gün türü API kurallarına uyuyor mu (şema ile aynı): boş = geçerli (kayıt yok). */
export function validEntry(dayType: AttendanceDayType, normal: string, overtime: string): boolean {
  const n = parseHours(normal);
  const o = parseHours(overtime);
  if (n === null || o === null) return false;
  const total = Number(n) + Number(o);
  if (total > MAX_HOURS_PER_DAY) return false;
  if (!dayTypeAllowsHours(dayType)) return total === 0;
  return dayType !== 'worked' || total > 0;
}

/** Kompakt saat gösterimi: "8", "7,5". */
export const hoursText = (v: number | string) => Number(v).toLocaleString('tr-TR', { maximumFractionDigits: 2 });

/** Kaydı API gövdesine çevirir. */
export interface EntryDraft {
  dayType: AttendanceDayType;
  normalHours: string;
  overtimeHours: string;
  projectId: string;
  wbsId: string;
  costCodeId: string;
  note: string | null;
}

export const draftOf = (e: AttendanceEntryRow): EntryDraft => ({
  dayType: e.dayType,
  normalHours: String(Number(e.normalHours)),
  overtimeHours: String(Number(e.overtimeHours)),
  projectId: e.projectId ?? '',
  wbsId: e.wbsId ?? '',
  costCodeId: e.costCodeId ?? '',
  note: e.note,
});

export function sameDraft(a: EntryDraft, b: EntryDraft): boolean {
  return (
    a.dayType === b.dayType &&
    Number(a.normalHours || 0) === Number(b.normalHours || 0) &&
    Number(a.overtimeHours || 0) === Number(b.overtimeHours || 0) &&
    a.projectId === b.projectId &&
    a.wbsId === b.wbsId &&
    a.costCodeId === b.costCodeId &&
    (a.note ?? '') === (b.note ?? '')
  );
}

export function entryBody(employeeId: string, workDate: string, d: EntryDraft) {
  const hours = dayTypeAllowsHours(d.dayType);
  const tagged = hours && !!d.projectId && Number(parseHours(d.normalHours) ?? 0) + Number(parseHours(d.overtimeHours) ?? 0) > 0;
  return {
    employeeId,
    workDate,
    dayType: d.dayType,
    normalHours: hours ? (parseHours(d.normalHours) ?? '0') : '0',
    overtimeHours: hours ? (parseHours(d.overtimeHours) ?? '0') : '0',
    projectId: tagged ? d.projectId : null,
    wbsId: tagged && d.wbsId ? d.wbsId : null,
    costCodeId: tagged && d.costCodeId ? d.costCodeId : null,
    note: d.note?.trim() ? d.note.trim() : null,
  };
}

/** Maliyet kodu seçici (aktif kodlar); proje seçilmemişse devre dışı. */
export function CostCodeSelect({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled?: boolean; label?: string }) {
  const { t } = useTranslation();
  const { allowed } = useProjectOptions();
  const codes = useCostCodes(allowed);
  if (!allowed) return null;
  return (
    <Select aria-label={label ?? t('attendance.costCode')} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('attendance.noCostCode')}</option>
      {codes
        .filter((c) => c.isActive || c.id === value)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} — {c.name}
          </option>
        ))}
    </Select>
  );
}
