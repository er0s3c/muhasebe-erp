import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
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
  decideApprovalSchema,
  supplierPerformanceQuerySchema,
  type Permission,
} from '@erp/shared';
import { z } from 'zod';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { pageOf } from '../../http/paging';
import { conflict, forbidden, notFound } from '../../http/errors';
import { isModuleDenied, moduleAccessDenied } from '../access/effective';
import { decide, getRequest as getApprovalRequest, pendingForMe, type ApprovalCtx } from '../approvals/service';
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
import { supplierPerformance } from './performance';
import { replenishmentSuggestions, requireCompanyStockScope } from './replenishment';

const pctx = ({ company, user }: TenantCtx): ProcurementCtx => ({ companyId: company.id, userId: user.id, baseCurrency: company.baseCurrency, sector: company.sector });
const actx = ({ company, user, role, access }: TenantCtx): ApprovalCtx => ({ companyId: company.id, userId: user.id, role, permissions: access.permissions });

/** Aynı satın alma API'si şantiyede legacy, deri sektöründe genel tedarik modülüne bağlıdır. */
function procurementRoute<T>(app: FastifyInstance, options: { permission: Permission }, handler: (ctx: TenantCtx) => Promise<T>) {
  return tenantRoute(app, options, async (c) => {
    const module = c.company.sector === 'CONSTRUCTION' ? 'construction.procurement' : 'core.procurement';
    if (!c.enabledModules.has(module)) throw forbidden('Satın alma modülü şirketinizde etkin değil', 'MODULE_DISABLED');
    if (isModuleDenied(c.access, module)) throw moduleAccessDenied();
    return handler(c);
  });
}

