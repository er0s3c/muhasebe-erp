import type { FastifyPluginAsync } from 'fastify';
import { listSerialsQuerySchema, serialLookupQuerySchema } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { listSerials, lookupSerial } from './serials';

export const serialRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'inventory.serials', permission: 'inventory.read' } as const;
  app.get('/api/serials', tenantRoute(app, read, async ({ tx, req }) => listSerials(tx, listSerialsQuerySchema.parse(req.query))));
  app.get('/api/serials/lookup', tenantRoute(app, read, async ({ tx, req }) => lookupSerial(tx, serialLookupQuerySchema.parse(req.query))));
};
