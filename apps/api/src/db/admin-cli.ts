import { hash } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { isWeakPassword } from '@erp/shared';
import { loadConfig } from '../config';
import { createDb } from './client';
import { devices, licenseState, refreshTokens, securityEvents, users } from './schema';

/**
 * Operatör komutları (paketlenmiş `node dist/admin.js <komut>`; geliştirmede `npm run admin -- <komut>`).
 *
 *   reset-password --email=<e-posta>   geçici parola üretir (E-posta/SMTP kapalıyken kurtarma yolu)
 *   devices                            kayıtlı cihazları (lisans koltukları) listeler
 *   devices:revoke --id=<kimlik|ön ek> bir cihazı kaldırır (koltuk boşalır, oturumları kapanır)
 *   devices:revoke-all --yes           TÜM cihazları kaldırır (herkes yeniden giriş yapar; koltuklar yeniden dolar)
 *
 * Cihaz komutları: koltuklar dolup kimse giremiyorsa (ör. ayrılan çalışanların bilgisayarları) kurtarma yoludur;
 * işlemler `security_events` tablosuna "operatör" imzasıyla yazılır.
 *
 * Kullanıcının parolasını rastgele bir GEÇİCİ parolayla değiştirir, tüm oturumlarını kapatır ve bir sonraki girişte
 * parolasını kendisinin belirlemesini zorunlu kılar. Geçici parola yalnızca bir kez, bu komutun çıktısında görünür;
 * kullanıcıya güvenli bir kanaldan iletin. İşlem `security_events` tablosuna "operatör" imzasıyla yazılır.
 * Çalışma zamanı rolüyle (DATABASE_URL) çalışır; şema sahibi gerekmez.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generateTemporaryPassword(email: string): string {
  for (;;) {
    const pw = Array.from({ length: 20 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (!isWeakPassword(pw, { email })) return pw;
  }
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string) => rest.includes(`--${name}`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const USAGE = 'Kullanım: admin <reset-password --email=<e-posta> | devices | devices:revoke --id=<kimlik> | devices:revoke-all --yes>';
if (!['reset-password', 'devices', 'devices:revoke', 'devices:revoke-all'].includes(command ?? '')) fail(USAGE);

const handle = createDb(loadConfig().DATABASE_URL);

/** Kiradaki koltuk ayarlarını (yalnızca GÖRÜNTÜLEME için, imza doğrulanmadan) okur. */
async function seatSettings(): Promise<{ limit: number | null; idleDays: number }> {
  try {
    const [row] = await handle.db.select({ token: licenseState.leaseToken }).from(licenseState);
    const payload = row?.token?.split('.')[2];
    if (!payload) return { limit: null, idleDays: 30 };
    const lease = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { deviceLimit?: number; deviceIdleDays?: number };
    return { limit: lease.deviceLimit ?? null, idleDays: lease.deviceIdleDays ?? 30 };
  } catch {
    return { limit: null, idleDays: 30 };
  }
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

async function resetPassword() {
  const email = flag('email')?.trim().toLowerCase();
  if (!email) fail('--email=<e-posta> gerekli');
  const temporary = await handle.db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, organizationId: users.organizationId, isActive: users.isActive })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    if (!user) return null;
    const password = generateTemporaryPassword(email!);
    await tx
      .update(users)
      .set({ passwordHash: await hash(password), mustChangePassword: true, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, user.id));
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
    await tx.insert(securityEvents).values({
      event: 'password_reset_completed',
      organizationId: user.organizationId,
      userId: user.id,
      email,
      meta: { via: 'operator-cli', accountActive: user.isActive },
    });
    return password;
  });
  if (!temporary) fail(`Kullanıcı bulunamadı: ${email}`);
  console.log(`${email} için geçici parola (yalnızca bir kez gösterilir, güvenli bir kanaldan iletin):\n\n  ${temporary}\n`);
  console.log('Kullanıcı bu parolayla girince kendi parolasını belirlemek zorundadır; eski oturumları kapatıldı.');
}

async function listDevices() {
  const { limit, idleDays } = await seatSettings();
  const cutoff = Date.now() - idleDays * 24 * 60 * 60 * 1000;
  const rows = await handle.db
    .select({
      id: devices.id,
      name: devices.name,
      lastSeenAt: devices.lastSeenAt,
      revokedAt: devices.revokedAt,
      email: users.email,
    })
    .from(devices)
    .leftJoin(users, eq(users.id, devices.lastUserId))
    .orderBy(asc(devices.revokedAt), sql`${devices.lastSeenAt} desc`);
  const status = (r: (typeof rows)[number]) => (r.revokedAt ? 'kaldırıldı' : r.lastSeenAt.getTime() >= cutoff ? 'etkin' : 'boşta');
  const active = rows.filter((r) => status(r) === 'etkin').length;
  console.log(`Koltuk: ${active}${limit ? ` / ${limit}` : ''} etkin (son ${idleDays} gün içinde görülen ve kaldırılmamış cihazlar)\n`);
  for (const r of rows) {
    console.log(`${r.id}  ${status(r).padEnd(10)} ${stamp(r.lastSeenAt)}  ${(r.email ?? '-').padEnd(32)} ${r.name}`);
  }
  if (rows.length === 0) console.log('Kayıtlı cihaz yok.');
}

/** Cihazı kaldırır; oturumlarını kapatır ve operatör imzalı olay yazar. Kaldırılan cihaz sayısını döndürür. */
async function revokeDevices(ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const done = await handle.db.transaction(async (tx) => {
      const r = await tx.update(devices).set({ revokedAt: new Date(), revokedBy: 'operator-cli' }).where(and(eq(devices.id, id), isNull(devices.revokedAt))).returning({ id: devices.id });
      if (r.length === 0) return false;
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.deviceId, id), isNull(refreshTokens.revokedAt)));
      await tx.insert(securityEvents).values({ event: 'device_revoked', meta: { deviceId: id, by: 'operator-cli' } });
      return true;
    });
    if (done) n++;
  }
  return n;
}

try {
  if (command === 'reset-password') {
    await resetPassword();
  } else if (command === 'devices') {
    await listDevices();
  } else if (command === 'devices:revoke') {
    const wanted = flag('id')?.trim().toLowerCase();
    if (!wanted || wanted.length < 8) fail('--id=<cihaz kimliği ya da en az 8 karakterlik ön eki> gerekli (kimlikler `admin devices` çıktısındadır)');
    const active = await handle.db.select({ id: devices.id }).from(devices).where(isNull(devices.revokedAt));
    const matches = active.filter((d) => d.id.startsWith(wanted!));
    if (matches.length === 0) fail(`Etkin cihaz bulunamadı: ${wanted}`);
    if (matches.length > 1) fail(`"${wanted}" birden çok cihazla eşleşiyor; daha uzun bir ön ek verin`);
    await revokeDevices([matches[0]!.id]);
    console.log('Cihaz kaldırıldı: koltuk boşaldı, oturumları kapandı.');
  } else {
    if (!has('yes')) fail('Bu işlem TÜM cihazları kaldırır (herkes yeniden giriş yapmak zorunda kalır). Onaylamak için --yes verin.');
    const active = await handle.db.select({ id: devices.id }).from(devices).where(isNull(devices.revokedAt));
    const n = await revokeDevices(active.map((d) => d.id));
    console.log(`${n} cihaz kaldırıldı. Kullanıcılar yeniden giriş yaptıkça koltuklar yeniden dolacak.`);
  }
} catch (err) {
  console.error('Komut başarısız:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
