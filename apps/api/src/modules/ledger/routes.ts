import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  accountLedgerQuerySchema,
  createAccountSchema,
  createJournalSchema,
  isoDate,
  reverseJournalSchema,
  trialBalanceQuerySchema,
  updateAccountSchema,
  uuid,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { createAccount, listAccounts, updateAccount } from './accounts';
import {
  backfillReporting,
  createJournalEntry,
  deleteDraftEntry,
  getJournalEntry,
  listJournalEntries,
  postJournalEntry,
  reverseJournalEntry,
  updateDraftEntry,
  type LedgerCtx,
} from './journal';
import { accountLedger, trialBalance } from './reports';

const idParam = z.object({ id: uuid });

const toLedgerCtx = (c: TenantCtx): LedgerCtx => ({
  companyId: c.company.id,
  userId: c.user.id,
  baseCurrency: c.company.baseCurrency,
  reportingCurrency: c.company.reportingCurrency,
});

export const ledgerRoutes: FastifyPluginAsync = async (app) => {
  const ledger = (permission: 'ledger.read' | 'ledger.post' | 'accounts.manage' | 'reports.read') =>
    ({ module: 'core.ledger', permission }) as const;

  // ---- Hesap planı ------------------------------------------------------
  app.get(
    '/api/accounts',
    tenantRoute(app, ledger('ledger.read'), async ({ tx }) => ({ accounts: await listAccounts(tx) })),
  );

  app.post(
    '/api/accounts',
    tenantRoute(app, ledger('accounts.manage'), async ({ tx, req, reply, company }) => {
      const input = createAccountSchema.parse(req.body);
      const account = await createAccount(tx, company.id, input);
      void reply.code(201);
      return { account };
    }),
  );

  app.patch(
    '/api/accounts/:id',
    tenantRoute(app, ledger('accounts.manage'), async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      return { account: await updateAccount(tx, id, updateAccountSchema.parse(req.body)) };
    }),
  );

  // ---- Yevmiye ----------------------------------------------------------
  app.get(
    '/api/journal-entries',
    tenantRoute(app, ledger('ledger.read'), async ({ tx, req }) => {
      const q = z
        .object({
          from: isoDate.optional(),
          to: isoDate.optional(),
          status: z.enum(['draft', 'posted']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(req.query);
      return { entries: await listJournalEntries(tx, q) };
    }),
  );

  app.get(
    '/api/journal-entries/:id',
    tenantRoute(app, ledger('ledger.read'), async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      return { entry: await getJournalEntry(tx, id) };
    }),
  );

  app.post(
    '/api/journal-entries',
    tenantRoute(app, ledger('ledger.post'), async (c) => {
      const input = createJournalSchema.parse(c.req.body);
      const entry = await createJournalEntry(c.tx, toLedgerCtx(c), input);
      void c.reply.code(201);
      return { entry };
    }),
  );

  app.put(
    '/api/journal-entries/:id',
    tenantRoute(app, ledger('ledger.post'), async (c) => {
      const { id } = idParam.parse(c.req.params);
      const input = createJournalSchema.parse(c.req.body);
      return { entry: await updateDraftEntry(c.tx, toLedgerCtx(c), id, input) };
    }),
  );

  app.delete(
    '/api/journal-entries/:id',
    tenantRoute(app, ledger('ledger.post'), async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      await deleteDraftEntry(tx, id);
      return { ok: true };
    }),
  );

  app.post(
    '/api/journal-entries/:id/post',
    tenantRoute(app, ledger('ledger.post'), async (c) => {
      const { id } = idParam.parse(c.req.params);
      return { entry: await postJournalEntry(c.tx, toLedgerCtx(c), id) };
    }),
  );

  app.post(
    '/api/journal-entries/:id/reverse',
    tenantRoute(app, ledger('ledger.post'), async (c) => {
      const { id } = idParam.parse(c.req.params);
      const input = reverseJournalSchema.parse(c.req.body ?? {});
      const entry = await reverseJournalEntry(c.tx, toLedgerCtx(c), id, input);
      void c.reply.code(201);
      return { entry };
    }),
  );

  /** Kur sonradan girildiyse, raporlama tutarı boş kalan satırları doldurur. */
  app.post(
    '/api/ledger/backfill-reporting',
    tenantRoute(app, { module: 'core.ledger', permission: 'rates.manage' }, async (c) =>
      backfillReporting(c.tx, toLedgerCtx(c)),
    ),
  );

  // ---- Raporlar ---------------------------------------------------------
  app.get(
    '/api/reports/trial-balance',
    tenantRoute(app, ledger('reports.read'), async ({ tx, req, company }) => {
      const q = trialBalanceQuerySchema.parse(req.query);
      return trialBalance(tx, {
        ...q,
        baseCurrency: company.baseCurrency,
        reportingCurrency: company.reportingCurrency,
      });
    }),
  );

  app.get(
    '/api/reports/account-ledger',
    tenantRoute(app, ledger('reports.read'), async ({ tx, req }) => {
      return accountLedger(tx, accountLedgerQuerySchema.parse(req.query));
    }),
  );
};
