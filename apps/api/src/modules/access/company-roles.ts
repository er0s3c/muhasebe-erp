import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCESS_AREA_KEYS, CUSTOM_ROLE_BASES, RESOURCE_OPERATIONS, areaOfPermission, createCompanyRoleSchema, customRoleAccessSchema, isAccessArea, isRoleBoundPermission, permissionOfOverride, resourceOperationAllowed, resourceOperationOf, roleDefaultPermissions, updateCompanyRoleSchema, uuid, type Role } from '@erp/shared';
import { companyRoles, memberModuleAccess, memberships } from '../../db/schema';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { AppError, forbidden, notFound, unprocessable } from '../../http/errors';
import { recordSecurityEvent } from '../auth/events';
import { accessChoicesToOverrides, buildAccess, loadMemberAccess, loadOverrides, type MemberAccess } from './effective';
import { areasForSector, editBlock } from './routes';
import { assertMemberScopeWithinGranter } from './grant-scope';

const idParam = z.object({ id: uuid });
const assignment = z.object({ roleId: uuid.nullable() });
const userParam = z.object({ userId: uuid });
type RoleAccess = ReturnType<typeof customRoleAccessSchema.parse>;

function validateChoices(c: TenantCtx, baseRole: Role, access: RoleAccess) {
  const allowed = new Set(areasForSector(c.company.sector));
  for (const key of Object.keys(access.levels)) if (!isAccessArea(key) || !allowed.has(key)) throw unprocessable('Bu modül şirketin sektöründe bulunmuyor', 'MODULE_ACCESS_UNKNOWN_MODULE');
  for (const [key, choice] of Object.entries(access.permissions)) {
    const permission = permissionOfOverride(`permission.${key}`);
    const area = permission ? areaOfPermission(permission) : null;
    if (!permission || !area || !allowed.has(area)) throw unprocessable('Bilinmeyen işlem izni', 'MODULE_ACCESS_UNKNOWN_MODULE');
    if (choice === 'allow' && isRoleBoundPermission(permission) && !roleDefaultPermissions(baseRole).has(permission)) throw new AppError(403, 'MODULE_ACCESS_ROLE_BOUND', 'Bu işlem için uygun temel rol seçilmelidir');
  }
  for (const key of Object.keys(access.operations)) {
    const operation = resourceOperationOf(key);
    if (!operation || !allowed.has(operation.area)) throw unprocessable('Bilinmeyen kayıt işlemi', 'MODULE_ACCESS_UNKNOWN_MODULE');
  }
}

export function assertAccessWithinGranter(c: TenantCtx, after: MemberAccess, before?: MemberAccess) {
  if ([...after.permissions].some(p => !before?.permissions.has(p) && !c.access.permissions.has(p))) throw new AppError(403, 'MODULE_ACCESS_EXCEEDS_OWN', 'Kendinizde bulunmayan bir yetkiyi başkasına veremezsiniz');
  for (const area of ACCESS_AREA_KEYS) for (const operation of RESOURCE_OPERATIONS) {
    if (resourceOperationAllowed(after.permissions, after.overrides, area, operation) && !resourceOperationAllowed(c.access.permissions, c.access.overrides, area, operation) && (!before || !resourceOperationAllowed(before.permissions, before.overrides, area, operation))) throw new AppError(403, 'MODULE_ACCESS_EXCEEDS_OWN', 'Kendinizde bulunmayan kayıt işlemini başkasına veremezsiniz');
  }
}

