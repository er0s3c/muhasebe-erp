import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { addMemberSchema, updateMemberSchema, uuid } from '@erp/shared';
import type { Tx } from '../../db/client';
import { memberships, users } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { AppError, notFound, unprocessable } from '../../http/errors';
import { TR } from '../../db/search';

const userIdParam = z.object({ userId: uuid });

export const memberRoutes: FastifyPluginAsync = async (app) => {
  const manage = { permission: 'members.manage' } as const;

  app.get(
    '/api/company/members',
    tenantRoute(app, manage, async ({ tx }) => {
      const rows = await tx
        .select({
          userId: users.id,
          email: users.email,
          fullName: users.fullName,
          isActive: users.isActive,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .orderBy(sql`${users.fullName} collate ${TR}`);
      return { members: rows };
    }),
  );

  app.post(
    '/api/company/members',
    tenantRoute(app, manage, async ({ tx, req, reply, company, user }) => {
      const input = addMemberSchema.parse(req.body);

      let [target] = await tx.select().from(users).where(eq(users.email, input.email));
      if (target && target.organizationId !== user.orgId) {
        throw new AppError(409, 'EMAIL_TAKEN', 'Bu e-posta adresi başka bir kuruluşta kayıtlı');
      }
      if (!target) {
        if (!input.password) {
          throw unprocessable('Yeni kullanıcı için ilk şifre gerekli', 'PASSWORD_REQUIRED');
        }
        [target] = await tx
          .insert(users)
          .values({
            organizationId: user.orgId,
            email: input.email,
            passwordHash: await hash(input.password),
            fullName: input.fullName,
          })
          .returning();
      }

      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, target!.id)));
      if (existing) throw new AppError(409, 'ALREADY_MEMBER', 'Kullanıcı bu şirkete zaten üye');

      await tx.insert(memberships).values({ companyId: company.id, userId: target!.id, role: input.role });
      void reply.code(201);
      return { member: { userId: target!.id, email: target!.email, fullName: target!.fullName, role: input.role } };
    }),
  );

  app.patch(
    '/api/company/members/:userId',
    tenantRoute(app, manage, async ({ tx, req, company }) => {
      const { userId } = userIdParam.parse(req.params);
      const { role } = updateMemberSchema.parse(req.body);
      await assertNotLastOwner(tx, company.id, userId, role);
      const [row] = await tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)))
        .returning();
      if (!row) throw notFound('Üye');
      return { member: { userId, role: row.role } };
    }),
  );

  app.delete(
    '/api/company/members/:userId',
    tenantRoute(app, manage, async ({ tx, req, company }) => {
      const { userId } = userIdParam.parse(req.params);
      await assertNotLastOwner(tx, company.id, userId, null);
      const deleted = await tx
        .delete(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)))
        .returning({ id: memberships.id });
      if (deleted.length === 0) throw notFound('Üye');
      return { ok: true };
    }),
  );
};

/** Şirketin sahipsiz kalmasını engeller. */
async function assertNotLastOwner(
  tx: Tx,
  companyId: string,
  userId: string,
  newRole: string | null,
) {
  if (newRole === 'owner') return;
  const [target] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId)));
  if (target?.role !== 'owner') return;
  const [owners] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner')));
  if ((owners?.n ?? 0) <= 1) {
    throw unprocessable('Şirketin en az bir sahibi olmalı', 'LAST_OWNER');
  }
}
