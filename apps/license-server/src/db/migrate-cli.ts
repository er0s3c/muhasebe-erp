import { runMigrations } from './migrate';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL tanımlı değil (şema sahibi rolün bağlantı adresi gerekir).');
  process.exit(1);
}
try {
  await runMigrations(url);
  console.log('Lisans sunucusu migration tamamlandı.');
} catch (err) {
  console.error('Migration başarısız:', err instanceof Error ? err.message : err);
  process.exit(1);
}