export function registerCompanyRoleRoutes(app: FastifyInstance) {
  const manage = { permission: 'members.manage' } as const;
  app.get('/api/company/roles', tenantRoute(app, manage, async c => {
    const roles = await c.tx.select({ id: companyRoles.id, name: companyRoles.name, baseRole: companyRoles.baseRole, access: companyRoles.access, version: companyRoles.version, isActive: companyRoles.isActive,
      memberCount: sql<number>`(select count(*)::int from memberships m where m.company_id = ${companyRoles.companyId} and m.custom_role_id = ${companyRoles.id})` }).from(companyRoles).where(eq(companyRoles.companyId, c.company.id)).orderBy(companyRoles.name);
    return { roles, areas: areasForSector(c.company.sector), basePermissions: Object.fromEntries(CUSTOM_ROLE_BASES.map(role => [role, [...roleDefaultPermissions(role)]])) };
  }));
  app.post('/api/company/roles', tenantRoute(app, manage, async c => {
    if (c.branch.mode !== 'all') throw forbidden('Ortak şirket rollerini yönetmek için tüm şubelere erişim gerekir', 'BRANCH_ADMIN_SCOPE_REQUIRED');
    const input = createCompanyRoleSchema.parse(c.req.body);
    validateChoices(c, input.baseRole, input.access);
    assertAccessWithinGranter(c, buildAccess(input.baseRole, {}, accessChoicesToOverrides(input.access)));
    const [role] = await c.tx.insert(companyRoles).values({ companyId: c.company.id, ...input, createdBy: c.user.id }).returning();
    await recordSecurityEvent(app.db, app.log, c.req, { event: 'company_role_changed', organizationId: c.user.orgId, userId: c.user.id, meta: { companyId: c.company.id, roleId: role!.id, action: 'created', version: role!.version } });
    void c.reply.code(201);
    return { role };
  }));
  app.put('/api/company/roles/:id', tenantRoute(app, manage, async c => {
    if (c.branch.mode !== 'all') throw forbidden('Ortak şirket rollerini yönetmek için tüm şubelere erişim gerekir', 'BRANCH_ADMIN_SCOPE_REQUIRED');
    const { id } = idParam.parse(c.req.params);
    const input = updateCompanyRoleSchema.parse(c.req.body);
    const [current] = await c.tx.select().from(companyRoles).where(and(eq(companyRoles.companyId, c.company.id), eq(companyRoles.id, id))).for('update');
    if (!current) throw notFound('Şirket rolü');
    if (current.version !== input.version) throw new AppError(409, 'ROLE_VERSION_CONFLICT', 'Rol başka bir kullanıcı tarafından değiştirildi; ekranı yenileyin');
    const members = await c.tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, c.company.id), eq(memberships.customRoleId, id))).orderBy(memberships.userId).for('update');
    if (members.length && (input.baseRole !== current.baseRole || !input.isActive)) throw new AppError(409, 'ROLE_IN_USE', 'Atanmış rolün temel rolünü değiştirmeden veya pasifleştirmeden önce üyeleri başka bir role taşıyın');
    validateChoices(c, input.baseRole, input.access);
    const oldOverrides = accessChoicesToOverrides(customRoleAccessSchema.parse(current.access));
    const newOverrides = accessChoicesToOverrides(input.access);
    assertAccessWithinGranter(c, buildAccess(input.baseRole, {}, newOverrides), buildAccess(current.baseRole as Role, {}, oldOverrides));
    for (const member of members) {
      const overrides = await loadOverrides(c.tx, c.company.id, member.userId);
      assertAccessWithinGranter(c, buildAccess(input.baseRole, overrides, newOverrides), buildAccess(current.baseRole as Role, overrides, oldOverrides));
    }
    const [role] = await c.tx.update(companyRoles).set({ name: input.name, baseRole: input.baseRole, access: input.access, isActive: input.isActive, version: current.version + 1, updatedAt: new Date() }).where(eq(companyRoles.id, id)).returning();
    await recordSecurityEvent(app.db, app.log, c.req, { event: 'company_role_changed', organizationId: c.user.orgId, userId: c.user.id, meta: { companyId: c.company.id, roleId: id, action: 'updated', version: role!.version, affectedMembers: members.length } });
    return { role };
  }));
  app.put('/api/company/members/:userId/custom-role', tenantRoute(app, manage, async c => {
    const { userId } = userParam.parse(c.req.params);
    const input = assignment.parse(c.req.body);
    const [customRole] = input.roleId ? await c.tx.select().from(companyRoles).where(and(eq(companyRoles.companyId, c.company.id), eq(companyRoles.id, input.roleId))).for('update') : [];
    if (input.roleId && !customRole) throw notFound('Şirket rolü');
    if (customRole && !customRole.isActive) throw unprocessable('Pasif rol atanamaz', 'ROLE_INACTIVE');
    const [member] = await c.tx.select().from(memberships).where(and(eq(memberships.companyId, c.company.id), eq(memberships.userId, userId))).for('update');
    if (!member) throw notFound('Üye');
    const block = editBlock(c.user.id, c.role, userId, member.role as Role);
    if (block) throw new AppError(403, block.code, block.message);
    await assertMemberScopeWithinGranter(c, userId);
    if (member.role === 'admin') throw unprocessable('Yönetici için önce bir standart kullanıcı rolü seçin', 'ROLE_ADMIN_CUSTOM');
    const baseRole = (customRole?.baseRole ?? member.role) as Role;
    const before = await loadMemberAccess(c.tx, c.company.id, userId, member.role as Role);
    const after = buildAccess(baseRole, {}, customRole ? accessChoicesToOverrides(customRoleAccessSchema.parse(customRole.access)) : {});
    assertAccessWithinGranter(c, after, before);
    await c.tx.update(memberships).set({ role: baseRole, customRoleId: customRole?.id ?? null }).where(eq(memberships.id, member.id));
    await c.tx.delete(memberModuleAccess).where(and(eq(memberModuleAccess.companyId, c.company.id), eq(memberModuleAccess.userId, userId)));
    await recordSecurityEvent(app.db, app.log, c.req, { event: 'member_role_changed', organizationId: c.user.orgId, userId, meta: { companyId: c.company.id, fromCustomRoleId: member.customRoleId, customRoleId: customRole?.id ?? null, role: baseRole, by: c.user.id, clearedIndividualAccess: true } });
    return { member: { userId, role: baseRole, customRoleId: customRole?.id ?? null } };
  }));
}
