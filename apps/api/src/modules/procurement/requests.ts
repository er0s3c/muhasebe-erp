import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  dec,
  roundMoney,
  toDbAmount,
  type CreatePurchaseRequestInput,
  type UpdatePurchaseRequestInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { items, projectWbs, projects, purchaseRequestLines, purchaseRequests } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { registerApprovalHandler, requestApproval, requestsForDoc, cancelRequest, type ApprovalCtx } from '../approvals/service';
import { nextNumber } from '../settings/numbering';
import { pageSql, paged, type PageQuery } from '../../http/paging';

export interface ProcurementCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
}

export const formatRequestCode = (n: number) => `SAT-${String(n).padStart(4, '0')}`;

export async function lockRequest(tx: Tx, id: string) {
  const [row] = await tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, id)).for('update');
  if (!row) throw notFound('Satın alma talebi');
  return row;
}

/** Satır girdilerini doğrular: stok kartı var, iş kalemi projeye ait. */
export async function validateLineRefs(tx: Tx, projectId: string, lines: readonly { itemId?: string | null; wbsId?: string | null }[]) {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  if (itemIds.length > 0) {
    const found = await tx.select({ id: items.id, active: items.isActive }).from(items).where(inArray(items.id, itemIds));
    if (found.length !== itemIds.length) throw unprocessable('Stok kartlarından biri bulunamadı', 'ITEM_NOT_FOUND');
    if (found.some((f) => !f.active)) throw unprocessable('Pasif bir stok kartı kullanılamaz', 'ITEM_INACTIVE');
  }
  const wbsIds = [...new Set(lines.map((l) => l.wbsId).filter((v): v is string => !!v))];
  if (wbsIds.length > 0) {
    const found = await tx.select({ id: projectWbs.id }).from(projectWbs).where(and(eq(projectWbs.projectId, projectId), inArray(projectWbs.id, wbsIds)));
    if (found.length !== wbsIds.length) throw unprocessable('İş kalemlerinden biri projeye ait değil', 'WBS_NOT_FOUND');
  }
}

async function writeLines(tx: Tx, companyId: string, requestId: string, projectId: string, lines: CreatePurchaseRequestInput['lines']) {
  await tx.delete(purchaseRequestLines).where(eq(purchaseRequestLines.requestId, requestId));
  await tx.insert(purchaseRequestLines).values(
    lines.map((l, i) => ({
      companyId,
      requestId,
      projectId,
      lineNo: i + 1,
      itemId: l.itemId ?? null,
      description: l.description,
      unit: l.unit,
      quantity: toDbAmount(dec(l.quantity)),
      estUnitPrice: l.estUnitPrice != null ? toDbAmount(dec(l.estUnitPrice)) : null,
      wbsId: l.wbsId ?? null,
    })),
  );
}

export async function createRequest(tx: Tx, ctx: ProcurementCtx, input: CreatePurchaseRequestInput) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
  if (!project) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
  if (project.status === 'completed' || project.status === 'cancelled') throw unprocessable('Kapalı projeye talep açılamaz', 'PROJECT_CLOSED');
  await validateLineRefs(tx, input.projectId, input.lines);
  const code = formatRequestCode(await nextNumber(tx, ctx.companyId, 'PURCHASE_REQUEST', 0));
  const [row] = await tx
    .insert(purchaseRequests)
    .values({ companyId: ctx.companyId, code, projectId: input.projectId, title: input.title, needDate: input.needDate ?? null, note: input.note ?? null, requestedBy: ctx.userId })
    .returning();
  await writeLines(tx, ctx.companyId, row!.id, input.projectId, input.lines);
  return getRequest(tx, row!.id);
}

export async function updateRequest(tx: Tx, ctx: ProcurementCtx, id: string, input: UpdatePurchaseRequestInput) {
  const r = await lockRequest(tx, id);
  if (r.status !== 'draft' && r.status !== 'rejected') throw unprocessable('Yalnızca taslak (ya da reddedilmiş) talep düzenlenir', 'REQUEST_NOT_DRAFT');
  await validateLineRefs(tx, r.projectId, input.lines);
  await writeLines(tx, ctx.companyId, id, r.projectId, input.lines);
  await tx
    .update(purchaseRequests)
    .set({ title: input.title, needDate: input.needDate ?? null, note: input.note ?? null, status: 'draft', rejectionNote: null })
    .where(eq(purchaseRequests.id, id));
  return getRequest(tx, id);
}

export async function deleteRequest(tx: Tx, id: string) {
  const r = await lockRequest(tx, id);
  if (r.status !== 'draft' && r.status !== 'cancelled') throw unprocessable('Yalnızca taslak talep silinir', 'REQUEST_NOT_DRAFT');
  // Satır sayısı denetlenir: eşzamanlı ikinci silme 404 alır (API-11)
  const deleted = await tx.delete(purchaseRequests).where(eq(purchaseRequests.id, id)).returning({ id: purchaseRequests.id });
  if (deleted.length === 0) throw notFound('Satın alma talebi');
}

