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
    // Each drop commits separately. Dropping every table/constraint in one statement
    // can exhaust PostgreSQL's default shared lock pool as the ERP schema grows.
    const tables=await client.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    for(const {tablename} of tables.rows){
      const quoted='"'+tablename.replaceAll('"','""')+'"';
      await client.query(`DROP TABLE IF EXISTS public.${quoted} CASCADE`);
    }
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

/** Sıfırlamadan önce korunan lisans durumu satırı (kurulum kimliği, anahtar çifti, kira). */
export type SavedLicenseState = Record<string, unknown>;

/**
 * Demo örneği sıfırlanırken lisans durumunu korumak için okur: aksi halde her sıfırlama yeni bir kurulum kimliği üretir ve
 * satıcıda yeni bir etkinleştirme yuvası tüketirdi. Tablo ya da satır yoksa null.
 */
export async function saveLicenseState(ownerUrl: string): Promise<SavedLicenseState | null> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const res = await client.query('SELECT * FROM license_state WHERE id = 1');
    return (res.rows[0] as SavedLicenseState | undefined) ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return null; // tablo henüz yok
    throw err;
  } finally {
    await client.end();
  }
}

/** `saveLicenseState` çıktısını, sıfırlanıp migrate edilmiş şemaya geri yazar. */
export async function restoreLicenseState(ownerUrl: string, row: SavedLicenseState): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO license_state (id, installation_id, public_key, private_key_pem, lease_token, high_water, last_check_at, last_success_at,
         last_error_code, last_error, pending_request_id, created_at, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        row.installation_id, row.public_key, row.private_key_pem, row.lease_token, row.high_water, row.last_check_at, row.last_success_at,
        row.last_error_code, row.last_error, row.pending_request_id, row.created_at, row.updated_at,
      ],
    );
  } finally {
    await client.end();
  }
}
