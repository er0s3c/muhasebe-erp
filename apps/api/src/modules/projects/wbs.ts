import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CreateWbsInput, UpdateWbsInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { projectWbs } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { getProjectRow } from './service';

export async function getWbsRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(projectWbs).where(eq(projectWbs.id, id));
  if (!row) throw notFound('İş kalemi');
  return row;
}

/** Ağacı derinlik-öncelikli sırayla (kardeşler sortOrder, sonra koda göre) düz liste olarak döndürür. */
export async function listWbs(tx: Tx, projectId: string) {
  await getProjectRow(tx, projectId);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    with recursive t as (
      select w.id, w.parent_id, w.code, w.name, w.sort_order, w.is_active, 1 as depth,
             array[lpad(w.sort_order::text, 6, '0') || '|' || w.code] as path
        from project_wbs w where w.project_id = ${projectId} and w.parent_id is null
      union all
      select w.id, w.parent_id, w.code, w.name, w.sort_order, w.is_active, t.depth + 1,
             t.path || (lpad(w.sort_order::text, 6, '0') || '|' || w.code)
        from project_wbs w join t on w.parent_id = t.id
       where w.project_id = ${projectId}
    )
    select t.id, t.parent_id as "parentId", t.code, t.name, t.sort_order as "sortOrder", t.is_active as "isActive", t.depth,
           not exists (select 1 from project_wbs c where c.parent_id = t.id) as "isLeaf",
           project_wbs_has_postings(t.id) as "hasPostings"
      from t order by t.path`);
  return { wbs: rows.rows };
}

async function assertCodeFree(tx: Tx, projectId: string, code: string, exceptId?: string) {
  const [dup] = await tx
    .select({ id: projectWbs.id })
    .from(projectWbs)
    .where(and(eq(projectWbs.projectId, projectId), eq(projectWbs.code, code)));
  if (dup && dup.id !== exceptId) throw conflict(`"${code}" kodlu iş kalemi bu projede zaten var`, 'WBS_CODE_TAKEN');
}

export async function createWbs(tx: Tx, companyId: string, projectId: string, input: CreateWbsInput) {
  await getProjectRow(tx, projectId);
  await assertCodeFree(tx, projectId, input.code);
  if (input.parentId) {
    const parent = await getWbsRow(tx, input.parentId);
    if (parent.projectId !== projectId) throw unprocessable('Üst iş kalemi bu projeye ait değil', 'WBS_PARENT_INVALID');
  }

  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const siblings = await tx.execute<{ next: number }>(sql`
      select coalesce(max(sort_order) + 10, 0)::int as next from project_wbs
       where project_id = ${projectId} and parent_id is not distinct from ${input.parentId ?? null}::uuid`);
    sortOrder = siblings.rows[0]?.next ?? 0;
  }
  const [row] = await tx
    .insert(projectWbs)
    .values({
      companyId,
      projectId,
      parentId: input.parentId ?? null,
      code: input.code,
      name: input.name,
      sortOrder,
    })
    .returning();
  return row!;
}

export async function updateWbs(tx: Tx, id: string, input: UpdateWbsInput) {
  const current = await getWbsRow(tx, id);
  const values: Partial<typeof projectWbs.$inferInsert> = {};
  if (input.code !== undefined && input.code !== current.code) {
    await assertCodeFree(tx, current.projectId, input.code, id);
    values.code = input.code;
  }
  if (input.name !== undefined) values.name = input.name;
  if (input.sortOrder !== undefined) values.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) values.isActive = input.isActive;
  if (input.parentId !== undefined && input.parentId !== current.parentId) {
    if (input.parentId) {
      const parent = await getWbsRow(tx, input.parentId);
      if (parent.projectId !== current.projectId) throw unprocessable('Üst iş kalemi bu projeye ait değil', 'WBS_PARENT_INVALID');
    }
    values.parentId = input.parentId;
  }
  if (Object.keys(values).length === 0) return current;
  const [row] = await tx.update(projectWbs).set(values).where(eq(projectWbs.id, id)).returning();
  return row!;
}

export async function deleteWbs(tx: Tx, id: string) {
  await getWbsRow(tx, id);
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(projectWbs).where(eq(projectWbs.id, id)).returning({ id: projectWbs.id });
  if (deleted.length === 0) throw notFound('İş kalemi');
}

/** Ağaçta kökler (testler ve raporlar için). */
export async function rootWbs(tx: Tx, projectId: string) {
  return tx.select().from(projectWbs).where(and(eq(projectWbs.projectId, projectId), isNull(projectWbs.parentId)));
}
