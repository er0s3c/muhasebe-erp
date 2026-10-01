import type { FastifyPluginAsync } from 'fastify';
import {
  activateContractSchema,
  bulkUnitsSchema,
  cancelContractSchema,
  createFeeScheduleSchema,
  createSalesContractSchema,
  feeScheduleListQuerySchema,
  verifyFeeScheduleSchema,
  createUnitSchema,
  handoverContractSchema,
  overdueQuerySchema,
  idParam,
  salesContractListQuerySchema,
  terminateContractSchema,
  unitListQuerySchema,
  updateSalesContractSchema,
  updateUnitSchema,
} from '@erp/shared';
import { todayIso } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { activateContract, cancelContract, createContract, getContract, handoverContract, listContracts, listInstallments, loadSalesCtx, salesSummary, updateContract } from './contracts';
import { createFeeSchedule, deleteFeeSchedule, feeEstimate, listFeeSchedules, verifyFeeSchedule } from './fees';
import { terminateContract } from './termination';
import { bulkCreateUnits, createUnit, deleteUnit, getUnit, listUnits, updateUnit, type RealEstateCtx } from './units';

const rctx = ({ company, user }: TenantCtx): RealEstateCtx => ({ companyId: company.id, userId: user.id, baseCurrency: company.baseCurrency });
const sctx = (c: TenantCtx) => loadSalesCtx(c.tx, c.company.id, c.user.id);

export const realEstateRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'construction.realestate';
  const read = { module: MODULE, permission: 'realestate.read' } as const;
  const manage = { module: MODULE, permission: 'realestate.manage' } as const;
  const approve = { module: MODULE, permission: 'realestate.approve' } as const;

  // --- Birimler ---------------------------------------------------------------------------------
  app.get('/api/real-estate/units', tenantRoute(app, read, async ({ tx, req }) => listUnits(tx, unitListQuerySchema.parse(req.query))));
  app.post(
    '/api/real-estate/units',
    tenantRoute(app, manage, async (c) => {
      const out = await createUnit(c.tx, rctx(c), createUnitSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.post(
    '/api/real-estate/units/bulk',
    tenantRoute(app, manage, async (c) => {
      const out = await bulkCreateUnits(c.tx, rctx(c), bulkUnitsSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/real-estate/units/:id', tenantRoute(app, read, async ({ tx, req }) => getUnit(tx, idParam.parse(req.params).id)));
  app.put('/api/real-estate/units/:id', tenantRoute(app, manage, async ({ tx, req }) => updateUnit(tx, idParam.parse(req.params).id, updateUnitSchema.parse(req.body))));
  app.delete(
    '/api/real-estate/units/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteUnit(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  app.get('/api/projects/:id/sales-summary', tenantRoute(app, read, async ({ tx, req }) => salesSummary(tx, idParam.parse(req.params).id)));

  // --- Fon ve harç tarifeleri (tarihli, doğrulama alanlı) ---------------------------------------------
  app.get('/api/fee-schedules', tenantRoute(app, read, async ({ tx, req }) => listFeeSchedules(tx, feeScheduleListQuerySchema.parse(req.query))));
  app.post(
    '/api/fee-schedules',
    tenantRoute(app, approve, async ({ tx, req, reply, company }) => {
      const row = await createFeeSchedule(tx, company.id, createFeeScheduleSchema.parse(req.body));
      void reply.code(201);
      return { feeSchedule: row };
    }),
  );
  app.post('/api/fee-schedules/:id/verify', tenantRoute(app, approve, async ({ tx, req }) => {
    const input = verifyFeeScheduleSchema.parse(req.body);
    return { feeSchedule: await verifyFeeSchedule(tx, idParam.parse(req.params).id, input.verifiedBy, input.sourceNote) };
  }));
  app.delete(
    '/api/fee-schedules/:id',
    tenantRoute(app, approve, async ({ tx, req, reply }) => {
      await deleteFeeSchedule(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );
  app.get('/api/projects/:id/fee-estimate', tenantRoute(app, read, async ({ tx, req, company }) => feeEstimate(tx, idParam.parse(req.params).id, ((req.query as { asOf?: string }).asOf) ?? todayIso(), company.baseCurrency)));

  // --- Satış sözleşmeleri -----------------------------------------------------------------------------
  app.get('/api/sales-contracts', tenantRoute(app, read, async ({ tx, req }) => listContracts(tx, salesContractListQuerySchema.parse(req.query))));
  app.post(
    '/api/sales-contracts',
    tenantRoute(app, manage, async (c) => {
      const out = await createContract(c.tx, await sctx(c), createSalesContractSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/real-estate/installments', tenantRoute(app, read, async ({ tx, req }) => listInstallments(tx, { ...overdueQuerySchema.parse(req.query), overdueOnly: (req.query as { overdue?: string }).overdue === 'true' })));
  app.get('/api/sales-contracts/:id', tenantRoute(app, read, async ({ tx, req }) => getContract(tx, idParam.parse(req.params).id)));
  app.put('/api/sales-contracts/:id', tenantRoute(app, manage, async (c) => updateContract(c.tx, await sctx(c), idParam.parse(c.req.params).id, updateSalesContractSchema.parse(c.req.body))));
  app.post('/api/sales-contracts/:id/activate', tenantRoute(app, approve, async (c) => activateContract(c.tx, await sctx(c), idParam.parse(c.req.params).id, activateContractSchema.parse(c.req.body ?? {}).date)));
  app.post('/api/sales-contracts/:id/handover', tenantRoute(app, approve, async (c) => handoverContract(c.tx, await sctx(c), idParam.parse(c.req.params).id, handoverContractSchema.parse(c.req.body ?? {}).date)));
  app.post('/api/sales-contracts/:id/cancel', tenantRoute(app, approve, async (c) => cancelContract(c.tx, await sctx(c), idParam.parse(c.req.params).id, cancelContractSchema.parse(c.req.body).reason)));  app.post('/api/sales-contracts/:id/terminate', tenantRoute(app, approve, async (c) => terminateContract(c.tx, await sctx(c), idParam.parse(c.req.params).id, terminateContractSchema.parse(c.req.body))));
};
