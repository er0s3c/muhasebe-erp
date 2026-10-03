import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  emailKey,
  normalizeTags,
  phoneKey,
  planContactMerge,
  type ContactFields,
  type ContactListQuery,
  type CreateContactInput,
  type CreateNoteInput,
  type CreateOrganizationInput,
  type UpdateContactInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { directoryContacts, directoryNotes, directoryOrganizations, employees, parties, personalDataAccessLog, projects } from '../../db/schema';
import { trContains } from '../../db/search';
import { notFound, unprocessable } from '../../http/errors';
import { pageSql, paged, type PageQuery } from '../../http/paging';

export interface DirCtx {
  companyId: string;
  userId: string;
}

const CONTACT_SELECT = sql`
  c.id, c.full_name as "fullName", c.title, c.organization_id as "organizationId", o.name as "organizationName",
  c.phone, c.phone2, c.email, c.email2, c.address, c.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
  c.employee_id as "employeeId", c.project_id as "projectId", pr.code as "projectCode", c.tags, c.note,
  c.is_archived as "isArchived", c.merged_into_id as "mergedIntoId", c.anonymized_at as "anonymizedAt",
  c.created_at as "createdAt", c.updated_at as "updatedAt"`;
const CONTACT_FROM = sql`
  from directory_contacts c
  left join directory_organizations o on o.id = c.organization_id
  left join parties p on p.id = c.party_id
  left join projects pr on pr.id = c.project_id`;

/** Bağlantı kimliklerinin bu şirkette var olduğunu doğrular (yoksa anlamlı 404; veritabanı FK'si yalnızca 409 verirdi). */
export async function assertRefs(tx: Tx, refs: { partyId?: string | null; projectId?: string | null; organizationId?: string | null; employeeId?: string | null; contactId?: string | null }) {
  const checks: [string | null | undefined, () => Promise<unknown[]>, string][] = [
    [refs.partyId, () => tx.select({ id: parties.id }).from(parties).where(eq(parties.id, refs.partyId!)), 'Cari'],
    [refs.projectId, () => tx.select({ id: projects.id }).from(projects).where(eq(projects.id, refs.projectId!)), 'Proje'],
    [refs.organizationId, () => tx.select({ id: directoryOrganizations.id }).from(directoryOrganizations).where(eq(directoryOrganizations.id, refs.organizationId!)), 'Kurum'],
    [refs.employeeId, () => tx.select({ id: employees.id }).from(employees).where(eq(employees.id, refs.employeeId!)), 'Personel'],
    [refs.contactId, () => tx.select({ id: directoryContacts.id }).from(directoryContacts).where(eq(directoryContacts.id, refs.contactId!)), 'Kişi'],
  ];
  for (const [id, run, label] of checks) if (id && (await run()).length === 0) throw notFound(label);
}

// --- Kurumlar ----------------------------------------------------------------------------------------------

