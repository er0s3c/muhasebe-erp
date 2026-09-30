import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { generateKeyPair, generateTotpSecret, otpauthUri, sealSigningKey, formatActivationCode, normalizeActivationCode } from '@erp/license-core';
import { SECTORS } from '@erp/shared';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { admins, customers, licenses } from './db/schema';
import { audit } from './audit';
import { encryptSecret } from './crypto';
import {
  createCustomer,
  createLicense,
  createLicenseSchema,
  extendLicense,
  regenerateCode,
  serializeLicense,
  setLicenseStatus,
  type Actor,
} from './modules/licenses';

/**
 * Satıcı komut satırı aracı (VPS'te SSH ile; kapta: `node dist/cli.js <komut>`).
 *
 *   keygen --kid=<kimlik> --out=<dosya>            imza anahtar çifti üretir, parola ile mühürlü dosyaya yazar
 *   admin:create --email= --name=                  yönetici oluşturur (rastgele parola + TOTP sırrı bir kez yazdırılır)
 *   admin:reset --email=                           parolayı ve TOTP'yi yeniler (yeni değerler bir kez yazdırılır)
 *   license:issue --customer="Ad" --sectors=A,B --devices=N [--companies=1] [--valid-until=YYYY-MM-DD]
 *                 [--kind=commercial|trial|demo] [--lease-days=7] [--grace-days=14] [--activations=1] [--offline]
 *   license:list | license:extend --id= --valid-until= | license:suspend|resume|revoke --id= | license:code --id=
 */
const [command, ...rest] = process.argv.slice(2);
const flags = new Map(rest.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), 'true'] as const : [a.slice(2, i), a.slice(i + 1)] as const; }));
const flag = (n: string) => flags.get(n);
const need = (n: string): string => flag(n) ?? fail(`--${n} gerekli`);
const cliActor: Actor = { actor: 'cli' };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function randomPassword(): string {
  // 24 karakter, ayırt edilebilir karakterler; parola politikası/ezberleme değil, yönetici tarayıcısında saklanır.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(randomBytes(24), (b) => alphabet[b % alphabet.length]).join('');
}

