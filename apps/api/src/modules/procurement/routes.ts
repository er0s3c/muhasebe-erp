import type { FastifyPluginAsync } from 'fastify';
import {
  awardRfqSchema,
  cancelOrderSchema,
  cancelReceiptSchema,
  createPurchaseOrderSchema,
  createPurchaseRequestSchema,
  createReceiptSchema,
  createRfqSchema,
  idParam,
  purchaseOrderListQuerySchema,
  procurementSettingsSchema,
  purchaseRequestListQuerySchema,
  updatePurchaseOrderSchema,
  updatePurchaseRequestSchema,
  upsertOfferSchema,
  pageQuerySchema,
} from '@erp/shared';
import { z } from 'zod';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { pageOf } from '../../http/paging';
import type { ApprovalCtx } from '../approvals/service';
import { cancelOrder, closeOrder, createOrder, deleteOrder, getOrder, issueOrder, listOrders, updateOrder } from './orders';
import { getProcurementSettings, invoiceableOrderLines, orderMatchSummary, putProcurementSettings } from './matching';
import { cancelReceipt, createReceipt } from './receipts';
import {
  cancelPurchaseRequest,
  createRequest,
  deleteRequest,
  getRequest,
  listRequests,
  submitRequest,
  updateRequest,
  withdrawRequest,
  type ProcurementCtx,
} from './requests';
import { awardRfq, cancelRfq, createRfq, deleteOffer, getRfq, listRfqs, upsertOffer } from './rfq';

const pctx = ({ company, user }: TenantCtx): ProcurementCtx => ({ companyId: company.id, userId: user.id, baseCurrency: company.baseCurrency });
const actx = ({ company, user, role, access }: TenantCtx): ApprovalCtx => ({ companyId: company.id, userId: user.id, role, permissions: access.permissions });