export async function listOrganizations(tx: Tx, q: { q?: string; category?: string; archived: 'active' | 'archived' | 'all'; partyId?: string }, page?: PageQuery) {
  const where: SQL[] = [];
  if (q.archived !== 'all') where.push(sql`o.is_archived = ${q.archived === 'archived'}`);
  if (q.q) where.push(trContains(['o.name', "coalesce(o.phone, '')", "coalesce(o.email, '')"], q.q));
  if (q.category) where.push(sql`o.category = ${q.category}`);
  if (q.partyId) where.push(sql`o.party_id = ${q.partyId}`);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select o.id, o.name, o.category, o.address, o.phone, o.email, o.web, o.party_id as "partyId", p.name as "partyName", o.note,
           o.is_archived as "isArchived", o.created_at as "createdAt",
           (select count(*)::int from directory_contacts c where c.organization_id = o.id and not c.is_archived) as "contactCount"
      from directory_organizations o left join parties p on p.id = o.party_id
     ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
     order by lower(o.name) collate "tr-TR-x-icu" ${pageSql(page)}`);
  const pg = paged(rows.rows, page);
  return { organizations: pg.rows, truncated: pg.truncated };
}

export async function getOrganization(tx: Tx, id: string) {
  const rows = await listOrganizations(tx, { archived: 'all' });
  const row = rows.organizations.find((o) => o.id === id);
  if (!row) throw notFound('Kurum');
  return { organization: row };
}

export async function createOrganization(tx: Tx, ctx: DirCtx, input: CreateOrganizationInput) {
  await assertRefs(tx, { partyId: input.partyId });
  const [row] = await tx
    .insert(directoryOrganizations)
    .values({
      companyId: ctx.companyId,
      name: input.name,
      category: input.category,
      address: input.address ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      web: input.web ?? null,
      partyId: input.partyId ?? null,
      note: input.note ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: directoryOrganizations.id });
  // Aynı adlı kurum varsa ipucu (engellemez)
  const dup = await tx.execute<{ id: string; name: string }>(sql`
    select id, name from directory_organizations where id <> ${row!.id} and lower(btrim(name)) = lower(btrim(${input.name}))`);
  return { ...(await getOrganization(tx, row!.id)), duplicates: dup.rows };
}

export async function updateOrganization(tx: Tx, id: string, input: Partial<CreateOrganizationInput>) {
  await assertRefs(tx, { partyId: input.partyId });
  const set: Partial<typeof directoryOrganizations.$inferInsert> = { updatedAt: new Date() };
  for (const k of ['name', 'category', 'address', 'phone', 'email', 'web', 'partyId', 'note'] as const) if (input[k] !== undefined) (set as Record<string, unknown>)[k] = input[k];
  const [row] = await tx.update(directoryOrganizations).set(set).where(eq(directoryOrganizations.id, id)).returning({ id: directoryOrganizations.id });
  if (!row) throw notFound('Kurum');
  return getOrganization(tx, id);
}

export async function setOrganizationArchived(tx: Tx, id: string, archived: boolean) {
  const [row] = await tx
    .update(directoryOrganizations)
    .set({ isArchived: archived, archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(directoryOrganizations.id, id))
    .returning({ id: directoryOrganizations.id });
  if (!row) throw notFound('Kurum');
  return getOrganization(tx, id);
}

// --- Kişiler -----------------------------------------------------------------------------------------------

export async function listContacts(tx: Tx, q: Partial<ContactListQuery> & { ids?: string[] }) {
  const where: SQL[] = [];
  const archived = q.archived ?? 'active';
  if (archived !== 'all') where.push(sql`c.is_archived = ${archived === 'archived'}`);
  if (q.q) where.push(trContains(['c.full_name', "coalesce(c.title, '')", "coalesce(c.phone, '')", "coalesce(c.phone2, '')", "coalesce(c.email, '')", "coalesce(c.email2, '')", "coalesce(o.name, '')", "array_to_string(c.tags, ' ')"], q.q));
  if (q.tag) where.push(sql`exists (select 1 from unnest(c.tags) t where lower(t) = lower(${q.tag}))`);
  if (q.organizationId) where.push(sql`c.organization_id = ${q.organizationId}`);
  if (q.partyId) where.push(sql`(c.party_id = ${q.partyId} or o.party_id = ${q.partyId})`);
  if (q.projectId) where.push(sql`c.project_id = ${q.projectId}`);
  if (q.ids?.length) where.push(sql`c.id = any(${pgTextArray(q.ids)}::uuid[])`);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select ${CONTACT_SELECT} ${CONTACT_FROM}
     ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
     order by lower(c.full_name) collate "tr-TR-x-icu" limit 2000`);
  return { contacts: rows.rows };
}

export async function getContact(tx: Tx, id: string) {
  const rows = await tx.execute<Record<string, unknown>>(sql`select ${CONTACT_SELECT} ${CONTACT_FROM} where c.id = ${id}`);
  if (!rows.rows[0]) throw notFound('Kişi');
  return { contact: rows.rows[0] };
}

