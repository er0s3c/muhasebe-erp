import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyServerOptions, type RouteOptions } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { existsSync } from 'node:fs';
import { errorHandler } from './http/errors';
import { MemoryLimiter, Semaphore } from './http/limits';
import { createMailer, type Mailer } from './modules/mail/mailer';
import { assertLicensed, createLicenseService, type LicenseSetup } from './licensing';
import { licenseRoutes } from './licensing/routes';
import { updateRoutes } from './modules/system/updates';
import { DeviceService } from './licensing/devices';
import { deviceRoutes } from './licensing/device-routes';
import { accountRoutes } from './modules/auth/account';
import { registerWebApp, webNotFoundHandler } from './http/static';
import { mfaRoutes } from './modules/auth/mfa';
import { authRoutes } from './modules/auth/routes';
import { inventoryRoutes } from './modules/inventory/routes';
import { deliveryRoutes } from './modules/deliveries/routes';
import { invoiceRoutes } from './modules/invoices/routes';
import { treasuryRoutes } from './modules/treasury/routes';
import { exportRoutes } from './modules/exports/routes';
import { importRoutes } from './modules/imports/routes';
import { bankStatementRoutes } from './modules/bank-statements/routes';
import { projectRoutes } from './modules/projects/routes';
import { procurementRoutes } from './modules/procurement/routes';
import { realEstateRoutes } from './modules/realestate/routes';
import { cashRoutes } from './modules/cash/routes';
import { subcontractRoutes } from './modules/subcontracts/routes';
import { hrRoutes } from './modules/hr/routes';
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
  /** Yalnızca testler: kaydedilen her rotayı gözlemler (rota–izin sözleşme testi). */
  onRoute?: (route: RouteOptions) => void;
  /** Giden posta; verilmezse yapılandırmadan (SMTP_URL / günlük modu / kapalı) kurulur. Testler bellek içi bir posta kutusu verir. */
  mailer?: Mailer;
  /** Lisanslama. Verilmezse yapılandırmadan kurulur: üretim paketinde denetim her zaman açık, geliştirmede LICENSE_ENFORCEMENT_DEV ile. Testler hizmeti/taşımayı enjekte eder. */
  license?: LicenseSetup;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const logging = opts.logger ?? config.NODE_ENV !== 'test';
  const serverOptions: FastifyServerOptions = {
    logger: logging
      ? {
          level: config.LOG_LEVEL,
          // Fastify istek başlıklarını varsayılan olarak yazmaz; olası bir serileştirici değişikliğine karşı güvence.
          redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[gizli]' },
        }
      : false,
    // Fastify çalışma zamanında atlama sayısını (number) destekler; tip tanımı eksiktir.
    trustProxy: config.TRUST_PROXY as FastifyServerOptions['trustProxy'],
    bodyLimit: 1024 * 1024,
    // Dışa aktarma gibi uzun işler için geniş, ama sonsuz olmayan sınırlar; vekilin boşta bekleme süresinden (60 sn) uzun.
    requestTimeout: 120_000,
    keepAliveTimeout: 65_000,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    },
  };
  const app = Fastify(serverOptions);
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);

  app.decorate('db', opts.db);
  app.decorate('config', config);
  app.decorate('rateFetcher', opts.rateFetcher ?? fetchKktcmbXml);
  app.decorate('limiter', new MemoryLimiter(config.RATE_LIMIT_ENABLED));
  app.decorate('exportGate', new Semaphore(config.EXPORT_CONCURRENCY));
  app.decorate('mailer', opts.mailer ?? createMailer(config, app.log));
  app.decorate('license', createLicenseService({ db: opts.db, config, log: app.log, setup: opts.license }));
  app.decorate('devices', new DeviceService({ db: opts.db, license: app.license, log: app.log, cookieSecure: config.COOKIE_SECURE, cacheMs: opts.license?.deviceCacheMs }));

  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  // Lisans kapısı (genel): lisanssız kurulumda yalnızca etkinleştirme akışı, salt-okunur modda yalnızca okuma açık.
  // Aynı denetim authedRoute/tenantRoute içinde de yapılır (bağımsız ikinci kapı).
  app.addHook('onRequest', async (req) => {
    await assertLicensed(app.license, req);
  });
  // API yanıtları (oturum, mali veri) tarayıcı ve ara önbelleklerde saklanmasın; dışa aktarmalar kendi başlığını koyar.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      // Düz http (Secure çerez kapalı) kurulumlarda varlık isteklerini https'ye yükseltmeye çalışıp kırmasın.
      directives: config.COOKIE_SECURE ? {} : { 'upgrade-insecure-requests': null },
    },
  });
  if (config.CORS_ORIGIN.length > 0) {
    await app.register(cors, {
      origin: config.CORS_ORIGIN,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Id'],
      // Dosya indirmede tarayıcı betiğinin dosya adını okuyabilmesi için
      exposedHeaders: ['Content-Disposition'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    });
  }
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_SECRET });
  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, { global: false });
  }

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(
    config.WEB_DIST_DIR
      ? webNotFoundHandler
      : (_req, reply) => {
          void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Uç nokta bulunamadı' } });
        },
  );

  /** Canlılık: süreç ayakta mı (veritabanına dokunmaz). */
  app.get('/api/health', async () => ({ status: 'ok' }));
  /** Hazırlık: veritabanı bağlantısı çalışıyor mu (orkestratör/HEALTHCHECK bunu yoklar). */
  app.get('/api/health/ready', async (req, reply) => {
    try {
      await app.db.execute(sql`select 1`);
      return { status: 'ok' };
    } catch (err) {
      req.log.error({ err }, 'hazırlık denetimi başarısız');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  /** Oturum açmadan önce arayüzün ihtiyaç duyduğu, gizli olmayan ayarlar. */
  app.get('/api/public-config', async () => {
    const snap = app.license.enforced ? await app.license.current() : null;
    return {
      registrationEnabled: config.REGISTRATION_ENABLED,
      mailEnabled: app.mailer.enabled,
      version: config.APP_VERSION,
      // Arayüz lisanssız kurulumda etkinleştirme sayfasına yönlensin diye (yalnızca durum; ayrıntı /api/license'ta)
      license: { enforced: app.license.enforced, state: snap?.state ?? null, reason: snap?.reason ?? null },
    };
  });

  await app.register(licenseRoutes);
  await app.register(updateRoutes);
  await app.register(deviceRoutes);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(mfaRoutes);
  await app.register(tenancyRoutes);
  await app.register(memberRoutes);
  await app.register(settingsRoutes);
  await app.register(ledgerRoutes);
  await app.register(partyRoutes);
  await app.register(inventoryRoutes);
  await app.register(invoiceRoutes);
  await app.register(deliveryRoutes);
  await app.register(treasuryRoutes);
  await app.register(exportRoutes);
  await app.register(importRoutes);
  await app.register(bankStatementRoutes);
  await app.register(projectRoutes);
  await app.register(subcontractRoutes);
  await app.register(hrRoutes);
  await app.register(procurementRoutes);
  await app.register(realEstateRoutes);
  await app.register(cashRoutes);

  // Derlenmiş web arayüzü (üretim): rotalardan SONRA kaydedilir; SPA yedeği yukarıdaki 404 işleyicisindedir.
  if (config.WEB_DIST_DIR) {
    if (!existsSync(config.WEB_DIST_DIR)) throw new Error(`WEB_DIST_DIR bulunamadı: ${config.WEB_DIST_DIR}`);
    await registerWebApp(app, config.WEB_DIST_DIR);
  }

  return app;
}
