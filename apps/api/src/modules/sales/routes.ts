import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  batchPreviewQuerySchema,
  batchRunSchema,
  createSalesDocSchema,
  hasPermission,
  idParam,
  listSalesDocsQuerySchema,
  orderToDeliverySchema,
  orderToInvoiceSchema,
  salesDocActionSchema,
  updateSalesDocSchema,
  type SalesDocStatus,
} from '@erp/shared';
import { sql } from 'drizzle-orm';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { orderToDelivery, orderToInvoice } from './convert';
import { batchPreview, runBatch } from './batch';
import {
  convertQuote,
  createSalesDoc,
  deleteSalesDoc,
  getSalesDoc,
  listSalesDocs,
  transitionSalesDoc,
  updateSalesDoc,
  type SalesCtx,
} from './orders';

const salesCtx = ({ company, user }: TenantCtx): SalesCtx => ({ companyId: company.id, userId: user.id, baseCurrency: company.baseCurrency });
const docCtx = ({ company, user }: TenantCtx) => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
  allowNegativeStock: company.allowNegativeStock,
});

/** Durum eylemleri: yol → geçiş. Hepsi `invoices.manage` ile; stok/yevmiye etkisi yoktur. */
const ACTIONS: Record<string, SalesDocStatus> = {
  send: 'sent',
  accept: 'accepted',
  reject: 'rejected',
  reopen: 'draft',
  cancel: 'cancelled',
  confirm: 'confirmed',
  close: 'closed',
};

export const salesRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'invoices.orders', permission: 'invoices.read' } as const;
  const manage = { module: 'invoices.orders', permission: 'invoices.manage' } as const;
  const toDelivery = { module: 'invoices.orders', permission: 'deliveries.manage' } as const;

  app.get('/api/sales-docs', tenantRoute(app, read, async ({ tx, req }) => listSalesDocs(tx, listSalesDocsQuerySchema.parse(req.query))));
  app.get('/api/sales-docs/:id', tenantRoute(app, read, async ({ tx, req }) => getSalesDoc(tx, idParam.parse(req.params).id)));

  app.post(
    '/api/sales-docs',
    tenantRoute(app, manage, async (c) => {
      const input = createSalesDocSchema.parse(c.req.body);
      const id = await createSalesDoc(c.tx, salesCtx(c), input);
      void c.reply.code(201);
      return getSalesDoc(c.tx, id);
    }),
  );

  app.put(
    '/api/sales-docs/:id',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      await updateSalesDoc(c.tx, salesCtx(c), id, updateSalesDocSchema.parse(c.req.body));
      return getSalesDoc(c.tx, id);
    }),
  );

  app.delete(
    '/api/sales-docs/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteSalesDoc(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  for (const [path, to] of Object.entries(ACTIONS)) {
    app.post(
      `/api/sales-docs/:id/${path}`,
      tenantRoute(app, manage, async (c) => {
        const { id } = idParam.parse(c.req.params);
        const body = salesDocActionSchema.parse(c.req.body ?? {});
        await transitionSalesDoc(c.tx, salesCtx(c), id, to, body.reason);
        return getSalesDoc(c.tx, id);
      }),
    );
  }

  app.post(
    '/api/sales-docs/:id/convert',
    tenantRoute(app, manage, async (c) => {
      const orderId = await convertQuote(c.tx, salesCtx(c), idParam.parse(c.req.params).id);
      void c.reply.code(201);
      return { orderId };
    }),
  );

  app.post(
    '/api/sales-docs/:id/delivery-note',
    tenantRoute(app, toDelivery, async (c) => {
      const noteId = await orderToDelivery(c.tx, docCtx(c), idParam.parse(c.req.params).id, orderToDeliverySchema.parse(c.req.body ?? {}));
      void c.reply.code(201);
      return { noteId };
    }),
  );

  app.post(
    '/api/sales-docs/:id/invoice',
    tenantRoute(app, manage, async (c) => {
      // Fatura taslağı yetkisi invoices.manage'dır (kayıt ayrıca invoices.post)
      const invoiceId = await orderToInvoice(c.tx, docCtx(c), idParam.parse(c.req.params).id, orderToInvoiceSchema.parse(c.req.body ?? {}));
      void c.reply.code(201);
      return { invoiceId };
    }),
  );

  // --- Toplu faturalama (çekirdek fatura modülü; sipariş modülünden bağımsız) ---
  const core = { module: 'core.invoices', permission: 'invoices.manage' } as const;

  app.get('/api/invoice-batches/preview', tenantRoute(app, core, async ({ tx, req }) => batchPreview(tx, batchPreviewQuerySchema.parse(req.query))));

  app.post(
    '/api/invoice-batches',
    tenantRoute(app, core, async (c) => {
      const input = batchRunSchema.parse(c.req.body);
      if (input.post && !hasPermission(c.role, 'invoices.post')) throw forbidden();
      const result = await runBatch(c.tx, docCtx(c), input);
      void c.reply.code(201);
      return result;
    }),
  );

  app.get(
    '/api/invoice-batches',
    tenantRoute(app, core, async ({ tx, req }) => {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
      const rows = await tx.execute<Record<string, unknown>>(sql`
        select b.id, b.invoice_date::text as "invoiceDate", b.grouping, b.post, b.invoices_created as "invoicesCreated",
               b.invoices_failed as "invoicesFailed", b.created_at as "createdAt", u.full_name as "userName"
        from invoice_batches b left join users u on u.id = b.created_by
        order by b.created_at desc limit ${limit}`);
      return { batches: rows.rows };
    }),
  );

  app.get(
    '/api/invoice-batches/:id',
    tenantRoute(app, core, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const items = await tx.execute<Record<string, unknown>>(sql`
        select i.id, i.status, i.party_id as "partyId", p.name as "partyName", i.invoice_id as "invoiceId",
               inv.invoice_no as "invoiceNo", inv.status as "invoiceStatus", i.error_code as "errorCode", i.error_message as "errorMessage",
               i.note_ids as "noteIds"
        from invoice_batch_items i join parties p on p.id = i.party_id left join invoices inv on inv.id = i.invoice_id
        where i.batch_id = ${id} order by i.created_at, i.id`);
      return { items: items.rows };
    }),
  );
};
