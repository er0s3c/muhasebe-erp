import { hash } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { isWeakPassword } from '@erp/shared';
import { loadConfig } from '../config';
import { createDb } from './client';
import { refreshTokens, securityEvents, users } from './schema';

/**
 * Operatör komutları (paketlenmiş `node dist/admin.js <komut>`; geliştirmede `npm run admin -- <komut>`).
 *
 *   reset-password --email=<e-posta>   geçici parola üretir (E-posta/SMTP kapalıyken kurtarma yolu)
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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command !== 'reset-password') fail('Kullanım: admin reset-password --email=<e-posta>');
const email = flag('email')?.trim().toLowerCase();
if (!email) fail('--email=<e-posta> gerekli');

const handle = createDb(loadConfig().DATABASE_URL);
try {
  const temporary = await handle.db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, organizationId: users.organizationId, isActive: users.isActive })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    if (!user) return null;
    const password = generateTemporaryPassword(email);
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
} catch (err) {
  console.error('Komut başarısız:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
