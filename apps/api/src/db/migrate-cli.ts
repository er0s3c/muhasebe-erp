import { runMigrations } from './migrate';

/**
 * `npm run db:migrate` / paketlenmiş `dist/migrate.js` girişi. Yalnızca sahip rolünün bağlantısını
 * (`MIGRATION_DATABASE_URL`) ister; çalışma zamanı rolüne (`DATABASE_URL`) asla düşmez, çünkü o rol DDL yapamaz
 * ve uygulama kabına sahip kimlik bilgisi verilmesin diye bu iş ayrı bir tek seferlik kapta çalışır.
 */
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL tanımlı değil (şema sahibi rolün bağlantı adresi gerekir).');
  process.exit(1);
}
try {
  await runMigrations(url);
  console.log('Migration tamamlandı.');
} catch (err) {
  console.error('Migration başarısız:', err instanceof Error ? err.message : err);
  process.exit(1);
}