export async function distinctTags(tx: Tx) {
  const rows = await tx.execute<{ tag: string }>(sql`
    select distinct on (lower(t)) t as tag from directory_contacts c, unnest(c.tags) t where not c.is_archived order by lower(t), t`);
  return { tags: rows.rows.map((r) => r.tag) };
}

/** Metin dizisini Postgres dizi değişmezine çevirir (tek parametre; sürücü dizi biçimine bağımlı olmaz). */
export const pgTextArray = (values: readonly string[]): string => `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;

const DIGITS = (col: string) => `regexp_replace(coalesce(${col}, ''), '\\D', '', 'g')`;
const PHONE_KEYS = sql.raw(`array[case when length(${DIGITS('c.phone')}) >= 7 then right(${DIGITS('c.phone')}, 10) end, case when length(${DIGITS('c.phone2')}) >= 7 then right(${DIGITS('c.phone2')}, 10) end]`);
const EMAIL_KEYS = sql.raw(`array[nullif(lower(btrim(coalesce(c.email, ''))), ''), nullif(lower(btrim(coalesce(c.email2, ''))), '')]`);

/** Aynı telefon (son 10 hane) ya da e-posta taşıyan başka kişiler: yalnızca ipucudur, kayıt engellenmez. */
export async function findDuplicates(tx: Tx, q: { phones?: (string | null | undefined)[]; emails?: (string | null | undefined)[]; excludeId?: string }) {
  const pk = pgTextArray([...new Set((q.phones ?? []).map(phoneKey).filter((v): v is string => !!v))]);
  const ek = pgTextArray([...new Set((q.emails ?? []).map(emailKey).filter((v): v is string => !!v))]);
  if (pk === '{}' && ek === '{}') return [];
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.full_name as "fullName", c.phone, c.email, c.is_archived as "isArchived",
           (case when ${pk}::text[] && ${PHONE_KEYS} then 'phone' else 'email' end) as "matchedOn"
      from directory_contacts c
     where c.anonymized_at is null and c.merged_into_id is null
       ${q.excludeId ? sql`and c.id <> ${q.excludeId}` : sql``}
       and (${pk}::text[] && ${PHONE_KEYS} or ${ek}::text[] && ${EMAIL_KEYS})
     order by lower(c.full_name) limit 20`);
  return rows.rows;
}

const contactValues = (input: Partial<CreateContactInput>) => {
  const v: Partial<typeof directoryContacts.$inferInsert> = {};
  for (const k of ['fullName', 'title', 'organizationId', 'phone', 'phone2', 'email', 'email2', 'address', 'partyId', 'employeeId', 'projectId', 'note'] as const) {
    if (input[k] !== undefined) (v as Record<string, unknown>)[k] = input[k];
  }
  if (input.tags !== undefined) v.tags = normalizeTags(input.tags);
  return v;
};

export async function createContact(tx: Tx, ctx: DirCtx, input: CreateContactInput) {
  await assertRefs(tx, input);
  const [row] = await tx
    .insert(directoryContacts)
    .values({ ...contactValues(input), fullName: input.fullName, companyId: ctx.companyId, createdBy: ctx.userId })
    .returning({ id: directoryContacts.id });
  const duplicates = await findDuplicates(tx, { phones: [input.phone, input.phone2], emails: [input.email, input.email2], excludeId: row!.id });
  return { ...(await getContact(tx, row!.id)), duplicates };
}

export async function updateContact(tx: Tx, id: string, input: UpdateContactInput) {
  await assertRefs(tx, input);
  const values = contactValues(input);
  if (Object.keys(values).length === 0) return getContact(tx, id);
  const [row] = await tx.update(directoryContacts).set({ ...values, updatedAt: new Date() }).where(eq(directoryContacts.id, id)).returning({ id: directoryContacts.id });
  if (!row) throw notFound('Kişi');
  const duplicates = await findDuplicates(tx, { phones: [input.phone, input.phone2], emails: [input.email, input.email2], excludeId: id });
  return { ...(await getContact(tx, id)), duplicates };
}

