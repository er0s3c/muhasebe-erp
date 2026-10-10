import type { FastifyPluginAsync } from 'fastify';
import {
  cancelInvoiceSchema,
  createInvoiceSchema,
  idParam,
  itemProfitQuerySchema,
  listInvoicesQuerySchema,
  salesReportQuerySchema,
  updateInvoiceSchema,
  vatSummaryQuerySchema,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { lockItems } from '../inventory/balances';
import { lockOrderLines } from '../sales/usage';
import { lockDeliveryLines } from './delivery-link';
import { itemProfitability, salesReport } from './analytics';
import { evaluateInvoiceMatch } from '../procurement/matching';
import { cancelInvoice, postInvoice } from './posting';
import { invoiceSummary, vatSummary } from './reports';
import { documentTaxRuleRoutes } from './tax-rules';
import { documentTaxReport } from './tax-report';
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

/**
 * Oluştur/güncelle + kaydet tek istekte yapılırken kilitler, satırlar yazılmadan ÖNCE alınmalıdır (aksi halde
 * satır eklerken yabancı anahtar denetiminin aldığı KEY SHARE kilidi sonradan FOR UPDATE'e yükselir ve aynı kartı/
 * irsaliye satırını kullanan eşzamanlı iki istek kilitlenir). Sıra, kayıt işlemindekiyle aynıdır: irsaliye satırları, kartlar.
 */
async function lockForPosting(tx: Tx, lines: readonly { itemId?: string | null; deliveryLineId?: string | null; salesOrderLineId?: string | null }[]) {
  await lockDeliveryLines(tx, lines.flatMap((l) => (l.deliveryLineId ? [l.deliveryLineId] : [])));
  await lockOrderLines(tx, lines.flatMap((l) => (l.salesOrderLineId ? [l.salesOrderLineId] : [])));
  await lockItems(tx, lines.flatMap((l) => (l.itemId ? [l.itemId] : [])));
}

export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  await app.register(documentTaxRuleRoutes);
  app.get('/api/reports/document-taxes', tenantRoute(app, { module: 'core.invoices', permission: 'reports.read' }, async ({ tx, req }) => documentTaxReport(tx, vatSummaryQuerySchema.parse(req.query))));
  const read = { module: 'core.invoices', permission: 'invoices.read' } as const;
  const manage = { module: 'core.invoices', permission: 'invoices.manage' } as const;
  const post = { module: 'core.invoices', permission: 'invoices.post' } as const;

  app.get(
    '/api/invoices',
    tenantRoute(app, read, async ({ tx, req }) => listInvoices(tx, listInvoicesQuerySchema.parse(req.query))),
  );

  app.get('/api/invoices/summary', tenantRoute(app, read, async ({ tx }) => invoiceSummary(tx)));

  app.get(
    '/api/invoices/:id/match',
    tenantRoute(app, read, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const { lines } = await getInvoice(tx, id);
      return { rows: await evaluateInvoiceMatch(tx, lines.map((l) => ({ lineNo: l.lineNo, poLineId: l.poLineId, quantity: l.quantity, net: l.net })), id) };
    }),
  );

  app.get(
    '/api/invoices/:id',
    tenantRoute(app, read, async ({ tx, req }) => getInvoice(tx, idParam.parse(req.params).id)),
  );

  app.post(
    '/api/invoices',
    tenantRoute(app, manage, async (c) => {
      const input = createInvoiceSchema.parse(c.req.body);
      // Taslak hazırlama ile muhasebeleştirme ayrı yetkilerdir
      if (input.post) c.require('invoices.post');
      if (input.matchOverrideReason && !c.can('procurement.approve')) throw forbidden('Eşleştirme sapmasını geçirmek için satın alma onay yetkisi gerekir');
      const ctx = invoiceCtx(c);
      if (input.post) await lockForPosting(c.tx, input.lines);
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
      if (input.post) c.require('invoices.post');
      if (input.matchOverrideReason && !c.can('procurement.approve')) throw forbidden('Eşleştirme sapmasını geçirmek için satın alma onay yetkisi gerekir');
      const ctx = invoiceCtx(c);
      if (input.post && input.lines) await lockForPosting(c.tx, input.lines);
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

  const reports = { module: 'core.invoices', permission: 'reports.read' } as const;
  app.get(
    '/api/reports/sales-report',
    tenantRoute(app, reports, async ({ tx, req }) => salesReport(tx, 'sales', salesReportQuerySchema.parse(req.query))),
  );
  app.get(
    '/api/reports/purchase-report',
    tenantRoute(app, reports, async ({ tx, req }) => salesReport(tx, 'purchases', salesReportQuerySchema.parse(req.query))),
  );
  app.get(
    '/api/reports/item-profitability',
    tenantRoute(app, reports, async ({ tx, req }) => itemProfitability(tx, itemProfitQuerySchema.parse(req.query))),
  );
};
