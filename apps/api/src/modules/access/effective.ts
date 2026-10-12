import { and, eq } from 'drizzle-orm';
import {
  ACCESS_AREAS,
  areaOfModule,
  areaOfPermission,
  effectivePermissions,
  isAccessArea,
  isAccessLevel,
  permissionOfOverride,
  permissionOverrideKey,
  roleHasDefault,
  resourceOperationOf,
  resourceOperationAllowed,
  customRoleAccessSchema,
  type AccessLevel,
  type AccessOverrides,
  type Permission,
  type Role,
  type ResourceOperation,
} from '@erp/shared';
import type { Queryable, Tx } from '../../db/client';
import { memberModuleAccess, memberships, companyRoles } from '../../db/schema';
import { AppError, forbidden } from '../../http/errors';

/**
 * Üyenin ETKİN erişimi (rol şablonu + kullanıcı bazlı modül erişimi). İzin denetiminin tek kaynağı budur: istek başına
 * (`tenantRoute`), arka plan taramalarında (bildirim), çok şirketli erişimde (konsolidasyon) aynı hesap kullanılır.
 * Önbellek YOKTUR: istekteki işlem içinde her seferinde okunur; bu yüzden değişiklik bir sonraki istekte hemen geçerlidir.
 */
export interface MemberAccess {
  role: Role;
  /** Yalnızca geçerli (bilinen alan, bilinen düzey) istisnalar; sahipte her zaman boş. */
  overrides: Record<string, AccessLevel>;
  permissions: Set<Permission>;
}

/** Şirket + kullanıcı için kayıtlı istisnalar (RLS: üye kendi satırlarını, yönetici hepsini okur; bağlam şirket bağlamı olmalı). */
export async function loadOverrides(db: Queryable, companyId: string, userId: string): Promise<Record<string, AccessLevel>> {
  const rows = await db
    .select({ key: memberModuleAccess.moduleKey, level: memberModuleAccess.level })
    .from(memberModuleAccess)
    .where(and(eq(memberModuleAccess.companyId, companyId), eq(memberModuleAccess.userId, userId)));
  const out: Record<string, AccessLevel> = {};
  for (const r of rows) if (validOverride(r.key, r.level)) out[r.key] = r.level as AccessLevel;
  return out;
}

export function buildAccess(role: Role, overrides: AccessOverrides, roleOverrides: AccessOverrides = {}): MemberAccess {
  // Sahipte istisna uygulanmaz (veritabanı da sahip için satır yazdırmaz); yine de savunma olarak boşaltılır
  const valid = role === 'owner' ? {} : (Object.fromEntries(Object.entries({ ...roleOverrides, ...overrides }).filter(([k, v]) => validOverride(k, v))) as Record<string, AccessLevel>);
  return { role, overrides: valid, permissions: effectivePermissions(role, valid) };
}

export async function loadMemberAccess(tx: Tx, companyId: string, userId: string, role: Role): Promise<MemberAccess> {
  return buildAccess(role, role === 'owner' ? {} : await loadOverrides(tx, companyId, userId), role === 'owner' ? {} : await loadRoleOverrides(tx, companyId, userId));
}

export function accessChoicesToOverrides(access: ReturnType<typeof customRoleAccessSchema.parse>): Record<string, AccessLevel> {
  const out: Record<string, AccessLevel> = {};
  for (const [key, level] of Object.entries(access.levels)) if (isAccessArea(key) && level !== 'default') out[key] = level;
  for (const [key, choice] of Object.entries(access.permissions)) if (permissionOfOverride(`permission.${key}`) && choice !== 'default') out[`permission.${key}`] = choice === 'allow' ? 'write' : 'none';
  for (const [key, choice] of Object.entries(access.operations)) if (resourceOperationOf(key) && choice !== 'default') out[key] = choice === 'allow' ? 'write' : 'none';
  return out;
}

export async function loadRoleOverrides(tx: Tx, companyId: string, userId: string): Promise<Record<string, AccessLevel>> {
  const [row] = await tx.select({ access: companyRoles.access, active: companyRoles.isActive }).from(memberships).innerJoin(companyRoles, and(eq(companyRoles.id, memberships.customRoleId), eq(companyRoles.companyId, memberships.companyId))).where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId)));
  if (!row) return {};
  // Pasif bir role bağlı üyelik yanlışlıkla hazır rolün geniş haklarına dönmez.
  if (!row.active) return Object.fromEntries(Object.keys(ACCESS_AREAS).map((key) => [key, 'none' as const]));
  return accessChoicesToOverrides(customRoleAccessSchema.parse(row.access));
}

export function requireResourceOperation(access: MemberAccess, module: string, operation: ResourceOperation) {
  const area = areaOfModule(module);
  if (area && !resourceOperationAllowed(access.permissions, access.overrides, area, operation)) throw new AppError(403, 'RESOURCE_OPERATION_DENIED', 'Bu kayıt işlemi için yetkiniz yok', { area, operation });
}

/** Bu modül, üyenin "Erişim yok" yaptığı bir alana mı bağlı? */
export const isModuleDenied = (a: MemberAccess, moduleKey: string): boolean => {
  const area = areaOfModule(moduleKey);
  return area !== null && a.overrides[area] === 'none';
};

export const MODULE_ACCESS_DENIED = 'MODULE_ACCESS_DENIED';
export const MODULE_READ_ONLY = 'MODULE_READ_ONLY';

export const moduleAccessDenied = () =>
  new AppError(403, MODULE_ACCESS_DENIED, 'Bu modüle erişiminiz yönetici tarafından kapatıldı');
export const moduleReadOnly = () =>
  new AppError(403, MODULE_READ_ONLY, 'Bu modülde yalnızca görüntüleme yetkiniz var; düzenleme yöneticiniz tarafından kapatıldı');

/**
 * İzin eksikken kullanıcıya doğru nedeni söyler: istisnadan kaynaklanıyorsa açık Türkçe kod (MODULE_ACCESS_DENIED / MODULE_READ_ONLY),
 * rolün zaten sahip olmadığı izinse olağan 403 FORBIDDEN.
 */
export function denialFor(a: MemberAccess, permission: Permission): AppError {
  if (a.overrides[permissionOverrideKey(permission)] === 'none') {
    return new AppError(403, MODULE_ACCESS_DENIED, 'Bu işlem için erişiminiz yönetici tarafından kapatıldı');
  }
  const area = areaOfPermission(permission);
  if (area) {
    const level = a.overrides[area];
    if (level === 'none') return moduleAccessDenied();
    if (level === 'read' && (ACCESS_AREAS[area].write as readonly Permission[]).includes(permission)) return moduleReadOnly();
    if (level === 'read' && roleHasDefault(a.role, permission)) return moduleReadOnly();
  }
  return forbidden();
}

function validOverride(key: string, level: unknown): boolean {
  return (isAccessArea(key) && isAccessLevel(level)) || ((permissionOfOverride(key) !== null || resourceOperationOf(key) !== null) && (level === 'none' || level === 'write'));
}

/** Handler içinde ek izin denetimi (ör. kayıt sırasında "muhasebeleştir" bayrağı): eksikse nedene uygun hata atar. */
export function requirePermission(a: MemberAccess, permission: Permission): void {
  if (!a.permissions.has(permission)) throw denialFor(a, permission);
}
