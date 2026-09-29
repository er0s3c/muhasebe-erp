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
import { ledgerRoutes } from './modules/ledger/routes';
import { settingsRoutes } from './modules/settings/routes';
import { memberRoutes } from './modules/tenancy/members';
import { tenancyRoutes } from './modules/tenancy/routes';

export async function buildApp(opts: { db: Db; config: Config; logger?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? opts.config.NODE_ENV !== 'test',
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.decorate('db', opts.db);
  app.decorate('config', opts.config);

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

  return app;
}
