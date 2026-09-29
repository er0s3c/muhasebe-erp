import { loadConfig } from './config';
import { createDb } from './db/client';
import { buildApp } from './app';

const config = loadConfig();
const handle = createDb(config.DATABASE_URL);
const app = await buildApp({ db: handle.db, config });

const shutdown = async () => {
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
