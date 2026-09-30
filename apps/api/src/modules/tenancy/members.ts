import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { WEAK_PASSWORD_MESSAGE, addMemberSchema, isWeakPassword, updateMemberSchema, uuid } from '@erp/shared';
import type { Tx } from '../../db/client';
import { memberships, users } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { AppError, forbidden, notFound, unprocessable } from '../../http/errors';
import { TR } from '../../db/search';
import { recordSecurityEvent } from '../auth/events';
import { issueUserToken } from '../auth/tokens';
import { queueMail } from '../mail/queue';
import { verifyEmailMail } from '../mail/templates';

const userIdParam = z.object({ userId: uuid });

/**
 * `members.manage` iznine yönetici (admin) de sahiptir; ancak `owner` rolünü vermek, almak ya da bir sahibin
 * üyeliğini değiştirmek yalnızca sahiplere aittir. Aksi halde yönetici kendini sahip yapabilir ya da sahibi çıkarabilir.
 */
function requireOwnerFor(callerRole: string, ...roles: (string | null | undefined)[]) {
  if (callerRole !== 'owner' && roles.includes('owner')) {
    throw forbidden('Sahip rolünü yalnızca şirket sahipleri verebilir, değiştirebilir veya kaldırabilir', 'OWNER_ONLY');
  }
}

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
    tenantRoute(app, manage, async ({ tx, req, reply, company, user, role }) => {
      const input = addMemberSchema.parse(req.body);
      requireOwnerFor(role, input.role);

      let [target] = await tx.select().from(users).where(eq(users.email, input.email));
      if (target && target.organizationId !== user.orgId) {
        throw new AppError(409, 'EMAIL_TAKEN', 'Bu e-posta adresi başka bir kuruluşta kayıtlı');
      }
      if (!target) {
        if (!input.password) {
          throw unprocessable('Yeni kullanıcı için ilk şifre gerekli', 'PASSWORD_REQUIRED');
        }
        if (isWeakPassword(input.password, { email: input.email })) throw unprocessable(WEAK_PASSWORD_MESSAGE, 'WEAK_PASSWORD');
        [target] = await tx
          .insert(users)
          .values({
            organizationId: user.orgId,
            email: input.email,
            passwordHash: await hash(input.password),
            fullName: input.fullName,
            // Yöneticinin belirlediği ilk parola geçicidir: kullanıcı ilk girişte kendi parolasını seçer.
            mustChangePassword: input.mustChangePassword,
            emailVerifiedAt: app.mailer.enabled ? null : new Date(),
          })
          .returning();
        if (app.mailer.enabled) {
          const token = await issueUserToken(tx, target!.id, 'verify_email', req.ip);
          queueMail(app, verifyEmailMail(target!.email, target!.fullName, `${app.config.APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`));
        }
      }

      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, target!.id)));
      if (existing) throw new AppError(409, 'ALREADY_MEMBER', 'Kullanıcı bu şirkete zaten üye');

      await tx.insert(memberships).values({ companyId: company.id, userId: target!.id, role: input.role });
      await recordSecurityEvent(app.db, app.log, req, { event: 'member_added', organizationId: user.orgId, userId: target!.id, email: target!.email, meta: { companyId: company.id, role: input.role, by: user.id } });
      void reply.code(201);
      return { member: { userId: target!.id, email: target!.email, fullName: target!.fullName, role: input.role } };
    }),
  );

  app.patch(
    '/api/company/members/:userId',
    tenantRoute(app, manage, async ({ tx, req, company, role: callerRole, user }) => {
      const { userId } = userIdParam.parse(req.params);
      const { role } = updateMemberSchema.parse(req.body);
      const [current] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)));
      if (!current) throw notFound('Üye');
      requireOwnerFor(callerRole, role, current.role);
      await assertNotLastOwner(tx, company.id, userId, role);
      const [row] = await tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)))
        .returning();
      if (!row) throw notFound('Üye');
      await recordSecurityEvent(app.db, app.log, req, { event: 'member_role_changed', organizationId: user.orgId, userId, meta: { companyId: company.id, from: current.role, to: role, by: user.id } });
      return { member: { userId, role: row.role } };
    }),
  );

  app.delete(
    '/api/company/members/:userId',
    tenantRoute(app, manage, async ({ tx, req, company, role: callerRole, user }) => {
      const { userId } = userIdParam.parse(req.params);
      const [current] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)));
      if (!current) throw notFound('Üye');
      requireOwnerFor(callerRole, current.role);
      await assertNotLastOwner(tx, company.id, userId, null);
      const deleted = await tx
        .delete(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)))
        .returning({ id: memberships.id });
      if (deleted.length === 0) throw notFound('Üye');
      await recordSecurityEvent(app.db, app.log, req, { event: 'member_removed', organizationId: user.orgId, userId, meta: { companyId: company.id, role: current.role, by: user.id } });
      return { ok: true };
    }),
  );
};

/**
 * Şirketin sahipsiz kalmasını engeller. Sahip üyelik satırları kilitlenir: iki sahibin aynı anda birbirini
 * düşürmesi (ikisi de "hâlâ iki sahip var" görüp geçmesi) böylece serileşir.
 */
async function assertNotLastOwner(
  tx: Tx,
  companyId: string,
  userId: string,
  newRole: string | null,
) {
  if (newRole === 'owner') return;
  const owners = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner')))
    .for('update');
  if (owners.some((o) => o.userId === userId) && owners.length <= 1) {
    throw unprocessable('Şirketin en az bir sahibi olmalı', 'LAST_OWNER');
  }
}
