import { and, asc, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import {
  hasPermission,
  type ApprovalDocType,
  type CreateApprovalRuleInput,
  type DecideApprovalInput,
  type Role,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { approvalRequests, approvalRuleSteps, approvalRules, approvalSteps } from '../../db/schema';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors';

export interface ApprovalCtx {
  companyId: string;
  userId: string;
  role: Role;
}

type StepSpec = { approverRole: string | null; approverUserId: string | null; label: string | null };

/** Belge tarafı, talep sonuçlandığında aynı işlemde çalışacak işleyiciyi kaydeder (ör. hakediş → yevmiye). */
export type ApprovalOutcome = 'approved' | 'rejected';
export type ApprovalRequestWithSteps = typeof approvalRequests.$inferSelect & { steps: (typeof approvalSteps.$inferSelect)[] };
export interface ApprovalHandler {
  onResolved(tx: Tx, ctx: ApprovalCtx, request: ApprovalRequestWithSteps, outcome: ApprovalOutcome): Promise<void>;
}
const handlers = new Map<ApprovalDocType, ApprovalHandler>();
export function registerApprovalHandler(docType: ApprovalDocType, handler: ApprovalHandler) {
  handlers.set(docType, handler);
}

// --- Kurallar ----------------------------------------------------------------------

export async function listRules(tx: Tx) {
  const rules = await tx.select().from(approvalRules).orderBy(asc(approvalRules.docType), asc(approvalRules.minAmount));
  const steps = await tx.select().from(approvalRuleSteps).orderBy(asc(approvalRuleSteps.stepNo));
  return rules.map((r) => ({ ...r, steps: steps.filter((s) => s.ruleId === r.id) }));
}

/** Belge türünün onay izni (karar ucu ayrıca `subcontracts.read` ister). */
const approvePermission = (docType: string) => (docType === 'purchase_request' ? 'procurement.approve' : 'subcontracts.approve');

/**
 * Adımların onaylayıcıları karar verebilmeli: rol adımında rol, kullanıcı adımında kullanıcının bu şirketteki rolü okuma ve
 * belge türünün onay (ya da yönetim) iznine sahip olmalı; kullanıcı bu şirketin etkin üyesi olmalı. Bulunmayan ve başka şirketin/kuruluşun
 * kullanıcısı aynı yanıtı alır (kullanıcı varlığı sızdırılmaz).
 */
async function assertApprovers(tx: Tx, companyId: string, input: CreateApprovalRuleInput) {
  const perm = approvePermission(input.docType);
  const manage = input.docType === 'purchase_request' ? 'procurement.manage' : 'subcontracts.manage';
  // Karar ucuna erişim (okuma) ve belge türünde onay ya da yönetim yetkisi (ör. şantiye şefi ilk adımı onaylayabilir; salt-okuyucu onaylayamaz)
  const canDecide = (role: string) =>
    hasPermission(role as Role, 'subcontracts.read') && (hasPermission(role as Role, perm) || hasPermission(role as Role, manage));
  for (const [i, s] of input.steps.entries()) {
    if (s.role && !canDecide(s.role)) {
      throw unprocessable(`${i + 1}. adımın rolü bu belge türünü onaylama iznine sahip değil`, 'APPROVER_INVALID', { step: i + 1 });
    }
    if (s.userId) {
      const rows = await tx.execute<{ role: string }>(sql`
        select m.role from memberships m join users u on u.id = m.user_id
         where m.company_id = ${companyId}::uuid and m.user_id = ${s.userId}::uuid and u.is_active`);
      const role = rows.rows[0]?.role;
      if (!role || !canDecide(role)) {
        throw unprocessable(`${i + 1}. adımın kullanıcısı bu şirkette bu belge türünü onaylayabilen etkin bir üye değil`, 'APPROVER_INVALID', { step: i + 1 });
      }
    }
  }
}

export async function createRule(tx: Tx, companyId: string, input: CreateApprovalRuleInput) {
  await assertApprovers(tx, companyId, input);
  const [rule] = await tx
    .insert(approvalRules)
    .values({
      companyId,
      docType: input.docType,
      projectId: input.projectId ?? null,
      minAmount: input.minAmount,
      maxAmount: input.maxAmount ?? null,
      separateRequester: input.separateRequester,
    })
    .returning();
  await tx.insert(approvalRuleSteps).values(
    input.steps.map((s, i) => ({
      companyId,
      ruleId: rule!.id,
      stepNo: i + 1,
      approverRole: s.role ?? null,
      approverUserId: s.userId ?? null,
      label: s.label ?? null,
    })),
  );
  return (await listRules(tx)).find((r) => r.id === rule!.id)!;
}

export async function setRuleActive(tx: Tx, id: string, isActive: boolean) {
  const [row] = await tx.update(approvalRules).set({ isActive }).where(eq(approvalRules.id, id)).returning({ id: approvalRules.id });
  if (!row) throw notFound('Onay kuralı');
}

export async function deleteRule(tx: Tx, id: string) {
  const rows = await tx.delete(approvalRules).where(eq(approvalRules.id, id)).returning({ id: approvalRules.id });
  if (rows.length === 0) throw notFound('Onay kuralı');
}

/**
 * En özgül kural: projeye özel kural genel kuraldan, daha yüksek alt sınır daha düşükten önce gelir.
 * Kural yoksa varsayılan: tek adım, `subcontracts.approve` izni olan herkes, gönderen de onaylayabilir.
 */
export async function resolveRule(tx: Tx, docType: ApprovalDocType, projectId: string | null, amount: string) {
  const [rule] = await tx
    .select()
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.docType, docType),
        eq(approvalRules.isActive, true),
        sql`${approvalRules.minAmount} <= ${amount}::numeric`,
        or(isNull(approvalRules.maxAmount), gte(approvalRules.maxAmount, sql`${amount}::numeric + 0.0001`)),
        projectId ? or(isNull(approvalRules.projectId), eq(approvalRules.projectId, projectId)) : isNull(approvalRules.projectId),
      ),
    )
    .orderBy(sql`${approvalRules.projectId} is null`, desc(approvalRules.minAmount))
    .limit(1);
  if (!rule) {
    return { separateRequester: false, steps: [{ approverRole: null, approverUserId: null, label: 'Onay' }] as StepSpec[] };
  }
  const steps = await tx.select().from(approvalRuleSteps).where(eq(approvalRuleSteps.ruleId, rule.id)).orderBy(asc(approvalRuleSteps.stepNo));
  return {
    separateRequester: rule.separateRequester,
    steps: steps.map((s) => ({ approverRole: s.approverRole, approverUserId: s.approverUserId, label: s.label })),
  };
}

