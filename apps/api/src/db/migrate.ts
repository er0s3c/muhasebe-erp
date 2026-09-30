import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb } from './client';

/**
 * Migration klasörü: `MIGRATIONS_DIR` ile açıkça verilebilir; verilmezse paketin yanındaki `drizzle/`
 * (dist/migrate.js → dist/drizzle), o da yoksa kaynak ağacındaki `apps/api/drizzle`.
 */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const beside = fileURLToPath(new URL('./drizzle', import.meta.url));
  return existsSync(beside) ? beside : fileURLToPath(new URL('../../drizzle', import.meta.url));
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
