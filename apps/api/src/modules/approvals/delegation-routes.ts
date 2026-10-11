import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { APPROVAL_DOC_TYPES, hasPermission, type Role } from '@erp/shared';
import { approvalDelegations, memberships, users } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { forbidden, notFound, unprocessable } from '../../http/errors';
import { loadMemberAccess } from '../access/effective';
import { approvalPermission, approvalReadPermission } from './document-policy';

const createSchema = z.object({
  delegateUserId: z.string().uuid(),
  docTypes: z.array(z.enum(APPROVAL_DOC_TYPES)).min(1).max(8).transform((v) => [...new Set(v)]),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  maxAmount: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/).optional().nullable().transform((v) => v || null),
  reason: z.string().trim().min(3).max(300),
});
const idParam = z.object({ id: z.string().uuid() });
const MAX_DAYS = 90;

/**
 * Onay vekâleti (öneri 98). Her üye yalnız kendi onay yetkisini, onaylayabildiği belge türleriyle sınırlı olarak, en çok 90 günlüğüne
 * şirketteki başka bir etkin üyeye devreder. Vekil, vekâleti veren ve üye yöneticisi listeyi görür; geri almayı veren ya da üye
 * yöneticisi yapar. Kapsam sonradan değiştirilemez (geri alınıp yenisi verilir).
 */
export const approvalDelegationRoutes: FastifyPluginAsync = async (app) => {
  const gate = { permission: 'workspace.use', operation: 'read' } as const;
  const delegator = alias(users, 'delegator');
  const delegate = alias(users, 'delegate');

  app.get('/api/approval-delegations', tenantRoute(app, gate, async (c) => {
    const admin = c.can('members.manage');
    const rows = await c.tx
      .select({
        id: approvalDelegations.id, delegatorUserId: approvalDelegations.delegatorUserId, delegatorName: delegator.fullName,
        delegateUserId: approvalDelegations.delegateUserId, delegateName: delegate.fullName, docTypes: approvalDelegations.docTypes,
        maxAmount: approvalDelegations.maxAmount, startsAt: approvalDelegations.startsAt, endsAt: approvalDelegations.endsAt,
        reason: approvalDelegations.reason, createdAt: approvalDelegations.createdAt, revokedAt: approvalDelegations.revokedAt,
      })
      .from(approvalDelegations)
      .innerJoin(delegator, eq(delegator.id, approvalDelegations.delegatorUserId))
      .innerJoin(delegate, eq(delegate.id, approvalDelegations.delegateUserId))
      .where(admin ? undefined : or(eq(approvalDelegations.delegatorUserId, c.user.id), eq(approvalDelegations.delegateUserId, c.user.id)))
      .orderBy(desc(approvalDelegations.createdAt))
      .limit(200);
    const now = Date.now();
    return {
      delegations: rows.map((r) => ({
        ...r,
        state: r.revokedAt ? 'revoked' : r.endsAt.getTime() < now ? 'expired' : r.startsAt.getTime() > now ? 'scheduled' : 'active',
      })),
    };
  }));

  app.post('/api/approval-delegations', tenantRoute(app, { ...gate, operation: 'create' }, async (c) => {
    const input = createSchema.parse(c.req.body);
    const starts = new Date(input.startsAt), ends = new Date(input.endsAt);
    if (ends <= starts || ends.getTime() <= Date.now()) throw unprocessable('Bitiş, başlangıçtan ve şu andan sonra olmalı', 'DELEGATION_WINDOW_INVALID');
    if (ends.getTime() - starts.getTime() > MAX_DAYS * 86_400_000) throw unprocessable(`Vekâlet en çok ${MAX_DAYS} gün olabilir`, 'DELEGATION_WINDOW_INVALID');
    if (input.delegateUserId === c.user.id) throw unprocessable('Kendinize vekâlet veremezsiniz', 'DELEGATION_SELF');
    // Yalnız kendi onaylayabildiği türleri devreder: vekâlet yetki genişletmez
    const missing = input.docTypes.filter((t) => !hasPermission(c.access.permissions, approvalPermission(t)));
    if (missing.length) throw unprocessable('Onay yetkiniz olmayan belge türlerini devredemezsiniz', 'DELEGATION_SCOPE_DENIED', { docTypes: missing });
    const [member] = await c.tx
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(users, and(eq(users.id, memberships.userId), eq(users.isActive, true)))
      .where(and(eq(memberships.companyId, c.company.id), eq(memberships.userId, input.delegateUserId)));
    if (!member) throw unprocessable('Vekil bu şirketin etkin üyesi olmalı', 'DELEGATE_NOT_MEMBER');
    // Vekil belgeleri görebilmeli; görmediği belgeyi onaylamasın
    const access = await loadMemberAccess(c.tx, c.company.id, input.delegateUserId, member.role as Role);
    const blind = input.docTypes.filter((t) => !hasPermission(access.permissions, approvalReadPermission(t)));
    if (blind.length) throw unprocessable('Vekil bu belge türlerini görme yetkisine sahip değil', 'DELEGATE_CANNOT_READ', { docTypes: blind });
    const [row] = await c.tx.insert(approvalDelegations).values({
      id: randomUUID(), companyId: c.company.id, delegatorUserId: c.user.id, delegateUserId: input.delegateUserId,
      docTypes: input.docTypes, maxAmount: input.maxAmount, startsAt: starts, endsAt: ends, reason: input.reason, createdBy: c.user.id,
    }).returning();
    void c.reply.code(201);
    return { delegation: row };
  }));

  app.post('/api/approval-delegations/:id/revoke', tenantRoute(app, { ...gate, operation: 'update' }, async (c) => {
    const { id } = idParam.parse(c.req.params);
    const [row] = await c.tx.select().from(approvalDelegations).where(eq(approvalDelegations.id, id)).for('update');
    if (!row) throw notFound('Vekâlet');
    if (row.delegatorUserId !== c.user.id && !c.can('members.manage')) throw forbidden('Vekâleti yalnız veren ya da üye yöneticisi geri alır');
    if (row.revokedAt) return { delegation: row };
    const [updated] = await c.tx.update(approvalDelegations).set({ revokedAt: sql`now()`, revokedBy: c.user.id }).where(eq(approvalDelegations.id, id)).returning();
    return { delegation: updated };
  }));
};
