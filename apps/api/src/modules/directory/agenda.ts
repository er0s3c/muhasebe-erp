import { eq, sql, type SQL } from 'drizzle-orm';
import { AGENDA_UPCOMING_DAYS, agendaBucket, todayIso, type AgendaListQuery, type CreateAgendaInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { agendaItems, directoryContacts, memberships } from '../../db/schema';
import { and } from 'drizzle-orm';
import { forbidden, notFound, unprocessable } from '../../http/errors';
import { assertRefs, getNote } from './service';

export interface AgendaCtx {
  companyId: string;
  userId: string;
  /** directory.manage: başkası/şirket adına kalem açar, tüm kalemleri düzenler ve görür. */
  canManage: boolean;
}

const AGENDA_SELECT = sql`
  a.id, a.kind, a.title, a.description, a.due_date::text as "dueDate", a.all_day as "allDay", a.start_time as "startTime", a.end_time as "endTime",
  a.remind_before_minutes as "remindBeforeMinutes", a.status, a.completed_at as "completedAt", a.owner_id as "ownerId", u.full_name as "ownerName",
  a.contact_id as "contactId", c.full_name as "contactName", a.organization_id as "organizationId", o.name as "organizationName",
  a.party_id as "partyId", p.name as "partyName", a.project_id as "projectId", pr.code as "projectCode", a.source_note_id as "sourceNoteId",
  a.created_by as "createdBy", a.created_at as "createdAt"`;
const AGENDA_FROM = sql`
  from agenda_items a
  left join users u on u.id = a.owner_id
  left join directory_contacts c on c.id = a.contact_id
  left join directory_organizations o on o.id = a.organization_id
  left join parties p on p.id = a.party_id
  left join projects pr on pr.id = a.project_id`;
const AGENDA_ORDER = sql`order by a.due_date, a.start_time nulls first, a.created_at`;

/** Kapsam koşulu: mine = benim; company = şirket ajandası; all = yöneticide hepsi, diğerlerinde benim + şirket. */
function scopeWhere(scope: 'mine' | 'company' | 'all', ctx: AgendaCtx): SQL | null {
  if (scope === 'mine') return sql`a.owner_id = ${ctx.userId}`;
  if (scope === 'company') return sql`a.owner_id is null`;
  return ctx.canManage ? null : sql`(a.owner_id = ${ctx.userId} or a.owner_id is null)`;
}

export async function listAgenda(tx: Tx, ctx: AgendaCtx, q: AgendaListQuery) {
  const where: SQL[] = [];
  const sc = scopeWhere(q.scope, ctx);
  if (sc) where.push(sc);
  if (q.status) where.push(sql`a.status = ${q.status}`);
  if (q.from) where.push(sql`a.due_date >= ${q.from}::date`);
  if (q.to) where.push(sql`a.due_date <= ${q.to}::date`);
  if (q.contactId) where.push(sql`a.contact_id = ${q.contactId}`);
  if (q.organizationId) where.push(sql`a.organization_id = ${q.organizationId}`);
  if (q.partyId) where.push(sql`a.party_id = ${q.partyId}`);
  if (q.projectId) where.push(sql`a.project_id = ${q.projectId}`);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select ${AGENDA_SELECT} ${AGENDA_FROM} ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``} ${AGENDA_ORDER} limit 1000`);
  const today = q.asOf ?? todayIso();
  return { asOf: today, items: rows.rows.map((r): Record<string, unknown> => ({ ...r, bucket: agendaBucket({ status: r.status as string, dueDate: r.dueDate as string }, today) })) };
}

/** Bugün / gecikmiş / yaklaşan listeleri (açık kalemler). Sayfa ve (varsa) gösterge paneli bunu kullanır. */
export async function agendaSummary(tx: Tx, ctx: AgendaCtx, q: { scope: 'mine' | 'company' | 'all'; asOf?: string }) {
  const { asOf, items } = await listAgenda(tx, ctx, { scope: q.scope, status: 'open', asOf: q.asOf });
  const pick = (b: string) => items.filter((i) => i.bucket === b);
  const overdue = pick('overdue');
  const today = pick('today');
  const upcoming = pick('upcoming');
  return { asOf, upcomingDays: AGENDA_UPCOMING_DAYS, counts: { overdue: overdue.length, today: today.length, upcoming: upcoming.length }, overdue, today, upcoming };
}

async function resolveOwner(tx: Tx, ctx: AgendaCtx, owner: string | null | undefined): Promise<string | null> {
  if (owner === undefined || owner === ctx.userId) return ctx.userId;
  if (!ctx.canManage) throw forbidden('Başkası ya da şirket adına ajanda kalemi açmak için rehber yönetim izni gerekir');
  if (owner === null) return null;
  const [m] = await tx.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.userId, owner), eq(memberships.companyId, ctx.companyId)));
  if (!m) throw notFound('Kullanıcı');
  return owner;
}

async function assertContactOpen(tx: Tx, contactId: string | null | undefined) {
  if (!contactId) return;
  const [c] = await tx.select({ a: directoryContacts.anonymizedAt, m: directoryContacts.mergedIntoId }).from(directoryContacts).where(eq(directoryContacts.id, contactId));
  if (c?.a || c?.m) throw unprocessable('Anonimleştirilmiş ya da birleştirilmiş kişiye ajanda kalemi bağlanamaz', 'DIRECTORY_CONTACT_FROZEN');
}

/**
 * Tek kalem. `ctx` verilirse listeyle aynı görünürlük uygulanır: yönetici olmayan başkasının özel kalemini kimliğiyle de okuyamaz
 * (bulunamadı döner; varlığı da sızdırılmaz).
 */
export async function getAgendaItem(tx: Tx, id: string, ctx?: AgendaCtx) {
  const vis = ctx ? scopeWhere('all', ctx) : null;
  const rows = await tx.execute<Record<string, unknown>>(sql`select ${AGENDA_SELECT} ${AGENDA_FROM} where a.id = ${id}${vis ? sql` and ${vis}` : sql``}`);
  if (!rows.rows[0]) throw notFound('Ajanda kalemi');
  return { item: rows.rows[0] };
}

export async function createAgendaItem(tx: Tx, ctx: AgendaCtx, input: CreateAgendaInput, sourceNoteId?: string) {
  await assertRefs(tx, input);
  await assertContactOpen(tx, input.contactId);
  const ownerId = await resolveOwner(tx, ctx, input.ownerId);
  const [row] = await tx
    .insert(agendaItems)
    .values({
      companyId: ctx.companyId,
      kind: input.kind,
      title: input.title,
      description: input.description ?? null,
      dueDate: input.dueDate,
      allDay: input.allDay,
      startTime: input.allDay ? null : (input.startTime ?? null),
      endTime: input.allDay ? null : (input.endTime ?? null),
      remindBeforeMinutes: input.remindBeforeMinutes ?? null,
      ownerId,
      contactId: input.contactId ?? null,
      organizationId: input.organizationId ?? null,
      partyId: input.partyId ?? null,
      projectId: input.projectId ?? null,
      sourceNoteId: sourceNoteId ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: agendaItems.id });
  return getAgendaItem(tx, row!.id);
}

async function editable(tx: Tx, ctx: AgendaCtx, id: string) {
  const [cur] = await tx.select().from(agendaItems).where(eq(agendaItems.id, id)).for('update');
  if (!cur) throw notFound('Ajanda kalemi');
  // Kendi kalemi her zaman düzenlenebilir; şirket kalemini oluşturanı ya da yönetici düzenler
  const own = cur.ownerId === ctx.userId || (cur.ownerId === null && cur.createdBy === ctx.userId);
  if (!own && !ctx.canManage) throw forbidden('Bu ajanda kalemini düzenleme yetkiniz yok');
  return cur;
}

export async function updateAgendaItem(tx: Tx, ctx: AgendaCtx, id: string, input: Partial<CreateAgendaInput>) {
  const cur = await editable(tx, ctx, id);
  await assertRefs(tx, input);
  if (input.contactId && input.contactId !== cur.contactId) await assertContactOpen(tx, input.contactId);
  const set: Partial<typeof agendaItems.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['kind', 'title', 'description', 'dueDate', 'remindBeforeMinutes', 'contactId', 'organizationId', 'partyId', 'projectId'] as const) {
    if (input[k] !== undefined) (set as Record<string, unknown>)[k] = input[k];
  }
  if (input.ownerId !== undefined) set.ownerId = await resolveOwner(tx, ctx, input.ownerId);
  const allDay = input.allDay ?? cur.allDay;
  set.allDay = allDay;
  set.startTime = allDay ? null : (input.startTime !== undefined ? input.startTime : cur.startTime);
  set.endTime = allDay ? null : (input.endTime !== undefined ? input.endTime : cur.endTime);
  if (!allDay && !set.startTime) throw unprocessable('Saatli kalem için başlangıç saati gerekli', 'AGENDA_TIME_REQUIRED');
  await tx.update(agendaItems).set(set).where(eq(agendaItems.id, id));
  return getAgendaItem(tx, id);
}

export async function setAgendaStatus(tx: Tx, ctx: AgendaCtx, id: string, status: 'open' | 'done' | 'cancelled') {
  await editable(tx, ctx, id);
  await tx
    .update(agendaItems)
    .set({ status, completedAt: status === 'done' ? new Date() : null, updatedAt: new Date() })
    .where(eq(agendaItems.id, id));
  return getAgendaItem(tx, id);
}

/** Görüşme notundan tek tıkla takip görevi: bağlantılar nottan gelir, başlık notun metninden KOPYALANMAZ (özel not sızmasın). */
export async function createFollowUp(tx: Tx, ctx: AgendaCtx, noteId: string, input: { title?: string; dueDate: string; ownerId?: string | null; remindBeforeMinutes?: number | null }) {
  const { note } = await getNote(tx, noteId, ctx.userId); // görünürlük politikası: başkasının özel notu bulunamaz
  const who = (note.contactName ?? note.organizationName ?? '') as string;
  return createAgendaItem(
    tx,
    ctx,
    {
      kind: 'task',
      title: input.title ?? `Takip: ${who}`.trim(),
      dueDate: input.dueDate,
      allDay: true,
      ownerId: input.ownerId,
      remindBeforeMinutes: input.remindBeforeMinutes ?? null,
      contactId: (note.contactId as string | null) ?? null,
      organizationId: (note.organizationId as string | null) ?? null,
      projectId: (note.projectId as string | null) ?? null,
    },
    noteId,
  );
}
