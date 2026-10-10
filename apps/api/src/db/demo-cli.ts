import { loadConfig } from '../config';
import { createDb } from './client';
import { seedManufacturingDemo } from './demo-manufacturing';
import { seedLeatherDemo } from './demo-leather';
import { seedDemo } from './demo';
import { runMigrations } from './migrate';
import { databaseNameOf, resetSchema, restoreLicenseState, saveLicenseState } from './reset';

/**
 * Operatör aracı (geliştirme `npm run db:seed` / `npm run demo:reset`; paketlenmiş `node dist/demo.js <komut>`).
 *
 *   seed                      demo verisini şirket bazlı sürümlerle ekler/günceller; mevcut şifreleri korur
 *   seed-manufacturing        mevcut demo kuruluşuna üretim şirketini ekler/günceller
 *   seed-leather              mevcut demo kuruluşuna deri şirketini (Ada Deri) ekler/günceller
 *   reset --confirm=<dbadı>   şemayı SİLER, migration'ları uygular, demo verisini yükler (yıkıcı); lisans durumu (kurulum kimliği + kira) korunur
 *
 * Güvenlik: üretim modunda (NODE_ENV=production) yalnızca ALLOW_DEMO=true ile çalışır; böylece bir müşteri
 * kurulumunda yanlışlıkla demo verisi yüklenemez ve veritabanı silinemez. `reset`, sahip rolünün bağlantısını
 * (MIGRATION_DATABASE_URL) ve hedef veritabanının adını açıkça yazmanızı ister. Yükleme çalışma zamanı rolüyle
 * (DATABASE_URL) yapılır.
 */
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const config = loadConfig();
if (config.NODE_ENV === 'production' && process.env.ALLOW_DEMO !== 'true') {
  fail(
    'Üretim modunda demo komutları kapalıdır. Yalnızca ayrı bir demo örneğinde ALLOW_DEMO=true ile çalıştırın.',
  );
}

try {
  if (command === 'seed' || command === 'seed-manufacturing' || command === 'seed-leather') {
    const handle = createDb(config.DATABASE_URL);
    try {
      if (command === 'seed-manufacturing') await seedManufacturingDemo(handle.db);
      else if (command === 'seed-leather') await seedLeatherDemo(handle.db);
      else await seedDemo(handle.db, console.log, { secret: config.JWT_SECRET });
    } finally {
      await handle.close();
    }
  } else if (command === 'reset') {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    if (!ownerUrl)
      fail('MIGRATION_DATABASE_URL tanımlı değil (şema sahibi rolün bağlantı adresi gerekir).');
    const dbName = databaseNameOf(ownerUrl);
    if (databaseNameOf(config.DATABASE_URL) !== dbName)
      fail('DATABASE_URL ile MIGRATION_DATABASE_URL farklı veritabanlarını gösteriyor.');
    if (flag('confirm') !== dbName)
      fail(
        `Yıkıcı işlem: "${dbName}" veritabanındaki TÜM veri silinecek. Onaylamak için --confirm=${dbName} verin.`,
      );
    console.log(`"${dbName}" sıfırlanıyor…`);
    // Lisans durumu (kurulum kimliği + kira) korunur: demo örneği her sıfırlamada satıcıdan yeni etkinleştirme istemesin.
    const license = await saveLicenseState(ownerUrl);
    await resetSchema(ownerUrl);
    await runMigrations(ownerUrl);
    if (license) await restoreLicenseState(ownerUrl, license);
    const handle = createDb(config.DATABASE_URL);
    try {
      await seedDemo(handle.db, console.log, { secret: config.JWT_SECRET });
    } finally {
      await handle.close();
    }
  } else {
    fail('Kullanım: demo-cli <seed | seed-manufacturing | reset --confirm=<veritabanı adı>>');
  }
} catch (err) {
  console.error('Demo komutu başarısız:', err);
  process.exit(1);
}
