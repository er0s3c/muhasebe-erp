import { and, asc, desc, eq, gte, inArray, lte, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CreateEliminationInput, CreateGroupInput, UpdateGroupInput } from '@erp/shared';
import { toDbAmount } from '@erp/shared';
import { setContext } from '../../db/client';
import { consolidationEliminationLines, consolidationEliminations, consolidationGroups, consolidationMembers, memberships } from '../../db/schema';
import type { AuthCtx } from '../../http/context';
import { AppError, conflict, notFound, unprocessable } from '../../http/errors';
import { assertLicensed } from '../../licensing/gate';
import { evaluateMember, type DenyReason, type MemberScope } from './access';

const DENY_TEXT: Record<DenyReason, string> = {
  NOT_A_MEMBER: 'Bu şirketin üyesi değilsiniz',
  ROLE_INSUFFICIENT: 'Bu şirkette konsolidasyon izniniz (reports.consolidation) yok',
  MODULE_DISABLED: 'Bu şirkette konsolidasyon modülü kapalı',
  LICENSE_SECTOR_MISMATCH: 'Lisansınız bu şirketin sektörünü kapsamıyor',
};

const userCtx = (ctx: AuthCtx) => ({ userId: ctx.user.id, orgId: ctx.user.orgId, ip: ctx.req.ip });

/** Kullanıcının üyesi olduğu ve konsolidasyona katılabileceği (üyelik + rol + modül + lisans) şirketler. */
export async function listEligibleCompanies(app: FastifyInstance, ctx: AuthCtx) {
  const license = await assertLicensed(app.license, ctx.req);
  const u = userCtx(ctx);
  await setContext(ctx.tx, u);
  const mine = await ctx.tx.select({ companyId: memberships.companyId }).from(memberships).where(eq(memberships.userId, ctx.user.id));
  const out: { id: string; name: string; baseCurrency: string; role: string }[] = [];
  for (const m of mine) {
    const r = await evaluateMember(app, ctx.tx, u, m.companyId, license);
    if ('scope' in r) out.push({ id: r.scope.companyId, name: r.scope.name, baseCurrency: r.scope.baseCurrency, role: r.scope.role });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

/** İstemcinin verdiği şirket kimliğini SUNUCUDA doğrular: üyelik + rol + modül + lisans; aksi 403 (şirketin varlığı sızdırılmaz). */
async function requireEligible(app: FastifyInstance, ctx: AuthCtx, companyId: string): Promise<MemberScope> {
  const license = await assertLicensed(app.license, ctx.req);
  const r = await evaluateMember(app, ctx.tx, userCtx(ctx), companyId, license);
  if ('excluded' in r) {
    throw new AppError(403, 'GROUP_MEMBER_DENIED', DENY_TEXT[r.excluded.reason], { companyId, reason: r.excluded.reason });
  }
  return r.scope;
}

export async function createGroup(app: FastifyInstance, ctx: AuthCtx, input: CreateGroupInput) {
  const { tx, user } = ctx;
  const ids = [...new Set(input.companyIds)];
  for (const id of ids) await requireEligible(app, ctx, id);
  await setContext(tx, userCtx(ctx));
  const [dup] = await tx
    .select({ id: consolidationGroups.id })
    .from(consolidationGroups)
    .where(and(eq(consolidationGroups.ownerUserId, user.id), eq(consolidationGroups.name, input.name)));
  if (dup) throw conflict('Bu adla bir grubunuz zaten var', 'GROUP_NAME_TAKEN');
  const [group] = await tx
    .insert(consolidationGroups)
    .values({ organizationId: user.orgId, ownerUserId: user.id, name: input.name, reportingCurrency: input.reportingCurrency })
    .returning();
  await tx.insert(consolidationMembers).values(ids.map((c) => ({ groupId: group!.id, memberCompanyId: c })));
  return group!;
}

export async function updateGroup(ctx: AuthCtx, id: string, input: UpdateGroupInput) {
  const [row] = await ctx.tx
    .update(consolidationGroups)
    .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}), updatedAt: new Date() })
    .where(and(eq(consolidationGroups.id, id), eq(consolidationGroups.ownerUserId, ctx.user.id)))
    .returning();
  if (!row) throw notFound('Konsolidasyon grubu');
  return row;
}

/** Sahibin grupları ve üyelerinin GÜNCEL erişim durumu (ad yalnızca erişilebilen şirket için gelir). */
export async function listGroups(app: FastifyInstance, ctx: AuthCtx) {
  const license = await assertLicensed(app.license, ctx.req);
  const u = userCtx(ctx);
  await setContext(ctx.tx, u);
  const groups = await ctx.tx
    .select()
    .from(consolidationGroups)
    .where(eq(consolidationGroups.ownerUserId, ctx.user.id))
    .orderBy(asc(consolidationGroups.isArchived), asc(consolidationGroups.name));
  const members = groups.length
    ? await ctx.tx.select().from(consolidationMembers).where(inArray(consolidationMembers.groupId, groups.map((g) => g.id))).orderBy(asc(consolidationMembers.addedAt))
    : [];
  const status = new Map<string, { name: string | null; baseCurrency: string | null; status: 'ok' | DenyReason }>();
  for (const cid of new Set(members.map((m) => m.memberCompanyId))) {
    const r = await evaluateMember(app, ctx.tx, u, cid, license);
    status.set(cid, 'scope' in r ? { name: r.scope.name, baseCurrency: r.scope.baseCurrency, status: 'ok' } : { name: null, baseCurrency: null, status: r.excluded.reason });
  }
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    reportingCurrency: g.reportingCurrency,
    isArchived: g.isArchived,
    createdAt: g.createdAt,
    members: members
      .filter((m) => m.groupId === g.id)
      .map((m) => ({ companyId: m.memberCompanyId, ...(status.get(m.memberCompanyId) ?? { name: null, baseCurrency: null, status: 'NOT_A_MEMBER' as const }) })),
  }));
}

