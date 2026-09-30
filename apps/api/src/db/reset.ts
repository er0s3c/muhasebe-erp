import pg from 'pg';

/**
 * Şemayı ÜRETİLEBİLİR biçimde sıfırlar: `drizzle` (migration geçmişi) ve `public` şemaları silinip `public`
 * yeniden yaratılır. Tüm veri kaybolur; çağıran, yıkıcı olduğunu bilerek çağırmalıdır (demo:reset onay ister,
 * test global-setup yalnızca test veritabanında çalışır). Şema SAHİBİ rolün bağlantısı gerekir.
 * Ardından `runMigrations(ownerUrl)` çalıştırılarak şema ve yetkiler yeniden kurulur.
 */
export async function resetSchema(ownerUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}

/** Bağlantı adresindeki veritabanı adı (yıkıcı işlemlerde açık onay için). */
export function databaseNameOf(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name) throw new Error('Bağlantı adresinde veritabanı adı yok');
  return name;
}
