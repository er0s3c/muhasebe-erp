import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import {
  hasPermission,
  roleDefaultPermissions,
  type ApprovalDocType,
  type CreateApprovalRuleInput,
  type DecideApprovalInput,
  type PermissionSet,
  type Role,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import {
  approvalDelegations,
  approvalRequests,
  approvalRuleSteps,
  approvalRules,
  approvalSteps,
  memberships,
  users,
} from '../../db/schema';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors';
import {
  approvalPermission,
  approvalReadPermission,
  approvalManagePermission,
  isGeneralApprovalType,
} from './document-policy';
import { loadMemberAccess } from '../access/effective';

export interface ApprovalCtx {
  companyId: string;
  userId: string;
  role: Role;
  /** Etkin izinler (rol + kullanıcı bazlı modül erişimi): karar yetkisi bunlarla sınanır, yalnızca rol eşleşmesi yetmez. */
  permissions: PermissionSet;
}

type StepSpec = {
  approverRole: string | null;
  approverUserId: string | null;
  label: string | null;
};

/** Belge tarafı, talep sonuçlandığında aynı işlemde çalışacak işleyiciyi kaydeder (ör. hakediş → yevmiye). */
export type ApprovalOutcome = 'approved' | 'rejected';
export type ApprovalRequestWithSteps = typeof approvalRequests.$inferSelect & {
  steps: (typeof approvalSteps.$inferSelect)[];
};
export interface ApprovalHandler {
  onResolved(
    tx: Tx,
    ctx: ApprovalCtx,
    request: ApprovalRequestWithSteps,
    outcome: ApprovalOutcome,
  ): Promise<void>;
  beforeDecision?(
    tx: Tx,
    ctx: ApprovalCtx,
    request: ApprovalRequestWithSteps,
    input: DecideApprovalInput,
  ): Promise<void>;
  onCancelled?(tx: Tx, ctx: ApprovalCtx, request: ApprovalRequestWithSteps): Promise<void>;
}
const handlers = new Map<ApprovalDocType, ApprovalHandler>();
export function registerApprovalHandler(docType: ApprovalDocType, handler: ApprovalHandler) {
  handlers.set(docType, handler);
}

// --- Kurallar ----------------------------------------------------------------------

export async function listRules(tx: Tx) {
  const rules = await tx
    .select()
    .from(approvalRules)
    .orderBy(asc(approvalRules.docType), asc(approvalRules.minAmount));
  const steps = await tx.select().from(approvalRuleSteps).orderBy(asc(approvalRuleSteps.stepNo));
  return rules.map((r) => ({ ...r, steps: steps.filter((s) => s.ruleId === r.id) }));
}

/** Belge türünün onay izni (karar ucu ayrıca `subcontracts.read` ister). */
const approvePermission = approvalPermission;

/**
 * Adımların onaylayıcıları karar verebilmeli: rol adımında rol, kullanıcı adımında kullanıcının bu şirketteki rolü okuma ve
 * belge türünün onay (ya da yönetim) iznine sahip olmalı; kullanıcı bu şirketin etkin üyesi olmalı. Bulunmayan ve başka şirketin/kuruluşun
 * kullanıcısı aynı yanıtı alır (kullanıcı varlığı sızdırılmaz).
 */
async function assertApprovers(tx: Tx, companyId: string, input: CreateApprovalRuleInput) {
  const perm = approvePermission(input.docType);
  const manage = approvalManagePermission(input.docType);
  // Karar ucuna erişim (okuma) ve belge türünde onay ya da yönetim yetkisi (ör. şantiye şefi ilk adımı onaylayabilir; salt-okuyucu onaylayamaz)
  // Kural kurulumunda rol şablonuna bakılır (kullanıcı istisnası başkasına görünmez); çalışma anında etkin izin ayrıca sınanır (stepMatches)
  const canDecide = (role: string) => {
    const p = roleDefaultPermissions(role as Role);
    return (
      hasPermission(p, approvalReadPermission(input.docType)) &&
      (hasPermission(p, perm) ||
        (!isGeneralApprovalType(input.docType) && hasPermission(p, manage)))
    );
  };
  if (input.escalateRole && !canDecide(input.escalateRole)) {
    throw unprocessable('Yönlendirme rolü bu belge türünü onaylama iznine sahip değil', 'APPROVER_INVALID', { step: 'escalation' });
  }
  for (const [i, s] of input.steps.entries()) {
    if (s.role && !canDecide(s.role)) {
      throw unprocessable(
        `${i + 1}. adımın rolü bu belge türünü onaylama iznine sahip değil`,
        'APPROVER_INVALID',
        { step: i + 1 },
      );
    }
    if (s.userId) {
      const rows = await tx.execute<{ role: string }>(sql`
        select m.role from memberships m join users u on u.id = m.user_id
         where m.company_id = ${companyId}::uuid and m.user_id = ${s.userId}::uuid and u.is_active`);
      const role = rows.rows[0]?.role;
      const access = role ? await loadMemberAccess(tx, companyId, s.userId, role as Role) : null;
      if (
        !role ||
        !access ||
        !hasPermission(access.permissions, approvalReadPermission(input.docType)) ||
        (!hasPermission(access.permissions, perm) &&
          (isGeneralApprovalType(input.docType) || !hasPermission(access.permissions, manage)))
      ) {
        throw unprocessable(
          `${i + 1}. adımın kullanıcısı bu şirkette bu belge türünü onaylayabilen etkin bir üye değil`,
          'APPROVER_INVALID',
          { step: i + 1 },
        );
      }
    }
  }
}

export async function createRule(tx: Tx, companyId: string, input: CreateApprovalRuleInput) {
  if (input.docType === 'sales_quote' && input.projectId)
    throw unprocessable(
      'Satış teklifinde proje alanı yok; şirket genelinde bir onay kuralı tanımlayın.',
      'APPROVAL_PROJECT_UNSUPPORTED',
    );
  if (isGeneralApprovalType(input.docType) && !input.separateRequester)
    throw unprocessable(
      'Mali belge onayında gönderen ve onaylayan ayrı olmalıdır',
      'APPROVAL_SEPARATE_REQUESTER_REQUIRED',
    );
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
      dueHours: input.dueHours ?? null,
      escalateRole: input.escalateRole ?? null,
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
  const [row] = await tx
    .update(approvalRules)
    .set({ isActive })
    .where(eq(approvalRules.id, id))
    .returning({ id: approvalRules.id });
  if (!row) throw notFound('Onay kuralı');
}

export async function deleteRule(tx: Tx, id: string) {
  const rows = await tx
    .delete(approvalRules)
    .where(eq(approvalRules.id, id))
    .returning({ id: approvalRules.id });
  if (rows.length === 0) throw notFound('Onay kuralı');
}

/**
 * En özgül kural: projeye özel kural genel kuraldan, daha yüksek alt sınır daha düşükten önce gelir.
 * Kural yoksa varsayılan: tek adım, `subcontracts.approve` izni olan herkes, gönderen de onaylayabilir.
 */
export async function resolveRule(
  tx: Tx,
  docType: ApprovalDocType,
  projectId: string | null,
  amount: string,
) {
  const [rule] = await tx
    .select()
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.docType, docType),
        eq(approvalRules.isActive, true),
        sql`${approvalRules.minAmount} <= ${amount}::numeric`,
        or(
          isNull(approvalRules.maxAmount),
          gte(approvalRules.maxAmount, sql`${amount}::numeric + 0.0001`),
        ),
        projectId
          ? or(isNull(approvalRules.projectId), eq(approvalRules.projectId, projectId))
          : isNull(approvalRules.projectId),
      ),
    )
    .orderBy(sql`${approvalRules.projectId} is null`, desc(approvalRules.minAmount))
    .limit(1);
  if (!rule) {
    return {
      ruleId: null,
      separateRequester: isGeneralApprovalType(docType),
      dueHours: null,
      escalateRole: null,
      steps: [{ approverRole: null, approverUserId: null, label: 'Onay' }] as StepSpec[],
    };
  }
  const steps = await tx
    .select()
    .from(approvalRuleSteps)
    .where(eq(approvalRuleSteps.ruleId, rule.id))
    .orderBy(asc(approvalRuleSteps.stepNo));
  return {
    ruleId: rule.id,
    separateRequester: rule.separateRequester,
    dueHours: rule.dueHours,
    escalateRole: rule.escalateRole,
    steps: steps.map((s) => ({
      approverRole: s.approverRole,
      approverUserId: s.approverUserId,
      label: s.label,
    })),
  };
}

