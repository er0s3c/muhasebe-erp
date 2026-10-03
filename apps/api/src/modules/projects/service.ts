import { and, eq, sql } from 'drizzle-orm';
import {
  PROJECT_TRANSITIONS,
  type CreateProjectInput,
  type ProjectListQuery,
  type ProjectStatus,
  type UpdateProjectInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { parties, projects } from '../../db/schema';
import { TR, trContains } from '../../db/search';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { nextNumber } from '../settings/numbering';

export interface ProjectCtx {
  companyId: string;
  userId: string;
}

const PROJECT_NUMBER_KEY = 'PROJECT';

export const formatProjectCode = (n: number) => `PRJ-${String(n).padStart(4, '0')}`;

export async function getProjectRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(projects).where(eq(projects.id, id));
  if (!row) throw notFound('Proje');
  return row;
}

/** Projeyi kilitleyerek okur (bütçe revizyonu ve onay gibi proje genelinde serileşmesi gereken işlemler). */
export async function lockProject(tx: Tx, id: string) {
  const [row] = await tx.select().from(projects).where(eq(projects.id, id)).for('update');
  if (!row) throw notFound('Proje');
  return row;
}

/** İşveren: aktif, müşteri ya da hem müşteri hem tedarikçi türünde cari. */
async function requireClient(tx: Tx, partyId: string) {
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw unprocessable('İşveren cari bulunamadı', 'PARTY_NOT_FOUND');
  if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
  if (party.kind === 'supplier') {
    throw unprocessable('İşveren, müşteri türünde bir cari olmalı (tedarikçi seçilemez)', 'PROJECT_CLIENT_KIND');
  }
  return party;
}

