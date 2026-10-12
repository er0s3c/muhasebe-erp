import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  cancelPayrollRunSchema,
  createPayrollItemSchema,
  createPayrollParamSchema,
  createPayrollRunSchema,
  createPayTermSchema,
  idParam,
  payPayrollRunSchema,
  payrollAdjustmentSchema,
  payrollCostQuerySchema,
  payrollRunListQuerySchema,
  unpayPayrollRunSchema,
  updatePayrollItemSchema,
  updatePayrollParamSchema,
  uuid,
  verifyPayrollParamSchema,
  createCountryPayrollConfigSchema,
  updateCountryPayrollConfigSchema,
  createPayrollTaxProfileSchema,
  countryPayrollPreviewSchema,
  computeCountryPayroll,
  turkeyPayroll2026,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { pageOf } from '../../http/paging';
import { createItem, createParam, createTerm, deleteParam, deleteTerm, listItems, listParams, listTerms, logPayrollAccess, updateItem, updateParam, verifyParam, type PayrollCtx } from './config';
import { payrollCostByProject } from './reports';
import { approveRun, calculateRun, cancelRun, createRun, deleteRun, getRun, getSlip, listRuns, payRun, removeAdjustment, setAdjustment, unpayRun } from './runs';
import { createCountryConfig, createTaxProfile, enableCountryConfig, listCountryConfigs, listTaxProfiles, verifyCountryConfig } from './country-config';
import { unprocessable } from '../../http/errors';