// --- Talep ve karar -------------------------------------------------------------------

export async function requestApproval(
  tx: Tx,
  ctx: ApprovalCtx,
  input: {
    docType: ApprovalDocType;
    docId: string;
    projectId: string | null;
    amount: string;
    branchId?: string | null;
    payloadHash?: string;
    documentSnapshot?: Record<string, unknown>;
  },
) {
  const [pending] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.docType, input.docType),
        eq(approvalRequests.docId, input.docId),
        eq(approvalRequests.status, 'pending'),
      ),
    );
  if (pending)
    throw conflict('Bu belge için bekleyen bir onay talebi var', 'APPROVAL_ALREADY_PENDING');

  const resolved = await resolveRule(tx, input.docType, input.projectId, input.amount);
  const [request] = await tx
    .insert(approvalRequests)
    .values({
      companyId: ctx.companyId,
      docType: input.docType,
      docId: input.docId,
      projectId: input.projectId,
      amount: input.amount,
      branchId: input.branchId ?? null,
      payloadHash: input.payloadHash ?? null,
      documentSnapshot: input.documentSnapshot ?? null,
      separateRequester: resolved.separateRequester,
      dueHours: resolved.dueHours,
      escalateRole: resolved.escalateRole,
      requestedBy: ctx.userId,
    })
    .returning();
  await tx.insert(approvalSteps).values(
    resolved.steps.map((s, i) => ({
      companyId: ctx.companyId,
      requestId: request!.id,
      stepNo: i + 1,
      ...s,
    })),
  );
  return getRequest(tx, request!.id);
}