export const procurementRoutes: FastifyPluginAsync = async (app) => {
  const read = { permission: 'procurement.read' } as const;
  const manage = { permission: 'procurement.manage' } as const;
  const approve = { permission: 'procurement.approve' } as const;

  const stockScope = (c: TenantCtx) => {
    requireCompanyStockScope(c.branch);
    c.require('inventory.read');
    if (!c.enabledModules.has('core.inventory') || isModuleDenied(c.access, 'core.inventory')) throw moduleAccessDenied();
  };
  app.get('/api/procurement/replenishment', procurementRoute(app, read, async c => {
    stockScope(c);
    return replenishmentSuggestions(c.tx, c.company.baseCurrency);
  }));
  app.post('/api/procurement/replenishment/draft', procurementRoute(app, manage, async c => {
    stockScope(c);
    const input = z.object({ projectId: z.uuid().nullable().optional(), needDate: z.iso.date().nullable().optional(),
      items: z.array(z.object({ itemId: z.uuid(), quantity: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/) })).min(1).max(300)
    }).parse(c.req.body);
    await c.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${c.company.id}),hashtext('stock-replenishment'))`);
    const suggestions = await replenishmentSuggestions(c.tx, c.company.baseCurrency);
    const ids = new Set<string>();
    const lines = input.items.map(item => {
      const row = suggestions.rows.find(row => row.itemId === item.itemId);
      if (ids.has(item.itemId) || !row?.suggested || Number(row.suggested) <= 0 || row.suggested !== item.quantity)
        throw conflict('Stok veya açık satın alma miktarı değişti. Öneriyi yenileyip tekrar seçin.', 'REPLENISHMENT_CHANGED');
      ids.add(item.itemId);
      return { itemId: row.itemId, description: row.name, unit: row.unit, quantity: row.suggested, estUnitPrice: row.estimateUnitPrice };
    });
    const output = await createRequest(c.tx, pctx(c), createPurchaseRequestSchema.parse({ projectId: input.projectId, needDate: input.needDate,
      title: 'Minimum ve hedef stok tamamlama', note: 'Öneri kaydedilirken güncel stok, açık siparişler ve talepler tekrar kontrol edildi. Tahmini fiyatları ve ihtiyacı onaya göndermeden önce inceleyin.', lines }));
    void c.reply.code(201);
    return output;
  }));

  app.get('/api/reports/supplier-performance', procurementRoute(app, read, async ({tx,req,company}) =>
    supplierPerformance(tx,company.timeZone,supplierPerformanceQuerySchema.parse(req.query)),
  ));

  app.get('/api/procurement/approvals/inbox', procurementRoute(app, read, async (c) => ({ requests: (await pendingForMe(c.tx, actx(c))).filter((r) => r.docType === 'purchase_request') })));
  app.post('/api/procurement/approvals/:id/decide', procurementRoute(app, approve, async (c) => {
    const id = idParam.parse(c.req.params).id;
    const request = await getApprovalRequest(c.tx, id);
    if (request.docType !== 'purchase_request') throw notFound('Satın alma onayı');
    return { request: await decide(c.tx, actx(c), id, decideApprovalSchema.parse(c.req.body)) };
  }));

  // --- Üçlü eşleştirme ----------------------------------------------------------------------------
  app.get('/api/procurement/settings', procurementRoute(app, read, async ({ tx }) => ({ settings: await getProcurementSettings(tx) })));
  app.put(
    '/api/procurement/settings',
    procurementRoute(app, manage, async ({ tx, company, req }) => ({ settings: await putProcurementSettings(tx, company.id, procurementSettingsSchema.parse(req.body)) })),
  );
  app.get('/api/procurement/invoiceable', procurementRoute(app, read, async ({ tx, req }) => {
    const q = z.object({ partyId: idParam.shape.id, currency: z.string().length(3) }).parse(req.query);
    return invoiceableOrderLines(tx, q.partyId, q.currency);
  }));
  app.get('/api/procurement/matching', procurementRoute(app, read, async ({ tx }) => orderMatchSummary(tx)));

  // --- Talepler ---------------------------------------------------------------------------------
  app.get('/api/purchase-requests', procurementRoute(app, read, async ({ tx, req }) => {
    const q = purchaseRequestListQuerySchema.parse(req.query);
    return listRequests(tx, q, pageOf(q));
  }));
  app.post(
    '/api/purchase-requests',
    procurementRoute(app, manage, async (c) => {
      const out = await createRequest(c.tx, pctx(c), createPurchaseRequestSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/purchase-requests/:id', procurementRoute(app, read, async ({ tx, req }) => getRequest(tx, idParam.parse(req.params).id)));
  app.put('/api/purchase-requests/:id', procurementRoute(app, manage, async (c) => updateRequest(c.tx, pctx(c), idParam.parse(c.req.params).id, updatePurchaseRequestSchema.parse(c.req.body))));
  app.delete(
    '/api/purchase-requests/:id',
    procurementRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteRequest(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );
  app.post('/api/purchase-requests/:id/submit', procurementRoute(app, manage, async (c) => submitRequest(c.tx, pctx(c), actx(c), idParam.parse(c.req.params).id)));
  app.post('/api/purchase-requests/:id/withdraw', procurementRoute(app, manage, async (c) => withdrawRequest(c.tx, actx(c), idParam.parse(c.req.params).id)));
  app.post('/api/purchase-requests/:id/cancel', procurementRoute(app, manage, async ({ tx, req }) => cancelPurchaseRequest(tx, idParam.parse(req.params).id)));

  // --- RFQ ve teklifler ----------------------------------------------------------------------------
  app.get('/api/rfqs', procurementRoute(app, read, async ({ tx, req }) => listRfqs(tx, pageOf(pageQuerySchema.parse(req.query)))));
  app.post(
    '/api/rfqs',
    procurementRoute(app, manage, async (c) => {
      const out = await createRfq(c.tx, pctx(c), createRfqSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/rfqs/:id', procurementRoute(app, read, async ({ tx, req }) => getRfq(tx, idParam.parse(req.params).id)));
  app.put('/api/rfqs/:id/offers', procurementRoute(app, manage, async (c) => upsertOffer(c.tx, pctx(c), idParam.parse(c.req.params).id, upsertOfferSchema.parse(c.req.body))));
  app.delete(
    '/api/rfqs/:id/offers/:offerId',
    procurementRoute(app, manage, async ({ tx, req }) => {
      const p = z.object({ id: z.uuid(), offerId: z.uuid() }).parse(req.params);
      return deleteOffer(tx, p.id, p.offerId);
    }),
  );
  // Teklif seçimi sipariş taslağı açar: onaylayıcı izni ister
  app.post(
    '/api/rfqs/:id/award',
    procurementRoute(app, approve, async (c) => {
      const out = await awardRfq(c.tx, pctx(c), idParam.parse(c.req.params).id, awardRfqSchema.parse(c.req.body).offerId);
      void c.reply.code(201);
      return out;
    }),
  );
  app.post('/api/rfqs/:id/cancel', procurementRoute(app, manage, async ({ tx, req }) => cancelRfq(tx, idParam.parse(req.params).id)));

  // --- Siparişler -------------------------------------------------------------------------------------
  app.get('/api/purchase-orders', procurementRoute(app, read, async ({ tx, req }) => {
    const q = purchaseOrderListQuerySchema.parse(req.query);
    return listOrders(tx, q, pageOf(q));
  }));
  app.post(
    '/api/purchase-orders',
    procurementRoute(app, manage, async (c) => {
      const out = await createOrder(c.tx, pctx(c), createPurchaseOrderSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/purchase-orders/:id', procurementRoute(app, read, async ({ tx, req }) => getOrder(tx, idParam.parse(req.params).id)));
  app.put('/api/purchase-orders/:id', procurementRoute(app, manage, async (c) => updateOrder(c.tx, pctx(c), idParam.parse(c.req.params).id, updatePurchaseOrderSchema.parse(c.req.body))));
  app.delete(
    '/api/purchase-orders/:id',
    procurementRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteOrder(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );
  // Siparişi vermek taahhüt yaratır: onaylayıcı izni ister
  app.post('/api/purchase-orders/:id/issue', procurementRoute(app, approve, async ({ tx, req }) => issueOrder(tx, idParam.parse(req.params).id)));
  app.post('/api/purchase-orders/:id/close', procurementRoute(app, approve, async ({ tx, req }) => closeOrder(tx, idParam.parse(req.params).id)));
  app.post('/api/purchase-orders/:id/cancel', procurementRoute(app, approve, async ({ tx, req }) => cancelOrder(tx, idParam.parse(req.params).id, cancelOrderSchema.parse(req.body).reason)));

  // --- Mal kabul ---------------------------------------------------------------------------------------
  app.post(
    '/api/purchase-orders/:id/receipts',
    procurementRoute(app, manage, async (c) => {
      const out = await createReceipt(c.tx, pctx(c), idParam.parse(c.req.params).id, createReceiptSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.post(
    '/api/po-receipts/:id/cancel',
    procurementRoute(app, approve, async (c) => {
      const body = cancelReceiptSchema.parse(c.req.body);
      return cancelReceipt(c.tx, pctx(c), idParam.parse(c.req.params).id, body.reason, body.date);
    }),
  );
};