export async function setContactArchived(tx: Tx, id: string, archived: boolean) {
  const [cur] = await tx.select({ anonymizedAt: directoryContacts.anonymizedAt, mergedIntoId: directoryContacts.mergedIntoId }).from(directoryContacts).where(eq(directoryContacts.id, id));
  if (!cur) throw notFound('Kişi');
  if (!archived && (cur.anonymizedAt || cur.mergedIntoId)) throw unprocessable('Anonimleştirilmiş ya da birleştirilmiş kişi yeniden etkinleştirilemez', 'DIRECTORY_CONTACT_FROZEN');
  await tx
    .update(directoryContacts)
    .set({ isArchived: archived, archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(directoryContacts.id, id));
  return getContact(tx, id);
}

const fieldsOf = (r: typeof directoryContacts.$inferSelect): ContactFields => ({
  fullName: r.fullName,
  title: r.title,
  organizationId: r.organizationId,
  phone: r.phone,
  phone2: r.phone2,
  email: r.email,
  email2: r.email2,
  address: r.address,
  partyId: r.partyId,
  employeeId: r.employeeId,
  projectId: r.projectId,
  tags: r.tags,
  note: r.note,
});

/**
 * Birleştirme: `dropId` kişisinin verisi `keepId` kişisine taşınır (boş alanlar dolar, notlar ve ajanda kalemleri yeniden bağlanır),
 * `dropId` arşivlenir ve kişisel alanları temizlenir (veri azaltma); `merged_into_id` iz bırakır. Denetim izine her iki kişi yazılır.
 * İki farklı cariye bağlı kişiler birleştirilmez.
 */
export async function mergeContacts(tx: Tx, keepId: string, dropId: string) {
  if (keepId === dropId) throw unprocessable('Kişi kendisiyle birleştirilemez', 'DIRECTORY_MERGE_SELF');
  const rows = await tx.select().from(directoryContacts).where(sql`${directoryContacts.id} in (${keepId}, ${dropId})`).for('update');
  const keep = rows.find((r) => r.id === keepId);
  const drop = rows.find((r) => r.id === dropId);
  if (!keep || !drop) throw notFound('Kişi');
  for (const r of [keep, drop]) {
    if (r.anonymizedAt || r.mergedIntoId) throw unprocessable('Anonimleştirilmiş ya da zaten birleştirilmiş kişi birleştirilemez', 'DIRECTORY_CONTACT_FROZEN');
  }
  if (keep.partyId && drop.partyId && keep.partyId !== drop.partyId) throw unprocessable('Farklı carilere bağlı kişiler birleştirilemez', 'DIRECTORY_MERGE_CONFLICT');
  if (keep.employeeId && drop.employeeId && keep.employeeId !== drop.employeeId) throw unprocessable('Farklı personele bağlı kişiler birleştirilemez', 'DIRECTORY_MERGE_CONFLICT');
  const { merged, conflicts } = planContactMerge(fieldsOf(keep), fieldsOf(drop));
  // Önce kaynak kişinin cari/personel bağlantısı bırakılır (aynı cariye iki etkin kişi bağlanabilir ama veri tekrarı azaltılır)
  await tx.update(directoryContacts).set({ partyId: null, employeeId: null, updatedAt: new Date() }).where(eq(directoryContacts.id, dropId));
  await tx.update(directoryContacts).set({ ...merged, updatedAt: new Date() }).where(eq(directoryContacts.id, keepId));
  const moved = await tx.execute<{ n: number }>(sql`select directory_repoint_notes(${dropId}::uuid, ${keepId}::uuid) as n`);
  await tx.execute(sql`update agenda_items set contact_id = ${keepId}, updated_at = now() where contact_id = ${dropId}`);
  // Kaynak kişi: arşiv + iz; kişisel alanlar temizlenir (artık hedef kişide)
  // (veritabanı işlevi: "birleştirme" bayrağı yalnızca SECURITY DEFINER işlev içinden geçerlidir)
  await tx.execute(sql`select directory_mark_merged(${dropId}::uuid, ${keepId}::uuid)`);
  return { ...(await getContact(tx, keepId)), movedNotes: Number(moved.rows[0]?.n ?? 0), conflicts };
}

// --- Görüşme notları ---------------------------------------------------------------------------------------

const NOTE_SELECT = sql`
  n.id, n.contact_id as "contactId", c.full_name as "contactName", n.organization_id as "organizationId", o.name as "organizationName",
  n.kind, n.note_date::text as "noteDate", n.summary, n.visibility, n.project_id as "projectId", pr.code as "projectCode",
  n.author_id as "authorId", u.full_name as "authorName", n.cleared_at as "clearedAt", n.edited_at as "editedAt", n.created_at as "createdAt"`;
const NOTE_FROM = sql`
  from directory_notes n
  left join directory_contacts c on c.id = n.contact_id
  left join directory_organizations o on o.id = n.organization_id
  left join projects pr on pr.id = n.project_id
  join users u on u.id = n.author_id`;

/** Notlar RLS görünürlük politikasından geçer: özel notlar yalnızca yazarına görünür. */
export async function listNotes(tx: Tx, q: { contactId?: string; organizationId?: string; projectId?: string }, userId: string) {
  const where: SQL[] = [];
  if (q.contactId) where.push(sql`n.contact_id = ${q.contactId}`);
  if (q.organizationId) where.push(sql`n.organization_id = ${q.organizationId}`);
  if (q.projectId) where.push(sql`n.project_id = ${q.projectId}`);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select ${NOTE_SELECT} ${NOTE_FROM} ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
     order by n.note_date desc, n.created_at desc limit 500`);
  return { notes: rows.rows.map((r): Record<string, unknown> => ({ ...r, mine: r.authorId === userId })) };
}

export async function getNote(tx: Tx, id: string, userId: string) {
  const rows = await tx.execute<Record<string, unknown>>(sql`select ${NOTE_SELECT} ${NOTE_FROM} where n.id = ${id}`);
  const r = rows.rows[0];
  if (!r) throw notFound('Not');
  const note: Record<string, unknown> = { ...r, mine: r.authorId === userId };
  return { note };
}

export async function createNote(tx: Tx, ctx: DirCtx, input: CreateNoteInput) {
  await assertRefs(tx, input);
  if (input.contactId) {
    const [c] = await tx.select({ anonymizedAt: directoryContacts.anonymizedAt, mergedIntoId: directoryContacts.mergedIntoId }).from(directoryContacts).where(eq(directoryContacts.id, input.contactId));
    if (c?.anonymizedAt || c?.mergedIntoId) throw unprocessable('Anonimleştirilmiş ya da birleştirilmiş kişiye not yazılamaz', 'DIRECTORY_CONTACT_FROZEN');
  }
  const [row] = await tx
    .insert(directoryNotes)
    .values({
      companyId: ctx.companyId,
      contactId: input.contactId ?? null,
      organizationId: input.organizationId ?? null,
      kind: input.kind,
      noteDate: input.noteDate,
      summary: input.summary,
      visibility: input.visibility,
      projectId: input.projectId ?? null,
      authorId: ctx.userId,
    })
    .returning({ id: directoryNotes.id });
  return getNote(tx, row!.id, ctx.userId);
}

/** Yalnızca yazarı düzenler (RLS başkasının özel notunu zaten göstermez; veritabanı koruması paylaşılan notu da yazarına kilitler). Geçmiş denetim izindedir. */
export async function updateNote(tx: Tx, ctx: DirCtx, id: string, input: { kind?: string; noteDate?: string; summary?: string; visibility?: string }) {
  const [cur] = await tx.select({ authorId: directoryNotes.authorId, clearedAt: directoryNotes.clearedAt }).from(directoryNotes).where(eq(directoryNotes.id, id));
  if (!cur) throw notFound('Not');
  if (cur.authorId !== ctx.userId) throw unprocessable('Notu yalnızca yazarı düzenleyebilir', 'DIRECTORY_NOTE_NOT_AUTHOR');
  if (cur.clearedAt) throw unprocessable('Temizlenmiş (anonimleştirilmiş) not değiştirilemez', 'DIRECTORY_NOTE_CLEARED');
  const set: Record<string, unknown> = {};
  for (const k of ['kind', 'noteDate', 'summary', 'visibility'] as const) if (input[k] !== undefined) set[k] = input[k];
  await tx.update(directoryNotes).set(set).where(and(eq(directoryNotes.id, id), eq(directoryNotes.authorId, ctx.userId)));
  return getNote(tx, id, ctx.userId);
}

// --- Kişisel veri: ilgili kişi dışa aktarması ve anonimleştirme ------------------------------------------------

/**
 * Rehber kişisinin tüm verisi (ilgili kişi erişim/dışa aktarma talebi). Başkalarının özel notları da dahildir (kişinin kendi verisi);
 * bu yüzden gerekçe zorunludur ve erişim günlüğüne 'directory_export' yazılır. Rehber okuma/not okuma günlüğe yazılmaz (hassas değil).
 */
export async function exportContactData(tx: Tx, ctx: DirCtx, id: string, reason: string) {
  const [c] = await tx.select().from(directoryContacts).where(eq(directoryContacts.id, id));
  if (!c) throw notFound('Kişi');
  await tx.insert(personalDataAccessLog).values({ companyId: ctx.companyId, contactId: id, field: 'directory_export', reason: reason.trim(), userId: ctx.userId });
  const org = c.organizationId ? (await tx.select({ name: directoryOrganizations.name }).from(directoryOrganizations).where(eq(directoryOrganizations.id, c.organizationId)))[0] : undefined;
  const notes = await tx.execute<Record<string, unknown>>(sql`
    select n.id, n.kind, n.note_date::text as "noteDate", n.summary, n.visibility, n.cleared_at as "clearedAt", n.created_at as "createdAt", u.email as "author"
      from directory_subject_notes(${id}::uuid) n join users u on u.id = n.author_id order by n.note_date, n.created_at`);
  const agenda = await tx.execute<Record<string, unknown>>(sql`
    select kind, title, description, due_date::text as "dueDate", status, created_at as "createdAt" from agenda_items where contact_id = ${id} order by due_date`);
  const accessLog = await tx.execute<Record<string, unknown>>(sql`
    select l.field, l.reason, l.created_at as "at", u.email as "by" from personal_data_access_log l join users u on u.id = l.user_id
     where l.contact_id = ${id} order by l.created_at desc`);
  const requests = await tx.execute<Record<string, unknown>>(sql`
    select kind, status, requester_name as "requesterName", description, resolution_note as "resolutionNote", opened_at as "openedAt", resolved_at as "resolvedAt"
      from data_subject_requests where contact_id = ${id} order by opened_at desc`);
  return {
    exportedAt: new Date().toISOString(),
    contact: {
      fullName: c.fullName,
      title: c.title,
      organization: org?.name ?? null,
      phone: c.phone,
      phone2: c.phone2,
      email: c.email,
      email2: c.email2,
      address: c.address,
      tags: c.tags,
      note: c.note,
      isArchived: c.isArchived,
      anonymizedAt: c.anonymizedAt,
      createdAt: c.createdAt,
    },
    notes: notes.rows,
    agenda: agenda.rows,
    accessLog: accessLog.rows,
    requests: requests.rows,
  };
}

/** Açık, gerekçeli ve denetimli anonimleştirme: işlevi çağırır, erişim günlüğüne 'directory_anonymize' yazar. */
export async function anonymizeContact(tx: Tx, ctx: DirCtx, id: string, reason: string) {
  await tx.execute(sql`select directory_anonymize_contact(${id}::uuid, ${reason}::text)`);
  await tx.insert(personalDataAccessLog).values({ companyId: ctx.companyId, contactId: id, field: 'directory_anonymize', reason: reason.trim(), userId: ctx.userId });
  return getContact(tx, id);
}
