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
  type AccessLevel,
  type AccessOverrides,
  type Permission,
  type Role,
} from '@erp/shared';
import type { Queryable, Tx } from '../../db/client';
import { memberModuleAccess } from '../../db/schema';
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

export function buildAccess(role: Role, overrides: AccessOverrides): MemberAccess {
  // Sahipte istisna uygulanmaz (veritabanı da sahip için satır yazdırmaz); yine de savunma olarak boşaltılır
  const valid = role === 'owner' ? {} : (Object.fromEntries(Object.entries(overrides).filter(([k, v]) => validOverride(k, v))) as Record<string, AccessLevel>);
  return { role, overrides: valid, permissions: effectivePermissions(role, valid) };
}

export async function loadMemberAccess(tx: Tx, companyId: string, userId: string, role: Role): Promise<MemberAccess> {
  return buildAccess(role, role === 'owner' ? {} : await loadOverrides(tx, companyId, userId));
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
  return (isAccessArea(key) && isAccessLevel(level)) || (permissionOfOverride(key) !== null && (level === 'none' || level === 'write'));
}

/** Handler içinde ek izin denetimi (ör. kayıt sırasında "muhasebeleştir" bayrağı): eksikse nedene uygun hata atar. */
export function requirePermission(a: MemberAccess, permission: Permission): void {
  if (!a.permissions.has(permission)) throw denialFor(a, permission);
}