if (command === 'keygen') {
  const kid = need('kid');
  const out = need('out');
  const passphrase = process.env.LICENSE_SIGNING_KEY_PASSPHRASE;
  if (!passphrase || passphrase.length < 12) fail('LICENSE_SIGNING_KEY_PASSPHRASE (en az 12 karakter) ortam değişkeni gerekli');
  if (existsSync(out)) fail(`${out} zaten var; üzerine yazılmaz (anahtarı kaybetmemek için). Başka bir ad verin.`);
  const pair = generateKeyPair();
  writeFileSync(out, JSON.stringify(sealSigningKey(kid, pair, passphrase!), null, 2), { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`Mühürlü imza anahtarı yazıldı: ${out} (kid: ${kid})`);
  console.log('\nAÇIK ANAHTARI uygulamaya gömün: apps/api/src/licensing/public-keys.json dosyasındaki "keys" nesnesine ekleyin:\n');
  console.log(`  "${kid}": "${pair.publicKey}"\n`);
  console.log('ÖNEMLİ: anahtar dosyasını ve parolasını AYRI yerlerde, çevrimdışı yedekleyin. Kaybolursa yeni lisans imzalayamazsınız;');
  console.log('sızarsa herkes sahte lisans üretebilir (docs/LICENSING.md: anahtar döndürme).');
  process.exit(0);
}

const config = loadConfig();
const handle = createDb(config.DATABASE_URL);
try {
  switch (command) {
    case 'admin:create': {
      const email = need('email').toLowerCase();
      const fullName = flag('name') ?? email;
      const password = randomPassword();
      const secret = generateTotpSecret();
      await handle.db.transaction(async (tx) => {
        const [dup] = await tx.select({ id: admins.id }).from(admins).where(eq(admins.email, email));
        if (dup) fail(`${email} zaten yönetici`);
        const [row] = await tx
          .insert(admins)
          .values({ email, fullName, passwordHash: await hash(password), totpSecretEnc: encryptSecret(secret, config.LICENSE_DATA_KEY) })
          .returning({ id: admins.id });
        await audit(tx, { ...cliActor, action: 'admin.create', targetType: 'admin', targetId: row!.id, meta: { email } });
      });
      console.log(`Yönetici oluşturuldu: ${email}\nParola (yalnızca bir kez gösterilir): ${password}\nTOTP sırrı (Authenticator uygulamasına elle girin): ${secret}\n${otpauthUri(secret, email, 'Muhasebe Lisans')}`);
      break;
    }
    case 'admin:reset': {
      const email = need('email').toLowerCase();
      const password = randomPassword();
      const secret = generateTotpSecret();
      const done = await handle.db
        .update(admins)
        .set({ passwordHash: await hash(password), totpSecretEnc: encryptSecret(secret, config.LICENSE_DATA_KEY), totpLastCounter: 0 })
        .where(eq(admins.email, email))
        .returning({ id: admins.id });
      if (done.length === 0) fail(`${email} bulunamadı`);
      await audit(handle.db, { ...cliActor, action: 'admin.reset', targetType: 'admin', targetId: done[0]!.id });
      console.log(`Yeni parola (bir kez): ${password}\nYeni TOTP sırrı: ${secret}\n${otpauthUri(secret, email, 'Muhasebe Lisans')}`);
      break;
    }
    case 'license:issue': {
      const name = need('customer');
      const sectors = need('sectors').split(',').map((s) => s.trim().toUpperCase());
      const bad = sectors.filter((s) => !(SECTORS as readonly string[]).includes(s));
      if (bad.length) fail(`Geçersiz sektör: ${bad.join(', ')} (${SECTORS.join(', ')})`);
      const validUntil = flag('valid-until') ?? new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
      const { license, code } = await handle.db.transaction(async (tx) => {
        let [customer] = await tx.select().from(customers).where(eq(customers.name, name));
        customer ??= await createCustomer(tx, { name }, cliActor);
        const input = createLicenseSchema.parse({
          customerId: customer.id,
          sectors,
          deviceLimit: Number(need('devices')),
          companyLimit: flag('companies') ? Number(flag('companies')) : undefined,
          validUntil,
          kind: flag('kind'),
          leaseDays: flag('lease-days') ? Number(flag('lease-days')) : undefined,
          graceDays: flag('grace-days') ? Number(flag('grace-days')) : undefined,
          maxActivations: flag('activations') ? Number(flag('activations')) : undefined,
          offlineAllowed: flag('offline') === 'true' ? true : undefined,
        });
        return createLicense(tx, input, cliActor);
      });
      console.log(`Lisans verildi: ${license.id}\nMüşteri: ${name}  Sektör: ${license.sectors.join(', ')}  Cihaz: ${license.deviceLimit}  Şirket: ${license.companyLimit}  Bitiş: ${license.validUntil.toISOString().slice(0, 10)}`);
      console.log(`\nETKİNLEŞTİRME KODU (yalnızca bir kez gösterilir):\n\n  ${formatActivationCode(normalizeActivationCode(code)!)}\n`);
      break;
    }
    case 'license:list': {
      const rows = await handle.db
        .select({ license: licenses, customer: customers.name })
        .from(licenses)
        .innerJoin(customers, eq(customers.id, licenses.customerId))
        .orderBy(sql`${licenses.createdAt} desc`);
      for (const r of rows) {
        const l = serializeLicense(r.license);
        console.log(`${l.id}  ${l.status.padEnd(9)} ${l.kind.padEnd(10)} ${r.customer}  [${l.sectors.join(',')}]  cihaz:${l.deviceLimit} şirket:${l.companyLimit}  bitiş:${l.validUntil.slice(0, 10)}  kod:${l.codePrefix}…`);
      }
      break;
    }
    case 'license:extend': {
      const parsed = createLicenseSchema.shape.validUntil.parse(need('valid-until'));
      await handle.db.transaction((tx) => extendLicense(tx, need('id'), parsed, cliActor));
      console.log('Süre uzatıldı.');
      break;
    }
    case 'license:suspend':
    case 'license:resume':
    case 'license:revoke': {
      const status = command === 'license:suspend' ? 'suspended' : command === 'license:resume' ? 'active' : 'revoked';
      await handle.db.transaction((tx) => setLicenseStatus(tx, need('id'), status, cliActor));
      console.log(`Lisans durumu: ${status}. Etkinleştirilmiş kurulumlar bir sonraki kalp atışında (en geç ~12 saat) salt-okunura geçer.`);
      break;
    }
    case 'license:code': {
      const { code } = await handle.db.transaction((tx) => regenerateCode(tx, need('id'), cliActor));
      console.log(`YENİ ETKİNLEŞTİRME KODU (eskisi geçersiz; yalnızca bir kez gösterilir):\n\n  ${formatActivationCode(normalizeActivationCode(code)!)}\n`);
      break;
    }
    default:
      fail('Kullanım: cli <keygen | admin:create | admin:reset | license:issue | license:list | license:extend | license:suspend | license:resume | license:revoke | license:code>');
  }
} catch (err) {
  console.error('Komut başarısız:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
