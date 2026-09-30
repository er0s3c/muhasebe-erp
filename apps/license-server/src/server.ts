import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { loadSigner } from './signer';

const config = loadConfig();
let log: { error: (obj: unknown, msg?: string) => void } = { error: (obj, msg) => console.error(msg ?? '', obj) };
const handle = createDb(config.DATABASE_URL, { onError: (err) => log.error({ err }, 'veritabanı bağlantı hatası (boşta bağlantı)') });
const signer = loadSigner(config);
const app = await buildApp({ db: handle.db, config, signer });
log = app.log;
app.log.info({ kid: signer.kid, publicKey: signer.publicKey }, 'lisans sunucusu imza anahtarı yüklendi');

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'kapatılıyor');
  const timer = setTimeout(() => process.exit(1), config.SHUTDOWN_TIMEOUT_MS);
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
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'işlenmemiş promise reddi');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'yakalanmamış istisna');
  process.exit(1);
});

await app.listen({ port: config.PORT, host: config.HOST });
