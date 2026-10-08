import { hash } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { WEAK_PASSWORD_MESSAGE, addMemberSchema, isWeakPassword, updateMemberSchema, uuid, type PermissionSet, type Role } from '@erp/shared';
import type { Tx } from '../../db/client';
import { memberModuleAccess, memberships, userMfa, users } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { AppError, forbidden, notFound, unprocessable } from '../../http/errors';
import { TR } from '../../db/search';
import { recordSecurityEvent } from '../auth/events';
import { issueUserToken } from '../auth/tokens';
import { queueMail } from '../mail/queue';
import { verifyEmailMail } from '../mail/templates';
import { buildAccess, loadOverrides } from '../access/effective';

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

/** Rol ataması da yetki verir: kısıtlı yönetici, modül/işlem kısıtlarını yeni bir kullanıcı veya rol değişimiyle aşamaz. */
function assertRoleWithinGranter(granter: PermissionSet, role: Role, before: PermissionSet = new Set()) {
  const extra = [...buildAccess(role, {}).permissions].filter((permission) => !before.has(permission) && !granter.has(permission));
  if (extra.length > 0) {
    throw forbidden('Bu rol, kendinizde bulunmayan yetkiler veriyor; bu atamayı şirket sahibi yapmalıdır', 'MODULE_ACCESS_EXCEEDS_OWN');
  }
}

export const memberRoutes: FastifyPluginAsync = async (app) => {
  const manage = { permission: 'members.manage' } as const;

  app.get(
    '/api/company/members',
    tenantRoute(app, manage, async ({ tx, company }) => {
      const rows = await tx
        .select({
          userId: users.id,
          email: users.email,
          fullName: users.fullName,
          isActive: users.isActive,
          role: memberships.role,
          mfaEnabled: sql<boolean>`exists (select 1 from user_mfa m where m.user_id = ${users.id} and m.enabled_at is not null)`,
          // Özel modül erişimi olan alan sayısı (liste rozeti); yalnızca sahip/yönetici bu satırları okuyabilir (RLS)
          customAccessCount: sql<number>`(select count(*)::int from member_module_access a where a.company_id = ${memberships.companyId} and a.user_id = ${users.id})`,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.companyId, company.id))
        .orderBy(sql`${users.fullName} collate ${TR}`);
      return { members: rows };
    }),
  );

  app.post(
    '/api/company/members',
    tenantRoute(app, manage, async ({ tx, req, reply, company, user, role, access }) => {
      const input = addMemberSchema.parse(req.body);
      requireOwnerFor(role, input.role);
      assertRoleWithinGranter(access.permissions, input.role);

      let [target] = await tx.select().from(users).where(eq(users.email, input.email));
      if (target && target.organizationId !== user.orgId) {
        // Genel ileti: adresin başka bir kuruluşta kayıtlı olduğu açıkça söylenmez (hesap varlığı sızdırılmaz).
        throw new AppError(409, 'EMAIL_UNAVAILABLE', 'Bu e-posta adresiyle kullanıcı eklenemiyor; başka bir adres deneyin');
      }
      // Mevcut kullanıcıyı şirkete bağlamak, onun üzerinde yetki (ör. iki adımlı doğrulamasını sıfırlama) kazandırır:
      // çağıranın, kullanıcının üye olduğu HER şirkette en az onun rütbesinde yönetici olması gerekir.
      if (target) await assertCanManageUser(tx, target.id);
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
    tenantRoute(app, manage, async ({ tx, req, company, role: callerRole, user, access }) => {
      const { userId } = userIdParam.parse(req.params);
      const { role } = updateMemberSchema.parse(req.body);
      // Sahip satırları hedef üyeden önce kilitlenir; eşzamanlı rol değişiklikleri aynı sırayla ilerler.
      if (callerRole === 'owner') await lockOwnerMemberships(tx, company.id);
      const [current] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)))
        .for('update');
      if (!current) throw notFound('Üye');
      requireOwnerFor(callerRole, role, current.role);
      await assertAccessOverridesAllowRoleChange(tx, company.id, userId, current.role, callerRole, user.id);
      if (role !== current.role) {
        const beforePermissions = buildAccess(current.role as Role, await loadOverrides(tx, company.id, userId)).permissions;
        assertRoleWithinGranter(access.permissions, role, beforePermissions);
      }
      if (current.role === 'owner') await assertNotLastOwner(tx, company.id, userId, role);
      const overridesBefore = role !== current.role ? await countOverrides(tx, company.id, userId) : 0;
      const [row] = await tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)))
        .returning();
      if (!row) throw notFound('Üye');
      await recordSecurityEvent(app.db, app.log, req, { event: 'member_role_changed', organizationId: user.orgId, userId, meta: { companyId: company.id, from: current.role, to: role, by: user.id } });
      // Rol değişince üyenin kullanıcı bazlı modül erişimi (özel istisnalar) veritabanı tetikleyicisiyle silinir: yeni rol şablonu aynen geçerli olur
      return { member: { userId, role: row.role }, clearedModuleAccess: overridesBefore };
    }),
  );

  /** Telefonunu/kurtarma kodlarını kaybeden üyenin iki adımlı doğrulamasını sıfırlar (kullanıcı yeniden kurar). */
  app.delete(
    '/api/company/members/:userId/mfa',
    tenantRoute(app, manage, async ({ tx, req, company, role: callerRole, user }) => {
      const { userId } = userIdParam.parse(req.params);
      const [current] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.companyId, company.id), eq(memberships.userId, userId)));
      if (!current) throw notFound('Üye');
      requireOwnerFor(callerRole, current.role);
      // İki adımlı doğrulama kullanıcıya özgüdür (tüm şirketler): kullanıcının üye olduğu her şirkette yetki gerekir.
      await assertCanManageUser(tx, userId);
      await tx.delete(userMfa).where(eq(userMfa.userId, userId));
      await recordSecurityEvent(app.db, app.log, req, { event: 'mfa_reset', organizationId: user.orgId, userId, meta: { companyId: company.id, by: user.id } });
      return { ok: true };
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
      await assertAccessOverridesAllowRoleChange(tx, company.id, userId, current.role, callerRole, user.id);
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

