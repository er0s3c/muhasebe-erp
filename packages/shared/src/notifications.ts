import { addDaysIso, getCompanyTimeZone, todayIso } from './dates';
import { hasPermission, type Permission, type PermissionSet } from './permissions';

/**
 * Bildirim sistemi (uygulama içi + isteğe bağlı e-posta özeti): paylaşılan sözlük ve saf yardımcılar.
 *
 * İlkeler:
 * - Bildirim METNİ GENELDİR: yalnızca sayı ve bağlantı taşır; ad, kimlik no, IBAN, ücret, belge numarası ya da tutar yazılmaz
 *   (kişisel veri; docs/LEGAL-NOTES.md §5). Ayrıntıya bağlantıdaki liste ekranından, kullanıcının kendi izniyle gidilir.
 * - Önceden-uyarı ("öncül") günleri kullanıcı tercihidir ve düz kullanım varsayılanlarıdır; YASAL süre değildir. Kaynak modülün kendi
 *   kullanıcı ayarı (ör. teminat mektubu uyarı günü) varsa tercih yokken o geçerlidir.
 * - Bildirim yalnızca kaynak modül şirkette açıksa ve kullanıcı kaynak iznine (etkin izin: rol + kullanıcı bazlı modül erişimi) sahipse üretilir.
 */

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_KINDS = [
  'cheque_due',
  'guarantee_expiring',
  'foreign_doc_expiring',
  'agenda_due',
  'agenda_reminder',
  'approval_pending',
  'license_expiring',
  'attendance_open',
  'payroll_open',
  'receivable_overdue',
  'stock_below_min',
  'draft_stale',
  'manufacturing_production_due',
  'manufacturing_subcontract_due',
  'leather_production_due',
  'leather_subcontract_due',
  'leather_custom_order_due',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Gün eşiğinin anlamı: ahead = vadeye/bitişe kaç gün kala; overdue = kaç gün gecikmeden sonra; age = kaç günden eski. */
export type LeadUnit = 'ahead' | 'overdue' | 'age';

export interface NotificationKindDef {
  kind: NotificationKind;
  /** Kaynak modüllerden EN AZ BİRİ şirkette açık olmalı (boş = her zaman). */
  modules: readonly string[];
  /** Kaynak izni: bildirim yalnızca bu izne sahip üyelere gider. */
  permission: Permission;
  /** Gün eşiği: kullanıcı tercihi (boşsa kaynak ayarı ya da `default`). */
  lead?: { unit: LeadUnit; default: number; min: number; max: number };
  /** Listeye gidilecek yol (arayüz içi). */
  link: string;
}

export const NOTIFICATION_KIND_DEFS: readonly NotificationKindDef[] = [
  {kind:'manufacturing_production_due',modules:['manufacturing.production'],permission:'manufacturing.production.read',lead:{unit:'ahead',default:3,min:0,max:90},link:'/manufacturing/production'},
  {kind:'manufacturing_subcontract_due',modules:['manufacturing.subcontracting'],permission:'manufacturing.subcontracting.read',lead:{unit:'ahead',default:3,min:0,max:90},link:'/manufacturing/subcontracting'},
  { kind: 'cheque_due', modules: ['treasury.cheques'], permission: 'treasury.read', lead: { unit: 'ahead', default: 7, min: 0, max: 90 }, link: '/treasury/cheques' },
  { kind: 'guarantee_expiring', modules: ['treasury.guarantees'], permission: 'treasury.read', lead: { unit: 'ahead', default: 30, min: 0, max: 365 }, link: '/treasury/guarantees' },
  { kind: 'foreign_doc_expiring', modules: ['hr.foreign'], permission: 'hr.read', lead: { unit: 'ahead', default: 30, min: 0, max: 365 }, link: '/hr/foreign-workers' },
  { kind: 'agenda_due', modules: ['core.directory'], permission: 'directory.read', lead: { unit: 'ahead', default: 0, min: 0, max: 30 }, link: '/agenda' },
  { kind: 'agenda_reminder', modules: ['core.directory'], permission: 'directory.read', link: '/agenda' },
  { kind: 'approval_pending', modules: ['construction.subcontracts', 'construction.procurement', 'core.procurement'], permission: 'subcontracts.read', link: '/approvals' },
  { kind: 'license_expiring', modules: ['core.settings'], permission: 'company.manage', lead: { unit: 'ahead', default: 30, min: 1, max: 365 }, link: '/settings/license' },
  { kind: 'attendance_open', modules: ['hr.core'], permission: 'hr.manage', link: '/hr/attendance' },
  { kind: 'payroll_open', modules: ['hr.payroll'], permission: 'hr.payroll_manage', link: '/hr/payroll' },
  { kind: 'receivable_overdue', modules: ['core.parties'], permission: 'parties.read', lead: { unit: 'overdue', default: 0, min: 0, max: 365 }, link: '/parties/aging' },
  { kind: 'stock_below_min', modules: ['core.inventory'], permission: 'inventory.read', link: '/inventory/status?low=1' },
  { kind: 'draft_stale', modules: ['core.invoices', 'core.ledger'], permission: 'invoices.manage', lead: { unit: 'age', default: 14, min: 1, max: 365 }, link: '/invoices/sales' },
  { kind: 'leather_production_due', modules: ['leather.production'], permission: 'leather.production.read', lead: { unit: 'ahead', default: 3, min: 0, max: 90 }, link: '/leather/production' },
  { kind: 'leather_subcontract_due', modules: ['leather.subcontracting'], permission: 'leather.subcontracting.read', lead: { unit: 'ahead', default: 3, min: 0, max: 90 }, link: '/leather/subcontracts' },
  { kind: 'leather_custom_order_due', modules: ['leather.catalog'], permission: 'leather.catalog.read', lead: { unit: 'ahead', default: 3, min: 0, max: 90 }, link: '/leather/custom-orders' },
];

const DEFS = new Map(NOTIFICATION_KIND_DEFS.map((d) => [d.kind, d]));
export const notificationKindDef = (kind: NotificationKind): NotificationKindDef => DEFS.get(kind)!;

/** Kaynak modül açık ve rol kaynak iznine sahip mi? (Alt izinler kaynak içinde ayrıca denetlenir: ör. taslak bildirimi.) */
export function canReceiveKind(def: NotificationKindDef, permissions: PermissionSet, enabledModules: ReadonlySet<string>): boolean {
  if (def.modules.length > 0 && !def.modules.some((m) => enabledModules.has(m))) return false;
  if (def.kind === 'approval_pending') {
    return (enabledModules.has('construction.subcontracts') && hasPermission(permissions, 'subcontracts.read'))
      || (['construction.procurement', 'core.procurement'].some(m => enabledModules.has(m)) && hasPermission(permissions, 'procurement.read'));
  }
  if (def.kind === 'draft_stale') {
    // Taslak: fatura (invoices.manage + fatura modülü) ya da yevmiye (ledger.post + muhasebe modülü) kaynağından en az biri
    return (enabledModules.has('core.invoices') && hasPermission(permissions, 'invoices.manage')) || (enabledModules.has('core.ledger') && hasPermission(permissions, 'ledger.post'));
  }
  return hasPermission(permissions, def.permission);
}

export const eligibleNotificationKinds = (permissions: PermissionSet, enabledModules: ReadonlySet<string>): NotificationKind[] =>
  NOTIFICATION_KIND_DEFS.filter((d) => canReceiveKind(d, permissions, enabledModules)).map((d) => d.kind);

/** Gün eşiği çözümü: tercih → kaynak ayarı → düz varsayılan; sınırlara kırpılır. Eşiksiz türde null. */
export function resolveLeadDays(def: NotificationKindDef, preference: number | null | undefined, sourceSetting: number | null | undefined): number | null {
  if (!def.lead) return null;
  const raw = preference ?? sourceSetting ?? def.lead.default;
  return Math.min(def.lead.max, Math.max(def.lead.min, Math.trunc(raw)));
}

/**
 * Durum parmak izi: bildirimin "hangi kayıtlar" durumunu temsil ettiğini kısa bir özetle (FNV-1a, iki 32 bit) tutar.
 * Kayıt kümesi değişince (ör. 3 çek → başka 3 çek) yeni bildirim doğar; aynı kümede zamanlayıcı tekrar çalışsa kopya doğmaz.
 * Parmak izi kimlik değil özettir (geri çevrilemez, ham kimlik saklanmaz).
 */
export function notificationFingerprint(parts: readonly (string | number)[]): string {
  const input = [...parts].map(String).sort().join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Bugünün ayından ÖNCEKİ `count` ay (en yeni önce), YYYY-AA. Ay sonu geçmiş (kapanmamış) ayları taramak için. */
export function previousMonths(today: string, count: number): string[] {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

/** Ayın ilk ve son günü (ISO). */
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const next = Number(month.slice(5, 7)) === 12 ? `${Number(month.slice(0, 4)) + 1}-01-01` : `${month.slice(0, 4)}-${String(Number(month.slice(5, 7)) + 1).padStart(2, '0')}-01`;
  return { from, to: addDaysIso(next, -1) };
}

/** Şirket saat diliminde tarih ve saat; yaz saati geçişleri duvar saatiyle doğrudur. */
export function nowLocal(now: Date = new Date(), timeZone: string = getCompanyTimeZone()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: todayIso(now, timeZone), time: `${get('hour')}:${get('minute')}` };
}

const wallMinutes = (date: string, time: string) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(time.slice(0, 2)), Number(time.slice(3, 5))) / 60_000;