/** Onaya gönderir: tahmini toplam (defter para birimi) onay tutarıdır. */
export async function submitRequest(tx: Tx, _ctx: ProcurementCtx, approvalCtx: ApprovalCtx, id: string) {
  const r = await lockRequest(tx, id);
  if (r.status !== 'draft') throw unprocessable('Yalnızca taslak talep onaya gönderilir', 'REQUEST_NOT_DRAFT');
  const lines = await tx.select().from(purchaseRequestLines).where(eq(purchaseRequestLines.requestId, id));
  if (lines.length === 0) throw unprocessable('Satırsız talep gönderilemez', 'REQUEST_EMPTY');
  const total = lines.reduce((s, l) => s.plus(roundMoney(dec(l.quantity).times(l.estUnitPrice ?? 0))), dec(0));
  await tx.update(purchaseRequests).set({ status: 'submitted', submittedAt: new Date(), rejectionNote: null }).where(eq(purchaseRequests.id, id));
  await requestApproval(tx, approvalCtx, { docType: 'purchase_request', docId: id, projectId: r.projectId, amount: total.toFixed(2) });
  return getRequest(tx, id);
}

export async function withdrawRequest(tx: Tx, approvalCtx: ApprovalCtx, id: string) {
  const r = await lockRequest(tx, id);
  if (r.status !== 'submitted') throw unprocessable('Yalnızca onaydaki talep geri çekilir', 'REQUEST_NOT_SUBMITTED');
  const [pending] = (await requestsForDoc(tx, 'purchase_request', id)).filter((x) => x.status === 'pending');
  if (pending) await cancelRequest(tx, approvalCtx, pending.id);
  await tx.update(purchaseRequests).set({ status: 'draft', submittedAt: null }).where(eq(purchaseRequests.id, id));
  return getRequest(tx, id);
}

export async function cancelPurchaseRequest(tx: Tx, id: string) {
  const r = await lockRequest(tx, id);
  if (!['draft', 'rejected', 'approved'].includes(r.status)) throw unprocessable('Bu durumdaki talep iptal edilemez', 'REQUEST_CANNOT_CANCEL');
  const open = await tx.execute(sql`select 1 from purchase_orders where request_id = ${id} and status in ('draft', 'issued', 'closed') limit 1`);
  if (open.rows.length > 0) throw conflict('Talepten açılmış sipariş var; önce siparişi iptal edin', 'REQUEST_HAS_ORDERS');
  await tx.update(purchaseRequests).set({ status: 'cancelled' }).where(eq(purchaseRequests.id, id));
  return getRequest(tx, id);
}

registerApprovalHandler('purchase_request', {
  async onResolved(tx, _ctx, request, outcome) {
    if (outcome === 'approved') {
      await tx.update(purchaseRequests).set({ status: 'approved' }).where(eq(purchaseRequests.id, request.docId));
      return;
    }
    const note = [...request.steps].reverse().find((s) => s.status === 'rejected')?.note ?? null;
    await tx.update(purchaseRequests).set({ status: 'rejected', rejectionNote: note }).where(eq(purchaseRequests.id, request.docId));
  },
});

export async function getRequest(tx: Tx, id: string) {
  const head = await tx.execute<Record<string, unknown>>(sql`
    select r.id, r.code, r.title, r.status, r.need_date::text as "needDate", r.note, r.rejection_note as "rejectionNote",
           r.project_id as "projectId", p.code as "projectCode", p.name as "projectName", r.created_at as "createdAt", r.submitted_at as "submittedAt"
      from purchase_requests r join projects p on p.id = r.project_id where r.id = ${id}`);
  const request = head.rows[0];
  if (!request) throw notFound('Satın alma talebi');
  const lines = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.line_no as "lineNo", l.item_id as "itemId", i.code as "itemCode", l.description, l.unit,
           l.quantity::text as quantity, l.est_unit_price::text as "estUnitPrice",
           l.wbs_id as "wbsId", w.code as "wbsCode", w.name as "wbsName"
      from purchase_request_lines l
      left join items i on i.id = l.item_id
      left join project_wbs w on w.id = l.wbs_id
     where l.request_id = ${id} order by l.line_no`);
  const total = lines.rows.reduce((s, l) => s.plus(l.estUnitPrice != null ? roundMoney(dec(String(l.quantity)).times(String(l.estUnitPrice))) : 0), dec(0));
  const rfq = await tx.execute<Record<string, unknown>>(sql`select id, code, status from rfqs where request_id = ${id} and status <> 'cancelled'`);
  const orders = await tx.execute<Record<string, unknown>>(sql`select id, code, status from purchase_orders where request_id = ${id} order by created_at`);
  return {
    request: { ...request, estimatedTotal: total.toFixed(2) },
    lines: lines.rows,
    approvals: await requestsForDoc(tx, 'purchase_request', id),
    rfq: rfq.rows[0] ?? null,
    orders: orders.rows,
  };
}

export async function listRequests(tx: Tx, q: { projectId?: string; status?: string }, page?: PageQuery) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select r.id, r.code, r.title, r.status, r.need_date::text as "needDate", r.project_id as "projectId", p.code as "projectCode",
           (select count(*)::int from purchase_request_lines l where l.request_id = r.id) as "lineCount",
           coalesce((select sum(round(l.quantity * l.est_unit_price, 2)) from purchase_request_lines l where l.request_id = r.id), 0)::text as "estimatedTotal",
           r.created_at as "createdAt"
      from purchase_requests r join projects p on p.id = r.project_id
     where (${q.projectId ?? null}::uuid is null or r.project_id = ${q.projectId ?? null}::uuid)
       and (${q.status ?? null}::text is null or r.status = ${q.status ?? null}::text)
     order by r.code desc ${pageSql(page)}`);
  const pg = paged(rows.rows, page);
  return { requests: pg.rows, truncated: pg.truncated };
}

