import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CreateProgressInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { projectProgress, projectWbs } from '../../db/schema';
import { unprocessable } from '../../http/errors';
import { getProjectRow, type ProjectCtx } from './service';

export type LatestProgress = {
  wbsId: string;
  percent: string;
  etcOverride: string | null;
  asOfDate: string;
  note: string | null;
};

/** asOf tarihine (dahil) kadarki her iş kaleminin en son ilerleme kaydı (aynı günde en son girilen geçerli). */
export async function latestProgress(tx: Tx, projectId: string, asOf: string): Promise<Map<string, LatestProgress>> {
  const rows = await tx.execute<LatestProgress>(sql`
    select distinct on (wbs_id)
           wbs_id as "wbsId", percent::text as percent, etc_override::text as "etcOverride",
           as_of_date::text as "asOfDate", note
      from project_progress
     where project_id = ${projectId} and as_of_date <= ${asOf}
     order by wbs_id, as_of_date desc, created_at desc, id desc`);
  return new Map(rows.rows.map((r) => [r.wbsId, r]));
}

export async function recordProgress(tx: Tx, ctx: ProjectCtx, projectId: string, input: CreateProgressInput) {
  const project = await getProjectRow(tx, projectId);
  if (project.status === 'cancelled') throw unprocessable('İptal edilmiş projeye ilerleme girilemez', 'PROJECT_CANCELLED');

  const wbsIds = input.items.map((i) => i.wbsId);
  const found = await tx
    .select({ id: projectWbs.id })
    .from(projectWbs)
    .where(and(eq(projectWbs.projectId, projectId), inArray(projectWbs.id, wbsIds)));
  if (found.length !== wbsIds.length) throw unprocessable('İş kalemlerinden biri bu projeye ait değil', 'WBS_NOT_FOUND');

  await tx.insert(projectProgress).values(
    input.items.map((i) => ({
      companyId: ctx.companyId,
      projectId,
      wbsId: i.wbsId,
      asOfDate: input.asOfDate,
      percent: i.percent,
      etcOverride: i.etcOverride ?? null,
      note: i.note ?? null,
      createdBy: ctx.userId,
    })),
  );
  return progressOverview(tx, projectId, input.asOfDate);
}

/** Verilen tarihteki geçerli ilerleme + son 100 kayıt (geçmiş). */
export async function progressOverview(tx: Tx, projectId: string, asOf: string) {
  await getProjectRow(tx, projectId);
  const latest = [...(await latestProgress(tx, projectId, asOf)).values()];
  const history = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.wbs_id as "wbsId", w.code as "wbsCode", w.name as "wbsName", p.as_of_date::text as "asOfDate",
           p.percent::text as percent, p.etc_override::text as "etcOverride", p.note, p.created_at as "createdAt"
      from project_progress p join project_wbs w on w.id = p.wbs_id
     where p.project_id = ${projectId}
     order by p.as_of_date desc, p.created_at desc, p.id desc
     limit 100`);
  return { asOf, latest, history: history.rows };
}
