import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const beside = fileURLToPath(new URL('./drizzle', import.meta.url));
  return existsSync(beside) ? beside : fileURLToPath(new URL('../../drizzle', import.meta.url));
}

/** Sahip rolüyle uygular; çalışma zamanı rolü (`erp_app`) yoksa GRANT'lar sessizce atlanacağı için açıkça hata verir. */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const roles = await pool.query("select 1 from pg_roles where rolname = 'erp_app'");
    if (roles.rowCount === 0) throw new Error("'erp_app' rolü yok. Önce roller ve veritabanı oluşturulmalı (infra/postgres/init.sql ya da init-prod.sh).");
    await migrate(drizzle(pool), { migrationsFolder: migrationsFolder() });
  } finally {
    await pool.end();
  }
}

/** Şemayı sıfırlar (yalnızca testler/geliştirme). */
export async function resetSchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}
