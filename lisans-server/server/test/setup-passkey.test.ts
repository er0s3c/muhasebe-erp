import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { base32Decode, hotp, totpCounter } from '@erp/license-core';
import { setupToken } from '../src/crypto';
import { adminPasskeys, admins, auditLog } from '../src/db/schema';
import { CSRF_HEADER, CSRF_VALUE } from '../src/modules/admin-auth';
import { TOTP_ISSUER } from '../src/modules/admin-setup';
import { DATA_KEY, adminClient, loginAdmin, makeServer, totpNow } from './helpers';
import { authenticationResponse, makeAuthenticator, registrationResponse } from './webauthn';

const ORIGIN = 'https://lisans.ornek.com';
const RP = { origin: ORIGIN, rpId: 'lisans.ornek.com' };
const s = await makeServer({ env: { LICENSE_ADMIN_ORIGIN: `${ORIGIN}/` } });
const TOKEN = setupToken(DATA_KEY);
const ownerUrl = process.env.TEST_LICENSE_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_license_test';

/** Kurulum testleri boş yönetici tablosu ister (diğer test dosyaları kendi yöneticilerini yeniden oluşturur). */
async function wipeAdmins() {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    // releases.created_by → admins: ON DELETE SET NULL (TRUNCATE yabancı anahtarlı tabloda çalışmaz)
    await c.query('TRUNCATE admin_passkeys, admin_sessions');
    await c.query('DELETE FROM admins');
  } finally {
    await c.end();
  }
}

const post = (url: string, payload: unknown, o: { ip?: string } = {}) => s.app.inject({ method: 'POST', url, payload: payload as object, remoteAddress: o.ip });

async function beginSetup(email = 'kurucu@ornek.com') {
  const r = await post('/admin/api/setup/totp', { setupToken: TOKEN, email });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { secret: string; otpauthUri: string; pending: string };
}

function setupBody(p: { secret: string; pending: string }, over: Record<string, unknown> = {}) {
  return { setupToken: TOKEN, email: 'Kurucu@Ornek.com ', fullName: 'Kurucu Yönetici', password: 'cok-guclu-parola-2026', passwordConfirm: 'cok-guclu-parola-2026', pending: p.pending, totp: totpNow(p.secret, s.clock.t), ...over };
}

