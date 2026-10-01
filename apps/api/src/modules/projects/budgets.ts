import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { dec, toDbAmount, type CreateBudgetInput, type PutBudgetLinesInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { projectBudgetLines, projectBudgets, projectWbs } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { getProjectRow, lockProject, type ProjectCtx } from './service';

export async function getBudgetRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(projectBudgets).where(eq(projectBudgets.id, id));
  if (!row) throw notFound('Bütçe revizyonu');
  return row;
}

/** Yürürlükteki bütçe: en yüksek numaralı onaylı revizyon (yoksa null). */
export async function currentBudget(tx: Tx, projectId: string) {
  const rows = await tx
    .select()
    .from(projectBudgets)
    .where(and(eq(projectBudgets.projectId, projectId), eq(projectBudgets.status, 'approved')))
    .orderBy(sql`${projectBudgets.revisionNo} desc`)
    .limit(1);
  return rows[0] ?? null;
}

export async function listBudgets(tx: Tx, projectId: string) {
  await getProjectRow(tx, projectId);
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select b.id, b.revision_no as "revisionNo", b.status, b.title,
           b.approved_at as "approvedAt", b.created_at as "createdAt",
           (select count(*)::int from project_budget_lines l where l.budget_id = b.id) as "lineCount",
           coalesce((select sum(l.amount) from project_budget_lines l where l.budget_id = b.id), 0)::text as total,
           b.id = (select c.id from project_budgets c
                    where c.project_id = b.project_id and c.status = 'approved'
                    order by c.revision_no desc limit 1) as "isCurrent"
      from project_budgets b
     where b.project_id = ${projectId}
     order by b.revision_no desc`);
  return { budgets: rows.rows };
}

export async function getBudget(tx: Tx, id: string) {
  const budget = await getBudgetRow(tx, id);
  const lines = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.wbs_id as "wbsId", w.code as "wbsCode", w.name as "wbsName", l.amount::text as amount
      from project_budget_lines l join project_wbs w on w.id = l.wbs_id
     where l.budget_id = ${id}
     order by w.code`);
  const total = lines.rows.reduce((acc, r) => acc.plus(dec(String(r.amount))), dec(0));
  return { budget: { ...budget, total: total.toFixed(2) }, lines: lines.rows };
}

export async function createBudget(tx: Tx, ctx: ProjectCtx, projectId: string, input: CreateBudgetInput) {
  const project = await lockProject(tx, projectId);
  if (project.status === 'cancelled') throw unprocessable('İptal edilmiş projeye bütçe eklenemez', 'PROJECT_CANCELLED');

  const [draft] = await tx
    .select({ id: projectBudgets.id, revisionNo: projectBudgets.revisionNo })
    .from(projectBudgets)
    .where(and(eq(projectBudgets.projectId, projectId), eq(projectBudgets.status, 'draft')));
  if (draft) {
    throw unprocessable(`Projede zaten taslak bir bütçe revizyonu var (rev. ${draft.revisionNo}); onaylayın ya da silin`, 'BUDGET_DRAFT_EXISTS');
  }

  const [last] = await tx
    .select({ max: sql<number>`coalesce(max(${projectBudgets.revisionNo}), 0)::int` })
    .from(projectBudgets)
    .where(eq(projectBudgets.projectId, projectId));
  const [row] = await tx
    .insert(projectBudgets)
    .values({
      companyId: ctx.companyId,
      projectId,
      revisionNo: (last?.max ?? 0) + 1,
      title: input.title ?? null,
      createdBy: ctx.userId,
    })
    .returning();

  if (input.copyFromCurrent) {
    const current = await currentBudget(tx, projectId);
    if (current) {
      await tx.execute(sql`
        insert into project_budget_lines (id, company_id, budget_id, project_id, wbs_id, amount)
        select gen_random_uuid(), l.company_id, ${row!.id}, l.project_id, l.wbs_id, l.amount
          from project_budget_lines l where l.budget_id = ${current.id}`);
    }
  }
  return row!;
}

/** Taslağın tüm satırlarını verilen listeyle değiştirir (sıfır tutarlı satırlar atlanır). */
export async function putBudgetLines(tx: Tx, companyId: string, budgetId: string, input: PutBudgetLinesInput) {
  const budget = await getBudgetRow(tx, budgetId);
  if (budget.status !== 'draft') {
    throw unprocessable('Yalnızca taslak bütçe revizyonu düzenlenebilir; yeni revizyon açın', 'BUDGET_NOT_DRAFT');
  }

  const wbsIds = [...new Set(input.lines.map((l) => l.wbsId))];
  if (wbsIds.length > 0) {
    const found = await tx
      .select({ id: projectWbs.id })
      .from(projectWbs)
      .where(and(eq(projectWbs.projectId, budget.projectId), inArray(projectWbs.id, wbsIds)));
    if (found.length !== wbsIds.length) {
      throw unprocessable('İş kalemlerinden biri bu projeye ait değil', 'WBS_NOT_FOUND');
    }
  }

  await tx.delete(projectBudgetLines).where(eq(projectBudgetLines.budgetId, budgetId));
  const rows = input.lines
    .filter((l) => dec(l.amount).gt(0))
    .map((l) => ({
      companyId,
      budgetId,
      projectId: budget.projectId,
      wbsId: l.wbsId,
      amount: toDbAmount(dec(l.amount)),
    }));
  if (rows.length > 0) await tx.insert(projectBudgetLines).values(rows);
  return getBudget(tx, budgetId);
}

/**
 * Taslağı onaylar; yürürlükteki revizyon olur, önceki onaylı revizyon `superseded` olur.
 * Proje satırı kilitlenir: iki eşzamanlı onay tek yürürlükteki revizyon bırakır.
 */
export async function approveBudget(tx: Tx, ctx: ProjectCtx, budgetId: string) {
  const budget = await getBudgetRow(tx, budgetId);
  await lockProject(tx, budget.projectId);
  // Kilit sonrası durumu yeniden oku (yarışı kaybeden onaylanmış bulur)
  const fresh = await getBudgetRow(tx, budgetId);
  if (fresh.status !== 'draft') {
    throw unprocessable('Yalnızca taslak bütçe revizyonu onaylanabilir', 'BUDGET_NOT_DRAFT');
  }
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(projectBudgetLines)
    .where(eq(projectBudgetLines.budgetId, budgetId));
  if (!count || count.n === 0) throw unprocessable('Boş bütçe onaylanamaz; en az bir iş kalemi tutarı girin', 'BUDGET_EMPTY');

  await tx
    .update(projectBudgets)
    .set({ status: 'approved', approvedAt: new Date(), approvedBy: ctx.userId })
    .where(eq(projectBudgets.id, budgetId));
  await tx
    .update(projectBudgets)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(projectBudgets.projectId, budget.projectId),
        eq(projectBudgets.status, 'approved'),
        lt(projectBudgets.revisionNo, budget.revisionNo),
      ),
    );
  return getBudget(tx, budgetId);
}

export async function deleteBudget(tx: Tx, budgetId: string) {
  const budget = await getBudgetRow(tx, budgetId);
  if (budget.status !== 'draft') {
    throw unprocessable('Onaylanmış bütçe revizyonu silinemez', 'BUDGET_NOT_DRAFT');
  }
  await tx.delete(projectBudgets).where(eq(projectBudgets.id, budgetId));
}
