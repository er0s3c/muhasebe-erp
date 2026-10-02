import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { closeFiscalYearSchema, createFiscalYearSchema, previewFiscalYearQuerySchema, reopenFiscalYearSchema, uuid, isoDate } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import type { LedgerCtx } from '../ledger/journal';
import {
  DEFAULT_CLOSING_OPTIONS,
  closeFiscalYear,
  closedYearsOverlapping,
  createFiscalYear,
  deleteFiscalYear,
  getFiscalYear,
  listFiscalYears,
  preflight,
  previewClosing,
  reopenFiscalYear,
} from './service';

const idParam = z.object({ id: uuid });

const toLedgerCtx = (c: TenantCtx): LedgerCtx => ({
  companyId: c.company.id,
  userId: c.user.id,
  baseCurrency: c.company.baseCurrency,
  reportingCurrency: c.company.reportingCurrency,
});

/**
 * Yıl sonu kapanışı ve devir. Durum okuma `ledger.read` (muhasebeci dahil); ön kontrol, önizleme, kapanış ve yeniden açma
 * yalnızca `ledger.yearend` (sahip, yönetici). Hesap seçimleri ve yöntem doğrulanmamıştır (LEGAL-NOTES §23).
 */
export const yearEndRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.ledger', permission: 'ledger.read' } as const;
  const manage = { module: 'core.ledger', permission: 'ledger.yearend' } as const;

  app.get(
    '/api/fiscal-years',
    tenantRoute(app, read, async ({ tx }) => listFiscalYears(tx)),
  );

  /** Aralığa değen kapalı mali yıllar (defter sayfalarındaki "kapalı yıl" uyarısı için). */
  app.get(
    '/api/fiscal-years/closed',
    tenantRoute(app, read, async ({ tx, req }) => {
      const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
      return { years: await closedYearsOverlapping(tx, q.from, q.to) };
    }),
  );

  app.post(
    '/api/fiscal-years',
    tenantRoute(app, manage, async (c) => {
      const year = await createFiscalYear(c.tx, toLedgerCtx(c), createFiscalYearSchema.parse(c.req.body));
      void c.reply.code(201);
      return { year };
    }),
  );

  app.delete(
    '/api/fiscal-years/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteFiscalYear(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  app.get(
    '/api/fiscal-years/:id/preflight',
    tenantRoute(app, manage, async ({ tx, req, company }) => {
      const year = await getFiscalYear(tx, idParam.parse(req.params).id);
      const q = previewFiscalYearQuerySchema.parse(req.query);
      return { year, ...(await preflight(tx, company.baseCurrency, year, { ...DEFAULT_CLOSING_OPTIONS, ...q })) };
    }),
  );

  app.get(
    '/api/fiscal-years/:id/preview',
    tenantRoute(app, manage, async ({ tx, req, company }) => {
      const year = await getFiscalYear(tx, idParam.parse(req.params).id);
      const q = previewFiscalYearQuerySchema.parse(req.query);
      return previewClosing(tx, company.baseCurrency, year, { ...DEFAULT_CLOSING_OPTIONS, ...q });
    }),
  );

  app.post(
    '/api/fiscal-years/:id/close',
    tenantRoute(app, manage, async (c) => closeFiscalYear(c.tx, toLedgerCtx(c), idParam.parse(c.req.params).id, closeFiscalYearSchema.parse(c.req.body ?? {}))),
  );

  app.post(
    '/api/fiscal-years/:id/reopen',
    tenantRoute(app, manage, async (c) => ({
      year: await reopenFiscalYear(c.tx, toLedgerCtx(c), idParam.parse(c.req.params).id, reopenFiscalYearSchema.parse(c.req.body ?? {}).reason),
    })),
  );
};