describe('ilk yönetici kurulumu', () => {
  beforeAll(wipeAdmins);

  it('yönetici yokken açık; kod olmadan TOTP sırrı verilmez; sır kasa/uygulama için otpauth adresiyle gelir', async () => {
    expect((await s.app.inject({ method: 'GET', url: '/admin/api/setup' })).json()).toEqual({ needed: true });
    const bad = await post('/admin/api/setup/totp', { setupToken: 'AAAA-BBBB-CCCC-DDDD-EEEE' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_SETUP_TOKEN');
    // Küçük harf ve tiresiz yazım da kabul edilir
    const ok = await post('/admin/api/setup/totp', { setupToken: TOKEN.toLowerCase().replaceAll('-', ''), email: 'kurucu@ornek.com' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUri).toBe(`otpauth://totp/${encodeURIComponent(TOTP_ISSUER)}:kurucu%40ornek.com?secret=${body.secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`);
    expect(body.pending).not.toContain(body.secret);
  });

  it('parola iki kez aynı ve ≥ 12 karakter olmalı; TOTP kodu, kurulum bilgisi ve süre denetlenir', async () => {
    const p = await beginSetup();
    const mismatch = await post('/admin/api/setup', setupBody(p, { passwordConfirm: 'baska-bir-parola-2026' }));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.details).toEqual([{ path: 'passwordConfirm', message: 'Parolalar eşleşmiyor' }]);
    const short = await post('/admin/api/setup', setupBody(p, { password: 'kisa-parola', passwordConfirm: 'kisa-parola' }));
    expect(short.json().error.details[0]).toMatchObject({ path: 'password', message: 'Parola en az 12 karakter olmalı' });
    const badEmail = await post('/admin/api/setup', setupBody(p, { email: 'eposta-degil' }));
    expect(badEmail.json().error.details[0].path).toBe('email');

    const wrongTotp = hotp(base32Decode(p.secret), totpCounter(s.clock.t) + 5);
    expect((await post('/admin/api/setup', setupBody(p, { totp: wrongTotp }))).json().error.code).toBe('INVALID_TOTP');
    // Başka bir sırla üretilmiş kod (istemci sırrı değiştiremez; sır şifreli blobtan gelir)
    const other = await beginSetup();
    expect((await post('/admin/api/setup', setupBody(p, { totp: totpNow(other.secret, s.clock.t) }))).json().error.code).toBe('INVALID_TOTP');
    // Kurcalanmış blob
    const tampered = `${p.pending.slice(0, -4)}AAAA`;
    expect((await post('/admin/api/setup', setupBody(p, { pending: tampered }))).json().error.code).toBe('SETUP_INVALID');
    // Yanlış kurulum kodu
    expect((await post('/admin/api/setup', setupBody(p, { setupToken: 'AAAA-BBBB-CCCC-DDDD-EEEE' }))).statusCode).toBe(401);
    // 30 dakika sonra süre dolar
    const saved = s.clock.t;
    s.clock.t += 31 * 60_000;
    expect((await post('/admin/api/setup', setupBody(p))).json().error.code).toBe('SETUP_EXPIRED');
    s.clock.t = saved;
    expect(await s.handle.db.select().from(admins)).toHaveLength(0);
  });

  it('başarılı kurulum: hesap oluşur, oturum açılır, parola+TOTP ile giriş çalışır, aynı kod ikinci kez kullanılamaz; kurulum kapanır', async () => {
    const p = await beginSetup();
    const res = await post('/admin/api/setup', setupBody(p), { ip: '203.0.113.9' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().admin).toMatchObject({ email: 'kurucu@ornek.com', fullName: 'Kurucu Yönetici' });
    const cookie = res.cookies.find((c) => c.name === 'lic_admin')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    expect((await s.app.inject({ method: 'GET', url: '/admin/api/me', cookies: { lic_admin: cookie.value } })).json().admin.email).toBe('kurucu@ornek.com');

    const [row] = await s.handle.db.select().from(admins);
    expect(row!.passwordHash).not.toContain('cok-guclu');
    expect(row!.totpSecretEnc).not.toContain(p.secret);
    const [entry] = await s.handle.db.select().from(auditLog).where(eq(auditLog.action, 'admin.setup'));
    expect(entry).toMatchObject({ adminId: row!.id, ip: '203.0.113.9' });
    expect(JSON.stringify(entry)).not.toContain('cok-guclu');

    const login = { email: 'kurucu@ornek.com', password: 'cok-guclu-parola-2026', secret: p.secret };
    // Kurulumda kullanılan kod yeniden oynatılamaz; sonraki adımın kodu kabul edilir
    expect((await loginAdmin(s, login)).statusCode).toBe(401);
    s.clock.t += 30_000;
    expect((await loginAdmin(s, login)).statusCode).toBe(200);

    expect((await s.app.inject({ method: 'GET', url: '/admin/api/setup' })).json()).toEqual({ needed: false });
    expect((await post('/admin/api/setup/totp', { setupToken: TOKEN })).json().error.code).toBe('SETUP_CLOSED');
    const again = await post('/admin/api/setup', setupBody(p, { email: 'ikinci@ornek.com' }));
    expect(again.statusCode).toBe(409);
    expect(await s.handle.db.select().from(admins)).toHaveLength(1);
  });

  it('eşzamanlı iki kurulumdan yalnızca biri yönetici oluşturur', async () => {
    await wipeAdmins();
    const [a, b] = [await beginSetup('a@ornek.com'), await beginSetup('b@ornek.com')];
    const results = await Promise.all([post('/admin/api/setup', setupBody(a, { email: 'a@ornek.com' })), post('/admin/api/setup', setupBody(b, { email: 'b@ornek.com' }))]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await s.handle.db.select().from(admins)).toHaveLength(1);
  });

  it('kurulum kodu kaba kuvvete karşı IP başına sınırlı', async () => {
    const limited = await makeServer({ rateLimit: true });
    await wipeAdmins();
    for (let i = 0; i < 10; i++) {
      const r = await limited.app.inject({ method: 'POST', url: '/admin/api/setup/totp', payload: { setupToken: `YANLIS-${i}` }, remoteAddress: '198.51.100.7' });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await limited.app.inject({ method: 'POST', url: '/admin/api/setup/totp', payload: { setupToken: TOKEN }, remoteAddress: '198.51.100.7' });
    expect(blocked.statusCode).toBe(429);
    const otherIp = await limited.app.inject({ method: 'POST', url: '/admin/api/setup/totp', payload: { setupToken: TOKEN }, remoteAddress: '198.51.100.8' });
    expect(otherIp.statusCode).toBe(200);
  });
});

describe('giriş anahtarları (WebAuthn)', () => {
  async function register(c: Awaited<ReturnType<typeof adminClient>>, o: Partial<typeof RP> & { uv?: boolean; synced?: boolean; name?: string } = {}) {
    const auth = makeAuthenticator();
    const opt = await c.post('/admin/api/passkeys/options');
    expect(opt.statusCode, opt.body).toBe(200);
    const res = await c.post('/admin/api/passkeys', { name: o.name, response: registrationResponse(auth, opt.json().options, { ...RP, ...o }) });
    return { auth, res, options: opt.json().options };
  }

  async function passkeyLogin(auth: ReturnType<typeof makeAuthenticator>, o: Partial<typeof RP> & { uv?: boolean } = {}) {
    const opt = await post('/admin/api/passkey/options', {});
    expect(opt.statusCode).toBe(200);
    const { challengeId, options } = opt.json();
    auth.counter += 1;
    return post('/admin/api/passkey/login', { challengeId, response: authenticationResponse(auth, options, { ...RP, ...o }) });
  }

  it('kayıt seçenekleri: alan adı yapılandırmadan, keşfedilebilir anahtar ve kullanıcı doğrulaması zorunlu', async () => {
    const c = await adminClient(s);
    const { options } = await register(c);
    expect(options.rp).toEqual({ name: TOTP_ISSUER, id: 'lisans.ornek.com' });
    expect(options.user.name).toBe(c.admin.email);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    expect(options.attestation).toBe('none');
    // Oturumsuz ya da CSRF başlıksız kayıt yok
    expect((await post('/admin/api/passkeys/options', {})).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: '/admin/api/passkeys/options', cookies: { lic_admin: c.cookie } })).statusCode).toBe(403);
  });

  it('kaydet → listele → giriş anahtarıyla gir (e-posta/parola/TOTP sorulmadan) → sil', async () => {
    const c = await adminClient(s);
    const { auth, res } = await register(c, { synced: true, name: 'Vaultwarden' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().passkey).toMatchObject({ name: 'Vaultwarden', backedUp: true });
    const list = (await c.get('/admin/api/passkeys')).json().passkeys;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('publicKey');

    const login = await passkeyLogin(auth);
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().admin.email).toBe(c.admin.email);
    const cookie = login.cookies.find((x) => x.name === 'lic_admin')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    expect((await s.app.inject({ method: 'GET', url: '/admin/api/me', cookies: { lic_admin: cookie.value } })).json().admin.email).toBe(c.admin.email);
    const [pk] = await s.handle.db.select().from(adminPasskeys).where(eq(adminPasskeys.id, list[0].id));
    expect(pk!.counter).toBe(1);
    expect(pk!.lastUsedAt).not.toBeNull();
    const audits = await s.handle.db.select().from(auditLog).where(eq(auditLog.adminId, pk!.adminId));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['admin.passkey_add', 'admin.login']));

    // Başka yönetici silemez; sahibi siler, sonra anahtar geçersiz
    const other = await adminClient(s);
    expect((await other.del(`/admin/api/passkeys/${list[0].id}`)).statusCode).toBe(404);
    expect((await c.del(`/admin/api/passkeys/${list[0].id}`)).statusCode).toBe(200);
    expect((await passkeyLogin(auth)).statusCode).toBe(401);
  });

  it('kullanıcı doğrulaması olmayan, yanlış kökenli ya da yeniden oynatılan yanıtlar reddedilir', async () => {
    const c = await adminClient(s);
    expect((await register(c, { uv: false })).res.json().error.code).toBe('PASSKEY_INVALID');
    expect((await register(c, { origin: 'https://sahte-lisans.com' })).res.json().error.code).toBe('PASSKEY_INVALID');
    expect((await register(c, { rpId: 'sahte-lisans.com' })).res.json().error.code).toBe('PASSKEY_INVALID');

    const { auth, options } = await register(c);
    // Kayıt meydan okuması tek kullanımlık
    const replay = await c.post('/admin/api/passkeys', { response: registrationResponse(makeAuthenticator(), options, RP) });
    expect(replay.json().error.code).toBe('CHALLENGE_EXPIRED');
    // Aynı anahtar ikinci kez kaydedilemez (tarayıcı excludeCredentials ile de engeller)
    const opt = (await c.post('/admin/api/passkeys/options')).json().options;
    expect(opt.excludeCredentials).toHaveLength(1);
    expect((await c.post('/admin/api/passkeys', { response: registrationResponse(auth, opt, RP) })).json().error.code).toBe('PASSKEY_EXISTS');

    expect((await passkeyLogin(auth, { uv: false })).statusCode).toBe(401);
    expect((await passkeyLogin(auth, { origin: 'https://sahte-lisans.com' })).statusCode).toBe(401);
    expect((await passkeyLogin(makeAuthenticator())).statusCode).toBe(401);

    // Giriş meydan okuması tek kullanımlık ve 5 dakikalık
    const opt2 = (await post('/admin/api/passkey/options', {})).json();
    auth.counter += 1;
    const assertion = authenticationResponse(auth, opt2.options, RP);
    expect((await post('/admin/api/passkey/login', { challengeId: opt2.challengeId, response: assertion })).statusCode).toBe(200);
    expect((await post('/admin/api/passkey/login', { challengeId: opt2.challengeId, response: assertion })).json().error.code).toBe('CHALLENGE_EXPIRED');
    const opt3 = (await post('/admin/api/passkey/options', {})).json();
    s.clock.t += 6 * 60_000;
    auth.counter += 1;
    expect((await post('/admin/api/passkey/login', { challengeId: opt3.challengeId, response: authenticationResponse(auth, opt3.options, RP) })).json().error.code).toBe('CHALLENGE_EXPIRED');

    // Devre dışı yönetici anahtarla giremez
    await s.handle.db.update(admins).set({ isActive: false }).where(eq(admins.email, c.admin.email));
    expect((await passkeyLogin(auth)).statusCode).toBe(401);
  });

  it('LICENSE_ADMIN_ORIGIN verilmezse köken istekten alınır', async () => {
    const dev = await makeServer();
    const a = await adminClient(dev);
    const opt = await dev.app.inject({ method: 'POST', url: '/admin/api/passkeys/options', cookies: { lic_admin: a.cookie }, headers: { [CSRF_HEADER]: CSRF_VALUE, host: 'localhost:5174' } });
    expect(opt.json().options.rp.id).toBe('localhost');
    const auth = makeAuthenticator();
    const reg = await dev.app.inject({
      method: 'POST',
      url: '/admin/api/passkeys',
      cookies: { lic_admin: a.cookie },
      headers: { [CSRF_HEADER]: CSRF_VALUE, host: 'localhost:5174', origin: 'http://localhost:5174' },
      payload: { response: registrationResponse(auth, opt.json().options, { origin: 'http://localhost:5174', rpId: 'localhost' }) },
    });
    expect(reg.statusCode, reg.body).toBe(200);
  });
});
