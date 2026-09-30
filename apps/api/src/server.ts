import { loadConfig } from './config';
import { createDb } from './db/client';
import { checkRuntimeRole } from './db/preflight';
import { buildApp } from './app';

const config = loadConfig();

// Uygulama kurulana dek günlükler konsola gider; sonra Fastify'ın pino günlüğüne geçilir.
let log: { error: (obj: unknown, msg?: string) => void } = { error: (obj, msg) => console.error(msg ?? '', obj) };

const handle = createDb(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  onError: (err) => log.error({ err }, 'veritabanı bağlantı hatası (boşta bağlantı)'),
});

const app = await buildApp({ db: handle.db, config });
log = app.log;

// Kiracı yalıtımı RLS'e bağlı: yanlış rolle çalışılıyorsa üretimde başlamayı reddet, geliştirmede uyar.
const issues = await checkRuntimeRole(handle.db);
for (const issue of issues) {
  if (config.NODE_ENV === 'production') app.log.fatal({ code: issue.code }, issue.message);
  else app.log.warn({ code: issue.code }, issue.message);
}
if (issues.length > 0 && config.NODE_ENV === 'production') {
  await handle.close();
  process.exit(1);
}
if (config.NODE_ENV === 'production' && !config.COOKIE_SECURE) {
  app.log.warn('COOKIE_SECURE=false: yenileme çerezi düz http üzerinden gider; üretimde TLS kullanın');
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'kapatılıyor');
  const timer = setTimeout(() => {
    app.log.error('kapanış zaman aşımına uğradı; zorla çıkılıyor');
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close();
    await handle.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'kapanış sırasında hata');
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Node 22 zaten bu durumlarda çıkar; burada yalnızca yapılandırılmış günlük bırakılır.
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'işlenmemiş promise reddi');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'yakalanmamış istisna');
  process.exit(1);
});

await app.listen({ port: config.PORT, host: config.HOST });