async function countOverrides(tx: Tx, companyId: string, userId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberModuleAccess)
    .where(and(eq(memberModuleAccess.companyId, companyId), eq(memberModuleAccess.userId, userId)));
  return r?.n ?? 0;
}

/**
 * Rol değişimi/çıkarma üyenin özel modül erişimini siler; bu bir kısıtı kaldırma yolu olmasın diye: özel erişimi olan üyenin kendi rolünü
 * değiştirmesi ve özel erişimi olan YÖNETİCİNİN rolünü/üyeliğini sahip dışında kimsenin değiştirmesi yasaktır (kısıtlı yönetici,
 * başka bir yönetici eliyle kısıtını sıfırlayamaz).
 */
async function assertAccessOverridesAllowRoleChange(tx: Tx, companyId: string, targetId: string, targetRole: string, callerRole: string, callerId: string) {
  if (callerRole === 'owner' && callerId !== targetId) return;
  if (targetId === callerId && targetRole === 'owner') return;
  if ((await countOverrides(tx, companyId, targetId)) === 0) return;
  if (targetId === callerId) {
    throw forbidden('Özel modül erişimi tanımlı üye kendi rolünü değiştiremez ya da kendi üyeliğini kaldıramaz', 'MODULE_ACCESS_SELF');
  }
  if (targetRole === 'admin') {
    throw forbidden('Özel modül erişimi tanımlı yöneticinin rolünü ya da üyeliğini yalnızca şirket sahibi değiştirebilir', 'MODULE_ACCESS_ADMIN_ONLY_OWNER');
  }
}

/**
 * Çağıran, hedef kullanıcının üye olduğu her şirkette sahip/yönetici ve en az onun rütbesinde mi (sahip > yönetici > diğer)?
 * Diğer şirketlerin üyelikleri RLS ile görünmediğinden SECURITY DEFINER `can_manage_user` işlevi kullanılır (0080).
 */
async function assertCanManageUser(tx: Tx, targetUserId: string) {
  const res = await tx.execute<{ ok: boolean }>(sql`select can_manage_user(${targetUserId}::uuid) as ok`);
  if (!res.rows[0]?.ok) {
    throw forbidden(
      'Bu kullanıcı üzerinde işlem için kullanıcının üye olduğu tüm şirketlerde en az onun yetkisinde sahip ya da yönetici olmalısınız',
      'MEMBER_OUTRANKS_YOU',
    );
  }
}

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
  const owners = await lockOwnerMemberships(tx, companyId);
  if (owners.some((o) => o.userId === userId) && owners.length <= 1) {
    throw unprocessable('Şirketin en az bir sahibi olmalı', 'LAST_OWNER');
  }
}

async function lockOwnerMemberships(tx: Tx, companyId: string) {
  return tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner')))
    .orderBy(memberships.userId)
    .for('update');
}