// --- Talep ve karar -------------------------------------------------------------------

export async function requestApproval(
  tx: Tx,
  ctx: ApprovalCtx,
  input: { docType: ApprovalDocType; docId: string; projectId: string | null; amount: string },
) {
  const [pending] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.docType, input.docType), eq(approvalRequests.docId, input.docId), eq(approvalRequests.status, 'pending')));
  if (pending) throw conflict('Bu belge için bekleyen bir onay talebi var', 'APPROVAL_ALREADY_PENDING');

  const resolved = await resolveRule(tx, input.docType, input.projectId, input.amount);
  const [request] = await tx
    .insert(approvalRequests)
    .values({
      companyId: ctx.companyId,
      docType: input.docType,
      docId: input.docId,
      projectId: input.projectId,
      amount: input.amount,
      separateRequester: resolved.separateRequester,
      requestedBy: ctx.userId,
    })
    .returning();
  await tx.insert(approvalSteps).values(resolved.steps.map((s, i) => ({ companyId: ctx.companyId, requestId: request!.id, stepNo: i + 1, ...s })));
  return getRequest(tx, request!.id);
}

export async function getRequest(tx: Tx, id: string) {
  const [request] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  if (!request) throw notFound('Onay talebi');
  const steps = await tx.select().from(approvalSteps).where(eq(approvalSteps.requestId, id)).orderBy(asc(approvalSteps.stepNo));
  return { ...request, steps };
}

