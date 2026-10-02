import type { FastifyPluginAsync } from 'fastify';
import {
  bankGuaranteeListQuerySchema,
  chequeActionSchema,
  chequeBouncedQuerySchema,
  chequeDueQuerySchema,
  chequeListQuerySchema,
  chequeMaturityQuerySchema,
  createBankGuaranteeSchema,
  createChequeSchema,
  idParam,
  resolveBankGuaranteeSchema,
  updateBankGuaranteeSchema,
  updateChequeSchema,
  updatePortfolioSettingsSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import type { LedgerCtx } from '../ledger/journal';
import { createGuarantee, deleteGuarantee, getGuarantee, getSettings, guaranteeReport, guaranteeWarnings, listGuarantees, resolveGuarantee, updateGuarantee, updateSettings } from './guarantees';
import { chequeMaturity, chequesBounced, chequesDue } from './reports';
import { createCheque, getCheque, listBatches, listCheques, runChequeAction, updateCheque } from './service';

const ledgerCtx = ({ company, user }: TenantCtx): LedgerCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
});

/** Çek/senet portföyü ve takas (treasury.cheques) ile banka teminat mektubu portföyü (treasury.guarantees); izinler kasa/banka izinleridir. */
export const chequeRoutes: FastifyPluginAsync = async (app) => {
  const chq = 'treasury.cheques';
  const gua = 'treasury.guarantees';
  const read = { module: chq, permission: 'treasury.read' } as const;
  const post = { module: chq, permission: 'treasury.post' } as const;
  const manage = { module: chq, permission: 'treasury.manage' } as const;
  const gRead = { module: gua, permission: 'treasury.read' } as const;
  const gManage = { module: gua, permission: 'treasury.manage' } as const;

  // --- Çek/senet ---------------------------------------------------------------------------------------------
  app.get('/api/cheques', tenantRoute(app, read, async ({ tx, req }) => listCheques(tx, chequeListQuerySchema.parse(req.query))));
  app.get('/api/cheques/batches', tenantRoute(app, read, async ({ tx }) => listBatches(tx)));
  app.get('/api/cheques/reports/maturity', tenantRoute(app, read, async ({ tx, req }) => chequeMaturity(tx, chequeMaturityQuerySchema.parse(req.query))));
  app.get('/api/cheques/reports/due', tenantRoute(app, read, async ({ tx, req }) => chequesDue(tx, chequeDueQuerySchema.parse(req.query))));
  app.get('/api/cheques/reports/bounced', tenantRoute(app, read, async ({ tx, req }) => chequesBounced(tx, chequeBouncedQuerySchema.parse(req.query))));
  app.get('/api/cheques/:id', tenantRoute(app, read, async ({ tx, req }) => getCheque(tx, idParam.parse(req.params).id)));
  app.post(
    '/api/cheques',
    tenantRoute(app, post, async (c) => {
      const result = await createCheque(c.tx, ledgerCtx(c), createChequeSchema.parse(c.req.body));
      void c.reply.code(201);
      return result;
    }),
  );
  app.patch('/api/cheques/:id', tenantRoute(app, manage, async ({ tx, req }) => updateCheque(tx, idParam.parse(req.params).id, updateChequeSchema.parse(req.body))));
  app.post('/api/cheques/actions', tenantRoute(app, post, async (c) => runChequeAction(c.tx, ledgerCtx(c), chequeActionSchema.parse(c.req.body))));

  // --- Banka teminat mektubu ---------------------------------------------------------------------------------------
  app.get('/api/bank-guarantees', tenantRoute(app, gRead, async ({ tx, req }) => listGuarantees(tx, bankGuaranteeListQuerySchema.parse(req.query))));
  app.get('/api/bank-guarantees/settings', tenantRoute(app, gRead, async ({ tx }) => getSettings(tx)));
  app.put('/api/bank-guarantees/settings', tenantRoute(app, gManage, async ({ tx, company, user, req }) => updateSettings(tx, { companyId: company.id, userId: user.id }, updatePortfolioSettingsSchema.parse(req.body))));
  app.get('/api/bank-guarantees/warnings', tenantRoute(app, gRead, async ({ tx }) => guaranteeWarnings(tx)));
  app.get('/api/bank-guarantees/report', tenantRoute(app, gRead, async ({ tx }) => guaranteeReport(tx)));
  app.get('/api/bank-guarantees/:id', tenantRoute(app, gRead, async ({ tx, req }) => ({ guarantee: await getGuarantee(tx, idParam.parse(req.params).id) })));
  app.post(
    '/api/bank-guarantees',
    tenantRoute(app, gManage, async (c) => {
      const guarantee = await createGuarantee(c.tx, { companyId: c.company.id, userId: c.user.id }, createBankGuaranteeSchema.parse(c.req.body));
      void c.reply.code(201);
      return { guarantee };
    }),
  );
  app.patch('/api/bank-guarantees/:id', tenantRoute(app, gManage, async ({ tx, req }) => ({ guarantee: await updateGuarantee(tx, idParam.parse(req.params).id, updateBankGuaranteeSchema.parse(req.body)) })));
  app.post('/api/bank-guarantees/:id/resolve', tenantRoute(app, gManage, async ({ tx, req }) => ({ guarantee: await resolveGuarantee(tx, idParam.parse(req.params).id, resolveBankGuaranteeSchema.parse(req.body)) })));
  app.delete(
    '/api/bank-guarantees/:id',
    tenantRoute(app, gManage, async ({ tx, req, reply }) => {
      await deleteGuarantee(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );
};
