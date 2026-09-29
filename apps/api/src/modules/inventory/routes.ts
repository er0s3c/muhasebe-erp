import type { FastifyPluginAsync } from 'fastify';
import {
  createItemCategorySchema,
  createItemSchema,
  createStockCountSchema,
  createStockDocumentSchema,
  createWarehouseSchema,
  idParam,
  itemMovementsQuerySchema,
  listItemsQuerySchema,
  listStockCountsQuerySchema,
  listStockDocumentsQuerySchema,
  reverseStockDocumentSchema,
  stockStatusQuerySchema,
  todayIso,
  updateItemCategorySchema,
  updateItemSchema,
  updateStockCountSchema,
  updateWarehouseSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { createCategory, deleteCategory, listCategories, updateCategory } from './categories';
import {
  createStockCount,
  deleteStockCount,
  getStockCount,
  listStockCounts,
  postStockCount,
  updateStockCount,
} from './counts';
import {
  getStockDocument,
  listStockDocuments,
  postStockDocument,
  reverseStockDocument,
  type StockCtx,
} from './documents';
import { createItem, deleteItem, getItem, itemStatement, listItems, updateItem } from './items';
import { inventorySummary, stockStatus } from './reports';
import { createWarehouse, deleteWarehouse, listWarehouses, updateWarehouse } from './warehouses';

const stockCtx = ({ company, user }: TenantCtx): StockCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
  allowNegativeStock: company.allowNegativeStock,
});

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.inventory', permission: 'inventory.read' } as const;
  const manage = { module: 'core.inventory', permission: 'inventory.manage' } as const;
  const move = { module: 'core.inventory', permission: 'inventory.move' } as const;

  // --- Kategoriler ---
  app.get('/api/item-categories', tenantRoute(app, read, async ({ tx }) => listCategories(tx)));
  app.post(
    '/api/item-categories',
    tenantRoute(app, manage, async ({ tx, req, reply, company }) => {
      const category = await createCategory(tx, company.id, createItemCategorySchema.parse(req.body));
      void reply.code(201);
      return { category };
    }),
  );
  app.patch(
    '/api/item-categories/:id',
    tenantRoute(app, manage, async ({ tx, req }) => ({
      category: await updateCategory(tx, idParam.parse(req.params).id, updateItemCategorySchema.parse(req.body)),
    })),
  );
  app.delete(
    '/api/item-categories/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteCategory(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  // --- Depolar ---
  app.get('/api/warehouses', tenantRoute(app, read, async ({ tx }) => listWarehouses(tx)));
  app.post(
    '/api/warehouses',
    tenantRoute(app, manage, async ({ tx, req, reply, company }) => {
      const warehouse = await createWarehouse(tx, company.id, createWarehouseSchema.parse(req.body));
      void reply.code(201);
      return { warehouse };
    }),
  );
  app.patch(
    '/api/warehouses/:id',
    tenantRoute(app, manage, async ({ tx, req }) => ({
      warehouse: await updateWarehouse(tx, idParam.parse(req.params).id, updateWarehouseSchema.parse(req.body)),
    })),
  );
  app.delete(
    '/api/warehouses/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteWarehouse(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  // --- Stok kartları ---
  app.get('/api/items', tenantRoute(app, read, async ({ tx, req }) => listItems(tx, listItemsQuerySchema.parse(req.query))));
  app.post(
    '/api/items',
    tenantRoute(app, manage, async ({ tx, req, reply, company }) => {
      const item = await createItem(tx, company.id, createItemSchema.parse(req.body));
      void reply.code(201);
      return { item };
    }),
  );
  app.get('/api/items/:id', tenantRoute(app, read, async ({ tx, req }) => getItem(tx, idParam.parse(req.params).id)));
  app.patch(
    '/api/items/:id',
    tenantRoute(app, manage, async ({ tx, req }) => ({
      item: await updateItem(tx, idParam.parse(req.params).id, updateItemSchema.parse(req.body)),
    })),
  );
  app.delete(
    '/api/items/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteItem(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );
  app.get(
    '/api/items/:id/movements',
    tenantRoute(app, read, async ({ tx, req }) =>
      itemStatement(tx, idParam.parse(req.params).id, itemMovementsQuerySchema.parse(req.query)),
    ),
  );

  // --- Stok belgeleri (hareketler) ---
  app.get(
    '/api/stock-documents',
    tenantRoute(app, read, async ({ tx, req }) => listStockDocuments(tx, listStockDocumentsQuerySchema.parse(req.query))),
  );
  app.post(
    '/api/stock-documents',
    tenantRoute(app, move, async (c) => {
      const result = await postStockDocument(c.tx, stockCtx(c), createStockDocumentSchema.parse(c.req.body));
      void c.reply.code(201);
      return result;
    }),
  );
  app.get(
    '/api/stock-documents/:id',
    tenantRoute(app, read, async ({ tx, req }) => getStockDocument(tx, idParam.parse(req.params).id)),
  );
  app.post(
    '/api/stock-documents/:id/reverse',
    tenantRoute(app, move, async (c) =>
      reverseStockDocument(c.tx, stockCtx(c), idParam.parse(c.req.params).id, reverseStockDocumentSchema.parse(c.req.body ?? {})),
    ),
  );

  // --- Sayımlar ---
  app.get(
    '/api/stock-counts',
    tenantRoute(app, read, async ({ tx, req }) => listStockCounts(tx, listStockCountsQuerySchema.parse(req.query))),
  );
  app.post(
    '/api/stock-counts',
    tenantRoute(app, move, async (c) => {
      const result = await createStockCount(c.tx, stockCtx(c), createStockCountSchema.parse(c.req.body));
      void c.reply.code(201);
      return result;
    }),
  );
  app.get('/api/stock-counts/:id', tenantRoute(app, read, async ({ tx, req }) => getStockCount(tx, idParam.parse(req.params).id)));
  app.put(
    '/api/stock-counts/:id',
    tenantRoute(app, move, async (c) =>
      updateStockCount(c.tx, stockCtx(c), idParam.parse(c.req.params).id, updateStockCountSchema.parse(c.req.body)),
    ),
  );
  app.delete(
    '/api/stock-counts/:id',
    tenantRoute(app, move, async ({ tx, req }) => {
      await deleteStockCount(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );
  app.post(
    '/api/stock-counts/:id/post',
    tenantRoute(app, move, async (c) => postStockCount(c.tx, stockCtx(c), idParam.parse(c.req.params).id)),
  );

  // --- Raporlar ---
  app.get(
    '/api/reports/stock-status',
    tenantRoute(app, read, async ({ tx, req, company }) =>
      stockStatus(
        tx,
        { baseCurrency: company.baseCurrency, reportingCurrency: company.reportingCurrency },
        stockStatusQuerySchema.parse(req.query),
      ),
    ),
  );
  app.get('/api/inventory/summary', tenantRoute(app, read, async ({ tx }) => inventorySummary(tx, todayIso())));
};
