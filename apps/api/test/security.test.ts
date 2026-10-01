import { createHash } from 'node:crypto';
import pg from 'pg';
import type { RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '@erp/shared';
import { buildApp } from '../src/app';
import { loadConfig, parseTrustProxy } from '../src/config';
import { createDb } from '../src/db/client';
import { GUARD, type GuardMeta } from '../src/http/context';
import {
  PASSWORD,
  addMember,
  asOwner,
  client,
  createCompany,
  day,
  execAsOwner,
  expectDbError,
  makeApp,
  registerUser,
} from './helpers';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'refresh_token')!.value;

describe('üye ve sahip yönetimi (yetki yükseltme)', async () => {
  const { app } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const owner = client(app, s.token, company.id);
    return { s, company, owner };
  }

  it('yönetici (admin) sahip rolü veremez, kendini sahip yapamaz, sahibi düşüremez ya da çıkaramaz', async () => {
    const { s, company, owner } = await setup('Yukselt');
    const admin = await addMember(app, owner, company.id, 'admin');

    // Yeni üyeyi sahip olarak ekleme
    const addOwner = await admin.client.post('/api/company/members', {
      email: `x-${Date.now()}@example.com`, fullName: 'Sızma Kişi', role: 'owner', password: PASSWORD,
    });
    expect(addOwner.statusCode).toBe(403);
    expect(addOwner.json().error.code).toBe('OWNER_ONLY');

    // Kendini sahipliğe yükseltme
    const self = await admin.client.patch(`/api/company/members/${admin.userId}`, { role: 'owner' });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('OWNER_ONLY');

    // Sahibi düşürme ve çıkarma
    const demote = await admin.client.patch(`/api/company/members/${s.userId}`, { role: 'viewer' });
    expect(demote.statusCode).toBe(403);
    const remove = await admin.client.delete(`/api/company/members/${s.userId}`);
    expect(remove.statusCode).toBe(403);

    // Yönetici yine de diğer rolleri yönetebilir
    const acct = await admin.client.post('/api/company/members', {
      email: `m-${Date.now()}@example.com`, fullName: 'Muhasebe Kişi', role: 'accountant', password: PASSWORD,
    });
    expect(acct.statusCode).toBe(201);
    const change = await admin.client.patch(`/api/company/members/${acct.json().member.userId}`, { role: 'viewer' });
    expect(change.statusCode).toBe(200);
  });

  it('sahip ikinci bir sahip ekleyebilir, sonra birini düşürebilir; son sahip düşürülemez', async () => {
    const { s, company, owner } = await setup('Sahip');
    const second = await addMember(app, owner, company.id, 'owner');
    expect((await owner.patch(`/api/company/members/${second.userId}`, { role: 'admin' })).statusCode).toBe(200);
    const last = await owner.patch(`/api/company/members/${s.userId}`, { role: 'admin' });
    expect(last.statusCode).toBe(422);
    expect(last.json().error.code).toBe('LAST_OWNER');
    expect((await owner.delete(`/api/company/members/${s.userId}`)).json().error.code).toBe('LAST_OWNER');
  });

  it('iki sahip aynı anda birbirini düşürürse biri LAST_OWNER ile reddedilir (sahipsiz şirket kalmaz)', async () => {
    for (let i = 0; i < 4; i++) {
      const { s, company, owner } = await setup(`Yaris${i}`);
      const second = await addMember(app, owner, company.id, 'owner');
      const a = client(app, s.token, company.id);
      const [r1, r2] = await Promise.all([
        a.patch(`/api/company/members/${second.userId}`, { role: 'viewer' }),
        second.client.patch(`/api/company/members/${s.userId}`, { role: 'viewer' }),
      ]);
      // Tam olarak biri başarılı olur; öteki, düşürülmeden önce yetki kontrolüne (403) ya da son-sahip kilidine (422) takılır
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes[0]).toBe(200);
      expect([403, 422]).toContain(codes[1]);
      const owners = await execAsOwner(`select count(*)::int as n from memberships where company_id = $1 and role = 'owner'`, [company.id]);
      expect(owners.rows[0].n).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('yenileme (refresh) token güvenliği', async () => {
  const { app } = await makeApp();
  const refresh = (cookie: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: cookie }, headers });

  it('aynı token ile eşzamanlı iki yenileme: biri 200, diğeri 409; kazananın yeni token\'ı geçerli kalır', async () => {
    const s = await registerUser(app, 'Es');
    // İki istek de token'ı okuyup GÜNCELLEMEDE bekler (satır kilidi elle tutulur); kilit açılınca yalnızca biri kazanmalı.
    const lock = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test' });
    await lock.connect();
    await lock.query('BEGIN');
    await lock.query('select 1 from refresh_tokens where token_hash = $1 for update', [sha256(s.cookie)]);
    const pa = refresh(s.cookie);
    const pb = refresh(s.cookie);
    await new Promise((r) => setTimeout(r, 400));
    await lock.query('ROLLBACK');
    await lock.end();
    const [a, b] = await Promise.all([pa, pb]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const winner = a.statusCode === 200 ? a : b;
    const loser = a.statusCode === 200 ? b : a;
    expect(loser.json().error.code).toBe('REFRESH_CONFLICT');
    // Kaybeden yeni bir token almadı; kazananın token'ı kullanılabilir ve oturumlar kapanmadı
    expect(loser.cookies.find((c) => c.name === 'refresh_token')).toBeUndefined();
    expect((await refresh(cookieOf(winner))).statusCode).toBe(200);
  });

  it('tolerans penceresi dışında yeniden kullanılan token toplu iptale yol açar (çalınma şüphesi)', async () => {
    const s = await registerUser(app, 'Calinma');
    const first = await refresh(s.cookie);
    expect(first.statusCode).toBe(200);
    const fresh = cookieOf(first);
    // Döndürme anını 1 dakika geriye al: artık çakışma değil, yeniden kullanım
    await execAsOwner(`update refresh_tokens set rotated_at = now() - interval '1 minute' where token_hash = $1`, [sha256(s.cookie)]);
    const reuse = await refresh(s.cookie);
    expect(reuse.statusCode).toBe(401);
    expect((await refresh(fresh)).statusCode).toBe(401);
  });

  it('oturumun mutlak ömrü dolunca yenileme reddedilir', async () => {
    const s = await registerUser(app, 'Omur');
    await execAsOwner(`update refresh_tokens set family_started_at = now() - interval '91 days' where token_hash = $1`, [sha256(s.cookie)]);
    const res = await refresh(s.cookie);
    expect(res.statusCode).toBe(401);
  });

  it('yenilenen token oturum ailesini ve başlangıç zamanını korur; süresi ilk girişten sayılır', async () => {
    const s = await registerUser(app, 'Aile');
    const first = await refresh(s.cookie);
    const next = cookieOf(first);
    const rows = await execAsOwner(
      `select family_id, family_started_at from refresh_tokens where token_hash = any($1)`,
      [[sha256(s.cookie), sha256(next)]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].family_id).toBe(rows.rows[1].family_id);
    expect(new Date(rows.rows[0].family_started_at).getTime()).toBe(new Date(rows.rows[1].family_started_at).getTime());
  });

  it('girişte kullanıcının süresi dolmuş token satırları temizlenir', async () => {
    const s = await registerUser(app, 'Temiz');
    await execAsOwner(`update refresh_tokens set expires_at = now() - interval '2 days' where user_id = $1`, [s.userId]);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const left = await execAsOwner(`select count(*)::int as n from refresh_tokens where user_id = $1 and expires_at < now()`, [s.userId]);
    expect(left.rows[0].n).toBe(0);
  });

  it('şifre değişince diğer oturumlar kapanır, isteği gönderen oturum açık kalır', async () => {
    const s = await registerUser(app, 'Kalan');
    const other = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: PASSWORD } });
    const otherCookie = cookieOf(other);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${s.token}` },
      cookies: { refresh_token: s.cookie },
      payload: { currentPassword: PASSWORD, newPassword: 'Yepyeni-Sifre-4567' },
    });
    expect(res.statusCode).toBe(200);
    expect((await refresh(s.cookie)).statusCode).toBe(200);
    expect((await refresh(otherCookie)).statusCode).toBe(401);
  });
});

describe('oran sınırları', () => {
  it('giriş IP başına sınırlıdır; X-Forwarded-For sahteciliği TRUST_PROXY=false iken işe yaramaz', async () => {
    const { app } = await makeApp({ configOverrides: { RATE_LIMIT_ENABLED: true, TRUST_PROXY: false } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
        payload: { email: `kimse-${i}@example.com`, password: 'yanlis-sifre-123' },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(res.json().error.code).toBe('RATE_LIMITED');
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10).every((c) => c === 429)).toBe(true);
  });

  // Vekil arkasında (Caddy/cloudflared) istemci adresi X-Forwarded-For'dan okunmalı; yoksa tüm kullanıcılar tek kovaya düşer.
  // Her istek başka e-posta kullanır: yalnızca IP başına sınır (10/dk) ölçülür, e-posta+IP sınırı (5 başarısız) devreye girmez.
  let seq = 0;
  const loginAs = (app: Awaited<ReturnType<typeof makeApp>>['app'], ip: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': ip },
      payload: { email: `kimse-${++seq}@example.com`, password: 'yanlis-sifre-123' },
    });

  it('vekil listesi (loopback,uniquelocal) verildiğinde X-Forwarded-For istemci adresini belirler: istemciler ayrı kovalara düşer', async () => {
    const { app } = await makeApp({ configOverrides: { RATE_LIMIT_ENABLED: true, TRUST_PROXY: parseTrustProxy('loopback,uniquelocal') } });
    for (let i = 0; i < 10; i++) expect((await loginAs(app, '203.0.113.10')).statusCode).toBe(401);
    expect((await loginAs(app, '203.0.113.10')).statusCode).toBe(429);
    // Başka bir istemci (başka IP) etkilenmez
    expect((await loginAs(app, '203.0.113.11')).statusCode).toBe(401);
  });

  it('sayısal atlama değeri Fastify 5.12\'de etkisizdir (tüm istemciler vekil adresi altında tek kovaya düşer); bu yüzden loadConfig sayıyı reddeder', async () => {
    // configOverrides doğrulamayı atlar: yalnızca Fastify'ın davranışını sabitler (bağımlılık değişirse bu test uyarır).
    const { app } = await makeApp({ configOverrides: { RATE_LIMIT_ENABLED: true, TRUST_PROXY: 1 } });
    for (let i = 0; i < 10; i++) expect((await loginAs(app, '203.0.113.20')).statusCode).toBe(401);
    expect((await loginAs(app, '203.0.113.21')).statusCode).toBe(429);
  });

  it('aynı e-posta+IP için 5 başarısız denemeden sonra doğru şifre bile 429 alır; başka IP etkilenmez', async () => {
    const { app } = await makeApp({ configOverrides: { RATE_LIMIT_ENABLED: true, TRUST_PROXY: true } });
    const s = await registerUser(app, 'Kilit');
    const login = (ip: string, password: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': ip }, payload: { email: s.email, password } });
    for (let i = 0; i < 5; i++) expect((await login('198.51.100.7', 'yanlis-sifre-123')).statusCode).toBe(401);
    const blocked = await login('198.51.100.7', PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('198.51.100.8', PASSWORD)).statusCode).toBe(200);
  });

  it('bir e-postaya farklı IP\'lerden yapılan 30 başarısız denemeden sonra e-posta genelinde 429 verilir', async () => {
    const { app } = await makeApp({ configOverrides: { RATE_LIMIT_ENABLED: true, TRUST_PROXY: true } });
    const s = await registerUser(app, 'Dagit');
    const login = (ip: string, password: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': ip }, payload: { email: s.email, password } });
    for (let i = 0; i < 30; i++) expect((await login(`192.0.2.${i + 1}`, 'yanlis-sifre-123')).statusCode).toBe(401);
    expect((await login('192.0.2.200', PASSWORD)).statusCode).toBe(429);
  });

  it('dışa aktarma kullanıcı başına dakikada 30 ile sınırlıdır', async () => {
    const { app } = await makeApp({ configOverrides: { RATE_LIMIT_ENABLED: true } });
    const s = await registerUser(app, 'Aktar');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const url = `/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&format=csv`;
    for (let i = 0; i < 30; i++) expect((await c.get(url)).statusCode).toBe(200);
    const over = await c.get(url);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    // Başka kullanıcı etkilenmez
    const t = await registerUser(app, 'Baska');
    const company2 = await createCompany(app, t.token);
    expect((await client(app, t.token, company2.id).get(url)).statusCode).toBe(200);
  });
});

describe('köken denetimi ve önbellek başlıkları', async () => {
  const { app } = await makeApp({ configOverrides: { CORS_ORIGIN: ['https://panel.example'] } });
  const login = (headers: Record<string, string>, email = 'yok@example.com') =>
    app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email, password: 'yanlis-sifre-123' } });

  it('Origin başlığı isteğin kendi kökeni ya da izinli köken değilse 403 BAD_ORIGIN', async () => {
    const evil = await login({ host: 'erp.example.com', origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('BAD_ORIGIN');
    expect((await login({ host: 'erp.example.com', origin: 'null' })).statusCode).toBe(403);
    // Kendi kökeni ve izinli köken geçer (kimlik bilgisi hatalı olduğundan 401)
    expect((await login({ host: 'erp.example.com', origin: 'https://erp.example.com' })).statusCode).toBe(401);
    expect((await login({ host: 'erp.example.com', origin: 'https://panel.example' })).statusCode).toBe(401);
    // Origin yoksa (sunucu-sunucu) geçer
    expect((await login({})).statusCode).toBe(401);
  });

  it('çıkış ve yenileme uçları da kökeni denetler', async () => {
    const s = await registerUser(app, 'Kok');
    const bad = { host: 'erp.example.com', origin: 'https://evil.example' };
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: bad, cookies: { refresh_token: s.cookie } });
    expect(out.statusCode).toBe(403);
    const ref = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: bad, cookies: { refresh_token: s.cookie } });
    expect(ref.statusCode).toBe(403);
    // Reddedilen istek token'ı tüketmedi
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: s.cookie } })).statusCode).toBe(200);
  });

  it('API yanıtları önbelleğe alınmaz; dışa aktarma kendi başlığını korur', async () => {
    const s = await registerUser(app, 'Onbellek');
    const me = await client(app, s.token).get('/api/me');
    expect(me.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).headers['cache-control']).toBe('no-store');
  });
});

describe('denetim kaydı salt eklenir', async () => {
  const { app } = await makeApp();

  it('şema sahibi rolü bile denetim kaydını değiştiremez ya da silemez (ERP07)', async () => {
    const s = await registerUser(app, 'Denetim');
    await createCompany(app, s.token);
    await asOwner(async (q) => {
      expect((await q('select count(*)::int as n from audit_log')).rows[0].n).toBeGreaterThan(0);
      expect((await expectDbError(q, `update audit_log set action = 'X'`)).code).toBe('ERP07');
      expect((await expectDbError(q, `delete from audit_log`)).code).toBe('ERP07');
    });
  });
});

describe('sözleşme testleri', async () => {
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL, { max: 2 });
  const routes: RouteOptions[] = [];
  const app = await buildApp({ db: handle.db, config, logger: false, onRoute: (r) => routes.push(r) });
  await app.ready();

  const methodsOf = (r: RouteOptions) => (Array.isArray(r.method) ? r.method : [r.method]).filter((m) => m !== 'HEAD');
  const guardOf = (r: RouteOptions) => (r.handler as unknown as Record<symbol, GuardMeta | undefined>)[GUARD];

  // Kimliksiz erişilebilen tek uçlar: sağlık, genel ayar ve oturum uçları. Yeni bir kamuya açık uç eklemek bilinçli bir karardır.
  const PUBLIC = [
    'GET /api/health',
    'GET /api/health/ready',
    'GET /api/public-config',
    'POST /api/auth/register',
    'POST /api/auth/login',
    // İkinci adım: yalnızca 5 dakikalık purpose:'mfa' belirteciyle çalışır (parola doğrulandıktan sonra verilir).
    'POST /api/auth/mfa/verify',
    'POST /api/auth/refresh',
    'POST /api/auth/logout',
    'POST /api/auth/forgot-password',
    'POST /api/auth/reset-password',
    'POST /api/auth/verify-email',
    // Yalnızca kurulum lisanssızken kimliksiz açıktır (etkinleştirme akışı); bir kira varsa şirket sahibi gerekir.
    'POST /api/license/activate',
    'POST /api/license/offline-activate',
    'POST /api/license/offline-request',
  ].sort();

  it('her /api rotası kamuya açık listede ya da tenantRoute/authedRoute kapısındadır (liste birebir)', () => {
    const unguarded: string[] = [];
    let guarded = 0;
    for (const r of routes) {
      if (!r.url.startsWith('/api/')) continue;
      for (const m of methodsOf(r)) {
        if (guardOf(r)) guarded++;
        else unguarded.push(`${m} ${r.url}`);
      }
    }
    expect(unguarded.sort()).toEqual(PUBLIC);
    expect(guarded).toBeGreaterThan(100);
  });

  it('yazma yapan (GET dışı) her şirket rotası bir izin ister', () => {
    const missing: string[] = [];
    for (const r of routes) {
      const g = guardOf(r);
      if (!r.url.startsWith('/api/') || g?.kind !== 'tenant') continue;
      for (const m of methodsOf(r)) {
        if (m !== 'GET' && !g.permission) missing.push(`${m} ${r.url}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('rotalarda geçen izinler ve modüller tanımlı kayıtlardandır', () => {
    for (const r of routes) {
      const g = guardOf(r);
      if (g?.permission) expect(PERMISSIONS as readonly string[]).toContain(g.permission);
    }
  });

  it('company_id sütunlu her tabloda RLS açık ve en az bir politika var; yalnızca bilinen kiracı-dışı tablolar hariç', async () => {
    await asOwner(async (q) => {
      const tenant = await q(`
        select c.relname, c.relrowsecurity, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
          from pg_class c
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`);
      expect(tenant.rows.length).toBeGreaterThan(25);
      for (const t of tenant.rows) {
        expect(t.relrowsecurity, `${t.relname} RLS`).toBe(true);
        expect(t.policies, `${t.relname} politika`).toBeGreaterThan(0);
      }
      // Kiracı sütunu olmayan tablolar: yeni bir tablo buraya bilinçli eklenmeli (kiracı verisi taşımadığı doğrulanarak)
      const global = await q(`
        select c.relname from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
           and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped)
         order by 1`);
      expect(global.rows.map((r) => r.relname)).toEqual([
        'companies', 'currencies', 'devices', 'license_state', 'organizations', 'refresh_tokens', 'security_events', 'user_mfa', 'user_tokens', 'users',
      ]);
    });
  });

  it('SECURITY DEFINER yalnızca bilinen işlevler; çalışma zamanı rolü süper kullanıcı/BYPASSRLS/tablo sahibi değil', async () => {
    await asOwner(async (q) => {
      const definers = await q(
        `select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef order by 1`,
      );
      // audit_row_change: denetim izi; license_company_count: RLS'i aşan, yalnızca sayı döndüren şirket sayımı (lisans sınırı)
      expect(definers.rows.map((r) => r.proname)).toEqual(['audit_row_change', 'license_company_count']);
      const role = await q(`select rolsuper, rolbypassrls from pg_roles where rolname = 'erp_app'`);
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const owned = await q(
        `select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and pg_get_userbyid(relowner) = 'erp_app'`,
      );
      expect(owned.rows[0].n).toBe(0);
    });
  });
});