async function ownGroup(ctx: AuthCtx, id: string) {
  await setContext(ctx.tx, userCtx(ctx));
  const [g] = await ctx.tx
    .select()
    .from(consolidationGroups)
    .where(and(eq(consolidationGroups.id, id), eq(consolidationGroups.ownerUserId, ctx.user.id)));
  if (!g) throw notFound('Konsolidasyon grubu');
  return g;
}

export async function addMember(app: FastifyInstance, ctx: AuthCtx, groupId: string, companyId: string) {
  const g = await ownGroup(ctx, groupId);
  if (g.isArchived) throw unprocessable('Arşivlenmiş gruba şirket eklenemez', 'GROUP_ARCHIVED');
  await requireEligible(app, ctx, companyId);
  await setContext(ctx.tx, userCtx(ctx));
  const [dup] = await ctx.tx
    .select({ id: consolidationMembers.id })
    .from(consolidationMembers)
    .where(and(eq(consolidationMembers.groupId, groupId), eq(consolidationMembers.memberCompanyId, companyId)));
  if (dup) throw conflict('Şirket zaten grupta', 'ALREADY_MEMBER');
  await ctx.tx.insert(consolidationMembers).values({ groupId, memberCompanyId: companyId });
}

export async function removeMember(ctx: AuthCtx, groupId: string, companyId: string) {
  await ownGroup(ctx, groupId);
  const rows = await ctx.tx
    .delete(consolidationMembers)
    .where(and(eq(consolidationMembers.groupId, groupId), eq(consolidationMembers.memberCompanyId, companyId)))
    .returning({ id: consolidationMembers.id });
  if (rows.length === 0) throw notFound('Grup üyesi');
}

// ---------------------------------------------------------------------------
// Eliminasyonlar (elle girilir, salt eklenir, iptal edilebilir; yöntem doğrulanmadı)
// ---------------------------------------------------------------------------

export interface EliminationDto {
  id: string;
  periodFrom: string;
  periodTo: string;
  kind: string;
  description: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  lines: { lineNo: number; accountCode: string; debit: string; credit: string; memo: string | null }[];
}

export async function listEliminations(ctx: AuthCtx, groupId: string, opts: { from?: string; to?: string; includeVoided?: boolean; limit?: number; offset?: number } = {}): Promise<EliminationDto[]> {
  await ownGroup(ctx, groupId);
  const heads = await ctx.tx
    .select()
    .from(consolidationEliminations)
    .where(
      and(
        eq(consolidationEliminations.groupId, groupId),
        opts.includeVoided ? undefined : isNull(consolidationEliminations.voidedAt),
        // Dönem SONU rapor dönemine düşen eliminasyonlar uygulanır (bilanço eliminasyonları birikir; dönem sonu raporun dışındakiler girmez)
        opts.from ? gte(consolidationEliminations.periodTo, opts.from) : undefined,
        opts.to ? lte(consolidationEliminations.periodTo, opts.to) : undefined,
      ),
    )
    .orderBy(desc(consolidationEliminations.createdAt))
    .$dynamic()
    .limit(opts.limit ?? 1_000_000)
    .offset(opts.offset ?? 0);
  if (heads.length === 0) return [];
  const lines = await ctx.tx
    .select()
    .from(consolidationEliminationLines)
    .where(inArray(consolidationEliminationLines.eliminationId, heads.map((h) => h.id)))
    .orderBy(asc(consolidationEliminationLines.lineNo));
  return heads.map((h) => ({
    id: h.id,
    periodFrom: h.periodFrom,
    periodTo: h.periodTo,
    kind: h.kind,
    description: h.description,
    createdAt: h.createdAt,
    voidedAt: h.voidedAt,
    voidReason: h.voidReason,
    lines: lines
      .filter((l) => l.eliminationId === h.id)
      .map((l) => ({ lineNo: l.lineNo, accountCode: l.accountCode, debit: toDbAmount(l.debit), credit: toDbAmount(l.credit), memo: l.memo })),
  }));
}

export async function createElimination(ctx: AuthCtx, groupId: string, input: CreateEliminationInput) {
  const g = await ownGroup(ctx, groupId);
  if (g.isArchived) throw unprocessable('Arşivlenmiş gruba eliminasyon girilemez', 'GROUP_ARCHIVED');
  const [head] = await ctx.tx
    .insert(consolidationEliminations)
    .values({ groupId, periodFrom: input.periodFrom, periodTo: input.periodTo, kind: input.kind, description: input.description, createdBy: ctx.user.id })
    .returning();
  await ctx.tx.insert(consolidationEliminationLines).values(
    input.lines.map((l, i) => ({
      eliminationId: head!.id,
      groupId,
      lineNo: i + 1,
      accountCode: l.accountCode,
      debit: toDbAmount(l.debit ?? '0'),
      credit: toDbAmount(l.credit ?? '0'),
      memo: l.memo ?? null,
    })),
  );
  return head!;
}

export async function voidElimination(ctx: AuthCtx, groupId: string, id: string, reason: string) {
  await ownGroup(ctx, groupId);
  const [row] = await ctx.tx
    .update(consolidationEliminations)
    .set({ voidedAt: new Date(), voidedBy: ctx.user.id, voidReason: reason })
    .where(and(eq(consolidationEliminations.id, id), eq(consolidationEliminations.groupId, groupId), isNull(consolidationEliminations.voidedAt)))
    .returning();
  if (!row) throw notFound('Eliminasyon (ya da zaten iptal edilmiş)');
  return row;
}
