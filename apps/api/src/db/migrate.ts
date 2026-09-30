import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from './client';

/** Paketlenmiş çalışma zamanında `MIGRATIONS_DIR` ile gösterilir (dist/drizzle); aksi halde kaynak ağacındaki klasör. */
export function migrationsFolder(): string {
  return process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../drizzle', import.meta.url));
}

/**
 * Migration'ları sahip rolüyle uygular. Uygulama rolü (`erp_app`) yoksa migration'lardaki GRANT blokları
 * sessizce atlanır ve uygulama çalışma zamanında "permission denied" verir; bu yüzden önce rol aranır.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, { max: 1 });
  try {
    const roles = await handle.pool.query("select 1 from pg_roles where rolname = 'erp_app'");
    if (roles.rowCount === 0) {
      throw new Error(
        "'erp_app' rolü yok. Önce roller ve veritabanı oluşturulmalı (infra/postgres/init.sql ya da init-prod.sh).",
      );
    }
    await migrate(handle.db, { migrationsFolder: migrationsFolder() });
  } finally {
    await handle.close();
  }
}