export async function requestsForDoc(tx: Tx, docType: ApprovalDocType, docId: string) {
  const rows = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.docType, docType), eq(approvalRequests.docId, docId)))
    .orderBy(desc(approvalRequests.requestedAt));
  return Promise.all(rows.map((r) => getRequest(tx, r.id)));
}

function stepMatches(step: StepSpec, ctx: ApprovalCtx, docType: string): boolean {
  if (step.approverUserId) return step.approverUserId === ctx.userId;
  if (step.approverRole) return step.approverRole === ctx.role;
  // Varsayılan adım: belge türüne göre onaylayıcı izni
  return hasPermission(ctx.role, approvePermission(docType));
}

/** Bekleyen taleplerden sıradaki adımı bu kullanıcı için olanlar. */
export async function pendingForMe(tx: Tx, ctx: ApprovalCtx) {
  const pending = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.status, 'pending')).orderBy(asc(approvalRequests.requestedAt));
  const out = [];
  for (const { id } of pending) {
    const req = await getRequest(tx, id);
    const current = req.steps.find((s) => s.status === 'pending');
    if (current && stepMatches(current, ctx, req.docType) && !(req.separateRequester && req.requestedBy === ctx.userId)) out.push(req);
  }
  return out;
}

export async function decide(tx: Tx, ctx: ApprovalCtx, requestId: string, input: DecideApprovalInput) {
  // Talep satırı kilitlenir: aynı talepte iki eşzamanlı karar sıraya girer
  await tx.execute(sql`select 1 from approval_requests where id = ${requestId} for update`);
  const req = await getRequest(tx, requestId);
  if (req.status !== 'pending') throw unprocessable('Bu talep zaten sonuçlanmış', 'APPROVAL_NOT_PENDING');
  const current = req.steps.find((s) => s.status === 'pending');
  if (!current) throw unprocessable('Bekleyen adım yok', 'APPROVAL_NOT_PENDING');
  if (!stepMatches(current, ctx, req.docType)) throw forbidden('Bu adımı onaylama yetkiniz yok');
  if (req.separateRequester && req.requestedBy === ctx.userId) {
    throw unprocessable('Kendi gönderdiğiniz belgeyi onaylayamazsınız', 'APPROVAL_SELF_DECISION');
  }
  const approve = input.decision === 'approve';
  await tx
    .update(approvalSteps)
    .set({ status: approve ? 'approved' : 'rejected', decidedBy: ctx.userId, decidedAt: new Date(), note: input.note ?? null })
    .where(eq(approvalSteps.id, current.id));

  const remaining = req.steps.filter((s) => s.status === 'pending' && s.id !== current.id).length;
  let outcome: ApprovalOutcome | null = null;
  if (!approve) outcome = 'rejected';
  else if (remaining === 0) outcome = 'approved';
  if (outcome) {
    await tx.update(approvalRequests).set({ status: outcome, completedAt: new Date() }).where(eq(approvalRequests.id, requestId));
    const resolved = await getRequest(tx, requestId);
    await handlers.get(req.docType as ApprovalDocType)?.onResolved(tx, ctx, resolved, outcome);
  }
  return getRequest(tx, requestId);
}

/** Gönderen ya da yönetici talebi geri çeker (belge taslağa döner). */
export async function cancelRequest(tx: Tx, ctx: ApprovalCtx, requestId: string) {
  await tx.execute(sql`select 1 from approval_requests where id = ${requestId} for update`);
  const req = await getRequest(tx, requestId);
  if (req.status !== 'pending') throw unprocessable('Bu talep zaten sonuçlanmış', 'APPROVAL_NOT_PENDING');
  if (req.requestedBy !== ctx.userId && !hasPermission(ctx.role, req.docType === 'purchase_request' ? 'procurement.approve' : 'subcontracts.approve')) throw forbidden('Talebi yalnızca gönderen veya onaylayıcı geri çekebilir');
  await tx.update(approvalRequests).set({ status: 'cancelled', completedAt: new Date() }).where(eq(approvalRequests.id, requestId));
  return getRequest(tx, requestId);
}
