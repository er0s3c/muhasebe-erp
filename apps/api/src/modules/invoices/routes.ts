import type { FastifyPluginAsync } from 'fastify';
import {
  cancelInvoiceSchema,
  createInvoiceSchema,
  hasPermission,
  idParam,
  listInvoicesQuerySchema,
  updateInvoiceSchema,
  vatSummaryQuerySchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { cancelInvoice, postInvoice } from './posting';
import { invoiceSummary, vatSummary } from './reports';
import {
  createInvoiceDraft,
  deleteInvoiceDraft,
  getInvoice,
  listInvoices,
  updateInvoiceDraft,
  type InvoiceCtx,
} from './service';

const invoiceCtx = ({ company, user }: TenantCtx): InvoiceCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
  allowNegativeStock: company.allowNegativeStock,
});

export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.invoices', permission: 'invoices.read' } as const;
  const manage = { module: 'core.invoices', permission: 'invoices.manage' } as const;
  const post = { module: 'core.invoices', permission: 'invoices.post' } as const;

  app.get(
    '/api/invoices',
    tenantRoute(app, read, async ({ tx, req }) => listInvoices(tx, listInvoicesQuerySchema.parse(req.query))),
  );

  app.get('/api/invoices/summary', tenantRoute(app, read, async ({ tx }) => invoiceSummary(tx)));

  app.get(
    '/api/invoices/:id',
    tenantRoute(app, read, async ({ tx, req }) => getInvoice(tx, idParam.parse(req.params).id)),
  );

  app.post(
    '/api/invoices',
    tenantRoute(app, manage, async (c) => {
      const input = createInvoiceSchema.parse(c.req.body);
      // Taslak hazırlama ile muhasebeleştirme ayrı yetkilerdir
      if (input.post && !hasPermission(c.role, 'invoices.post')) throw forbidden();
      const ctx = invoiceCtx(c);
      const id = await createInvoiceDraft(c.tx, ctx, input);
      const result = input.post ? await postInvoice(c.tx, ctx, id) : await getInvoice(c.tx, id);
      void c.reply.code(201);
      return result;
    }),
  );

  app.put(
    '/api/invoices/:id',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const input = updateInvoiceSchema.parse(c.req.body);
      if (input.post && !hasPermission(c.role, 'invoices.post')) throw forbidden();
      const ctx = invoiceCtx(c);
      await updateInvoiceDraft(c.tx, ctx, id, input);
      return input.post ? postInvoice(c.tx, ctx, id) : getInvoice(c.tx, id);
    }),
  );

  app.delete(
    '/api/invoices/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteInvoiceDraft(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  app.post(
    '/api/invoices/:id/post',
    tenantRoute(app, post, async (c) => postInvoice(c.tx, invoiceCtx(c), idParam.parse(c.req.params).id)),
  );

  app.post(
    '/api/invoices/:id/cancel',
    tenantRoute(app, post, async (c) =>
      cancelInvoice(c.tx, invoiceCtx(c), idParam.parse(c.req.params).id, cancelInvoiceSchema.parse(c.req.body)),
    ),
  );

  app.get(
    '/api/reports/vat-summary',
    tenantRoute(app, { module: 'core.invoices', permission: 'reports.read' }, async ({ tx, req }) =>
      vatSummary(tx, vatSummaryQuerySchema.parse(req.query)),
    ),
  );
};
