import type { FastifyPluginAsync } from 'fastify';
import { cashForecastQuerySchema, createCashForecastItemSchema, idParam, updateCashForecastItemSchema } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { cashForecast, createForecastItem, deleteForecastItem, listForecastItems, updateForecastItem } from './forecast';

export const cashRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.treasury', permission: 'treasury.read' } as const;
  const manage = { module: 'core.treasury', permission: 'treasury.manage' } as const;

  app.get('/api/cash-forecast', tenantRoute(app, read, async ({ tx, req, company, user }) => cashForecast(tx, { companyId: company.id, userId: user.id, baseCurrency: company.baseCurrency, reportingCurrency: company.reportingCurrency ?? null }, cashForecastQuerySchema.parse(req.query))));
  app.get('/api/cash-forecast/items', tenantRoute(app, read, async ({ tx }) => listForecastItems(tx)));
  app.post(
    '/api/cash-forecast/items',
    tenantRoute(app, manage, async ({ tx, req, reply, company, user }) => {
      const out = await createForecastItem(tx, { companyId: company.id, userId: user.id }, createCashForecastItemSchema.parse(req.body));
      void reply.code(201);
      return out;
    }),
  );
  app.put('/api/cash-forecast/items/:id', tenantRoute(app, manage, async ({ tx, req }) => updateForecastItem(tx, idParam.parse(req.params).id, updateCashForecastItemSchema.parse(req.body))));
  app.delete(
    '/api/cash-forecast/items/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteForecastItem(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );
};
