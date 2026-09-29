import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  NAV_GROUPS,
  NAV_ITEMS,
  ROLE_PERMISSIONS,
  createCompanySchema,
  hasPermission,
  updateCompanySchema,
} from '@erp/shared';
import { companies, memberships, users } from '../../db/schema';
import { authedRoute, tenantRoute } from '../../http/context';
import { unauthorized } from '../../http/errors';
import { createCompany } from './service';

export const tenancyRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/me',
    authedRoute(app, async ({ tx, user }) => {
      const [me] = await tx
        .select({ id: users.id, email: users.email, fullName: users.fullName })
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
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(companies, eq(companies.id, memberships.companyId))
        .where(eq(memberships.userId, user.id))
        .orderBy(companies.name);
      return { user: me, companies: myCompanies };
    }),
  );

  app.post(
    '/api/companies',
    authedRoute(app, async ({ tx, user, req, reply }) => {
      const input = createCompanySchema.parse(req.body);
      const company = await createCompany(tx, user, input, req.ip);
      void reply.code(201);
      return { company };
    }),
  );

  app.get(
    '/api/navigation',
    tenantRoute(app, {}, async ({ company, role, enabledModules }) => {
      const groups = NAV_GROUPS.map((g) => ({
        key: g.key,
        labelKey: g.labelKey,
        items: NAV_ITEMS.filter(
          (i) =>
            i.group === g.key &&
            enabledModules.has(i.module) &&
            (!i.permission || hasPermission(role, i.permission)),
        ).map(({ key, labelKey, path, icon, module }) => ({ key, labelKey, path, icon, module })),
      })).filter((g) => g.items.length > 0);

      return {
        company,
        role,
        permissions: ROLE_PERMISSIONS[role],
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
      const [row] = await tx
        .update(companies)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.taxNumber !== undefined ? { taxNumber: input.taxNumber } : {}),
          ...(input.taxOffice !== undefined ? { taxOffice: input.taxOffice } : {}),
        })
        .where(and(eq(companies.id, company.id)))
        .returning();
      return { company: row };
    }),
  );
};