export async function listProjects(tx: Tx, q: ProjectListQuery) {
  const conds = [sql`true`];
  if (q.status) conds.push(sql`p.status = ${q.status}`);
  if (q.kind) conds.push(sql`p.kind = ${q.kind}`);
  if (q.q) conds.push(trContains(['p.code', 'p.name', "coalesce(c.name, '')"], q.q));
  const where = sql.join(conds, sql` and `);

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.code, p.name, p.kind, p.status, p.client_party_id as "clientPartyId", c.name as "clientName",
           p.start_date::text as "startDate", p.end_date::text as "endDate", p.location,
           (select count(*)::int from project_wbs w where w.project_id = p.id) as "wbsCount"
    from projects p left join parties c on c.id = p.client_party_id
    where ${where}
    order by case p.status when 'active' then 0 when 'planned' then 1 when 'on_hold' then 2 when 'completed' then 3 else 4 end,
             p.code collate ${TR}
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from projects p left join parties c on c.id = p.client_party_id where ${where}`);
  return { projects: rows.rows, total: total.rows[0]?.n ?? 0 };
}

export async function getProject(tx: Tx, id: string) {
  const row = await getProjectRow(tx, id);
  const extra = await tx.execute<Record<string, unknown>>(sql`
    select c.code as "clientCode", c.name as "clientName",
           (select count(*)::int from project_wbs w where w.project_id = ${id}) as "wbsCount",
           (select count(*)::int from project_budgets b where b.project_id = ${id}) as "budgetCount",
           project_has_postings(${id}) as "hasPostings"
    from projects p left join parties c on c.id = p.client_party_id
    where p.id = ${id}`);
  return { ...row, ...(extra.rows[0] ?? {}) };
}

export async function createProject(tx: Tx, ctx: ProjectCtx, input: CreateProjectInput) {
  if (input.clientPartyId) await requireClient(tx, input.clientPartyId);

  let code = input.code;
  if (code) {
    const [dup] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, code));
    if (dup) throw conflict(`"${code}" kodlu proje zaten var`, 'PROJECT_CODE_TAKEN');
  } else {
    // Elle girilmiş bir kodla çakışmayan ilk numara (boşluk bırakmayan sayaç ilerler)
    for (let i = 0; i < 25; i++) {
      const candidate = formatProjectCode(await nextNumber(tx, ctx.companyId, PROJECT_NUMBER_KEY, 0));
      const [dup] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, candidate));
      if (!dup) {
        code = candidate;
        break;
      }
    }
    if (!code) throw conflict('Proje kodu üretilemedi; kodu elle girin', 'PROJECT_CODE_TAKEN');
  }

  const [row] = await tx
    .insert(projects)
    .values({
      companyId: ctx.companyId,
      code,
      name: input.name,
      kind: input.kind,
      clientPartyId: input.clientPartyId ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      location: input.location ?? null,
      description: input.description ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

export async function updateProject(tx: Tx, id: string, input: UpdateProjectInput) {
  const current = await getProjectRow(tx, id);
  const values: Partial<typeof projects.$inferInsert> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.location !== undefined) values.location = input.location;
  if (input.description !== undefined) values.description = input.description;
  if (input.startDate !== undefined) values.startDate = input.startDate;
  if (input.endDate !== undefined) values.endDate = input.endDate;
  if (input.clientPartyId !== undefined) {
    if (current.kind === 'own' && input.clientPartyId) {
      throw unprocessable('Kendi projenizde işveren olmaz', 'PROJECT_CLIENT_NOT_ALLOWED');
    }
    if (current.kind === 'contract') {
      if (!input.clientPartyId) throw unprocessable('İşverene yapılan işte işveren (cari) zorunlu', 'PROJECT_CLIENT_REQUIRED');
      if (input.clientPartyId !== current.clientPartyId) await requireClient(tx, input.clientPartyId);
    }
    values.clientPartyId = input.clientPartyId;
  }
  const start = values.startDate !== undefined ? values.startDate : current.startDate;
  const end = values.endDate !== undefined ? values.endDate : current.endDate;
  if (start && end && end < start) throw unprocessable('Bitiş tarihi başlangıçtan önce olamaz', 'PROJECT_DATES_INVALID');
  if (Object.keys(values).length === 0) return current;
  values.updatedAt = new Date();
  const [row] = await tx.update(projects).set(values).where(eq(projects.id, id)).returning();
  return row!;
}

export async function setProjectStatus(tx: Tx, id: string, status: ProjectStatus) {
  const current = await lockProject(tx, id);
  if (current.status === status) return current;
  const allowed = PROJECT_TRANSITIONS[current.status as ProjectStatus] ?? [];
  if (!allowed.includes(status)) {
    throw unprocessable(`Proje durumu "${current.status}" iken "${status}" yapılamaz`, 'PROJECT_STATUS_INVALID');
  }
  if (status === 'cancelled') {
    const used = await tx.execute<{ used: boolean }>(sql`select project_has_postings(${id}) as used`);
    if (used.rows[0]?.used) {
      throw unprocessable('Maliyet kaydı olan proje iptal edilemez; tamamlandı olarak işaretleyin', 'PROJECT_HAS_POSTINGS');
    }
  }
  const [row] = await tx
    .update(projects)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(projects.id, id)))
    .returning();
  return row!;
}

export async function deleteProject(tx: Tx, id: string) {
  // Satır kilitlenir: eşzamanlı silmeler sıraya girer, ikincisi 404 alır (API-11)
  const [locked] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).for('update');
  if (!locked) throw notFound('Proje');
  const used = await tx.execute<{ used: boolean }>(sql`select project_has_postings(${id}) as used`);
  if (used.rows[0]?.used) {
    throw unprocessable('Maliyet kaydı olan proje silinemez; tamamlandı olarak işaretleyin', 'PROJECT_HAS_POSTINGS');
  }
  const structure = await tx.execute<{ n: number }>(sql`
    select ((select count(*) from project_wbs where project_id = ${id}) + (select count(*) from project_budgets where project_id = ${id}))::int as n`);
  if ((structure.rows[0]?.n ?? 0) > 0) {
    throw unprocessable('İş kalemi veya bütçesi olan proje silinemez; iptal edin', 'PROJECT_HAS_STRUCTURE');
  }
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
  if (deleted.length === 0) throw notFound('Proje');
}
