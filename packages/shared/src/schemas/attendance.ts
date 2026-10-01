import { z } from 'zod';
import { isoDate, uuid } from './common';

/**
 * Günlük puantaj (Faz D2). Gün türü bir sınıflandırmadır: yasal gün sayısı, izin hakkı ya da fazla mesai çarpanı
 * burada YOKTUR (bordro, D3, tarihli ve doğrulama alanlı parametrelerle yapar).
 */
export const ATTENDANCE_DAY_TYPES = ['worked', 'absent', 'annual_leave', 'sick_leave', 'unpaid_leave', 'public_holiday', 'weekly_rest'] as const;
export type AttendanceDayType = (typeof ATTENDANCE_DAY_TYPES)[number];

/**
 * Saat girilebilen gün türleri: çalışılan gün ile resmî tatilde / hafta tatilinde çalışma (gün türü günün niteliğini,
 * saatler yapılan işi gösterir; D3 tatil çalışmasını ayrı ele alabilsin diye ayrı tutulur). İzin ve devamsızlık
 * günlerinde saat 0'dır.
 */
export const HOURS_DAY_TYPES: readonly AttendanceDayType[] = ['worked', 'public_holiday', 'weekly_rest'];
export const dayTypeAllowsHours = (t: AttendanceDayType): boolean => HOURS_DAY_TYPES.includes(t);

/** Bir gündeki toplam saat üst sınırı: yasal sınır değil, günün 24 saat olması (veri girişi hatası denetimi). */
export const MAX_HOURS_PER_DAY = 24;

/** En çok 2 ondalık basamaklı saat ("8", "7.5", "0.25"). */
export const hoursString = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'Geçersiz saat');

/** "2026-03" */
export const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Ay YYYY-AA biçiminde olmalı');

/** Ayın ilk ve son günü (ISO). */
export function monthBounds(month: string): { start: string; end: string; days: number } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, '0')}`, days };
}

const text = (max: number) => z.string().trim().max(max);

export const attendanceEntrySchema = z
  .object({
    employeeId: uuid,
    workDate: isoDate,
    dayType: z.enum(ATTENDANCE_DAY_TYPES),
    normalHours: hoursString.default('0'),
    overtimeHours: hoursString.default('0'),
    /** İşçilik maliyeti etiketi (isteğe bağlı): proje, projenin yaprak iş kalemi, maliyet kodu. */
    projectId: uuid.nullable().optional(),
    wbsId: uuid.nullable().optional(),
    costCodeId: uuid.nullable().optional(),
    note: text(300).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const normal = Number(v.normalHours);
    const overtime = Number(v.overtimeHours);
    const total = normal + overtime;
    if (total > MAX_HOURS_PER_DAY) ctx.addIssue({ code: 'custom', path: ['normalHours'], message: `Bir günün toplam saati ${MAX_HOURS_PER_DAY}'ü aşamaz` });
    if (!dayTypeAllowsHours(v.dayType) && total !== 0) ctx.addIssue({ code: 'custom', path: ['normalHours'], message: 'İzin ve devamsızlık günlerinde saat girilmez' });
    if (v.dayType === 'worked' && total <= 0) ctx.addIssue({ code: 'custom', path: ['normalHours'], message: 'Çalışılan günde saat girilmeli' });
    if (v.projectId && total <= 0) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Proje etiketi yalnızca saat girilen günlere konur' });
    if (v.wbsId && !v.projectId) ctx.addIssue({ code: 'custom', path: ['wbsId'], message: 'İş kalemi için proje seçilmeli' });
    if (v.costCodeId && !v.projectId) ctx.addIssue({ code: 'custom', path: ['costCodeId'], message: 'Maliyet kodu için proje seçilmeli' });
  });
export type AttendanceEntryInput = z.infer<typeof attendanceEntrySchema>;

/** Toplu yazım üst sınırı: bir ayın tam çizelgesi (çok sayıda personel × 31 gün) tek istekte kaydedilebilir. */
export const ATTENDANCE_BULK_MAX = 3100;

const clearItem = z.object({ employeeId: uuid, workDate: isoDate });

/** Toplu kayıt: `entries` eklenir/güncellenir (personel + tarih tekil), `clear` silinir. Tek işlemdir: biri reddedilirse hiçbiri yazılmaz. */
export const upsertAttendanceSchema = z
  .object({
    entries: z.array(attendanceEntrySchema).max(ATTENDANCE_BULK_MAX).default([]),
    clear: z.array(clearItem).max(ATTENDANCE_BULK_MAX).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.entries.length + v.clear.length === 0) ctx.addIssue({ code: 'custom', path: ['entries'], message: 'En az bir kayıt verilmeli' });
    const seen = new Set<string>();
    for (const e of [...v.entries, ...v.clear]) {
      const k = `${e.employeeId}|${e.workDate}`;
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['entries'], message: 'Aynı personel ve tarih iki kez verilemez' });
      seen.add(k);
    }
  });
export type UpsertAttendanceInput = z.infer<typeof upsertAttendanceSchema>;

export const attendanceMonthQuerySchema = z.object({ month: yearMonth });

export const attendanceLaborQuerySchema = z
  .object({ from: isoDate, to: isoDate, projectId: uuid.optional() })
  .refine((v) => v.from <= v.to, { message: 'Başlangıç tarihi bitişten sonra olamaz', path: ['to'] });
export type AttendanceLaborQuery = z.infer<typeof attendanceLaborQuerySchema>;

export const closeAttendanceMonthSchema = z.object({ month: yearMonth, note: text(300).nullable().optional() });
/** Kapalı ayı açmak gerekçe ister; açma denetim izine ve ayın kaydına yazılır. */
export const reopenAttendanceMonthSchema = z.object({ month: yearMonth, reason: text(300).min(3, 'Gerekçe gerekli (en az 3 karakter)') });