export interface AgendaReminderInput {
  status: string;
  dueDate: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  remindBeforeMinutes: number | null;
}

/**
 * Ajanda hatırlatması (X6 `remind_before_minutes`): hatırlatma anı = başlangıç − ofset (tüm gün kalemde gün başı 00:00).
 * `active`: hatırlatma anı geldi ve kalem henüz bitmedi (saatli kalemde bitiş saati, yoksa başlangıç; tüm gün kalemde günün sonu).
 * `pending`: hatırlatma anı henüz gelmedi; `over`: kalem bitti; `none`: ofset yok ya da kalem açık değil.
 */
export function agendaReminderState(item: AgendaReminderInput, local: { date: string; time: string }): 'none' | 'pending' | 'active' | 'over' {
  if (item.status !== 'open' || item.remindBeforeMinutes === null) return 'none';
  const start = wallMinutes(item.dueDate, item.allDay ? '00:00' : (item.startTime ?? '00:00'));
  const remindAt = start - item.remindBeforeMinutes;
  const endAt = item.allDay ? wallMinutes(item.dueDate, '23:59') + 1 : wallMinutes(item.dueDate, item.endTime ?? item.startTime ?? '00:00');
  const nowM = wallMinutes(local.date, local.time);
  if (nowM < remindAt) return 'pending';
  if (nowM >= endAt) return 'over';
  return 'active';
}

/** Bildirim tercihleri: tür başına uygulama içi / e-posta özeti / gün eşiği. */
export interface NotificationPreferenceView {
  kind: NotificationKind;
  inApp: boolean;
  email: boolean;
  leadDays: number | null;
  /** Gün eşiğinin bu tür için geçerli (tercihsiz) varsayılanı; eşiksiz türde null. */
  leadDefault: number | null;
  leadUnit: LeadUnit | null;
  leadMin: number | null;
  leadMax: number | null;
}

/** Varsayılan tercih: uygulama içi açık, e-posta özeti KAPALI, gün eşiği tanımsız (kaynak ayarı/varsayılan geçerli). */
export const DEFAULT_NOTIFICATION_PREFERENCE = { inApp: true, email: false, leadDays: null } as const;

