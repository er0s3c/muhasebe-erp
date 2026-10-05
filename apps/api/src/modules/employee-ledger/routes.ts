import type { FastifyPluginAsync } from 'fastify';
import {
  advanceListQuerySchema,
  cancelAdvanceSchema,
  createAdvanceSchema,
  employeeBalancesQuerySchema,
  employeeStatementQuerySchema,
  idParam,
  outstandingAdvancesQuerySchema,
  repayAdvanceSchema,
  salaryPaymentSchema,
  setAdvanceDeductionsSchema,
  updateLedgerSettingsSchema,
  verifyLedgerSettingsSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import type { LedgerCtx } from '../ledger/journal';
import { getRun } from '../payroll/runs';
import { getLedgerSettings } from './hooks';
import { advanceRegister, employeeBalances, employeeStatement, logLedgerAccess } from './reports';
import {
  cancelAdvance,
  getAdvance,
  giveAdvance,
  listRunDeductions,
  listSalaryPayments,
  openEmployeeParty,
  outstandingAdvances,
  paySalary,
  repayAdvance,
  setRunAdvanceDeductions,
  updateLedgerSettings,
  verifyLedgerSettings,
} from './service';
import { z } from 'zod';

const lctx = ({ company, user }: TenantCtx): LedgerCtx => ({ companyId: company.id, userId: user.id, baseCurrency: company.baseCurrency, reportingCurrency: company.reportingCurrency });

/**
 * Personel cari ve avans takibi (hr.employee_ledger). İzinler: okuma `hr.payroll` (ücret/avans bakiyesi hassas veridir; okuma erişim günlüğüne
 * yazılır), yazma `hr.payroll_manage`; kasa/banka çıkışı/girişi yapan işlemler ayrıca `treasury.post` ister.
 */
export const employeeLedgerRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'hr.employee_ledger';
  const read = { module: MODULE, permission: 'hr.payroll' } as const;
  const manage = { module: MODULE, permission: 'hr.payroll_manage' } as const;
  const needTreasury = (c: TenantCtx) => {
    c.require('treasury.post');
  };
  const runParam = z.object({ id: z.uuid() });

  app.get('/api/employee-ledger/balances', tenantRoute(app, read, async ({ tx, req }) => employeeBalances(tx, employeeBalancesQuerySchema.parse(req.query))));
  app.get('/api/employee-ledger/advances', tenantRoute(app, read, async ({ tx, req }) => advanceRegister(tx, advanceListQuerySchema.parse(req.query))));
  app.get('/api/employee-ledger/advances/outstanding', tenantRoute(app, read, async ({ tx, req }) => outstandingAdvances(tx, outstandingAdvancesQuerySchema.parse(req.query))));
  app.get(
    '/api/employee-ledger/advances/:id',
    tenantRoute(app, read, async ({ tx, req }) => {
      const d = await getAdvance(tx, idParam.parse(req.params).id);
      await logLedgerAccess(tx, [d.advance.employeeId as string], 'Avans kaydı görüntüleme');
      return d;
    }),
  );
  app.post(
    '/api/employee-ledger/advances',
    tenantRoute(app, manage, async (c) => {
      needTreasury(c);
      const out = await giveAdvance(c.tx, lctx(c), createAdvanceSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.post(
    '/api/employee-ledger/advances/:id/cancel',
    tenantRoute(app, manage, async (c) => {
      needTreasury(c);
      return cancelAdvance(c.tx, lctx(c), idParam.parse(c.req.params).id, cancelAdvanceSchema.parse(c.req.body));
    }),
  );
  app.post(
    '/api/employee-ledger/advances/:id/repay',
    tenantRoute(app, manage, async (c) => {
      needTreasury(c);
      return repayAdvance(c.tx, lctx(c), idParam.parse(c.req.params).id, repayAdvanceSchema.parse(c.req.body));
    }),
  );

  app.get('/api/employee-ledger/employees/:id/statement', tenantRoute(app, read, async ({ tx, req }) => employeeStatement(tx, idParam.parse(req.params).id, employeeStatementQuerySchema.parse(req.query))));
  app.post(
    '/api/employee-ledger/employees/:id/open-party',
    tenantRoute(app, manage, async (c) => {
      const out = await openEmployeeParty(c.tx, lctx(c), idParam.parse(c.req.params).id);
      void c.reply.code(out.created ? 201 : 200);
      return out;
    }),
  );

  app.get('/api/employee-ledger/salary-payments', tenantRoute(app, read, async ({ tx, req }) => listSalaryPayments(tx, z.object({ employeeId: z.uuid().optional() }).parse(req.query))));
  app.post(
    '/api/employee-ledger/salary-payments',
    tenantRoute(app, manage, async (c) => {
      needTreasury(c);
      const out = await paySalary(c.tx, lctx(c), salaryPaymentSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );

  app.get('/api/employee-ledger/runs/:id/deductions', tenantRoute(app, read, async ({ tx, req }) => listRunDeductions(tx, runParam.parse(req.params).id)));
  app.put(
    '/api/employee-ledger/runs/:id/deductions',
    tenantRoute(app, manage, async (c) => {
      const id = runParam.parse(c.req.params).id;
      const out = await setRunAdvanceDeductions(c.tx, lctx(c), id, setAdvanceDeductionsSchema.parse(c.req.body));
      return { ...out, run: (await getRun(c.tx, id)).run };
    }),
  );

  app.get('/api/employee-ledger/settings', tenantRoute(app, read, async ({ tx }) => ({ settings: await getLedgerSettings(tx) })));
  app.put('/api/employee-ledger/settings', tenantRoute(app, manage, async (c) => ({ settings: await updateLedgerSettings(c.tx, lctx(c), updateLedgerSettingsSchema.parse(c.req.body)) })));
  app.post('/api/employee-ledger/settings/verify', tenantRoute(app, manage, async (c) => ({ settings: await verifyLedgerSettings(c.tx, lctx(c), verifyLedgerSettingsSchema.parse(c.req.body ?? {}).note) })));
};
