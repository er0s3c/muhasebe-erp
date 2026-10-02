import { eq, sql } from 'drizzle-orm';
import type { CreateGuaranteeInput, GuaranteeStatus } from '@erp/shared';
import type { Tx } from '../../db/client';
import { employees, foreignWorkerDocs, foreignWorkerGuarantees } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { resolveParamAt, type ForeignCtx } from './params';

/**
 * Teminat tutarı İSTEKTEN ALINMAZ: yatırma tarihinde geçerli, açık ve en yeni `guarantee_amount` parametresinden anlık görüntü
 * alınır. Parametre yoksa ya da kapalıysa kayıt açılamaz (varsayılan tutar yoktur). Kasa/yevmiye bağlantısı yoktur: yalnızca takip.
 */
export async function createGuarantee(tx: Tx, ctx: ForeignCtx, input: CreateGuaranteeInput) {
  const [emp] = await tx.select({ id: employees.id, projectId: employees.projectId }).from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');
  if (input.docId) {
    const [doc] = await tx.select({ employeeId: foreignWorkerDocs.employeeId }).from(foreignWorkerDocs).where(eq(foreignWorkerDocs.id, input.docId));
    if (!doc || doc.employeeId !== input.employeeId) throw unprocessable('Bağlı belge bu personele ait değil', 'FOREIGN_DOC_MISMATCH');
  }
  const p = await resolveParamAt(tx, 'guarantee_amount', input.depositedDate);
  if (!p || !p.currency) throw unprocessable('Yatırma tarihinde geçerli ve açık bir teminat tutarı parametresi yok; önce ayarlardan tarihli parametre girin', 'GUARANTEE_PARAM_MISSING');
  const [row] = await tx
    .insert(foreignWorkerGuarantees)
    .values({
      companyId: ctx.companyId,
      employeeId: input.employeeId,
      docId: input.docId ?? null,
      paramId: p.id,
      projectId: emp.projectId,
      amount: p.value,
      currency: p.currency,
      paramVerified: !!p.verifiedAt,
      depositedDate: input.depositedDate,
      depositReference: input.depositReference?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning();
  return (await getGuarantee(tx, row!.id))!;
}

const COLS = sql`g.id, g.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", g.doc_id as "docId",
  g.project_id as "projectId", p.code as "projectCode", p.name as "projectName", g.amount::text as amount, g.currency,
  g.param_verified as "paramVerified", g.deposited_date::text as "depositedDate", g.deposit_reference as "depositReference",
  g.status, g.resolved_date::text as "resolvedDate", g.resolution_note as "resolutionNote"`;

export type GuaranteeView = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  docId: string | null;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  amount: string;
  currency: string;
  paramVerified: boolean;
  depositedDate: string;
  depositReference: string | null;
  status: GuaranteeStatus;
  resolvedDate: string | null;
  resolutionNote: string | null;
};

export async function listGuarantees(tx: Tx, q: { employeeId?: string; projectId?: string; status?: string }) {
  const res = await tx.execute<GuaranteeView>(sql`
    select ${COLS} from foreign_worker_guarantees g
      join employees e on e.id = g.employee_id and e.company_id = g.company_id
      left join projects p on p.id = g.project_id
     where true ${q.employeeId ? sql`and g.employee_id = ${q.employeeId}` : sql``} ${q.projectId ? sql`and g.project_id = ${q.projectId}` : sql``}
       ${q.status ? sql`and g.status = ${q.status}` : sql``}
     order by e.code, g.deposited_date desc`);
  return { guarantees: res.rows };
}

async function getGuarantee(tx: Tx, id: string) {
  const res = await tx.execute<GuaranteeView>(sql`
    select ${COLS} from foreign_worker_guarantees g
      join employees e on e.id = g.employee_id and e.company_id = g.company_id
      left join projects p on p.id = g.project_id where g.id = ${id}`);
  return res.rows[0] ?? null;
}

export async function resolveGuarantee(tx: Tx, id: string, input: { status: 'refunded' | 'forfeited'; resolvedDate: string; note?: string | null }) {
  const [cur] = await tx.select().from(foreignWorkerGuarantees).where(eq(foreignWorkerGuarantees.id, id)).for('update');
  if (!cur) throw notFound('Teminat');
  if (cur.status !== 'held') throw unprocessable('Teminat zaten sonuçlanmış', 'GUARANTEE_ALREADY_RESOLVED');
  if (input.resolvedDate < cur.depositedDate) throw unprocessable('İade/irat tarihi yatırma tarihinden önce olamaz', 'GUARANTEE_DATES');
  await tx
    .update(foreignWorkerGuarantees)
    .set({ status: input.status, resolvedDate: input.resolvedDate, resolutionNote: input.note?.trim() || null, updatedAt: new Date() })
    .where(eq(foreignWorkerGuarantees.id, id));
  return (await getGuarantee(tx, id))!;
}

export async function deleteGuarantee(tx: Tx, id: string) {
  const rows = await tx.delete(foreignWorkerGuarantees).where(eq(foreignWorkerGuarantees.id, id)).returning({ id: foreignWorkerGuarantees.id });
  if (rows.length === 0) throw notFound('Teminat');
}

/**
 * Tutulan (iade/irat edilmemiş) teminat raporu: personel ve projeye göre, para birimi ayrı (kur çevrimi yok). Proje, kayıt anındaki
 * personel proje etiketidir. Doğrulanmamış parametreden gelen tutarlar ayrıca sayılır.
 */
export async function guaranteeReport(tx: Tx, q: { projectId?: string }) {
  const where = q.projectId ? sql`and g.project_id = ${q.projectId}` : sql``;
  const byEmployee = await tx.execute<Record<string, unknown>>(sql`
    select g.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", g.project_id as "projectId", p.code as "projectCode", p.name as "projectName",
           g.currency, count(*)::int as count, sum(g.amount)::numeric(19,2)::text as amount, count(*) filter (where not g.param_verified)::int as unverified
      from foreign_worker_guarantees g join employees e on e.id = g.employee_id and e.company_id = g.company_id left join projects p on p.id = g.project_id
     where g.status = 'held' ${where} group by g.employee_id, e.code, e.full_name, g.project_id, p.code, p.name, g.currency order by e.code, g.currency`);
  const byProject = await tx.execute<Record<string, unknown>>(sql`
    select g.project_id as "projectId", p.code as "projectCode", p.name as "projectName", g.currency, count(distinct g.employee_id)::int as employees, count(*)::int as count,
           sum(g.amount)::numeric(19,2)::text as amount, count(*) filter (where not g.param_verified)::int as unverified
      from foreign_worker_guarantees g left join projects p on p.id = g.project_id
     where g.status = 'held' ${where} group by g.project_id, p.code, p.name, g.currency order by p.code nulls last, g.currency`);
  const totals = await tx.execute<{ currency: string; held: string; refunded: string; forfeited: string }>(sql`
    select g.currency, coalesce(sum(g.amount) filter (where g.status = 'held'), 0)::numeric(19,2)::text as held,
           coalesce(sum(g.amount) filter (where g.status = 'refunded'), 0)::numeric(19,2)::text as refunded,
           coalesce(sum(g.amount) filter (where g.status = 'forfeited'), 0)::numeric(19,2)::text as forfeited
      from foreign_worker_guarantees g where true ${where} group by g.currency order by g.currency`);
  return { byEmployee: byEmployee.rows, byProject: byProject.rows, totals: totals.rows, unverified: byEmployee.rows.some((r) => Number(r.unverified) > 0) };
}
