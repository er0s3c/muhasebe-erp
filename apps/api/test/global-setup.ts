import { runMigrations } from '../src/db/migrate';
import { resetSchema } from '../src/db/reset';

const ownerUrl =
  process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';

/** Her test çalıştırmasında şemayı sıfırlar ve migration'ları uygular (operatörün demo:reset'iyle aynı kod). */
export default async function setup() {
  await resetSchema(ownerUrl);
  await runMigrations(ownerUrl);
}
