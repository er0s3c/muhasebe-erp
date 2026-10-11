import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  createDisputeSchema,
  disputeActionSchema,
  idParam,
  listDisputesQuerySchema,
  partySalesRepSchema,
  salesPolicySchema,
  salesRepReportQuerySchema,
  salesRepTargetsSchema,
} from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { commercialView, loadSalesPolicy, negotiationHistory, saveSalesPolicy } from './commercial';
import { actOnDispute, createDispute, getDispute, listDisputes } from './disputes';
import { listSalesRepTargets, listSalesReps, partySalesRepHistory, salesRepReport, saveSalesRepTargets, setPartySalesRep } from './reps';

/**
 * F6 ticari kararlar: teklif/sipariş ticari görüntüsü ve müzakere geçmişi (33, 34), katkı/kredi politikası (35, 38),
 * satış sorumlusu ve hedefler (13), ticari itiraz dosyası (39). Politika ve hedefler şirket ayarıdır (`settings.manage`).
 */
export const salesCommercialRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'invoices.orders', permission: 'invoices.read' } as const;
  const settings = { module: 'invoices.orders', permission: 'settings.manage' } as const;
  const partyRead = { module: 'core.parties', permission: 'parties.read' } as const;
  const partyManage = { module: 'core.parties', permission: 'parties.manage' } as const;

  app.get('/api/sales-policy', tenantRoute(app, read, async ({ tx }) => loadSalesPolicy(tx)));
  app.put('/api/sales-policy', tenantRoute(app, settings, async (c) => saveSalesPolicy(c.tx, { companyId: c.company.id, userId: c.user.id }, salesPolicySchema.parse(c.req.body))));

  app.get('/api/sales-docs/:id/commercial', tenantRoute(app, read, async (c) => commercialView(c.tx, c.company.baseCurrency, idParam.parse(c.req.params).id)));
  app.get('/api/sales-docs/:id/negotiation', tenantRoute(app, read, async ({ tx, req }) => negotiationHistory(tx, idParam.parse(req.params).id)));

  app.get('/api/sales-reps', tenantRoute(app, partyRead, async (c) => listSalesReps(c.tx, c.company.id)));
  app.get('/api/parties/:id/sales-rep', tenantRoute(app, partyRead, async ({ tx, req }) => partySalesRepHistory(tx, idParam.parse(req.params).id)));
  app.put(
    '/api/parties/:id/sales-rep',
    tenantRoute(app, partyManage, async (c) => setPartySalesRep(c.tx, { companyId: c.company.id, userId: c.user.id }, idParam.parse(c.req.params).id, partySalesRepSchema.parse(c.req.body))),
  );
  app.get(
    '/api/sales-rep-targets',
    tenantRoute(app, read, async ({ tx, req }) => listSalesRepTargets(tx, z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query).year)),
  );
  app.put('/api/sales-rep-targets', tenantRoute(app, settings, async (c) => saveSalesRepTargets(c.tx, { companyId: c.company.id, userId: c.user.id }, salesRepTargetsSchema.parse(c.req.body))));
  app.get('/api/reports/sales-reps', tenantRoute(app, read, async ({ tx, req }) => salesRepReport(tx, salesRepReportQuerySchema.parse(req.query))));

  app.get('/api/disputes', tenantRoute(app, partyRead, async ({ tx, req }) => listDisputes(tx, listDisputesQuerySchema.parse(req.query))));
  app.get('/api/disputes/:id', tenantRoute(app, partyRead, async ({ tx, req }) => getDispute(tx, idParam.parse(req.params).id)));
  app.post(
    '/api/disputes',
    tenantRoute(app, { ...partyManage, idempotent: true }, async (c) => {
      const result = await createDispute(c.tx, { companyId: c.company.id, userId: c.user.id }, createDisputeSchema.parse(c.req.body));
      void c.reply.code(201);
      return result;
    }),
  );
  app.post(
    '/api/disputes/:id/actions',
    tenantRoute(app, partyManage, async (c) => actOnDispute(c.tx, { companyId: c.company.id, userId: c.user.id }, idParam.parse(c.req.params).id, disputeActionSchema.parse(c.req.body))),
  );
};
