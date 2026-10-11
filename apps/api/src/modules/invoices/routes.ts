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
import { z } from 'zod';
import { forbidden, notFound, unprocessable } from '../../http/errors';
import { retryOutboxMessage, sourceDeliveries } from '../outbox/service';
import { invoiceDeliveries, sendInvoiceDocument, sendInvoiceDocumentSchema } from './deliveries';
import { salesChain, salesChainQuerySchema } from '../sales/chain';
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
    // Cevabı kaybolup yeniden gönderilen kayıt ikinci fatura oluşturmaz (Idempotency-Key)
    tenantRoute(app, { ...manage, idempotent: true }, async (c) => {
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

  // Satış belge zinciri (öneri 3): teklif → sipariş → irsaliye → fatura/iade → tahsilat; her aşama kendi yetkisiyle görünür
  app.get('/api/sales-chain', tenantRoute(app, read, async (c) => salesChain(c, salesChainQuerySchema.parse(c.req.query))));

  // Belge gönderimi (öneri 7): dışa aktarma işlemi sayılır; ileti kalıcı outbox'a yazılır, gönderim zamanlayıcıdadır
  const send = { ...read, operation: 'export' } as const;
  app.get(
    '/api/invoices/:id/deliveries',
    tenantRoute(app, read, async ({ tx, req }) => invoiceDeliveries(tx, idParam.parse(req.params).id)),
  );
  app.post(
    '/api/invoices/:id/deliveries',
    tenantRoute(app, { ...send, idempotent: true }, async (c) => {
      if (!app.mailer.enabled) throw unprocessable('Giden e-posta bu kurulumda yapılandırılmamış', 'MAIL_DISABLED');
      const key = c.req.headers['idempotency-key'];
      const result = await sendInvoiceDocument(c.tx, { companyId: c.company.id, userId: c.user.id }, idParam.parse(c.req.params).id, sendInvoiceDocumentSchema.parse(c.req.body), typeof key === 'string' ? key : null);
      c.reply.code(result.created ? 201 : 200);
      return { delivery: result.delivery };
    }),
  );
  app.post(
    '/api/invoices/:id/deliveries/:deliveryId/retry',
    tenantRoute(app, send, async ({ tx, req }) => {
      const { id, deliveryId } = z.object({ id: z.string().uuid(), deliveryId: z.string().uuid() }).parse(req.params);
      const own = (await sourceDeliveries(tx, 'invoice', id)).some((d) => d.id === deliveryId);
      if (!own) throw notFound('Gönderim kaydı');
      const row = await retryOutboxMessage(tx, deliveryId);
      return { delivery: { id: row.id, status: row.status } };
    }),
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
