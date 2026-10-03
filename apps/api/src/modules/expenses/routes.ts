import type { FastifyPluginAsync } from 'fastify';
import {
  cancelExpenseEntrySchema,
  createExpenseCardSchema,
  createExpenseEntrySchema,
  expenseReportQuerySchema,
  idParam,
  listExpenseEntriesQuerySchema,
  updateExpenseCardSchema,
  pageParams,
} from '@erp/shared';
import { z } from 'zod';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { pageOf } from '../../http/paging';
import type { LedgerCtx } from '../ledger/journal';
import { expenseReport } from './reports';
import {
  cancelExpenseEntry,
  createExpenseCard,
  createExpenseEntry,
  deleteExpenseCard,
  getExpenseEntry,
  listExpenseCards,
  listExpenseEntries,
  updateExpenseCard,
} from './service';

const ledgerCtx = ({ company, user }: TenantCtx): LedgerCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
});

/** Gider kartları ve gider fişi (treasury.expenses); izinler kasa/banka izinleridir: okuma treasury.read, kart yönetimi treasury.manage, fiş kaydı/iptali treasury.post. */
export const expenseRoutes: FastifyPluginAsync = async (app) => {
  const mod = 'treasury.expenses';
  const read = { module: mod, permission: 'treasury.read' } as const;
  const manage = { module: mod, permission: 'treasury.manage' } as const;
  const post = { module: mod, permission: 'treasury.post' } as const;

  app.get('/api/expense-cards', tenantRoute(app, read, async ({ tx, req }) => {
    const q = z.object({ all: z.enum(['true', 'false']).optional(), ...pageParams(2000, 5000) }).parse(req.query);
    return listExpenseCards(tx, { all: q.all === 'true' }, pageOf(q));
  }));
  app.post(
    '/api/expense-cards',
    tenantRoute(app, manage, async (c) => {
      const card = await createExpenseCard(c.tx, c.company.id, createExpenseCardSchema.parse(c.req.body));
      void c.reply.code(201);
      return { card };
    }),
  );
  app.patch('/api/expense-cards/:id', tenantRoute(app, manage, async (c) => ({ card: await updateExpenseCard(c.tx, c.company.id, idParam.parse(c.req.params).id, updateExpenseCardSchema.parse(c.req.body)) })));
  app.delete(
    '/api/expense-cards/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteExpenseCard(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );

  app.get('/api/expense-entries', tenantRoute(app, read, async ({ tx, req }) => listExpenseEntries(tx, listExpenseEntriesQuerySchema.parse(req.query))));
  app.get('/api/expense-entries/report', tenantRoute(app, read, async ({ tx, req }) => expenseReport(tx, expenseReportQuerySchema.parse(req.query))));
  app.get('/api/expense-entries/:id', tenantRoute(app, read, async ({ tx, req }) => ({ entry: await getExpenseEntry(tx, idParam.parse(req.params).id) })));
  app.post(
    '/api/expense-entries',
    tenantRoute(app, post, async (c) => {
      const entry = await createExpenseEntry(c.tx, ledgerCtx(c), createExpenseEntrySchema.parse(c.req.body));
      void c.reply.code(201);
      return { entry };
    }),
  );
  app.post('/api/expense-entries/:id/cancel', tenantRoute(app, post, async (c) => ({ entry: await cancelExpenseEntry(c.tx, ledgerCtx(c), idParam.parse(c.req.params).id, cancelExpenseEntrySchema.parse(c.req.body)) })));
};