export async function getRequest(tx: Tx, id: string) {
  const [request] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  if (!request) throw notFound('Onay talebi');
  const steps = await tx
    .select()
    .from(approvalSteps)
    .where(eq(approvalSteps.requestId, id))
    .orderBy(asc(approvalSteps.stepNo));
  const due = currentStepDue({ ...request, steps });
  return { ...request, steps, dueAt: due?.toISOString() ?? null, overdue: !!due && due.getTime() <= Date.now() };
}

/**
 * Geçerli adımın karar süresi (öneri 99): önceki adımın karar anından, ilk adımda gönderimden itibaren `dueHours` saat.
 * Süresiz kuralda ve sonuçlanmış talepte null.
 */
export function currentStepDue(request: Pick<typeof approvalRequests.$inferSelect, 'status' | 'dueHours' | 'requestedAt'> & { steps: (typeof approvalSteps.$inferSelect)[] }): Date | null {
  if (request.status !== 'pending' || !request.dueHours) return null;
  const decided = request.steps.filter((s) => s.decidedAt).map((s) => s.decidedAt!.getTime());
  const from = decided.length ? Math.max(...decided) : request.requestedAt.getTime();
  return new Date(from + request.dueHours * 3_600_000);
}

/** Adım kendisine atanmış olan ya da süre dolduğunda yönlendirme rolüyle karar verebilen üye. */
function canActOnStep(request: ApprovalRequestWithSteps, step: StepSpec, ctx: ApprovalCtx): boolean {
  if (stepMatches(step, ctx, request.docType)) return true;
  const due = currentStepDue(request);
  return !!request.escalateRole && !!due && due.getTime() <= Date.now() && request.escalateRole === ctx.role &&
    hasPermission(ctx.permissions, approvePermission(request.docType));
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
  // Rol/kullanıcı eşleşmesi yetmez: belge türünde etkin onay (ya da yönetim) izni de gerekir; modülü "Erişim yok"/"Sadece görüntüle" yapılan üye karar veremez
  const manage = approvalManagePermission(docType);
  const mayDecide =
    hasPermission(ctx.permissions, approvePermission(docType)) ||
    (!isGeneralApprovalType(docType) && hasPermission(ctx.permissions, manage));
  if (step.approverUserId) return step.approverUserId === ctx.userId && mayDecide;
  if (step.approverRole) return step.approverRole === ctx.role && mayDecide;
  // Varsayılan adım: belge türüne göre onaylayıcı izni
  return hasPermission(ctx.permissions, approvePermission(docType));
}

