import { describe, expect, it } from 'vitest';
import { OutboxMailer } from '../src/modules/mail/mailer';
import { PASSWORD, addMember, asOwner, client, createCompany, execAsOwner, expectDbError, makeApp, registerUser } from './helpers';

const post = (app: Awaited<ReturnType<typeof makeApp>>['app'], url: string, payload: unknown, cookies?: Record<string, string>) =>
  app.inject({ method: 'POST', url, payload: payload as object, cookies });
const NEW_PASSWORD = 'Kirmizi-Bulut-84!x';

describe('parola sıfırlama', async () => {
  const outbox = new OutboxMailer();
  const { app } = await makeApp({ mailer: outbox });

  async function newUser(name: string) {
    const s = await registerUser(app, name);
    outbox.sent.length = 0;
    return s;
  }

  it('bilinmeyen ve kayıtlı e-posta aynı 202 yanıtını alır; yalnızca kayıtlıya bağlantı gider', async () => {
    const s = await newUser('Unut');
    const known = await post(app, '/api/auth/forgot-password', { email: s.email });
    const unknown = await post(app, '/api/auth/forgot-password', { email: 'yok-kullanici@example.com' });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]!.to).toBe(s.email);
    expect(outbox.sent[0]!.text).toMatch(/\/reset-password\?token=[\w-]{40,}/);
    expect(outbox.sent[0]!.html).toContain('Şifremi sıfırla');
  });

  it('bağlantıyla parola sıfırlanır; tüm oturumlar kapanır, jeton tek kullanımlık, e-posta doğrulanmış sayılır', async () => {
    const s = await newUser('Sifirla');
    await post(app, '/api/auth/forgot-password', { email: s.email });
    const token = outbox.lastTokenFor(s.email)!;

    const ok = await post(app, '/api/auth/reset-password', { token, newPassword: NEW_PASSWORD });
    expect(ok.statusCode).toBe(200);
    // Eski oturum çerezi ve eski parola geçersiz; yeni parola çalışır
    expect((await post(app, '/api/auth/refresh', {}, { refresh_token: s.cookie })).statusCode).toBe(401);
    expect((await post(app, '/api/auth/login', { email: s.email, password: PASSWORD })).statusCode).toBe(401);
    const login = await post(app, '/api/auth/login', { email: s.email, password: NEW_PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.emailVerified).toBe(true);
    // Jeton ikinci kez kullanılamaz
    const again = await post(app, '/api/auth/reset-password', { token, newPassword: 'Baska-Bir-Sifre-55!' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('INVALID_TOKEN');
    // Değişiklik bildirimi gönderildi
    expect(outbox.sent.at(-1)!.subject).toBe('Şifreniz değiştirildi');
  });

  it('bilinmeyen, süresi dolmuş ya da değiştirilmiş jeton reddedilir; yeni istek eskisini geçersiz kılar', async () => {
    const s = await newUser('Gecersiz');
    expect((await post(app, '/api/auth/reset-password', { token: 'x'.repeat(43), newPassword: NEW_PASSWORD })).json().error.code).toBe('INVALID_TOKEN');

    await post(app, '/api/auth/forgot-password', { email: s.email });
    const first = outbox.lastTokenFor(s.email)!;
    await post(app, '/api/auth/forgot-password', { email: s.email });
    const second = outbox.lastTokenFor(s.email)!;
    expect(second).not.toBe(first);
    expect((await post(app, '/api/auth/reset-password', { token: first, newPassword: NEW_PASSWORD })).statusCode).toBe(400);

    await execAsOwner(`update user_tokens set expires_at = now() - interval '1 minute' where user_id = $1 and used_at is null`, [s.userId]);
    expect((await post(app, '/api/auth/reset-password', { token: second, newPassword: NEW_PASSWORD })).statusCode).toBe(400);
  });

  it('zayıf yeni parola reddedilir ve jeton tüketilmez (aynı bağlantı yeniden denenebilir)', async () => {
    const s = await newUser('Zayif');
    await post(app, '/api/auth/forgot-password', { email: s.email });
    const token = outbox.lastTokenFor(s.email)!;
    const weak = await post(app, '/api/auth/reset-password', { token, newPassword: 'password123' });
    expect(weak.statusCode).toBe(400); // şema: yaygın parola
    const local = s.email.split('@')[0]!;
    const withEmail = await post(app, '/api/auth/reset-password', { token, newPassword: `${local}-2026!` });
    expect(withEmail.statusCode).toBe(422);
    expect(withEmail.json().error.code).toBe('WEAK_PASSWORD');
    expect((await post(app, '/api/auth/reset-password', { token, newPassword: NEW_PASSWORD })).statusCode).toBe(200);
  });

  it('veritabanında jetonun kendisi değil yalnızca özeti saklanır', async () => {
    const s = await newUser('Ozet');
    await post(app, '/api/auth/forgot-password', { email: s.email });
    const token = outbox.lastTokenFor(s.email)!;
    const rows = await execAsOwner(`select token_hash from user_tokens where user_id = $1 and purpose = 'reset_password'`, [s.userId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].token_hash).not.toContain(token);
    expect(rows.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('posta hatası isteği bozmaz (202 döner, kayıt tamamlanır)', async () => {
    const s = await newUser('Hata');
    outbox.failing = true;
    try {
      expect((await post(app, '/api/auth/forgot-password', { email: s.email })).statusCode).toBe(202);
      const reg = await post(app, '/api/auth/register', { email: `posta-hata-${Date.now()}@example.com`, password: PASSWORD, fullName: 'Posta Hata', organizationName: 'Hata Ltd' });
      expect(reg.statusCode).toBe(201);
    } finally {
      outbox.failing = false;
    }
  });
});

describe('sıfırlama istekleri sınırlıdır', () => {
  it('aynı e-postaya saatte en çok 3 bağlantı gönderilir (yanıt yine 202, ayırt edilemez)', async () => {
    const outbox = new OutboxMailer();
    const { app } = await makeApp({ mailer: outbox, configOverrides: { RATE_LIMIT_ENABLED: true } });
    const s = await registerUser(app, 'Sinir');
    outbox.sent.length = 0;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(app, '/api/auth/forgot-password', { email: s.email })).statusCode);
    expect(codes).toEqual([202, 202, 202, 202, 202]);
    expect(outbox.sent).toHaveLength(3);
  });
});

describe('posta kapalıyken', async () => {
  const { app } = await makeApp(); // yapılandırmada SMTP yok: posta kapalı

  it('sıfırlama uçları 503 MAIL_DISABLED verir; kayıt e-postayı doğrulanmış sayar', async () => {
    expect((await post(app, '/api/auth/forgot-password', { email: 'a@example.com' })).json().error.code).toBe('MAIL_DISABLED');
    expect((await app.inject({ method: 'GET', url: '/api/public-config' })).json().mailEnabled).toBe(false);
    const res = await post(app, '/api/auth/register', { email: `kapali-${Date.now()}@example.com`, password: PASSWORD, fullName: 'Posta Kapalı', organizationName: 'K Ltd' });
    expect(res.json().user.emailVerified).toBe(true);
  });
});

describe('e-posta doğrulama', async () => {
  const outbox = new OutboxMailer();
  const { app } = await makeApp({ mailer: outbox });

  it('kayıtta doğrulama postası gider; bağlantıyla doğrulanır, jeton tek kullanımlık', async () => {
    const email = `dogrula-${Date.now()}@example.com`;
    const reg = await post(app, '/api/auth/register', { email, password: PASSWORD, fullName: 'Doğrula Kişi', organizationName: 'D Ltd' });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().user.emailVerified).toBe(false);
    const token = outbox.lastTokenFor(email)!;
    expect(token).toBeTruthy();
    const me0 = await client(app, reg.json().accessToken).get('/api/me');
    expect(me0.json().user).toMatchObject({ emailVerified: false, mustChangePassword: false });

    expect((await post(app, '/api/auth/verify-email', { token })).statusCode).toBe(200);
    expect((await client(app, reg.json().accessToken).get('/api/me')).json().user.emailVerified).toBe(true);
    expect((await post(app, '/api/auth/verify-email', { token })).json().error.code).toBe('INVALID_TOKEN');
  });

  it('yeniden gönderim: doğrulanmamışsa yeni bağlantı (eskisi geçersiz), doğrulanmışsa alreadyVerified', async () => {
    const email = `tekrar-${Date.now()}@example.com`;
    const reg = await post(app, '/api/auth/register', { email, password: PASSWORD, fullName: 'Tekrar Kişi', organizationName: 'T Ltd' });
    const c = client(app, reg.json().accessToken);
    const first = outbox.lastTokenFor(email)!;
    const res = await c.post('/api/auth/resend-verification');
    expect(res.json()).toEqual({ ok: true, alreadyVerified: false });
    const second = outbox.lastTokenFor(email)!;
    expect(second).not.toBe(first);
    expect((await post(app, '/api/auth/verify-email', { token: first })).statusCode).toBe(400);
    expect((await post(app, '/api/auth/verify-email', { token: second })).statusCode).toBe(200);
    expect((await c.post('/api/auth/resend-verification')).json()).toEqual({ ok: true, alreadyVerified: true });
  });

  it('yeniden gönderim dakikada bir ile sınırlıdır', async () => {
    const box = new OutboxMailer();
    const { app: limited } = await makeApp({ mailer: box, configOverrides: { RATE_LIMIT_ENABLED: true } });
    const reg = await post(limited, '/api/auth/register', { email: `dk-${Date.now()}@example.com`, password: PASSWORD, fullName: 'Dakika Kişi', organizationName: 'M Ltd' });
    const c = client(limited, reg.json().accessToken);
    expect((await c.post('/api/auth/resend-verification')).statusCode).toBe(200);
    const again = await c.post('/api/auth/resend-verification');
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('yöneticinin belirlediği ilk parola geçicidir', async () => {
  const { app } = await makeApp();

  it('kullanıcı ilk girişte şifresini değiştirene dek şirket uçları 403 PASSWORD_CHANGE_REQUIRED verir', async () => {
    const s = await registerUser(app, 'Yonet');
    const company = await createCompany(app, s.token);
    const owner = client(app, s.token, company.id);
    const email = `gecici-${Date.now()}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: 'Geçici Şifreli', role: 'accountant', password: PASSWORD });
    expect(add.statusCode).toBe(201);

    const login = await post(app, '/api/auth/login', { email, password: PASSWORD });
    expect(login.json().user).toMatchObject({ mustChangePassword: true });
    const token = login.json().accessToken as string;
    const member = client(app, token, company.id);

    expect((await member.get('/api/accounts')).json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await member.get('/api/navigation')).statusCode).toBe(403);
    expect((await client(app, token).post('/api/companies', { name: 'Yeni Şirket Ltd.', sector: 'COMMERCE', jurisdiction: 'KKTC' })).statusCode).toBe(403);
    // Oturum bilgisi ve şifre değiştirme açık kalır
    expect((await client(app, token).get('/api/me')).json().user.mustChangePassword).toBe(true);

    const same = await client(app, token).post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.statusCode).toBe(422);
    expect(same.json().error.code).toBe('SAME_PASSWORD');
    const weak = await client(app, token).post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: '1234567890' });
    expect(weak.statusCode).toBe(400);
    // Tarayıcı gibi oturum çerezini de gönderir: parola değişimi diğer oturumları kapatır, bu oturum açık kalır
    const cookie = login.cookies.find((c) => c.name === 'refresh_token')!.value;
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      cookies: { refresh_token: cookie },
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);

    expect((await member.get('/api/accounts')).statusCode).toBe(200);
    expect((await client(app, token).get('/api/me')).json().user.mustChangePassword).toBe(false);
  });

  it('mustChangePassword:false ile (hizmet hesabı) kullanıcı doğrudan çalışır', async () => {
    const s = await registerUser(app, 'Hizmet');
    const company = await createCompany(app, s.token);
    const svc = await addMember(app, client(app, s.token, company.id), company.id, 'viewer');
    expect((await svc.client.get('/api/accounts')).statusCode).toBe(200);
  });
});

describe('kayıt ve parola politikası', async () => {
  const { app } = await makeApp();

  it('yaygın parola ve e-postanın kullanıcı adını içeren parola kayıtta reddedilir', async () => {
    const common = await post(app, '/api/auth/register', { email: 'yaygin@example.com', password: 'Password-123!', fullName: 'Yaygın Kişi', organizationName: 'Y Ltd' });
    expect(common.statusCode).toBe(400);
    expect(JSON.stringify(common.json())).toContain('çok yaygın');
    const withEmail = await post(app, '/api/auth/register', { email: 'mehmet.demir@example.com', password: 'mehmet.demir-2026!', fullName: 'Mehmet Demir', organizationName: 'M Ltd' });
    expect(withEmail.statusCode).toBe(422);
    expect(withEmail.json().error.code).toBe('WEAK_PASSWORD');
  });
});

describe('güvenlik olayları', async () => {
  const outbox = new OutboxMailer();
  const { app } = await makeApp({ mailer: outbox });

  it('giriş, sıfırlama ve üye değişiklikleri olay olarak kaydedilir; parola/jeton kaydedilmez; kayıtlar değiştirilemez', async () => {
    const s = await registerUser(app, 'Olay');
    await post(app, '/api/auth/login', { email: s.email, password: 'yanlis-sifre-123' });
    await post(app, '/api/auth/login', { email: s.email, password: PASSWORD });
    await post(app, '/api/auth/forgot-password', { email: s.email });
    await post(app, '/api/auth/reset-password', { token: outbox.lastTokenFor(s.email)!, newPassword: NEW_PASSWORD });
    // Şifre sıfırlama oturumları (erişim belirteçleri dahil) kapattığı için yeniden giriş
    expect((await client(app, s.token).get('/api/me')).statusCode).toBe(401);
    const token = (await post(app, '/api/auth/login', { email: s.email, password: NEW_PASSWORD })).json().accessToken as string;
    const company = await createCompany(app, token);
    const owner = client(app, token, company.id);
    const m = await addMember(app, owner, company.id, 'accountant');
    await owner.patch(`/api/company/members/${m.userId}`, { role: 'viewer' });
    await owner.delete(`/api/company/members/${m.userId}`);

    const rows = await execAsOwner(`select event, meta, email from security_events where email = $1 or user_id = $2 order by at`, [s.email, m.userId]);
    const names = rows.rows.map((r) => r.event);
    for (const e of ['login_failed', 'login_succeeded', 'password_reset_requested', 'password_reset_completed', 'member_added', 'member_role_changed', 'member_removed']) {
      expect(names, e).toContain(e);
    }
    const all = JSON.stringify(rows.rows);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(NEW_PASSWORD);
    expect(all).not.toContain('yanlis-sifre-123');

    await asOwner(async (q) => {
      expect((await expectDbError(q, `update security_events set event = 'x'`)).code).toBe('ERP07');
      expect((await expectDbError(q, `delete from security_events`)).code).toBe('ERP07');
    });
  });
});
