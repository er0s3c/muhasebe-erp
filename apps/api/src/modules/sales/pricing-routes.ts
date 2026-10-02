import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  adjustPriceListSchema,
  copyPriceListSchema,
  createPriceListSchema,
  idParam,
  isoDate,
  listPartyPricesQuerySchema,
  listPriceListItemsQuerySchema,
  listPriceListsQuerySchema,
  partyPriceSchema,
  partyPricingSchema,
  priceListItemSchema,
  resolvePriceQuerySchema,
  updatePriceListItemSchema,
  updatePriceListSchema,
} from '@erp/shared';
import { tenantRoute } from '../../http/context';
import {
  addPartyPrice,
  addPriceListItem,
  adjustPriceList,
  bulkUpsertPriceListItems,
  copyPriceList,
  createPriceList,
  deletePartyPrice,
  deletePriceList,
  deletePriceListItem,
  getPartyPricing,
  getPriceList,
  listPartyPrices,
  listPriceListItems,
  listPriceLists,
  setPartyPricing,
  suggestPrice,
  updatePartyPrice,
  updatePriceList,
  updatePriceListItem,
} from './pricelists';

const bulkSchema = z.object({
  rows: z
    .array(
      z.object({
        itemCode: z.string().trim().min(1).max(30),
        minQty: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/).optional(),
        price: z.string().regex(/^\d{1,15}(\.\d{1,6})?$/),
        validFrom: isoDate.nullable().optional(),
        validTo: isoDate.nullable().optional(),
      }),
    )
    .min(1)
    .max(2000),
});
const rowParam = z.object({ id: z.uuid(), rowId: z.uuid() });

export const pricingRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'sales.pricelists', permission: 'invoices.read' } as const;
  const manage = { module: 'sales.pricelists', permission: 'invoices.manage' } as const;
  // Satır girişinde öneri: fiyat çözümleyicisi her zaman çalışır (modül kapalıyken yalnızca kart fiyatı + önceki veri)
  const suggest = { module: 'core.invoices', permission: 'invoices.read' } as const;

  app.get('/api/price-resolution', tenantRoute(app, suggest, async ({ tx, req }) => suggestPrice(tx, resolvePriceQuerySchema.parse(req.query))));

  app.get('/api/price-lists', tenantRoute(app, read, async ({ tx, req }) => listPriceLists(tx, listPriceListsQuerySchema.parse(req.query))));
  app.get('/api/price-lists/:id', tenantRoute(app, read, async ({ tx, req }) => getPriceList(tx, idParam.parse(req.params).id)));
  app.post(
    '/api/price-lists',
    tenantRoute(app, manage, async (c) => {
      const row = await createPriceList(c.tx, c.company.id, createPriceListSchema.parse(c.req.body));
      void c.reply.code(201);
      return getPriceList(c.tx, row.id);
    }),
  );
  app.put(
    '/api/price-lists/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      await updatePriceList(tx, id, updatePriceListSchema.parse(req.body));
      return getPriceList(tx, id);
    }),
  );
  app.delete(
    '/api/price-lists/:id',
    tenantRoute(app, manage, async (c) => {
      await deletePriceList(c.tx, idParam.parse(c.req.params).id);
      void c.reply.code(204);
      return null;
    }),
  );
  app.post(
    '/api/price-lists/:id/copy',
    tenantRoute(app, manage, async (c) => {
      const row = await copyPriceList(c.tx, c.company.id, idParam.parse(c.req.params).id, copyPriceListSchema.parse(c.req.body));
      void c.reply.code(201);
      return getPriceList(c.tx, row.id);
    }),
  );
  app.post(
    '/api/price-lists/:id/adjust',
    tenantRoute(app, manage, async ({ tx, req }) => adjustPriceList(tx, idParam.parse(req.params).id, adjustPriceListSchema.parse(req.body))),
  );

  app.get(
    '/api/price-lists/:id/items',
    tenantRoute(app, read, async ({ tx, req }) => listPriceListItems(tx, idParam.parse(req.params).id, listPriceListItemsQuerySchema.parse(req.query))),
  );
  app.post(
    '/api/price-lists/:id/items',
    tenantRoute(app, manage, async (c) => {
      const row = await addPriceListItem(c.tx, c.company.id, idParam.parse(c.req.params).id, priceListItemSchema.parse(c.req.body));
      void c.reply.code(201);
      return row;
    }),
  );
  app.post(
    '/api/price-lists/:id/items/bulk',
    tenantRoute(app, manage, async (c) => bulkUpsertPriceListItems(c.tx, c.company.id, idParam.parse(c.req.params).id, bulkSchema.parse(c.req.body).rows)),
  );
  app.put(
    '/api/price-lists/:id/items/:rowId',
    tenantRoute(app, manage, async ({ tx, req }) => {
      const p = rowParam.parse(req.params);
      return updatePriceListItem(tx, p.id, p.rowId, updatePriceListItemSchema.parse(req.body));
    }),
  );
  app.delete(
    '/api/price-lists/:id/items/:rowId',
    tenantRoute(app, manage, async (c) => {
      const p = rowParam.parse(c.req.params);
      await deletePriceListItem(c.tx, p.id, p.rowId);
      void c.reply.code(204);
      return null;
    }),
  );

  app.get('/api/party-prices', tenantRoute(app, read, async ({ tx, req }) => listPartyPrices(tx, listPartyPricesQuerySchema.parse(req.query))));
  app.post(
    '/api/party-prices',
    tenantRoute(app, manage, async (c) => {
      const row = await addPartyPrice(c.tx, c.company.id, partyPriceSchema.parse(c.req.body));
      void c.reply.code(201);
      return row;
    }),
  );
  app.put(
    '/api/party-prices/:id',
    tenantRoute(app, manage, async ({ tx, req }) => updatePartyPrice(tx, idParam.parse(req.params).id, partyPriceSchema.parse(req.body))),
  );
  app.delete(
    '/api/party-prices/:id',
    tenantRoute(app, manage, async (c) => {
      await deletePartyPrice(c.tx, idParam.parse(c.req.params).id);
      void c.reply.code(204);
      return null;
    }),
  );

  app.get('/api/parties/:id/pricing', tenantRoute(app, read, async ({ tx, req }) => getPartyPricing(tx, idParam.parse(req.params).id)));
  app.put(
    '/api/parties/:id/pricing',
    tenantRoute(app, manage, async ({ tx, req }) => setPartyPricing(tx, idParam.parse(req.params).id, partyPricingSchema.parse(req.body))),
  );
};