export function canDecideRequest(request: ApprovalRequestWithSteps, ctx: ApprovalCtx, delegations: readonly ActiveDelegation[] = []): boolean {
  const current = request.steps.find((step) => step.status === 'pending');
  if (request.status !== 'pending' || !current || !hasPermission(ctx.permissions, approvalReadPermission(request.docType))) return false;
  if (request.separateRequester && request.requestedBy === ctx.userId) return false;
  return canActOnStep(request, current, ctx) || !!delegationFor(request, current, ctx, delegations);
}

// --- Vekâlet (öneri 98) --------------------------------------------------------------

/** Kullanıcıya şu an geçerli olan vekâlet: asıl onaylayıcının GÜNCEL rolü ve izinleriyle (yetkisini kaybeden vekâlet veremez). */
export interface ActiveDelegation {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegatorRole: Role;
  delegatorPermissions: PermissionSet;
  docTypes: readonly string[];
  maxAmount: string | null;
}

/** Süresi içinde, geri alınmamış ve asıl onaylayıcısı hâlâ etkin üye olan vekâletler. */
export async function activeDelegations(tx: Tx, ctx: Pick<ApprovalCtx, 'companyId' | 'userId'>): Promise<ActiveDelegation[]> {
  const now = new Date();
  const rows = await tx
    .select({
      id: approvalDelegations.id, delegatorId: approvalDelegations.delegatorUserId, delegatorName: users.fullName, role: memberships.role,
      docTypes: approvalDelegations.docTypes, maxAmount: approvalDelegations.maxAmount,
    })
    .from(approvalDelegations)
    .innerJoin(memberships, and(eq(memberships.companyId, approvalDelegations.companyId), eq(memberships.userId, approvalDelegations.delegatorUserId)))
    .innerJoin(users, and(eq(users.id, approvalDelegations.delegatorUserId), eq(users.isActive, true)))
    .where(and(
      eq(approvalDelegations.delegateUserId, ctx.userId),
      isNull(approvalDelegations.revokedAt),
      lte(approvalDelegations.startsAt, now),
      gte(approvalDelegations.endsAt, now),
    ));
  const out: ActiveDelegation[] = [];
  for (const row of rows) {
    const access = await loadMemberAccess(tx, ctx.companyId, row.delegatorId, row.role as Role);
    out.push({ id: row.id, delegatorId: row.delegatorId, delegatorName: row.delegatorName, delegatorRole: row.role as Role, delegatorPermissions: access.permissions, docTypes: row.docTypes, maxAmount: row.maxAmount });
  }
  return out;
}

/**
 * Bu adımda kullanılabilecek vekâlet: belge türü ve tutar kapsamda, asıl onaylayıcı adımı kendisi onaylayabilir ve talebi
 * kendisi göndermemiş olmalı. Vekil belgeyi görme iznine zaten sahip olmalıdır (kontrol çağıranda).
 */
export function delegationFor(request: ApprovalRequestWithSteps, step: StepSpec, ctx: ApprovalCtx, delegations: readonly ActiveDelegation[]): ActiveDelegation | null {
  return delegations.find((d) =>
    d.docTypes.includes(request.docType) &&
    (d.maxAmount === null || Number(request.amount) <= Number(d.maxAmount)) &&
    !(request.separateRequester && request.requestedBy === d.delegatorId) &&
    canActOnStep(request, step, { ...ctx, userId: d.delegatorId, role: d.delegatorRole, permissions: d.delegatorPermissions }),
  ) ?? null;
}

/** Bekleyen taleplerden sıradaki adımı bu kullanıcı için olanlar; vekâletle gelenler `onBehalfOf` taşır. */
export async function pendingForMe(tx: Tx, ctx: ApprovalCtx) {
  const pending = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.status, 'pending'))
    .orderBy(asc(approvalRequests.requestedAt));
  const delegations = await activeDelegations(tx, ctx);
  const out: (ApprovalRequestWithSteps & { onBehalfOf?: { userId: string; name: string } })[] = [];
  for (const { id } of pending) {
    const req = await getRequest(tx, id);
    const current = req.steps.find((s) => s.status === 'pending');
    if (!current || (req.separateRequester && req.requestedBy === ctx.userId)) continue;
    if (canActOnStep(req, current, ctx)) { out.push(req); continue; }
    const delegation = hasPermission(ctx.permissions, approvalReadPermission(req.docType)) ? delegationFor(req, current, ctx, delegations) : null;
    if (delegation) out.push({ ...req, onBehalfOf: { userId: delegation.delegatorId, name: delegation.delegatorName } });
  }
  return out;
}

