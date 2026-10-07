import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ACCESS_AREA_KEYS,
  ACCESS_LEVEL_LABELS,
  AREA_NAV_GROUP,
  MODULES,
  areaAccessOf,
  effectivePermissions,
  exceedsGranter,
  isAccessArea,
  isModuleAvailableForSector,
  modulesOfArea,
  roleDefaultPermissions,
  setModuleAccessSchema,
  uuid,
  type AccessAreaKey,
  type AccessLevel,
  type AreaAccessView,
  type Role,
  type Sector,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { memberModuleAccess, memberships, users } from '../../db/schema';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { AppError, notFound, unprocessable } from '../../http/errors';
import { recordSecurityEvent } from '../auth/events';
import { buildAccess, loadOverrides } from './effective';

const userIdParam = z.object({ userId: uuid });

const moduleLabel = (key: string) => MODULES.find((m) => m.key === key);

/** Şirketin sektöründe bağlı modüllerinden en az biri kullanılabilen erişim alanları. */
export function areasForSector(sector: Sector): AccessAreaKey[] {
  return ACCESS_AREA_KEYS.filter((k) => {
    return modulesOfArea(k).some((mk) => {
      const m = moduleLabel(mk);
      return !!m && isModuleAvailableForSector(m, sector);
    });
  });
}

/**
 * Hedef üyenin erişimini bu çağıranın DEĞİŞTİRİP DEĞİŞTİREMEYECEĞİ (rütbe kuralları): kimse kendi erişimini değiştiremez,
 * sahibin erişimi kısıtlanamaz, yöneticinin erişimini yalnızca sahip değiştirir.
 */
export function editBlock(callerId: string, callerRole: Role, targetId: string, targetRole: Role): { code: string; message: string } | null {
  if (callerId === targetId) return { code: 'MODULE_ACCESS_SELF', message: 'Kendi modül erişiminizi değiştiremezsiniz' };
  if (targetRole === 'owner') return { code: 'MODULE_ACCESS_OWNER', message: 'Sahibin modül erişimi kısıtlanamaz' };
  if (targetRole === 'admin' && callerRole !== 'owner') return { code: 'MODULE_ACCESS_ADMIN_ONLY_OWNER', message: 'Yöneticinin modül erişimini yalnızca şirket sahibi değiştirebilir' };
  if (callerRole !== 'owner' && callerRole !== 'admin') return { code: 'FORBIDDEN', message: 'Bu işlem için yetkiniz yok' };
  return null;
}

interface AreaRow {
  key: AccessAreaKey;
  label: string;
  labelKey: string;
  group: string;
  /** Alana bağlı kayıt modülleri (alanın kendisi dahil). */
  modules: { key: string; label: string; labelKey: string; enabled: boolean }[];
  roleDefault: AreaAccessView;
  /** Yönetici seçimi; yoksa null (rol varsayılanı). */
  override: AccessLevel | null;
  effective: AreaAccessView;
  setBy: string | null;
  setAt: string | null;
  note: string | null;
}

async function areaRows(tx: Tx, ctx: TenantCtx, targetId: string, targetRole: Role): Promise<AreaRow[]> {
  const rows = await tx
    .select({ key: memberModuleAccess.moduleKey, level: memberModuleAccess.level, setBy: memberModuleAccess.setBy, setAt: memberModuleAccess.setAt, note: memberModuleAccess.note, setByName: users.fullName })
    .from(memberModuleAccess)
    .leftJoin(users, eq(users.id, memberModuleAccess.setBy))
    .where(and(eq(memberModuleAccess.companyId, ctx.company.id), eq(memberModuleAccess.userId, targetId)));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const overrides = await loadOverrides(tx, ctx.company.id, targetId);
  const eff = buildAccess(targetRole, overrides).permissions;
  const def = roleDefaultPermissions(targetRole);
  return areasForSector(ctx.company.sector).map((key) => {
    const m = moduleLabel(key)!;
    const row = byKey.get(key);
    return {
      key,
      label: m.label,
      labelKey: m.labelKey,
      group: AREA_NAV_GROUP[key],
      modules: modulesOfArea(key).map((mk) => {
        const mm = moduleLabel(mk)!;
        return { key: mk, label: mm.label, labelKey: mm.labelKey, enabled: ctx.enabledModules.has(mk) };
      }).filter((x) => isModuleAvailableForSector(moduleLabel(x.key)!, ctx.company.sector)),
      roleDefault: areaAccessOf(def, key),
      override: (overrides[key] as AccessLevel | undefined) ?? null,
      effective: areaAccessOf(eff, key),
      setBy: row?.setByName ?? null,
      setAt: row ? row.setAt.toISOString() : null,
      note: row?.note ?? null,
    };
  });
}