export const payrollRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'hr.payroll';
  const read = { module: MODULE, permission: 'hr.payroll' } as const;
  const manage = { module: MODULE, permission: 'hr.payroll_manage' } as const;
  const pctx = ({ company, user }: TenantCtx): PayrollCtx => ({ companyId: company.id, userId: user.id, baseCurrency: company.baseCurrency, reportingCurrency: company.reportingCurrency });
  const adjParam = z.object({ id: uuid, adjId: uuid });
  const slipParam = z.object({ id: uuid, employeeId: uuid });
  const termsQuery = z.object({ employeeId: uuid.optional() });

  app.get('/api/payroll/country-configs', tenantRoute(app, read, async ({ tx }) => ({ configs: await listCountryConfigs(tx), suggestions: { TR: turkeyPayroll2026() } })));
  app.post('/api/payroll/country-configs', tenantRoute(app, manage, async (c) => {
    const config = await createCountryConfig(c.tx, pctx(c), createCountryPayrollConfigSchema.parse(c.req.body));
    void c.reply.code(201); return { config };
  }));
  app.post('/api/payroll/country-configs/:id/verify', tenantRoute(app, manage, async (c) => ({ config: await verifyCountryConfig(c.tx, idParam.parse(c.req.params).id, c.user.id) })));
  app.patch('/api/payroll/country-configs/:id', tenantRoute(app, manage, async (c) => ({ config: await enableCountryConfig(c.tx, idParam.parse(c.req.params).id, updateCountryPayrollConfigSchema.parse(c.req.body).enabled) })));
  app.get('/api/payroll/tax-profiles', tenantRoute(app, read, async ({ tx }) => ({ profiles: await listTaxProfiles(tx) })));
  app.post('/api/payroll/tax-profiles', tenantRoute(app, manage, async (c) => {
    const profile = await createTaxProfile(c.tx, pctx(c), createPayrollTaxProfileSchema.parse(c.req.body));
    void c.reply.code(201); return { profile };
  }));
  app.post('/api/payroll/country-preview', tenantRoute(app, read, async (c) => {
    const i = countryPayrollPreviewSchema.parse(c.req.body);
    try {
      return { calculation: computeCountryPayroll({ ...i, basis: 'monthly', rate: i.gross, params: {}, items: [], attendance: { normalHours: '0', overtimeHours: '0', hourDays: 0, annualLeaveDays: 0, sickLeaveDays: 0, unpaidLeaveDays: 0, absentDays: 0 } }), previewOnly: true };
    } catch (err) { throw unprocessable(err instanceof Error ? err.message : 'Önizleme hesaplanamadı', 'PAYROLL_COUNTRY_CALCULATION'); }
  }));

  // --- Parametreler (tarihli, doğrulama alanlı, varsayılan kapalı) ---------------------------------------
  app.get('/api/payroll/params', tenantRoute(app, read, async ({ tx }) => ({ params: await listParams(tx) })));
  app.post(
    '/api/payroll/params',
    tenantRoute(app, manage, async (c) => {
      const row = await createParam(c.tx, pctx(c), createPayrollParamSchema.parse(c.req.body));
      void c.reply.code(201);
      return { param: row };
    }),
  );
  app.patch('/api/payroll/params/:id', tenantRoute(app, manage, async ({ tx, req }) => ({ param: await updateParam(tx, idParam.parse(req.params).id, updatePayrollParamSchema.parse(req.body)) })));
  app.post('/api/payroll/params/:id/verify', tenantRoute(app, manage, async (c) => ({ param: await verifyParam(c.tx, idParam.parse(c.req.params).id, c.user.id, verifyPayrollParamSchema.parse(c.req.body ?? {}).note) })));
  app.delete(
    '/api/payroll/params/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteParam(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );

  // --- Kalem kataloğu -------------------------------------------------------------------------------------
  app.get('/api/payroll/items', tenantRoute(app, read, async ({ tx }) => ({ items: await listItems(tx) })));
  app.post(
    '/api/payroll/items',
    tenantRoute(app, manage, async (c) => {
      const row = await createItem(c.tx, pctx(c), createPayrollItemSchema.parse(c.req.body));
      void c.reply.code(201);
      return { item: row };
    }),
  );
  app.patch('/api/payroll/items/:id', tenantRoute(app, manage, async ({ tx, req }) => ({ item: await updateItem(tx, idParam.parse(req.params).id, updatePayrollItemSchema.parse(req.body)) })));

  // --- Ücret şartları (ücret verisi: okuma erişim günlüğüne yazılır) --------------------------------------
  app.get(
    '/api/payroll/pay-terms',
    tenantRoute(app, read, async (c) => {
      const terms = await listTerms(c.tx, termsQuery.parse(c.req.query));
      await logPayrollAccess(c.tx, terms.map((t) => t.employeeId), 'Ücret şartı görüntüleme');
      return { terms };
    }),
  );
  app.post(
    '/api/payroll/pay-terms',
    tenantRoute(app, manage, async (c) => {
      const row = await createTerm(c.tx, pctx(c), createPayTermSchema.parse(c.req.body));
      void c.reply.code(201);
      return { term: row };
    }),
  );
  app.delete(
    '/api/payroll/pay-terms/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteTerm(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );

  // --- Bordro çalıştırmaları ------------------------------------------------------------------------------
  app.get('/api/payroll/runs', tenantRoute(app, read, async ({ tx, req }) => {
    const q = payrollRunListQuerySchema.parse(req.query);
    return listRuns(tx, q, pageOf(q));
  }));
  app.post(
    '/api/payroll/runs',
    tenantRoute(app, manage, async (c) => {
      const out = await createRun(c.tx, pctx(c), createPayrollRunSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/payroll/runs/:id', tenantRoute(app, read, async ({ tx, req }) => getRun(tx, idParam.parse(req.params).id)));
  app.delete(
    '/api/payroll/runs/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteRun(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );
  app.post('/api/payroll/runs/:id/calculate', tenantRoute(app, manage, async (c) => calculateRun(c.tx, pctx(c), idParam.parse(c.req.params).id)));
  app.put('/api/payroll/runs/:id/adjustments', tenantRoute(app, manage, async (c) => setAdjustment(c.tx, pctx(c), idParam.parse(c.req.params).id, payrollAdjustmentSchema.parse(c.req.body))));
  app.delete('/api/payroll/runs/:id/adjustments/:adjId', tenantRoute(app, manage, async (c) => {
    const p = adjParam.parse(c.req.params);
    return removeAdjustment(c.tx, pctx(c), p.id, p.adjId);
  }));
  app.post('/api/payroll/runs/:id/approve', tenantRoute(app, manage, async (c) => approveRun(c.tx, pctx(c), idParam.parse(c.req.params).id)));
  app.post('/api/payroll/runs/:id/pay', tenantRoute(app, manage, async (c) => payRun(c.tx, pctx(c), idParam.parse(c.req.params).id, payPayrollRunSchema.parse(c.req.body))));
  app.post('/api/payroll/runs/:id/unpay', tenantRoute(app, manage, async (c) => unpayRun(c.tx, idParam.parse(c.req.params).id, unpayPayrollRunSchema.parse(c.req.body).reason)));
  app.post('/api/payroll/runs/:id/cancel', tenantRoute(app, manage, async (c) => cancelRun(c.tx, pctx(c), idParam.parse(c.req.params).id, cancelPayrollRunSchema.parse(c.req.body))));
  app.get('/api/payroll/runs/:id/slips/:employeeId', tenantRoute(app, read, async (c) => {
    const p = slipParam.parse(c.req.params);
    return getSlip(c.tx, p.id, p.employeeId);
  }));

  // --- Rapor ------------------------------------------------------------------------------------------------
  app.get('/api/payroll/reports/cost', tenantRoute(app, read, async ({ tx, req }) => payrollCostByProject(tx, payrollCostQuerySchema.parse(req.query))));
};