export async function decide(
  tx: Tx,
  ctx: ApprovalCtx,
  requestId: string,
  input: DecideApprovalInput,
) {
  // Talep satırı kilitlenir: aynı talepte iki eşzamanlı karar sıraya girer
  await tx.execute(sql`select 1 from approval_requests where id = ${requestId} for update`);
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.companyId, ctx.companyId),
        eq(memberships.userId, ctx.userId),
        eq(users.isActive, true),
      ),
    );
  if (!member) throw forbidden();
  const live = await loadMemberAccess(tx, ctx.companyId, ctx.userId, member.role as Role);
  ctx = { ...ctx, role: member.role as Role, permissions: live.permissions };
  const req = await getRequest(tx, requestId);
  if (req.status !== 'pending')
    throw unprocessable('Bu talep zaten sonuçlanmış', 'APPROVAL_NOT_PENDING');
  const current = req.steps.find((s) => s.status === 'pending');
  if (!current) throw unprocessable('Bekleyen adım yok', 'APPROVAL_NOT_PENDING');
  if (req.separateRequester && req.requestedBy === ctx.userId) {
    throw unprocessable('Kendi gönderdiğiniz belgeyi onaylayamazsınız', 'APPROVAL_SELF_DECISION');
  }
  // Kendi adına onaylayamıyorsa geçerli bir vekâletle asıl onaylayıcı adına karar verir (karar anında yeniden denetlenir)
  let delegation: ActiveDelegation | null = null;
  if (!canActOnStep(req, current, ctx)) {
    if (hasPermission(ctx.permissions, approvalReadPermission(req.docType))) delegation = delegationFor(req, current, ctx, await activeDelegations(tx, ctx));
    if (!delegation) throw forbidden('Bu adımı onaylama yetkiniz yok');
  }
  // Belge işleyicileri (canlı yetki/şube denetimi, nihai kayıt) asıl onaylayıcının güncel yetkisiyle çalışır; gerçek karar veren
  // adımda decided_by, adına karar verilen on_behalf_of olarak kalır.
  const effective: ApprovalCtx = delegation
    ? { ...ctx, userId: delegation.delegatorId, role: delegation.delegatorRole, permissions: delegation.delegatorPermissions }
    : ctx;
  await handlers.get(req.docType as ApprovalDocType)?.beforeDecision?.(tx, effective, req, input);
  const approve = input.decision === 'approve';
  await tx
    .update(approvalSteps)
    .set({
      status: approve ? 'approved' : 'rejected',
      decidedBy: ctx.userId,
      decidedAt: new Date(),
      note: input.note ?? null,
      onBehalfOf: delegation?.delegatorId ?? null,
      delegationId: delegation?.id ?? null,
    })
    .where(eq(approvalSteps.id, current.id));

  const remaining = req.steps.filter((s) => s.status === 'pending' && s.id !== current.id).length;
  let outcome: ApprovalOutcome | null = null;
  if (!approve) outcome = 'rejected';
  else if (remaining === 0) outcome = 'approved';
  if (outcome) {
    await tx
      .update(approvalRequests)
      .set({ status: outcome, completedAt: new Date() })
      .where(eq(approvalRequests.id, requestId));
    const resolved = await getRequest(tx, requestId);
    await handlers.get(req.docType as ApprovalDocType)?.onResolved(tx, effective, resolved, outcome);
  }
  return getRequest(tx, requestId);
}

/** Gönderen ya da yönetici talebi geri çeker (belge taslağa döner). */
export async function cancelRequest(tx: Tx, ctx: ApprovalCtx, requestId: string) {
  await tx.execute(sql`select 1 from approval_requests where id = ${requestId} for update`);
  const req = await getRequest(tx, requestId);
  if (req.status !== 'pending')
    throw unprocessable('Bu talep zaten sonuçlanmış', 'APPROVAL_NOT_PENDING');
  if (
    req.requestedBy !== ctx.userId &&
    !hasPermission(ctx.permissions, approvePermission(req.docType))
  )
    throw forbidden('Talebi yalnızca gönderen veya onaylayıcı geri çekebilir');
  await tx
    .update(approvalRequests)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(approvalRequests.id, requestId));
  await handlers.get(req.docType as ApprovalDocType)?.onCancelled?.(tx, ctx, req);
  return getRequest(tx, requestId);
}