async function memberOf(tx: Tx, companyId: string, userId: string, lock = false) {
  const q = tx
    .select({ userId: memberships.userId, role: memberships.role, fullName: users.fullName, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId)));
  const [row] = await (lock ? q.for('update', { of: memberships }) : q);
  if (!row) throw notFound('Üye');
  return { ...row, role: row.role as Role };
}

async function view(tx: Tx, ctx: TenantCtx, userId: string) {
  const member = await memberOf(tx, ctx.company.id, userId);
  const block = editBlock(ctx.user.id, ctx.role, member.userId, member.role);
  return {
    member: { userId: member.userId, fullName: member.fullName, email: member.email, role: member.role },
    canEdit: block === null,
    blockedReason: block ? block.message : null,
    areas: await areaRows(tx, ctx, member.userId, member.role),
  };
}

export const accessRoutes: FastifyPluginAsync = async (app) => {
  const manage = { permission: 'members.manage' } as const;

  /** Üyenin modül erişimi: rol varsayılanı, yönetici seçimi ve etkin sonuç (yalnızca sahip/yönetici). */
  app.get('/api/company/members/:userId/module-access', tenantRoute(app, manage, async (c) => view(c.tx, c, userIdParam.parse(c.req.params).userId)));

  /**
   * Birden çok alanın düzeyini birlikte değiştirir (`default` = istisnayı kaldır). Kurallar: kendi erişimi değiştirilemez, sahibinki
   * kısıtlanamaz, yöneticininkini yalnızca sahip değiştirir; alan şirketin sektöründe bulunmalı; çağıran, hedefe KENDİSİNDE olmayan
   * bir izin veremez. Üye satırı kilitlenir (eşzamanlı rol değişimi ile sıralanır).
   */
  app.put(
    '/api/company/members/:userId/module-access',
    tenantRoute(app, manage, async (c) => {
      const { tx, req, company, user, role: callerRole } = c;
      const { userId } = userIdParam.parse(req.params);
      const input = setModuleAccessSchema.parse(req.body);
      const member = await memberOf(tx, company.id, userId, true);
      const block = editBlock(user.id, callerRole, member.userId, member.role);
      if (block) throw new AppError(403, block.code, block.message);

      const allowed = new Set(areasForSector(company.sector));
      for (const key of Object.keys(input.levels)) {
        if (!isAccessArea(key) || !allowed.has(key)) throw unprocessable('Bu modül için erişim düzeyi belirlenemez', 'MODULE_ACCESS_UNKNOWN_MODULE', { module: key });
      }

      const before = await loadOverrides(tx, company.id, userId);
      const after: Record<string, AccessLevel> = { ...before };
      const changes: { area: string; from: AccessLevel | null; to: AccessLevel | null }[] = [];
      for (const [key, level] of Object.entries(input.levels)) {
        const to = level === 'default' ? null : (level as AccessLevel);
        const from = before[key] ?? null;
        if (from === to) continue;
        if (to === null) delete after[key];
        else after[key] = to;
        changes.push({ area: key, from, to });
      }

      // Verme sınırı: sonuçta hedefin alan izinleri çağıranın etkin izinlerinin dışına çıkamaz
      const targetAfter = effectivePermissions(member.role, after);
      for (const ch of changes) {
        const extra = exceedsGranter(c.access.permissions, targetAfter, ch.area as AccessAreaKey);
        if (extra.length > 0) {
          throw new AppError(403, 'MODULE_ACCESS_EXCEEDS_OWN', 'Kendinizde bulunmayan bir yetkiyi başkasına veremezsiniz', { module: ch.area, permissions: extra });
        }
      }

      for (const ch of changes) {
        if (ch.to === null) {
          await tx
            .delete(memberModuleAccess)
            .where(and(eq(memberModuleAccess.companyId, company.id), eq(memberModuleAccess.userId, userId), eq(memberModuleAccess.moduleKey, ch.area)));
        } else {
          await tx
            .insert(memberModuleAccess)
            .values({ companyId: company.id, userId, moduleKey: ch.area, level: ch.to, setBy: user.id, note: input.note ?? null })
            .onConflictDoUpdate({
              target: [memberModuleAccess.companyId, memberModuleAccess.userId, memberModuleAccess.moduleKey],
              set: { level: ch.to, setBy: user.id, setAt: sql`now()`, note: input.note ?? null },
            });
        }
      }
      if (changes.length > 0) {
        await recordSecurityEvent(app.db, app.log, req, {
          event: 'member_module_access_changed',
          organizationId: user.orgId,
          userId,
          meta: { companyId: company.id, by: user.id, role: member.role, changes },
        });
      }
      return view(tx, c, userId);
    }),
  );

  /** Üyenin tüm istisnalarını kaldırır (rol varsayılanına döner). */
  app.delete(
    '/api/company/members/:userId/module-access',
    tenantRoute(app, manage, async (c) => {
      const { tx, req, company, user, role: callerRole } = c;
      const { userId } = userIdParam.parse(req.params);
      const member = await memberOf(tx, company.id, userId, true);
      const block = editBlock(user.id, callerRole, member.userId, member.role);
      if (block) throw new AppError(403, block.code, block.message);
      const before = await loadOverrides(tx, company.id, userId);
      const keys = Object.keys(before);
      // Kaldırmak da bir verme olabilir (kısıt kalkınca rol varsayılanı döner): çağıranın sınırı aşılamaz
      const targetAfter = effectivePermissions(member.role, {});
      for (const key of keys) {
        const extra = exceedsGranter(c.access.permissions, targetAfter, key as AccessAreaKey);
        if (extra.length > 0) throw new AppError(403, 'MODULE_ACCESS_EXCEEDS_OWN', 'Kendinizde bulunmayan bir yetkiyi başkasına veremezsiniz', { module: key, permissions: extra });
      }
      if (keys.length > 0) {
        await tx.delete(memberModuleAccess).where(and(eq(memberModuleAccess.companyId, company.id), eq(memberModuleAccess.userId, userId), inArray(memberModuleAccess.moduleKey, keys)));
        await recordSecurityEvent(app.db, app.log, req, {
          event: 'member_module_access_changed',
          organizationId: user.orgId,
          userId,
          meta: { companyId: company.id, by: user.id, role: member.role, reset: true, changes: keys.map((k) => ({ area: k, from: before[k], to: null })) },
        });
      }
      return view(tx, c, userId);
    }),
  );

  /** Giriş yapmış üyenin kendi etkin erişimi (izinler + alan düzeyleri); izin gerektirmez, yalnızca kendi satırlarını okur. */
  app.get(
    '/api/me/access',
    tenantRoute(app, {}, async (c) => {
      const perms = c.access.permissions;
      const def = roleDefaultPermissions(c.role);
      return {
        role: c.role,
        permissions: [...perms],
        areas: areasForSector(c.company.sector).map((key) => ({
          key,
          levelLabel: ACCESS_LEVEL_LABELS[areaAccessOf(perms, key).level],
          ...areaAccessOf(perms, key),
          custom: c.access.overrides[key] ?? null,
          roleDefault: areaAccessOf(def, key).level,
        })),
      };
    }),
  );
};

