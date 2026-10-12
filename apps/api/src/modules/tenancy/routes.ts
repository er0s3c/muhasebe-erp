import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  MODULES,
  NAV_GROUPS,
  NAV_ITEMS,
  areaOfModule,
  checkModuleToggle,
  createCompanySchema,
  describeModules,
  hasPermission,
  updateCompanySchema,
  type ModuleToggleReason,
  companyProfileInputSchema,
  activateCompanyProfileSchema,
} from '@erp/shared';
import { companies, companyModules, memberships, users } from '../../db/schema';
import { authedRoute, tenantRoute } from '../../http/context';
import { notFound, unauthorized, unprocessable } from '../../http/errors';
import { publicUser } from '../auth/routes';
import { assertCanCreateCompany, createCompany } from './service';
import { getCompanyProfile, previewCompanyProfile, activateCompanyProfile } from './profiles';

export const tenancyRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/me',
    authedRoute(app, async ({ tx, user }) => {
      const [me] = await tx
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          emailVerifiedAt: users.emailVerifiedAt,
          mustChangePassword: users.mustChangePassword,
        })
        .from(users)
        .where(eq(users.id, user.id));
      if (!me) throw unauthorized();

      const myCompanies = await tx
        .select({
          id: companies.id,
          name: companies.name,
          sector: companies.sector,
          baseCurrency: companies.baseCurrency,
          reportingCurrency: companies.reportingCurrency,
          jurisdiction: companies.jurisdiction,
          profileMode: companies.profileMode,
          profileVersionId: companies.profileVersionId,
          timeZone: companies.timeZone,
          fxProvider: companies.fxProvider,
          taxSetupStatus: companies.taxSetupStatus,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(companies, eq(companies.id, memberships.companyId))
        .where(eq(memberships.userId, user.id))
        .orderBy(companies.name);
      return { user: publicUser(me), companies: myCompanies };
    }, { allowMustChange: true }),
  );

  app.post(
    '/api/companies',
    // Her çağrı ~150 hesaplık plan tohumlar; IP başına dakikada 10 (RATE_LIMIT_ENABLED iken).
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    authedRoute(app, async ({ tx, user, req, reply }) => {
      const input = createCompanySchema.parse(req.body);
      await assertCanCreateCompany(tx, user.id);
      const company = await createCompany(tx, user, input, req.ip, await app.license.companyRules());
      void reply.code(201);
      return { company };
    }),
  );

  app.get(
    '/api/navigation',
    tenantRoute(app, {}, async ({ company, role, enabledModules, access,branch }) => {
      const groups = NAV_GROUPS.map((g) => ({
        key: g.key,
        labelKey: g.labelKey,
        items: NAV_ITEMS.filter(
          (i) =>
            i.group === g.key &&
            (!i.sectors || i.sectors.includes(company.sector)) &&
            enabledModules.has(i.module) &&
            !(areaOfModule(i.module) && access.overrides[areaOfModule(i.module)!] === 'none') &&
            (!i.permission || hasPermission(access.permissions, i.permission)),
        ).map(({ key, labelKey, path, icon, module }) => ({ key, labelKey, path, icon, module })),
      })).filter((g) => g.items.length > 0);

      return {
        company,
        branch,
        role,
        // Etkin izinler (rol + kullanıcı bazlı modül erişimi): menü, sayfa kapıları ve düğmeler bunlara bakar
        permissions: [...access.permissions],
        // Yöneticinin bu üyeye verdiği özel erişim (alan → düzey); boşsa rol varsayılanı. Yetki ekranı nedeni göstermek için kullanır.
        moduleAccess: access.overrides,
        modules: [...enabledModules],
        groups,
      };
    }),
  );

  app.get(
    '/api/company',
    tenantRoute(app, {}, async ({ tx, company }) => {
      const [row] = await tx.select().from(companies).where(eq(companies.id, company.id));
      return { company: row };
    }),
  );

  app.patch(
    '/api/company',
    tenantRoute(app, { permission: 'company.manage' }, async ({ tx, company, req }) => {
      const input = updateCompanySchema.parse(req.body);
      const values = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.taxNumber !== undefined ? { taxNumber: input.taxNumber } : {}),
        ...(input.taxOffice !== undefined ? { taxOffice: input.taxOffice } : {}),
        ...(input.allowNegativeStock !== undefined ? { allowNegativeStock: input.allowNegativeStock } : {}),
      };
      // Değiştirilecek alan yoksa güncel kayıt döner (API-6)
      if (Object.keys(values).length === 0) {
        const [cur] = await tx.select().from(companies).where(eq(companies.id, company.id));
        return { company: cur };
      }
      const [row] = await tx
        .update(companies)
        .set(values)
        .where(and(eq(companies.id, company.id)))
        .returning();
      return { company: row };
    }),
  );

  app.get('/api/company/profile', tenantRoute(app, { permission: 'settings.read' }, async ({ tx, company }) => getCompanyProfile(tx, company.id)));
  app.post('/api/company/profile/preview', tenantRoute(app, { permission: 'company.manage' }, async ({ tx, company, req }) => previewCompanyProfile(tx, company.id, companyProfileInputSchema.parse(req.body))));
  app.post('/api/company/profile/activate', tenantRoute(app, { permission: 'company.manage' }, async ({ tx, company, user, req }) => {
    const { revision, ...input } = activateCompanyProfileSchema.parse(req.body);
    return activateCompanyProfile(tx, company.id, user.id, input, revision);
  }));

  // ---- Modül istisnaları (Ayarlar > Modüller) -------------------------------------------------
  const labelsOf = (keys: string[]) => keys.map((k) => MODULES.find((m) => m.key === k)?.label ?? k).join(', ');
  const toggleMessage = (reason: ModuleToggleReason, modules: string[]): string => {
    switch (reason) {
      case 'PLANNED':
        return 'Bu modül henüz kullanıma açılmadı';
      case 'SECTOR_MISMATCH':
        return 'Bu modül şirketinizin faaliyet alanında bulunmuyor';
      case 'LOCKED':
        return 'Bu modül kapatılamaz';
      case 'REQUIRED_BY':
        return `Bu modül şu etkin modüller için gerekli; önce onları kapatın: ${labelsOf(modules)}`;
      case 'MISSING_REQUIREMENT':
        return `Bu modülün çalışması için önce şu modülleri açın: ${labelsOf(modules)}`;
      default:
        return 'Geçersiz modül';
    }
  };

  app.get(
    '/api/company/modules',
    tenantRoute(app, { module: 'core.settings', permission: 'settings.read' }, async ({ tx, company }) => {
      const overrides = await tx.select({ module: companyModules.module, enabled: companyModules.enabled }).from(companyModules);
      return { modules: describeModules(company.sector, overrides) };
    }),
  );

  /**
   * Modülü kapatır (istisna satırı yazar) ya da açar (istisna satırını siler). Sektör/planlı/kilitli/bağımlılık
   * kuralları `checkModuleToggle` ile denetlenir. Şirket satırı kilitlenir: iki yöneticinin eşzamanlı geçişi
   * (biri bağımlıyı açarken öteki gereksinimi kapatması) kuralı aşamaz.
   */
  app.put(
    '/api/company/modules/:key',
    tenantRoute(app, { module: 'core.settings', permission: 'settings.manage' }, async ({ tx, req, company }) => {
      const { key } = z.object({ key: z.string().min(3).max(60) }).parse(req.params);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      await tx.execute(sql`select id from companies where id = ${company.id} for update`);
      const current = async () => tx.select({ module: companyModules.module, enabled: companyModules.enabled }).from(companyModules);

      const check = checkModuleToggle(company.sector, await current(), key, enabled);
      if (!check.ok) {
        if (check.reason === 'UNKNOWN') throw notFound('Modül');
        throw unprocessable(toggleMessage(check.reason, check.modules), `MODULE_${check.reason}`, { modules: check.modules });
      }
      if (enabled) {
        await tx.delete(companyModules).where(and(eq(companyModules.companyId, company.id), eq(companyModules.module, key)));
      } else {
        await tx
          .insert(companyModules)
          .values({ companyId: company.id, module: key, enabled: false })
          .onConflictDoUpdate({ target: [companyModules.companyId, companyModules.module], set: { enabled: false } });
      }
      return { modules: describeModules(company.sector, await current()) };
    }),
  );
};
