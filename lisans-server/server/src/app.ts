import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions, type RouteOptions } from 'fastify';
import type { Signer } from '@erp/license-core';
import type { Config } from './config';
import type { Db } from './db/client';
import { errorHandler } from './errors';
import { MemoryLimiter } from './limits';
import { adminApiRoutes } from './modules/admin-api';
import { adminAuthRoutes } from './modules/admin-auth';
import { adminPasskeyRoutes } from './modules/admin-passkeys';
import { adminSetupRoutes } from './modules/admin-setup';
import { panelNotFoundHandler, registerPanel } from './panel';
import { publicRoutes } from './modules/public';
import { releaseRoutes } from './modules/releases';
import { feedbackAdminRoutes } from './modules/feedback';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    signer: Signer;
    limiter: MemoryLimiter;
    /** Satıcı saati (ms); testlerde değiştirilebilir. */
    now: () => number;
  }
}

export interface BuildOptions {
  db: Db;
  config: Config;
  signer: Signer;
  logger?: boolean;
  now?: () => number;
  /** Testler: kayıtlı tüm rotaları toplamak için. */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const serverOptions: FastifyServerOptions = {
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    // Sayısal atlama değeri Fastify ≥ 5.12'de yok sayılır (güvenlik gereği); CIDR/ad listesi verin (ör. loopback,uniquelocal).
    trustProxy: config.TRUST_PROXY as FastifyServerOptions['trustProxy'],
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
  };
  const app = Fastify(serverOptions);
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);
  const now = opts.now ?? Date.now;
  app.decorate('db', opts.db);
  app.decorate('config', config);
  app.decorate('signer', opts.signer);
  app.decorate('limiter', new MemoryLimiter(config.RATE_LIMIT_ENABLED, now));
  app.decorate('now', now);

  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
  });
  await app.register(helmet);
  await app.register(cookie);
  app.setErrorHandler(errorHandler);
  if (config.PANEL_DIST_DIR) app.setNotFoundHandler(panelNotFoundHandler);

  await app.register(publicRoutes);
  await app.register(adminAuthRoutes);
  await app.register(adminSetupRoutes);
  await app.register(adminPasskeyRoutes);
  await app.register(adminApiRoutes);
  await app.register(feedbackAdminRoutes);
  await app.register(releaseRoutes);
  // Yönetim paneli (derlenmişse) rotalardan SONRA kaydedilir
  if (config.PANEL_DIST_DIR) await registerPanel(app, config.PANEL_DIST_DIR);
  return app;
}
