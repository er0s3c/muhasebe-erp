import { describe, expect, it } from 'vitest';
import { addDaysIso } from './dates';
import {
  agendaReminderState,
  canReceiveKind,
  eligibleNotificationKinds,
  monthRange,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_DEFS,
  notificationFingerprint,
  notificationKindDef,
  nowLocal,
  previousMonths,
  resolveLeadDays,
} from './notifications';
import { notificationListQuerySchema, updateNotificationPreferencesSchema } from './schemas/notifications';
import { MODULES, resolveEnabledModules } from './module-registry';
import { PERMISSIONS } from './permissions';
import { effectivePermissions } from './module-access';

describe('bildirim türleri sözlüğü', () => {
  it('her tür tam bir kez tanımlıdır; modül ve izin gerçek kayıtlardandır', () => {
    expect(NOTIFICATION_KIND_DEFS.map((d) => d.kind).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    const moduleKeys = new Set(MODULES.map((m) => m.key));
    for (const d of NOTIFICATION_KIND_DEFS) {
      expect(PERMISSIONS, d.kind).toContain(d.permission);
      for (const m of d.modules) expect(moduleKeys.has(m), `${d.kind}: ${m}`).toBe(true);
      expect(d.link.startsWith('/') && !d.link.startsWith('//'), d.kind).toBe(true);
      if (d.lead) {
        expect(d.lead.min).toBeLessThanOrEqual(d.lead.default);
        expect(d.lead.default).toBeLessThanOrEqual(d.lead.max);
      }
    }
  });

  it('kaynak izni ve modül kapısı: izleyici İK/ajanda bildirimi almaz; modül kapalıysa hiçbir rol almaz', () => {
    const all = resolveEnabledModules('CONSTRUCTION', []);
    expect(eligibleNotificationKinds(effectivePermissions('viewer'), all)).toEqual(['cheque_due', 'guarantee_expiring', 'approval_pending', 'receivable_overdue', 'stock_below_min']);
    expect(eligibleNotificationKinds(effectivePermissions('viewer'), all)).not.toContain('foreign_doc_expiring');
    expect(eligibleNotificationKinds(effectivePermissions('owner'), all)).toContain('license_expiring');
    expect(eligibleNotificationKinds(effectivePermissions('admin'), all)).not.toContain('license_expiring'); // yalnız sahip
    expect(canReceiveKind(notificationKindDef('foreign_doc_expiring'), effectivePermissions('accountant'), all)).toBe(true);
    expect(canReceiveKind(notificationKindDef('payroll_open'), effectivePermissions('accountant'), all)).toBe(true);
    expect(canReceiveKind(notificationKindDef('attendance_open'), effectivePermissions('accountant'), all)).toBe(false); // hr.manage yok
    const noForeign = resolveEnabledModules('CONSTRUCTION', [{ module: 'hr.foreign', enabled: false }]);
    expect(canReceiveKind(notificationKindDef('foreign_doc_expiring'), effectivePermissions('owner'), noForeign)).toBe(false);
    const noCheques = resolveEnabledModules('CONSTRUCTION', [{ module: 'treasury.cheques', enabled: false }]);
    expect(canReceiveKind(notificationKindDef('cheque_due'), effectivePermissions('owner'), noCheques)).toBe(false);
    expect(canReceiveKind(notificationKindDef('guarantee_expiring'), effectivePermissions('owner'), noCheques)).toBe(true);
  });

  it('taslak bildirimi: fatura ya da yevmiye kaynağından biri yetkili ve açık olmalı', () => {
    const all = resolveEnabledModules('CONSTRUCTION', []);
    const def = notificationKindDef('draft_stale');
    expect(canReceiveKind(def, effectivePermissions('sales'), all)).toBe(true); // invoices.manage
    expect(canReceiveKind(def, effectivePermissions('viewer'), all)).toBe(false);
    expect(canReceiveKind(def, effectivePermissions('accountant'), all)).toBe(true);
    const noInvoices = resolveEnabledModules('CONSTRUCTION', [{ module: 'core.invoices', enabled: false }]);
    expect(canReceiveKind(def, effectivePermissions('sales'), noInvoices)).toBe(false);
    expect(canReceiveKind(def, effectivePermissions('accountant'), noInvoices)).toBe(true); // yevmiye taslağı
  });
});

describe('gün eşiği çözümü', () => {
  const cheque = notificationKindDef('cheque_due');
  const guarantee = notificationKindDef('guarantee_expiring');
  it('tercih → kaynak ayarı → düz varsayılan; sınırlara kırpılır; eşiksiz tür null', () => {
    expect(resolveLeadDays(cheque, null, null)).toBe(7);
    expect(resolveLeadDays(cheque, 3, null)).toBe(3);
    expect(resolveLeadDays(guarantee, null, 45)).toBe(45); // teminat mektubu ayarı
    expect(resolveLeadDays(guarantee, 10, 45)).toBe(10); // tercih önce
    expect(resolveLeadDays(guarantee, null, null)).toBe(30);
    expect(resolveLeadDays(cheque, 9999, null)).toBe(90);
    expect(resolveLeadDays(cheque, -4, null)).toBe(0);
    expect(resolveLeadDays(cheque, 2.9, null)).toBe(2);
    expect(resolveLeadDays(notificationKindDef('stock_below_min'), 5, 5)).toBeNull();
  });
});

describe('durum parmak izi', () => {
  it('sıradan bağımsız, kümeye duyarlı, sabit uzunlukta; ham kimlik içermez', () => {
    const a = notificationFingerprint(['id-1', 'id-2', 'id-3']);
    expect(a).toBe(notificationFingerprint(['id-3', 'id-1', 'id-2']));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('id-');
    expect(notificationFingerprint(['id-1', 'id-2', 'id-4'])).not.toBe(a);
    expect(notificationFingerprint(['id-1', 'id-2'])).not.toBe(a);
    expect(notificationFingerprint([])).toMatch(/^[0-9a-f]{16}$/);
    expect(notificationFingerprint([1, 2])).toBe(notificationFingerprint(['2', '1']));
  });
});

describe('ay yardımcıları', () => {
  it('previousMonths yıl başında bir önceki yıla geçer', () => {
    expect(previousMonths('2026-03-15', 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(previousMonths('2026-01-01', 2)).toEqual(['2025-12', '2025-11']);
    expect(previousMonths('2026-10-04', 0)).toEqual([]);
  });
  it('monthRange artık yıl ve yıl sonu', () => {
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
  it('addDaysIso takvim aritmetiği', () => {
    expect(addDaysIso('2026-03-30', 3)).toBe('2026-04-02');
    expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('Europe/Nicosia gün sınırı', () => {
  it('gün sınırı yerel gece yarısıdır: kışın UTC+2, yazın UTC+3', () => {
    // Kış: Nicosia = UTC+2
    expect(nowLocal(new Date('2026-01-10T21:59:00Z'))).toEqual({ date: '2026-01-10', time: '23:59' });
    expect(nowLocal(new Date('2026-01-10T22:00:00Z'))).toEqual({ date: '2026-01-11', time: '00:00' });
    // Yaz: Nicosia = UTC+3
    expect(nowLocal(new Date('2026-07-10T20:59:00Z'))).toEqual({ date: '2026-07-10', time: '23:59' });
    expect(nowLocal(new Date('2026-07-10T21:00:00Z'))).toEqual({ date: '2026-07-11', time: '00:00' });
  });
});

describe('ajanda hatırlatma durumu', () => {
  const timed = { status: 'open', dueDate: '2026-10-10', allDay: false, startTime: '14:00', endTime: '15:00', remindBeforeMinutes: 60 };
  it('saatli kalem: hatırlatma anı gelince etkin, bitince biter', () => {
    expect(agendaReminderState(timed, { date: '2026-10-10', time: '12:59' })).toBe('pending');
    expect(agendaReminderState(timed, { date: '2026-10-10', time: '13:00' })).toBe('active');
    expect(agendaReminderState(timed, { date: '2026-10-10', time: '14:30' })).toBe('active');
    expect(agendaReminderState(timed, { date: '2026-10-10', time: '15:00' })).toBe('over');
    expect(agendaReminderState(timed, { date: '2026-10-11', time: '09:00' })).toBe('over');
  });
  it('ofset gün sınırını aşar: 1 gün önceden hatırlatma', () => {
    const early = { ...timed, remindBeforeMinutes: 24 * 60 };
    expect(agendaReminderState(early, { date: '2026-10-09', time: '13:59' })).toBe('pending');
    expect(agendaReminderState(early, { date: '2026-10-09', time: '14:00' })).toBe('active');
  });
  it('tüm gün kalem günün başından (ofset kadar öncesinden) günün sonuna dek etkin', () => {
    const allDay = { status: 'open', dueDate: '2026-10-10', allDay: true, startTime: null, endTime: null, remindBeforeMinutes: 120 };
    expect(agendaReminderState(allDay, { date: '2026-10-09', time: '21:59' })).toBe('pending');
    expect(agendaReminderState(allDay, { date: '2026-10-09', time: '22:00' })).toBe('active');
    expect(agendaReminderState(allDay, { date: '2026-10-10', time: '23:58' })).toBe('active');
    expect(agendaReminderState(allDay, { date: '2026-10-11', time: '00:00' })).toBe('over');
  });
  it('ofset yoksa ya da kalem açık değilse hatırlatma yok', () => {
    expect(agendaReminderState({ ...timed, remindBeforeMinutes: null }, { date: '2026-10-10', time: '13:30' })).toBe('none');
    expect(agendaReminderState({ ...timed, status: 'done' }, { date: '2026-10-10', time: '13:30' })).toBe('none');
    expect(agendaReminderState({ ...timed, remindBeforeMinutes: 0 }, { date: '2026-10-10', time: '14:00' })).toBe('active');
  });
});

describe('bildirim şemaları', () => {
  it('liste sorgusu varsayılanları ve sınırları', () => {
    expect(notificationListQuerySchema.parse({})).toMatchObject({ status: 'active', limit: 50, offset: 0 });
    expect(notificationListQuerySchema.parse({ status: 'unread', kind: 'cheque_due', limit: '10' })).toMatchObject({ status: 'unread', kind: 'cheque_due', limit: 10 });
    expect(notificationListQuerySchema.safeParse({ kind: 'bilinmeyen' }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });
  it('tercih güncelleme: boş liste, bilinmeyen tür ve sınır dışı gün reddedilir', () => {
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [{ kind: 'x', inApp: true }] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [{ kind: 'cheque_due', leadDays: 400 }] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: [{ kind: 'cheque_due', leadDays: null, email: true }] }).success).toBe(true);
  });
});
