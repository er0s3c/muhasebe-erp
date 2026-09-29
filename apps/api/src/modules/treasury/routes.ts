import type { FastifyPluginAsync } from 'fastify';
import {
  cancelTreasuryTransactionSchema,
  createTreasuryAccountSchema,
  createTreasuryTransactionSchema,
  fxDifferencesQuerySchema,
  idParam,
  listTreasuryTransactionsQuerySchema,
  todayIso,
  treasuryStatementQuerySchema,
  updateTreasuryAccountSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import type { LedgerCtx } from '../ledger/journal';
import {
  createTreasuryAccount,
  getTreasuryAccountRow,
  listTreasuryAccounts,
  treasurySummary,
  updateTreasuryAccount,
} from './accounts';
import { fxDifferences } from './fx-report';
import { cancelTreasuryTransaction, postTreasuryTransaction } from './posting';
import { treasuryStatement } from './reports';
import { getTreasuryTransaction, listTreasuryTransactions } from './transactions';

const ledgerCtx = ({ company, user }: TenantCtx): LedgerCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
});

export const treasuryRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.treasury', permission: 'treasury.read' } as const;
  const manage = { module: 'core.treasury', permission: 'treasury.manage' } as const;
  const post = { module: 'core.treasury', permission: 'treasury.post' } as const;

  app.get('/api/treasury/accounts', tenantRoute(app, read, async (c) => ({ accounts: await listTreasuryAccounts(c.tx, ledgerCtx(c), todayIso()) })));

  app.get('/api/treasury/summary', tenantRoute(app, read, async (c) => treasurySummary(c.tx, ledgerCtx(c), todayIso())));

  app.get(
    '/api/treasury/accounts/:id',
    tenantRoute(app, read, async (c) => {
      const { id } = idParam.parse(c.req.params);
      await getTreasuryAccountRow(c.tx, id);
      const list = await listTreasuryAccounts(c.tx, ledgerCtx(c), todayIso());
      return { account: list.find((a) => a.id === id)! };
    }),
  );

  app.get(
    '/api/treasury/accounts/:id/statement',
    tenantRoute(app, read, async ({ tx, req }) =>
      treasuryStatement(tx, idParam.parse(req.params).id, treasuryStatementQuerySchema.parse(req.query)),
    ),
  );

  app.post(
    '/api/treasury/accounts',
    tenantRoute(app, manage, async (c) => {
      const row = await createTreasuryAccount(c.tx, ledgerCtx(c), createTreasuryAccountSchema.parse(c.req.body));
      const list = await listTreasuryAccounts(c.tx, ledgerCtx(c), todayIso());
      void c.reply.code(201);
      return { account: list.find((a) => a.id === row.id)! };
    }),
  );

  app.patch(
    '/api/treasury/accounts/:id',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      await updateTreasuryAccount(c.tx, id, updateTreasuryAccountSchema.parse(c.req.body));
      const list = await listTreasuryAccounts(c.tx, ledgerCtx(c), todayIso());
      return { account: list.find((a) => a.id === id)! };
    }),
  );

  app.get(
    '/api/treasury/transactions',
    tenantRoute(app, read, async ({ tx, req }) => listTreasuryTransactions(tx, listTreasuryTransactionsQuerySchema.parse(req.query))),
  );

  app.get(
    '/api/treasury/transactions/:id',
    tenantRoute(app, read, async ({ tx, req }) => getTreasuryTransaction(tx, idParam.parse(req.params).id)),
  );

  app.post(
    '/api/treasury/transactions',
    tenantRoute(app, post, async (c) => {
      const result = await postTreasuryTransaction(c.tx, ledgerCtx(c), createTreasuryTransactionSchema.parse(c.req.body));
      void c.reply.code(201);
      return result;
    }),
  );

  app.post(
    '/api/treasury/transactions/:id/cancel',
    tenantRoute(app, post, async (c) =>
      cancelTreasuryTransaction(c.tx, ledgerCtx(c), idParam.parse(c.req.params).id, cancelTreasuryTransactionSchema.parse(c.req.body)),
    ),
  );

  app.get(
    '/api/reports/fx-differences',
    tenantRoute(app, { module: 'core.treasury', permission: 'reports.read' }, async ({ tx, req }) =>
      fxDifferences(tx, fxDifferencesQuerySchema.parse(req.query)),
    ),
  );
};
