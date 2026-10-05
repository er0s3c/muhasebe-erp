import { sql } from 'drizzle-orm';
import {
  canReceiveKind,
  eligibleNotificationKinds,
  notificationKindDef,
  resolveLeadDays,
  type NotificationKind,
  type NotificationListQuery,
  type NotificationPreferenceView,
  type NotificationSeverity,
  type PermissionSet,
  type UpdateNotificationPreferencesInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { notFound, unprocessable } from '../../http/errors';
import { pageSql, paged, type PageQuery } from '../../http/paging';
import { NOTIFICATION_SOURCES, type ScanCtx } from './sources';

export type NotificationView = {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  link: string;
  count: number;
  bucketDate: string;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
  resolvedAt: string | null;
};

const COLS = sql`id, kind, severity, title, body, link, count, bucket_date::text as "bucketDate", created_at as "createdAt",
  read_at as "readAt", dismissed_at as "dismissedAt", resolved_at as "resolvedAt"`;
/** Okunmamış ve hâlâ geçerli (kapatılmamış, çözülmemiş). */
const UNREAD = sql`read_at is null and dismissed_at is null and resolved_at is null`;
const ACTIVE = sql`dismissed_at is null and resolved_at is null`;

/**
 * Kullanıcının GÖREBİLECEĞİ türler (etkin izin + açık modül). Modül erişimi sonradan kapatılan üyenin eski açık bildirimleri, bir sonraki tarama
 * onları çözene kadar da listelenmez ve sayılmaz.
 */
const visibleKinds = (kinds: readonly NotificationKind[]) => (kinds.length === 0 ? sql`false` : sql`kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`);

/**
 * Kullanıcının kendi bildirimleri (RLS ayrıca kullanıcıya süzer: başkasının satırı hiçbir sorguda görünmez).
 * `status`: active = kapatılmamış ve çözülmemiş; unread = bunlardan okunmamış; all = geçmiş dahil.
 */
export async function listNotifications(tx: Tx, q: NotificationListQuery, kinds: readonly NotificationKind[]) {
  const where = [q.status === 'unread' ? UNREAD : q.status === 'active' ? ACTIVE : sql`true`, visibleKinds(kinds)];
  if (q.kind) where.push(sql`kind = ${q.kind}`);
  const page: PageQuery = { limit: q.limit, offset: q.offset };
  const res = await tx.execute<NotificationView>(sql`
    select ${COLS} from notifications where ${sql.join(where, sql` and `)} order by created_at desc, id desc ${pageSql(page)}`);
  const { rows, truncated } = paged(res.rows, page);
  return { notifications: rows, truncated, unreadCount: (await unreadCount(tx, kinds)).count };
}

export async function unreadCount(tx: Tx, kinds: readonly NotificationKind[]): Promise<{ count: number; hasCritical: boolean }> {
  const r = await tx.execute<{ n: number; crit: boolean }>(sql`
    select count(*)::int as n, coalesce(bool_or(severity = 'critical'), false) as crit from notifications where ${UNREAD} and ${visibleKinds(kinds)}`);
  return { count: r.rows[0]?.n ?? 0, hasCritical: r.rows[0]?.crit ?? false };
}

/** Okundu işaretler (tekrarlı çağrı zararsızdır). Başkasının ya da olmayan bildirim 404. */
export async function markRead(tx: Tx, id: string): Promise<NotificationView> {
  const r = await tx.execute<NotificationView>(sql`
    update notifications set read_at = coalesce(read_at, now()) where id = ${id}::uuid returning ${COLS}`);
  if (!r.rows[0]) throw notFound('Bildirim');
  return r.rows[0];
}

/** Kapatır (listeden kalkar; aynı durum için yeniden bildirilmez). Kapatmak okumayı da kapsar. */
export async function dismiss(tx: Tx, id: string): Promise<NotificationView> {
  const r = await tx.execute<NotificationView>(sql`
    update notifications set dismissed_at = coalesce(dismissed_at, now()), read_at = coalesce(read_at, now()) where id = ${id}::uuid returning ${COLS}`);
  if (!r.rows[0]) throw notFound('Bildirim');
  return r.rows[0];
}

export async function markAllRead(tx: Tx, kinds: readonly NotificationKind[]): Promise<{ updated: number }> {
  const r = await tx.execute<{ id: string }>(sql`update notifications set read_at = now() where ${UNREAD} and ${visibleKinds(kinds)} returning id`);
  return { updated: r.rows.length };
}

// --- Tercihler -------------------------------------------------------------------------------------------------------------

export interface PrefCtx {
  userId: string;
  permissions: PermissionSet;
  enabledModules: ReadonlySet<string>;
  companyId: string;
  today: string;
}

type PrefRow = { kind: NotificationKind; inApp: boolean; email: boolean; leadDays: number | null };

/** Kullanıcının alabileceği türler ve tercihleri (modül kapalı ya da izni olmayan tür listelenmez). */
export async function getPreferences(tx: Tx, ctx: PrefCtx, emailAvailable: boolean) {
  const rows = (await tx.execute<PrefRow>(sql`select kind, in_app as "inApp", email, lead_days as "leadDays" from notification_preferences`)).rows;
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const scanCtx = { tx, companyId: ctx.companyId, today: ctx.today, time: '00:00', enabled: ctx.enabledModules, license: null, ownerOrg: false } satisfies ScanCtx;
  const kinds: (NotificationPreferenceView & { leadFromSetting: boolean })[] = [];
  for (const kind of eligibleNotificationKinds(ctx.permissions, ctx.enabledModules)) {
    const def = notificationKindDef(kind);
    const p = byKind.get(kind);
    const src = NOTIFICATION_SOURCES[kind];
    // Kaynak modülün kendi ayarı (varsa) tercihsiz geçerli eşiktir; yoksa düz varsayılan
    const setting = src.sourceLead ? await src.sourceLead(scanCtx).catch(() => null) : null;
    kinds.push({
      kind,
      inApp: p?.inApp ?? true,
      email: p?.email ?? false,
      leadDays: p?.leadDays ?? null,
      leadDefault: def.lead ? resolveLeadDays(def, null, setting) : null,
      leadUnit: def.lead?.unit ?? null,
      leadMin: def.lead?.min ?? null,
      leadMax: def.lead?.max ?? null,
      leadFromSetting: setting !== null && !!def.lead,
    });
  }
  return { kinds, emailAvailable };
}

/**
 * Tercihleri günceller (gönderilmeyen alanlar korunur). Kullanıcının alamadığı tür 422; gün eşiği olmayan türe gün eşiği 422.
 * Uygulama içi kapatılan türün açık bildirimleri hemen çözülür (listeden kalkar).
 */
export async function updatePreferences(tx: Tx, ctx: PrefCtx, input: UpdateNotificationPreferencesInput) {
  const existing = new Map(
    (await tx.execute<PrefRow>(sql`select kind, in_app as "inApp", email, lead_days as "leadDays" from notification_preferences`)).rows.map((r) => [r.kind, r]),
  );
  for (const p of input.preferences) {
    const def = notificationKindDef(p.kind);
    if (!canReceiveKind(def, ctx.permissions, ctx.enabledModules)) {
      throw unprocessable('Bu bildirim türü bu şirkette ya da rolünüz için kullanılamıyor', 'NOTIFICATION_KIND_UNAVAILABLE', { kind: p.kind });
    }
    if (p.leadDays != null) {
      if (!def.lead) throw unprocessable('Bu bildirim türünde gün eşiği yok', 'NOTIFICATION_LEAD_NOT_SUPPORTED', { kind: p.kind });
      if (p.leadDays < def.lead.min || p.leadDays > def.lead.max) {
        throw unprocessable(`Gün eşiği ${def.lead.min} ile ${def.lead.max} arasında olmalı`, 'NOTIFICATION_LEAD_RANGE', { kind: p.kind, min: def.lead.min, max: def.lead.max });
      }
    }
    const cur = existing.get(p.kind);
    const next = {
      inApp: p.inApp ?? cur?.inApp ?? true,
      email: p.email ?? cur?.email ?? false,
      leadDays: p.leadDays === undefined ? (cur?.leadDays ?? null) : p.leadDays,
    };
    await tx.execute(sql`
      insert into notification_preferences (company_id, user_id, kind, in_app, email, lead_days)
      values (${ctx.companyId}::uuid, ${ctx.userId}::uuid, ${p.kind}, ${next.inApp}, ${next.email}, ${next.leadDays})
      on conflict (company_id, user_id, kind) do update set in_app = excluded.in_app, email = excluded.email, lead_days = excluded.lead_days, updated_at = now()`);
    if (!next.inApp) {
      await tx.execute(sql`update notifications set resolved_at = now() where kind = ${p.kind} and resolved_at is null`);
    }
  }
}

