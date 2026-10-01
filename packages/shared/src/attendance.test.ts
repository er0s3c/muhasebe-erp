import { describe, expect, it } from 'vitest';
import { attendanceEntrySchema, closeAttendanceMonthSchema, monthBounds, reopenAttendanceMonthSchema, upsertAttendanceSchema } from './schemas/attendance';

const emp = '0198f2c4-7b1a-7000-8000-000000000001';
const proj = '0198f2c4-7b1a-7000-8000-000000000002';
const entry = (o: Record<string, unknown>) => attendanceEntrySchema.safeParse({ employeeId: emp, workDate: '2026-03-02', dayType: 'worked', normalHours: '8', ...o });

describe('puantaj şeması', () => {
  it('çalışılan gün saatli olmalı; izin/devamsızlık günü saatsiz; tatil ve hafta tatilinde çalışma saatli olabilir', () => {
    expect(entry({}).success).toBe(true);
    expect(entry({ normalHours: '0' }).success).toBe(false);
    expect(entry({ dayType: 'annual_leave', normalHours: '8' }).success).toBe(false);
    expect(entry({ dayType: 'annual_leave', normalHours: undefined }).success).toBe(true);
    expect(entry({ dayType: 'sick_leave', normalHours: '0', overtimeHours: '1' }).success).toBe(false);
    expect(entry({ dayType: 'public_holiday', normalHours: '6' }).success).toBe(true);
    expect(entry({ dayType: 'weekly_rest', normalHours: '0', overtimeHours: '4' }).success).toBe(true);
    expect(entry({ dayType: 'absent', normalHours: '0' }).success).toBe(true);
  });

  it('günlük toplam 24 saati aşamaz; saat biçimi en çok 2 ondalık', () => {
    expect(entry({ normalHours: '16', overtimeHours: '8' }).success).toBe(true);
    expect(entry({ normalHours: '16', overtimeHours: '8.25' }).success).toBe(false);
    expect(entry({ normalHours: '7.5' }).success).toBe(true);
    expect(entry({ normalHours: '7.555' }).success).toBe(false);
    expect(entry({ normalHours: '-1' }).success).toBe(false);
  });

  it('etiket: proje yalnızca saatli günde; iş kalemi/maliyet kodu proje ister', () => {
    expect(entry({ projectId: proj }).success).toBe(true);
    expect(entry({ dayType: 'absent', normalHours: '0', projectId: proj }).success).toBe(false);
    expect(entry({ wbsId: proj }).success).toBe(false);
    expect(entry({ costCodeId: proj }).success).toBe(false);
    expect(entry({ projectId: proj, wbsId: proj, costCodeId: proj }).success).toBe(true);
  });

  it('toplu kayıt: boş istek ve aynı personel+tarih tekrarı reddedilir', () => {
    const e = { employeeId: emp, workDate: '2026-03-02', dayType: 'worked', normalHours: '8' };
    expect(upsertAttendanceSchema.safeParse({}).success).toBe(false);
    expect(upsertAttendanceSchema.safeParse({ entries: [e] }).success).toBe(true);
    expect(upsertAttendanceSchema.safeParse({ entries: [e, e] }).success).toBe(false);
    expect(upsertAttendanceSchema.safeParse({ entries: [e], clear: [{ employeeId: emp, workDate: '2026-03-02' }] }).success).toBe(false);
    expect(upsertAttendanceSchema.safeParse({ clear: [{ employeeId: emp, workDate: '2026-03-02' }] }).success).toBe(true);
  });

  it('ay ve gerekçe', () => {
    expect(closeAttendanceMonthSchema.safeParse({ month: '2026-03' }).success).toBe(true);
    expect(closeAttendanceMonthSchema.safeParse({ month: '2026-13' }).success).toBe(false);
    expect(closeAttendanceMonthSchema.safeParse({ month: '2026-3' }).success).toBe(false);
    expect(reopenAttendanceMonthSchema.safeParse({ month: '2026-03', reason: 'ab' }).success).toBe(false);
    expect(reopenAttendanceMonthSchema.safeParse({ month: '2026-03', reason: 'Eksik giriş' }).success).toBe(true);
  });

  it('ay sınırları (artık yıl dahil)', () => {
    expect(monthBounds('2026-03')).toEqual({ start: '2026-03-01', end: '2026-03-31', days: 31 });
    expect(monthBounds('2026-02').end).toBe('2026-02-28');
    expect(monthBounds('2028-02').end).toBe('2028-02-29');
    expect(monthBounds('2026-12').end).toBe('2026-12-31');
  });
});
