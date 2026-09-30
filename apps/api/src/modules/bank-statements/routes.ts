import type { FastifyPluginAsync } from 'fastify';
import { createFromLineSchema, idParam, ignoreLineSchema, matchLineSchema, reconciliationQuerySchema } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import type { LedgerCtx } from '../ledger/journal';
import { autoMatch, createTransactionFromLine, deleteStatement, ignoreLine, matchLine, reconciliation, restoreLine, unmatchLine } from './service';

const ledgerCtx = ({ company, user }: TenantCtx): LedgerCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
});

/**
 * Banka mutabakatı: ekstre satırları ile bağlı muhasebe hesabının defter satırlarını eşleştirir. Okuma `treasury.read`,
 * eşleştirme/hareket oluşturma/geri alma `treasury.post` ister. (Ekstre içe aktarma `/api/imports/bank_statement/…`.)
 */
export const bankStatementRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.treasury', permission: 'treasury.read' } as const;
  const post = { module: 'core.treasury', permission: 'treasury.post' } as const;

  app.get(
    '/api/treasury/accounts/:id/reconciliation',
    tenantRoute(app, read, async ({ tx, req }) => reconciliation(tx, idParam.parse(req.params).id, reconciliationQuerySchema.parse(req.query))),
  );

  app.post(
    '/api/treasury/accounts/:id/reconciliation/auto-match',
    tenantRoute(app, post, async (c) =>
      autoMatch(c.tx, ledgerCtx(c), idParam.parse(c.req.params).id, reconciliationQuerySchema.parse(c.req.body ?? {})),
    ),
  );

  app.post(
    '/api/bank-statement-lines/:id/match',
    tenantRoute(app, post, async (c) => ({
      line: await matchLine(c.tx, ledgerCtx(c), idParam.parse(c.req.params).id, matchLineSchema.parse(c.req.body).journalLineId),
    })),
  );

  app.post(
    '/api/bank-statement-lines/:id/unmatch',
    tenantRoute(app, post, async ({ tx, req }) => ({ line: await unmatchLine(tx, idParam.parse(req.params).id) })),
  );

  app.post(
    '/api/bank-statement-lines/:id/ignore',
    tenantRoute(app, post, async ({ tx, req }) => ({
      line: await ignoreLine(tx, idParam.parse(req.params).id, ignoreLineSchema.parse(req.body ?? {}).reason),
    })),
  );

  app.post(
    '/api/bank-statement-lines/:id/restore',
    tenantRoute(app, post, async ({ tx, req }) => ({ line: await restoreLine(tx, idParam.parse(req.params).id) })),
  );

  app.post(
    '/api/bank-statement-lines/:id/create-transaction',
    tenantRoute(app, post, async (c) => {
      const result = await createTransactionFromLine(c.tx, ledgerCtx(c), idParam.parse(c.req.params).id, createFromLineSchema.parse(c.req.body));
      void c.reply.code(201);
      return result;
    }),
  );

  app.delete(
    '/api/bank-statements/:id',
    tenantRoute(app, post, async ({ tx, req }) => {
      await deleteStatement(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );
};
