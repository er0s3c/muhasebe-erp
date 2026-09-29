import pg from 'pg';
import { runMigrations } from '../src/db/migrate';

const ownerUrl =
  process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';

/** Her test çalıştırmasında şemayı sıfırlar ve migration'ları uygular. */
export default async function setup() {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  await runMigrations(ownerUrl);
}
