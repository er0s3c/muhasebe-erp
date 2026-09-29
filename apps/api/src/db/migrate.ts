import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { createDb } from './client';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString);
  try {
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}

// Doğrudan çalıştırıldığında (npm run db:migrate)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const url = config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
  await runMigrations(url);
  console.log('Migration tamamlandı.');
}
