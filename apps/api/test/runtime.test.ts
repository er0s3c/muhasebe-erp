import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { loadConfig, parseTrustProxy } from '../src/config';
import { checkRuntimeRole } from '../src/db/preflight';
import { buildApp } from '../src/app';
import { PASSWORD, client, makeApp, registerUser } from './helpers';

const base = {
  DATABASE_URL: 'postgres://erp_app:erp_app@localhost:5432/erp_test',
  JWT_SECRET: 'a-random-secret-with-more-than-32-characters-0123',
};

describe('yapılandırma', () => {
  it('üretimde örnek/geliştirme JWT_SECRET değerini reddeder', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'dev-only-secret-change-me-please-32chars-min' }),
    ).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'ci-only-secret-ci-only-secret-32chars' })).toThrow(
      /JWT_SECRET/,
    );
    // Aynı değer geliştirmede sorun değil
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: 'dev-only-secret-change-me-please-32chars-min' }),
    ).not.toThrow();
    // Rastgele güçlü değer üretimde kabul edilir
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });

  it('JWT_SECRET 32 karakterden kısa olamaz', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'kisa' })).toThrow(/JWT_SECRET/);
  });

  it('CORS_ORIGIN üretimde boş (aynı köken), geliştirmede Vite adresi; liste kırpılır', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).CORS_ORIGIN).toEqual([]);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).CORS_ORIGIN).toEqual(['http://localhost:5173']);
    expect(loadConfig({ ...base, CORS_ORIGIN: ' https://a.example , https://b.example ,' }).CORS_ORIGIN).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('COOKIE_SECURE varsayılanı yalnızca üretimde açık; açıkça geçersiz kılınabilir', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).COOKIE_SECURE).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
    expect(loadConfig({ ...base, NODE_ENV: 'development', COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
  });

  it('TRUST_PROXY ayrıştırılır ve varsayılan false', () => {
    expect(loadConfig(base).TRUST_PROXY).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('yeni kayıt varsayılan açık; DB_POOL_MAX ve zaman aşımları sayı olur', () => {
    const c = loadConfig({ ...base, DB_POOL_MAX: '25', DB_STATEMENT_TIMEOUT_MS: '30000' });
    expect(c.REGISTRATION_ENABLED).toBe(true);
    expect(c.DB_POOL_MAX).toBe(25);
    expect(c.DB_STATEMENT_TIMEOUT_MS).toBe(30000);
    expect(loadConfig({ ...base, REGISTRATION_ENABLED: 'false' }).REGISTRATION_ENABLED).toBe(false);
  });
});

describe('sağlık uçları ve genel ayarlar', () => {
  it('/api/health veritabanına dokunmaz, /api/health/ready dokunur', async () => {
    const { app } = await makeApp();
    const live = await app.inject({ method: 'GET', url: '/api/health' });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok' });
  });

  it('veritabanı yanıt vermezse hazırlık 503 döner, canlılık 200 kalır', async () => {
    const config = loadConfig();
    const broken = { execute: () => Promise.reject(new Error('bağlantı koptu')) } as unknown as Db;
    const app = await buildApp({ db: broken, config, logger: false });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(503);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('public-config kayıt durumunu ve sürümü gösterir', async () => {
    const { app } = await makeApp({ configOverrides: { APP_VERSION: '1.2.3' } });
    const res = await app.inject({ method: 'GET', url: '/api/public-config' });
    expect(res.json()).toEqual({ registrationEnabled: true, mailEnabled: false, version: '1.2.3' });
  });

  it('istek kimliği yanıt başlığında döner; geçerli gelen kimlik korunur, geçersiz olan değiştirilir', async () => {
    const { app } = await makeApp();
    const generated = await app.inject({ method: 'GET', url: '/api/health' });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'destek-123' } });
    expect(kept.headers['x-request-id']).toBe('destek-123');
    const replaced = await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-request-id': 'kötü değer!' } });
    expect(replaced.headers['x-request-id']).not.toBe('kötü değer!');
  });
});

describe('kayıt bayrağı ve çerez', () => {
  it('REGISTRATION_ENABLED=false iken kayıt 403 REGISTRATION_DISABLED verir, giriş sürer', async () => {
    const open = await makeApp();
    const user = await registerUser(open.app, 'Bayrak');

    const { app } = await makeApp({ configOverrides: { REGISTRATION_ENABLED: false } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'yeni@example.com', password: PASSWORD, fullName: 'Yeni Kişi', organizationName: 'Yeni Ltd' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('REGISTRATION_DISABLED');
    expect((await app.inject({ method: 'GET', url: '/api/public-config' })).json().registrationEnabled).toBe(false);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
  });

  it('yenileme çerezi HttpOnly, SameSite ve /api/auth yolunda; Secure bayrağı COOKIE_SECURE ile', async () => {
    for (const secure of [true, false]) {
      const { app } = await makeApp({ configOverrides: { COOKIE_SECURE: secure } });
      const user = await registerUser(app, 'Cerez');
      void user;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: `cerez-${secure}-${Date.now()}@example.com`, password: PASSWORD, fullName: 'Çerez Test', organizationName: 'Çerez Ltd' },
      });
      const cookie = res.cookies.find((c) => c.name === 'refresh_token');
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.path).toBe('/api/auth');
      expect(String(cookie?.sameSite).toLowerCase()).toBe('lax');
      expect(Boolean(cookie?.secure)).toBe(secure);
    }
  });

  it('X-Company-Id katı UUID biçimi ister (tirelerden oluşan 36 karakter reddedilir)', async () => {
    const { app } = await makeApp();
    const user = await registerUser(app, 'Uuid');
    const bad = await client(app, user.token, '-'.repeat(36)).get('/api/navigation');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('COMPANY_REQUIRED');
  });
});

describe('çalışma zamanı rolü denetimi', () => {
  it('RLS\'e tabi çalışma zamanı rolü (erp_app) için sorun bildirmez', async () => {
    const { handle } = await makeApp();
    expect(await checkRuntimeRole(handle.db)).toEqual([]);
  });

  it('şema sahibi rolüyle bağlanılırsa RLS\'in atlandığını bildirir', async () => {
    const owner = createDb(process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test', { max: 1 });
    try {
      const issues = await checkRuntimeRole(owner.db);
      expect(issues.map((i) => i.code)).toContain('ROLE_OWNS_TABLES');
    } finally {
      await owner.close();
    }
  });
});
