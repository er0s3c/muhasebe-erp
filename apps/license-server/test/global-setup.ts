import { resetSchema, runMigrations } from '../src/db/migrate';

const ownerUrl = process.env.TEST_LICENSE_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_license_test';

export default async function setup() {
  await resetSchema(ownerUrl);
  await runMigrations(ownerUrl);
}
