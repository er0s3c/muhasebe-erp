import { sql } from 'drizzle-orm';
import {
  addDaysIso,
  agendaReminderState,
  foreignDocStatus,
  guaranteeExpiryState,
  hasPermission,
  monthRange,
  notificationKindDef,
  OPEN_CHEQUE_STATUSES,
  previousMonths,
  type NotificationKind,
  type NotificationSeverity,
  type PermissionSet,
  type Role,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { warningAt } from '../foreignworkers/params';
import { pendingForMe } from '../approvals/service';
import { inventorySummary } from '../inventory/reports';
import { allOpenItems } from '../parties/service';
import { productionOrderScope } from '../leather/visibility';

/**
 * Bildirim kaynakları: her biri bir türün "şu an bildirilecek durum var mı?" sorusunu yanıtlar. Metinler GENELDİR (yalnızca sayı);
 * ad, kimlik no, IBAN, ücret, belge numarası ya da tutar bildirime YAZILMAZ (LEGAL-NOTES §5). Gün eşiği tercihten (yoksa kaynak ayarından,
 * yoksa düz varsayılandan) gelir; kodda yasal süre yoktur. Kaynak yalnızca okur; hiçbir kayıt değiştirmez ve erişim günlüğüne yazmaz.
 */

export interface LicenseView {
  enforced: boolean;
  state: string;
  daysUntilExpiry?: number | null;
  /** Kurulumun sahibi kuruluş (verilmezse veritabanındaki `installation_owner_org()` kullanılır; testler enjekte eder). */
  ownerOrgId?: string | null;
}

export interface ScanCtx {
  tx: Tx;
  companyId: string;
  /** Şirket saat diliminde (Europe/Nicosia) bugün. */
  today: string;
  /** Şirket saat diliminde şimdiki duvar saati (SS:DD). */
  time: string;
  enabled: ReadonlySet<string>;
  license: LicenseView | null;
  /** Şirket, kurulumun sahibi kuruluşa mı ait (lisans bildirimi yalnızca oraya gider). */
  ownerOrg: boolean;
}

export interface SourceUser {
  id: string;
  role: Role;
  /** Etkin izinler (rol + kullanıcı bazlı modül erişimi). */
  permissions: PermissionSet;
}

export interface Finding {
  severity: NotificationSeverity;
  title: string;
  body: string;
  count: number;
  /** Durum parmak izi girdisi (kayıt kimlikleri/sayılar); kopya üretimini belirler, bildirime yazılmaz. */
  parts: (string | number)[];
  /** Varsayılan bağlantının yerine (ör. kullanıcının yetkisine göre taslak listesi). */
  link?: string;
}

export interface NotificationSource {
  kind: NotificationKind;
  /** true: sonuç kullanıcıya bağlıdır (ajanda, onay); aksi halde şirket genelinde bir kez hesaplanır. */
  perUser?: boolean;
  /** Kaynak modülün kendi kullanıcı ayarı (tercih yokken gün eşiği); yoksa null. */
  sourceLead?(ctx: ScanCtx): Promise<number | null>;
  scan(ctx: ScanCtx, args: { lead: number | null; user: SourceUser }): Promise<Finding | null>;
}

type IdRow = { id: string };
/** `x in (…)` listesi (drizzle dizi parametresini satır kurucusuna çevirdiği için `= any($1)` kullanılmaz). */
const inList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

// --- Çek/senet vadesi ------------------------------------------------------------------------------------------------
const chequeDue: NotificationSource = {
  kind: 'cheque_due',
  async scan({ tx, today }, { lead }) {
    const days = lead ?? 7;
    const to = addDaysIso(today, days);
    const res = await tx.execute<IdRow & { due: string }>(sql`
      select c.id, c.due_date::text as due from cheques c
       where ((c.direction = 'received' and c.status in (${inList(OPEN_CHEQUE_STATUSES.received)}))
           or (c.direction = 'issued' and c.status in (${inList(OPEN_CHEQUE_STATUSES.issued)})))
         and c.due_date <= ${to}::date`);
    const n = res.rows.length;
    if (n === 0) return null;
    const overdue = res.rows.filter((r) => r.due < today).length;
    return {
      severity: overdue > 0 ? 'critical' : 'warning',
      title: `Vadesi gelen ya da geçen çek/senet: ${n}`,
      body: `${days} gün içinde vadesi dolacak ya da vadesi geçmiş ${n} açık çek/senet var${overdue > 0 ? ` (vadesi geçen: ${overdue})` : ''}. Çek/senet portföyünden inceleyin.`,
      count: n,
      parts: [...ids(res.rows), overdue],
    };
  },
};

// --- Banka teminat mektubu süresi --------------------------------------------------------------------------------------
const guaranteeExpiring: NotificationSource = {
  kind: 'guarantee_expiring',
  async sourceLead({ tx }) {
    const r = await tx.execute<{ d: number | null }>(sql`select guarantee_warning_days as d from portfolio_settings limit 1`);
    return r.rows[0]?.d ?? null;
  },
  async scan({ tx, today }, { lead }) {
    const res = await tx.execute<IdRow & { expiry: string }>(sql`
      select g.id, g.expiry_date::text as expiry from bank_guarantees g where g.status = 'active' and g.expiry_date is not null`);
    const hit = res.rows
      .map((r) => ({ ...r, st: guaranteeExpiryState(r.expiry, today, lead ?? 30).state }))
      .filter((r) => r.st === 'expiring' || r.st === 'lapsed');
    if (hit.length === 0) return null;
    const lapsed = hit.filter((r) => r.st === 'lapsed').length;
    return {
      severity: lapsed > 0 ? 'critical' : 'warning',
      title: `Süresi dolan ya da dolmak üzere olan teminat mektubu: ${hit.length}`,
      body: `${hit.length} aktif teminat mektubunun süresi ${lead ?? 30} gün içinde doluyor${lapsed > 0 ? ` ya da doldu (süresi geçen: ${lapsed})` : ''}. Teminat mektupları ekranından inceleyin.`,
      count: hit.length,
      parts: [...ids(hit), lapsed],
    };
  },
};

// --- Yabancı işçi belge süresi --------------------------------------------------------------------------------------
const foreignDocExpiring: NotificationSource = {
  kind: 'foreign_doc_expiring',
  async sourceLead({ tx, today }) {
    return (await warningAt(tx, today)).days;
  },
  async scan({ tx, today }, { lead }) {
    // Yalnızca sayı: personel adı/numarası/uyruğu bildirime girmez. İşten ayrılmış personelin belgesi sayılmaz.
    const res = await tx.execute<IdRow & { expiry: string }>(sql`
      select d.id, d.expiry_date::text as expiry
        from foreign_worker_docs d join employees e on e.id = d.employee_id and e.company_id = d.company_id
       where d.revoked_at is null and d.expiry_date is not null and e.status = 'active'`);
    const hit = res.rows
      .map((r) => ({ ...r, st: foreignDocStatus({ expiryDate: r.expiry, revoked: false, today, warningDays: lead ?? 30 }).status }))
      .filter((r) => r.st === 'expiring' || r.st === 'expired');
    if (hit.length === 0) return null;
    const expired = hit.filter((r) => r.st === 'expired').length;
    return {
      severity: expired > 0 ? 'critical' : 'warning',
      title: `Süresi dolan ya da dolmak üzere olan yabancı işçi belgesi: ${hit.length}`,
      body: `${hit.length} belgenin süresi ${lead ?? 30} gün içinde doluyor${expired > 0 ? ` ya da doldu (süresi dolan: ${expired})` : ''}. Yabancı işçi belgeleri ekranından inceleyin.`,
      count: hit.length,
      parts: [...ids(hit), expired],
    };
  },
};

// --- Ajanda: bugün / geciken ------------------------------------------------------------------------------------------
const agendaDue: NotificationSource = {
  kind: 'agenda_due',
  perUser: true,
  async scan({ tx, today }, { lead, user }) {
    const days = lead ?? 0;
    const to = addDaysIso(today, days);
    // Kullanıcının kendi kalemleri ve şirket ajandası (sahibi boş); başkasının kalemi bildirilmez
    const res = await tx.execute<IdRow & { due: string }>(sql`
      select a.id, a.due_date::text as due from agenda_items a
       where a.status = 'open' and a.due_date <= ${to}::date and (a.owner_id = ${user.id}::uuid or a.owner_id is null)`);
    const n = res.rows.length;
    if (n === 0) return null;
    const overdue = res.rows.filter((r) => r.due < today).length;
    return {
      severity: overdue > 0 ? 'warning' : 'info',
      title: `Ajandada ${days > 0 ? `${days} gün içinde vadesi gelen` : 'bugün vadesi gelen'} ya da geciken kalem: ${n}`,
      body: `${n} açık ajanda kaleminin ${days > 0 ? `${days} gün içinde ` : 'bugün '}vadesi geliyor${overdue > 0 ? ` ya da geçti (geciken: ${overdue})` : ''}. Ajandadan görüntüleyin.`,
      count: n,
      parts: [...ids(res.rows), overdue],
    };
  },
};

// --- Ajanda: hatırlatma ofseti (X6 remind_before_minutes) ---------------------------------------------------------------
const agendaReminder: NotificationSource = {
  kind: 'agenda_reminder',
  perUser: true,
  async scan({ tx, today, time }, { user }) {
    // Ofset en çok 30 gündür (43200 dk): bugünün 1 gün öncesinden 31 gün sonrasına kadar olan kalemler aday
    const res = await tx.execute<IdRow & { dueDate: string; allDay: boolean; startTime: string | null; endTime: string | null; remind: number }>(sql`
      select a.id, a.due_date::text as "dueDate", a.all_day as "allDay", a.start_time as "startTime", a.end_time as "endTime", a.remind_before_minutes as remind
        from agenda_items a
       where a.status = 'open' and a.remind_before_minutes is not null
         and a.due_date between ${addDaysIso(today, -1)}::date and ${addDaysIso(today, 31)}::date
         and (a.owner_id = ${user.id}::uuid or a.owner_id is null)`);
    const active = res.rows.filter(
      (r) => agendaReminderState({ status: 'open', dueDate: r.dueDate, allDay: r.allDay, startTime: r.startTime, endTime: r.endTime, remindBeforeMinutes: r.remind }, { date: today, time }) === 'active',
    );
    if (active.length === 0) return null;
    return {
      severity: 'info',
      title: `Hatırlatma zamanı gelen ajanda kalemi: ${active.length}`,
      body: `${active.length} ajanda kaleminin hatırlatma zamanı geldi. Ajandadan görüntüleyin.`,
      count: active.length,
      parts: ids(active),
    };
  },
};

// --- Onay bekleyen belgeler -------------------------------------------------------------------------------------------
const approvalPending: NotificationSource = {
  kind: 'approval_pending',
  perUser: true,
  async scan({ tx, companyId, enabled }, { user }) {
    const canProcure = ['core.procurement', 'construction.procurement'].some(m => enabled.has(m)) && hasPermission(user.permissions, 'procurement.read');
    const canSubcontract = enabled.has('construction.subcontracts') && hasPermission(user.permissions, 'subcontracts.read');
    const requests = (await pendingForMe(tx, { companyId, userId: user.id, role: user.role, permissions: user.permissions }))
      .filter(r => r.docType === 'purchase_request' ? canProcure : canSubcontract);
    if (requests.length === 0) return null;
    return {
      severity: 'warning',
      title: `Onayınızı bekleyen belge: ${requests.length}`,
      body: `Sıradaki onay adımı sizde olan ${requests.length} belge var. Onay kutusundan karar verin.`,
      count: requests.length,
      parts: requests.map((r) => r.id),
      link: enabled.has('core.procurement') && requests.every(r => r.docType === 'purchase_request') ? '/purchasing/requests' : '/approvals',
    };
  },
};

function leatherDue(kind: NotificationKind, table: string, finished: string[], subject: string): NotificationSource {
  return {
    kind,
    perUser: table === 'leather_production_orders',
    async scan({ tx, today }, { lead, user }) {
      const to = addDaysIso(today, lead ?? 3);
      const result = await tx.execute<IdRow & { due: string }>(sql`select id,due_date::text as due from ${sql.identifier(table)} r
        where due_date <= ${to}::date and status not in (${inList(finished)})
          ${table === 'leather_production_orders' ? sql`and ${productionOrderScope(user.role, user.id, 'r')}` : sql``} order by due_date,id`);
      if (!result.rows.length) return null;
      const overdue = result.rows.filter(r => r.due < today).length;
      return { severity: overdue ? 'critical' : 'warning', title: `Teslim tarihi yaklaşan ${subject}: ${result.rows.length}`,
        body: `${lead ?? 3} gün içinde teslim tarihi gelen veya geçen ${result.rows.length} açık kayıt var. İlgili listeden inceleyin.`,
        count: result.rows.length, parts: [...ids(result.rows), overdue] };
    },
  };
}

// --- Lisans ---------------------------------------------------------------------------------------------------------
const licenseExpiring: NotificationSource = {
  kind: 'license_expiring',
  async scan({ license, ownerOrg }, { lead }) {
    // Lisans kurulum düzeyindedir: yalnızca kurulumun sahibi kuruluşun şirketlerinde (ve yalnızca sahip rolüne) bildirilir
    if (!license?.enforced || !ownerOrg) return null;
    const days = license.daysUntilExpiry ?? null;
    if (license.state === 'restricted') {
      return { severity: 'critical', title: 'Lisans kısıtlı modda', body: 'Lisans durumu nedeniyle uygulama salt-okunur çalışıyor. Lisans ekranından durumu ve yenileme adımlarını görün.', count: 1, parts: ['restricted'] };
    }
    if (license.state === 'grace') {
      return { severity: 'critical', title: 'Lisans süresi doldu; tolerans süresindesiniz', body: 'Lisansı tolerans süresi bitmeden yenileyin; aksi halde uygulama salt-okunur olur.', count: 1, parts: ['grace', days ?? ''] };
    }
    if (license.state === 'active' && days !== null && days <= (lead ?? 30)) {
      return {
        severity: 'warning',
        title: `Lisansın bitmesine ${Math.max(0, days)} gün kaldı`,
        body: 'Lisansı süre dolmadan yenileyin. Lisans ekranından durumu görebilirsiniz.',
        count: Math.max(0, days),
        parts: ['active', days],
      };
    }
    return null;
  },
};

// --- Puantaj / bordro: ay sonu geçti, hâlâ açık ----------------------------------------------------------------------
const LOOKBACK_MONTHS = 6;

async function closedAttendanceMonths(tx: Tx, months: string[]): Promise<Set<string>> {
  const r = await tx.execute<{ month: string }>(sql`select month from attendance_months where status = 'closed' and month in (${inList(months)})`);
  return new Set(r.rows.map((x) => x.month));
}

const attendanceOpen: NotificationSource = {
  kind: 'attendance_open',
  async scan({ tx, today }) {
    const months = previousMonths(today, LOOKBACK_MONTHS);
    const from = monthRange(months[months.length - 1]!).from;
    const to = monthRange(months[0]!).to;
    // Yalnızca puantaj kaydı olan aylar (kayıt girilmemiş ay "açık" sayılmaz)
    const withEntries = await tx.execute<{ m: string }>(sql`
      select distinct to_char(work_date, 'YYYY-MM') as m from attendance_entries where work_date between ${from}::date and ${to}::date`);
    const closed = await closedAttendanceMonths(tx, months);
    const open = withEntries.rows.map((r) => r.m).filter((m) => !closed.has(m));
    if (open.length === 0) return null;
    return {
      severity: 'warning',
      title: `Ayı geçen ama kapatılmamış puantaj: ${open.length} ay`,
      body: `${open.length} ayın puantajı ay sonu geçtiği halde kapatılmadı. Puantaj ekranından ayı kontrol edip kapatın.`,
      count: open.length,
      parts: open,
    };
  },
};

const payrollOpen: NotificationSource = {
  kind: 'payroll_open',
  async scan({ tx, today }) {
    const months = previousMonths(today, LOOKBACK_MONTHS);
    const runs = await tx.execute<{ month: string; status: string }>(sql`
      select month, status from payroll_runs where status <> 'cancelled' and month in (${inList(months)})`);
    const closed = await closedAttendanceMonths(tx, months);
    const byMonth = new Map(runs.rows.map((r) => [r.month, r.status]));
    // Taslak bordro onaylanmamış; puantajı kapanmış ayın bordrosu hiç hazırlanmamış
    const open = months.filter((m) => byMonth.get(m) === 'draft' || (closed.has(m) && !byMonth.has(m)));
    if (open.length === 0) return null;
    return {
      severity: 'warning',
      title: `Ayı geçen ama onaylanmamış bordro: ${open.length} ay`,
      body: `${open.length} ayın bordrosu hazırlanmadı ya da taslakta kaldı. Bordro ekranından kontrol edin.`,
      count: open.length,
      parts: open,
    };
  },
};

// --- Vadesi geçmiş alacak ----------------------------------------------------------------------------------------------
const receivableOverdue: NotificationSource = {
  kind: 'receivable_overdue',
  async scan({ tx, today }, { lead }) {
    const grace = lead ?? 0;
    const items = (await allOpenItems(tx, 'receivable', today)).filter((i) => i.daysOverdue > grace);
    if (items.length === 0) return null;
    // Personel carisi (avans) alacak sayılmaz: personel verisi bu bildirime girmez
    const personnel = await tx.execute<{ id: string }>(sql`select id from parties where kind = 'employee'`);
    const skip = new Set(personnel.rows.map((r) => r.id));
    const rows = items.filter((i) => !skip.has(i.partyId));
    if (rows.length === 0) return null;
    const parties = new Set(rows.map((i) => i.partyId)).size;
    const oldest = Math.max(...rows.map((i) => i.daysOverdue));
    return {
      severity: oldest > 90 ? 'critical' : 'warning',
      title: `Vadesi geçmiş alacağı olan cari: ${parties}`,
      body: `${rows.length} açık alacak kaleminin vadesi geçti (en eskisi ${oldest} gün). Cari yaşlandırma raporundan inceleyin.`,
      count: parties,
      parts: [parties, rows.length, oldest > 90 ? 'old' : 'recent'],
    };
  },
};

// --- Kritik stok --------------------------------------------------------------------------------------------------------
const stockBelowMin: NotificationSource = {
  kind: 'stock_below_min',
  async scan({ tx, today }) {
    const { lowCount } = await inventorySummary(tx, today);
    if (lowCount === 0) return null;
    return {
      severity: 'warning',
      title: `Kritik seviyenin altındaki stok kartı: ${lowCount}`,
      body: `${lowCount} stok kartının eldeki miktarı kritik seviyeye eşit ya da altında. Stok durumu ekranından inceleyin.`,
      count: lowCount,
      parts: [lowCount],
    };
  },
};

// --- Uzun süredir kaydedilmeyen taslaklar ---------------------------------------------------------------------------
const draftStale: NotificationSource = {
  kind: 'draft_stale',
  perUser: true,
  async scan({ tx, today, enabled }, { lead, user }) {
    const days = lead ?? 14;
    const cutoff = addDaysIso(today, -days);
    let invoices: string[] = [];
    let entries: string[] = [];
    if (enabled.has('core.invoices') && hasPermission(user.permissions, 'invoices.manage')) {
      const r = await tx.execute<IdRow>(sql`
        select i.id from invoices i where i.status = 'draft' and (i.created_at at time zone 'Europe/Nicosia')::date <= ${cutoff}::date`);
      invoices = ids(r.rows);
    }
    if (enabled.has('core.ledger') && hasPermission(user.permissions, 'ledger.post')) {
      const r = await tx.execute<IdRow>(sql`
        select j.id from journal_entries j where j.status = 'draft' and (j.created_at at time zone 'Europe/Nicosia')::date <= ${cutoff}::date`);
      entries = ids(r.rows);
    }
    const n = invoices.length + entries.length;
    if (n === 0) return null;
    const parts: string[] = [];
    if (invoices.length) parts.push(`${invoices.length} fatura`);
    if (entries.length) parts.push(`${entries.length} yevmiye`);
    return {
      severity: 'info',
      title: `Uzun süredir kaydedilmeyen taslak: ${n}`,
      body: `${parts.join(' ve ')} taslağı ${days} günden uzun süredir bekliyor. Kaydedin ya da gereksizse silin.`,
      count: n,
      parts: [...invoices, ...entries],
      link: invoices.length > 0 ? notificationKindDef('draft_stale').link : '/accounting/journal',
    };
  },
};

export const NOTIFICATION_SOURCES: Readonly<Record<NotificationKind, NotificationSource>> = {
  manufacturing_production_due: leatherDue('manufacturing_production_due','leather_production_orders',['completed','cancelled'],'üretim emri'),
  manufacturing_subcontract_due: leatherDue('manufacturing_subcontract_due','leather_subcontract_jobs',['received','cancelled'],'fason işi'),
  cheque_due: chequeDue,
  guarantee_expiring: guaranteeExpiring,
  foreign_doc_expiring: foreignDocExpiring,
  agenda_due: agendaDue,
  agenda_reminder: agendaReminder,
  approval_pending: approvalPending,
  license_expiring: licenseExpiring,
  attendance_open: attendanceOpen,
  payroll_open: payrollOpen,
  receivable_overdue: receivableOverdue,
  stock_below_min: stockBelowMin,
  draft_stale: draftStale,
  leather_production_due: leatherDue('leather_production_due', 'leather_production_orders', ['completed', 'cancelled'], 'üretim emri'),
  leather_subcontract_due: leatherDue('leather_subcontract_due', 'leather_subcontract_jobs', ['received', 'cancelled'], 'fason işi'),
  leather_custom_order_due: leatherDue('leather_custom_order_due', 'leather_custom_orders', ['delivered', 'cancelled'], 'özel sipariş'),
};
