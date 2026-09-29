import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { errorHandler } from './http/errors';
import { authRoutes } from './modules/auth/routes';
import { inventoryRoutes } from './modules/inventory/routes';
import { deliveryRoutes } from './modules/deliveries/routes';
import { invoiceRoutes } from './modules/invoices/routes';
import { ledgerRoutes } from './modules/ledger/routes';
import { partyRoutes } from './modules/parties/routes';
import { fetchKktcmbXml } from './modules/settings/kktcmb';
import { settingsRoutes } from './modules/settings/routes';
import { memberRoutes } from './modules/tenancy/members';
import { tenancyRoutes } from './modules/tenancy/routes';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  logger?: boolean;
  /** Varsayılan: resmî Merkez Bankası adresinden indirir (sertifika doğrulaması açık). */
  rateFetcher?: (isoDate?: string) => Promise<string>;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? opts.config.NODE_ENV !== 'test',
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.decorate('db', opts.db);
  app.decorate('config', opts.config);
  app.decorate('rateFetcher', opts.rateFetcher ?? fetchKktcmbXml);

  await app.register(helmet);
  await app.register(cors, {
    origin: opts.config.CORS_ORIGIN.split(','),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);
  await app.register(jwt, { secret: opts.config.JWT_SECRET });
  if (opts.config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, { global: false });
  }

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Uç nokta bulunamadı' } });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  await app.register(authRoutes);
  await app.register(tenancyRoutes);
  await app.register(memberRoutes);
  await app.register(settingsRoutes);
  await app.register(ledgerRoutes);
  await app.register(partyRoutes);
  await app.register(inventoryRoutes);
  await app.register(invoiceRoutes);
  await app.register(deliveryRoutes);

  return app;
}
