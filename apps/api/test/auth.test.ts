import { describe, expect, it } from 'vitest';
import { PASSWORD, client, makeApp, registerUser } from './helpers';

describe('kimlik doğrulama', async () => {
  const { app } = await makeApp();

  it('kayıt olur, access token ve httpOnly refresh cookie alır', async () => {
    const s = await registerUser(app, 'Kayit');
    expect(s.token.split('.')).toHaveLength(3);
    expect(s.cookie.length).toBeGreaterThan(20);
    const me = await client(app, s.token).get('/api/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(s.email);
    expect(me.json().companies).toEqual([]);
  });

  it('aynı e-posta ikinci kez kaydedilemez', async () => {
    const s = await registerUser(app, 'Dup');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: s.email, password: PASSWORD, fullName: 'Başka Biri', organizationName: 'X Ltd' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('zayıf şifreyi ve geçersiz e-postayı reddeder', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@b.co', password: 'kisa', fullName: 'Ab', organizationName: 'Ab' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('VALIDATION_ERROR');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: PASSWORD, fullName: 'Ab', organizationName: 'Ab' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('doğru şifreyle giriş yapar; yanlış şifre ve bilinmeyen e-posta aynı hatayı verir', async () => {
    const s = await registerUser(app, 'Login');
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: PASSWORD } });
    expect(ok.statusCode).toBe(200);

    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: 'yanlis-sifre-123' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'yok@example.com', password: 'yanlis-sifre-123' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error).toEqual(unknown.json().error);
  });

  it('token olmadan veya bozuk token ile 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await client(app, 'bozuk.token.degeri').get('/api/me')).statusCode).toBe(401);
  });

  it('refresh token döner; döndürülen token hemen tekrar sunulursa 409 (çakışma) verir ve yeni oturum bozulmaz', async () => {
    const s = await registerUser(app, 'Refresh');
    const first = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: s.cookie } });
    expect(first.statusCode).toBe(200);
    const newCookie = first.cookies.find((c) => c.name === 'refresh_token')!.value;
    expect(newCookie).not.toBe(s.cookie);

    // Tolerans penceresi içinde eski token: çakışma (yeni token verilmez, oturumlar kapanmaz)
    const race = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: s.cookie } });
    expect(race.statusCode).toBe(409);
    expect(race.json().error.code).toBe('REFRESH_CONFLICT');
    const next = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: newCookie } });
    expect(next.statusCode).toBe(200);
  });

  it('çıkış refresh tokenını iptal eder', async () => {
    const s = await registerUser(app, 'Logout');
    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { refresh_token: s.cookie } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: s.cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('şifre değişince eski şifre geçmez ve refresh tokenlar kapanır', async () => {
    const s = await registerUser(app, 'Pwd');
    const wrong = await client(app, s.token).post('/api/auth/change-password', {
      currentPassword: 'yanlis-sifre-123',
      newPassword: 'Yeni-Sifre-98765',
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await client(app, s.token).post('/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'Yeni-Sifre-98765',
    });
    expect(ok.statusCode).toBe(200);
    const old = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: PASSWORD } });
    expect(old.statusCode).toBe(401);
    const fresh = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: 'Yeni-Sifre-98765' } });
    expect(fresh.statusCode).toBe(200);
    const refresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: s.cookie } });
    expect(refresh.statusCode).toBe(401);
  });
});