export const procurementRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'construction.procurement';
  const read = { module: MODULE, permission: 'procurement.read' } as const;
  const manage = { module: MODULE, permission: 'procurement.manage' } as const;
  const approve = { module: MODULE, permission: 'procurement.approve' } as const;

  // --- Üçlü eşleştirme ----------------------------------------------------------------------------
  app.get('/api/procurement/settings', tenantRoute(app, read, async ({ tx }) => ({ settings: await getProcurementSettings(tx) })));
  app.put(
    '/api/procurement/settings',
    tenantRoute(app, manage, async ({ tx, company, req }) => ({ settings: await putProcurementSettings(tx, company.id, procurementSettingsSchema.parse(req.body)) })),
  );
  app.get('/api/procurement/invoiceable', tenantRoute(app, read, async ({ tx, req }) => {
    const q = z.object({ partyId: idParam.shape.id, currency: z.string().length(3) }).parse(req.query);
    return invoiceableOrderLines(tx, q.partyId, q.currency);
  }));
  app.get('/api/procurement/matching', tenantRoute(app, read, async ({ tx }) => orderMatchSummary(tx)));

  // --- Talepler ---------------------------------------------------------------------------------
  app.get('/api/purchase-requests', tenantRoute(app, read, async ({ tx, req }) => {
    const q = purchaseRequestListQuerySchema.parse(req.query);
    return listRequests(tx, q, pageOf(q));
  }));
  app.post(
    '/api/purchase-requests',
    tenantRoute(app, manage, async (c) => {
      const out = await createRequest(c.tx, pctx(c), createPurchaseRequestSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/purchase-requests/:id', tenantRoute(app, read, async ({ tx, req }) => getRequest(tx, idParam.parse(req.params).id)));
  app.put('/api/purchase-requests/:id', tenantRoute(app, manage, async (c) => updateRequest(c.tx, pctx(c), idParam.parse(c.req.params).id, updatePurchaseRequestSchema.parse(c.req.body))));
  app.delete(
    '/api/purchase-requests/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteRequest(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );
  app.post('/api/purchase-requests/:id/submit', tenantRoute(app, manage, async (c) => submitRequest(c.tx, pctx(c), actx(c), idParam.parse(c.req.params).id)));
  app.post('/api/purchase-requests/:id/withdraw', tenantRoute(app, manage, async (c) => withdrawRequest(c.tx, actx(c), idParam.parse(c.req.params).id)));
  app.post('/api/purchase-requests/:id/cancel', tenantRoute(app, manage, async ({ tx, req }) => cancelPurchaseRequest(tx, idParam.parse(req.params).id)));

  // --- RFQ ve teklifler ----------------------------------------------------------------------------
  app.get('/api/rfqs', tenantRoute(app, read, async ({ tx, req }) => listRfqs(tx, pageOf(pageQuerySchema.parse(req.query)))));
  app.post(
    '/api/rfqs',
    tenantRoute(app, manage, async (c) => {
      const out = await createRfq(c.tx, pctx(c), createRfqSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/rfqs/:id', tenantRoute(app, read, async ({ tx, req }) => getRfq(tx, idParam.parse(req.params).id)));
  app.put('/api/rfqs/:id/offers', tenantRoute(app, manage, async (c) => upsertOffer(c.tx, pctx(c), idParam.parse(c.req.params).id, upsertOfferSchema.parse(c.req.body))));
  app.delete(
    '/api/rfqs/:id/offers/:offerId',
    tenantRoute(app, manage, async ({ tx, req }) => {
      const p = z.object({ id: z.uuid(), offerId: z.uuid() }).parse(req.params);
      return deleteOffer(tx, p.id, p.offerId);
    }),
  );
  // Teklif seçimi sipariş taslağı açar: onaylayıcı izni ister
  app.post(
    '/api/rfqs/:id/award',
    tenantRoute(app, approve, async (c) => {
      const out = await awardRfq(c.tx, pctx(c), idParam.parse(c.req.params).id, awardRfqSchema.parse(c.req.body).offerId);
      void c.reply.code(201);
      return out;
    }),
  );
  app.post('/api/rfqs/:id/cancel', tenantRoute(app, manage, async ({ tx, req }) => cancelRfq(tx, idParam.parse(req.params).id)));

  // --- Siparişler -------------------------------------------------------------------------------------
  app.get('/api/purchase-orders', tenantRoute(app, read, async ({ tx, req }) => {
    const q = purchaseOrderListQuerySchema.parse(req.query);
    return listOrders(tx, q, pageOf(q));
  }));
  app.post(
    '/api/purchase-orders',
    tenantRoute(app, manage, async (c) => {
      const out = await createOrder(c.tx, pctx(c), createPurchaseOrderSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/purchase-orders/:id', tenantRoute(app, read, async ({ tx, req }) => getOrder(tx, idParam.parse(req.params).id)));
  app.put('/api/purchase-orders/:id', tenantRoute(app, manage, async (c) => updateOrder(c.tx, pctx(c), idParam.parse(c.req.params).id, updatePurchaseOrderSchema.parse(c.req.body))));
  app.delete(
    '/api/purchase-orders/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteOrder(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );
  // Siparişi vermek taahhüt yaratır: onaylayıcı izni ister
  app.post('/api/purchase-orders/:id/issue', tenantRoute(app, approve, async ({ tx, req }) => issueOrder(tx, idParam.parse(req.params).id)));
  app.post('/api/purchase-orders/:id/close', tenantRoute(app, approve, async ({ tx, req }) => closeOrder(tx, idParam.parse(req.params).id)));
  app.post('/api/purchase-orders/:id/cancel', tenantRoute(app, approve, async ({ tx, req }) => cancelOrder(tx, idParam.parse(req.params).id, cancelOrderSchema.parse(req.body).reason)));

  // --- Mal kabul ---------------------------------------------------------------------------------------
  app.post(
    '/api/purchase-orders/:id/receipts',
    tenantRoute(app, manage, async (c) => {
      const out = await createReceipt(c.tx, pctx(c), idParam.parse(c.req.params).id, createReceiptSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.post(
    '/api/po-receipts/:id/cancel',
    tenantRoute(app, approve, async (c) => {
      const body = cancelReceiptSchema.parse(c.req.body);
      return cancelReceipt(c.tx, pctx(c), idParam.parse(c.req.params).id, body.reason, body.date);
    }),
  );
};
