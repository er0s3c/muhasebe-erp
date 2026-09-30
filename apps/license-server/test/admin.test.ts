import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseLeaseToken } from '@erp/license-core';
import { adminSessions, admins, auditLog } from '../src/db/schema';
import { ADMIN_GUARD, CSRF_HEADER, CSRF_VALUE } from '../src/modules/admin-auth';
import { DAY, activate, adminClient, createAdmin, heartbeat, issueLicense, loginAdmin, makeInstallation, makeServer, offlineRequestCode, totpNow } from './helpers';

const s = await makeServer();

describe('yönetici kimlik doğrulama', () => {
  it('parola VE TOTP gerekir; çerez httpOnly + SameSite=Strict; oturum çıkışta ve süre dolunca geçersizleşir', async () => {
    const a = await createAdmin(s);
    const ok = await loginAdmin(s, a);
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'lic_admin')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    const me = await s.app.inject({ method: 'GET', url: '/admin/api/me', cookies: { lic_admin: cookie.value } });
    expect(me.json().admin.email).toBe(a.email);

    // Çıkış
    const out = await s.app.inject({ method: 'POST', url: '/admin/api/logout', cookies: { lic_admin: cookie.value }, headers: { [CSRF_HEADER]: CSRF_VALUE } });
    expect(out.statusCode).toBe(200);
    expect((await s.app.inject({ method: 'GET', url: '/admin/api/me', cookies: { lic_admin: cookie.value } })).statusCode).toBe(401);

    // Süre dolumu (8 saat)
    s.clock.t += 61_000; // yeni TOTP adımı
    const again = await loginAdmin(s, a);
    const c2 = again.cookies.find((c) => c.name === 'lic_admin')!.value;
    s.clock.t += 8 * 3600_000 + 1000;
    expect((await s.app.inject({ method: 'GET', url: '/admin/api/me', cookies: { lic_admin: c2 } })).statusCode).toBe(401);
  });

  it('yanlış parola, yanlış/eksik TOTP ve bilinmeyen e-posta aynı genel hatayı verir', async () => {
    const a = await createAdmin(s);
    for (const res of [
      await loginAdmin(s, a, { password: 'yanlis-parola' }),
      await loginAdmin(s, a, { totp: '000000' }),
      await s.app.inject({ method: 'POST', url: '/admin/api/login', payload: { email: 'yok@ornek.com', password: 'x', totp: '123456' } }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    }
    expect((await s.app.inject({ method: 'POST', url: '/admin/api/login', payload: { email: a.email, password: a.password } })).statusCode).toBe(400); // TOTP zorunlu
    // Doğru parola + doğru TOTP girer
    expect((await loginAdmin(s, a)).statusCode).toBe(200);
  });

  it('aynı TOTP kodu yeniden kullanılamaz (yeniden oynatma)', async () => {
    const a = await createAdmin(s);
    const code = totpNow(a.secret, s.clock.t);
    expect((await loginAdmin(s, a, { totp: code })).statusCode).toBe(200);
    const replay = await loginAdmin(s, a, { totp: code });
    expect(replay.statusCode).toBe(401);
    // Eski bir adımın kodu da (sayaç ilerlemediği için) kabul edilmez
    expect((await loginAdmin(s, a, { totp: totpNow(a.secret, s.clock.t, -1) })).statusCode).toBe(401);
  });

  it('pasifleştirilmiş yönetici giremez ve mevcut oturumu çalışmaz', async () => {
    const c = await adminClient(s);
    await s.handle.db.update(admins).set({ isActive: false }).where(eq(admins.email, c.admin.email));
    expect((await c.get('/admin/api/me')).statusCode).toBe(401);
    s.clock.t += 61_000;
    expect((await loginAdmin(s, c.admin)).statusCode).toBe(401);
  });

  it('başarısız girişler (e-posta+IP) 5 denemeden sonra engellenir', async () => {
    const rl = await makeServer({ rateLimit: true });
    const a = await createAdmin(rl);
    for (let i = 0; i < 5; i++) expect((await loginAdmin(rl, a, { password: 'yanlis', ip: '10.1.1.1' })).statusCode).toBe(401);
    const blocked = await loginAdmin(rl, a, { ip: '10.1.1.1' }); // doğru bilgiler bile
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('başarısız ve başarılı girişler denetim kaydına yazılır; parola/TOTP kaydedilmez', async () => {
    const a = await createAdmin(s);
    await loginAdmin(s, a, { password: 'cok-gizli-yanlis-parola' });
    s.clock.t += 61_000;
    await loginAdmin(s, a);
    const rows = await s.handle.db.select().from(auditLog).where(eq(auditLog.actor, 'admin'));
    const mine = rows.filter((r) => JSON.stringify(r.meta ?? {}).includes(a.email) || r.action === 'admin.login');
    expect(mine.some((r) => r.action === 'admin.login_failed')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('cok-gizli-yanlis-parola');
    expect(JSON.stringify(rows)).not.toContain(a.secret);
  });
});

describe('yönetim uçlarının korunması', () => {
  it('rota envanteri: /admin/api altındaki (giriş/kurulum hariç) her rota yönetici kapısından geçer; genel uçlar bilinen listede', () => {
    const adminRoutes = s.routes.filter((r) => r.url.startsWith('/admin/api'));
    expect(adminRoutes.length).toBeGreaterThan(15);
    const unguarded = adminRoutes.filter((r) => (r.handler as Record<symbol, unknown>)[ADMIN_GUARD] !== true).map((r) => `${String(r.method)} ${r.url}`);
    // Kimlik doğrulamadan önce gereken uçlar: parola+TOTP girişi, ilk kurulum (kurulum koduyla), giriş anahtarıyla giriş
    expect(unguarded.sort()).toEqual(
      ['GET /admin/api/setup', 'HEAD /admin/api/setup', 'POST /admin/api/login', 'POST /admin/api/passkey/login', 'POST /admin/api/passkey/options', 'POST /admin/api/setup', 'POST /admin/api/setup/totp'].sort(),
    );
    const others = s.routes.filter((r) => !r.url.startsWith('/admin/api')).map((r) => r.url).sort();
    expect([...new Set(others)]).toEqual(['/healthz', '/v1/activate', '/v1/deactivate', '/v1/heartbeat']);
  });

  it('çerezsiz her yönetim isteği 401; değiştiren isteklerde CSRF başlığı ve köken denetimi', async () => {
    expect((await s.app.inject({ method: 'GET', url: '/admin/api/customers' })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: '/admin/api/licenses', payload: {} })).statusCode).toBe(401);
    const c = await adminClient(s);
    // CSRF başlığı yok
    const noHeader = await s.app.inject({ method: 'POST', url: '/admin/api/customers', payload: { name: 'Başlıksız' }, cookies: { lic_admin: c.cookie } });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error.code).toBe('CSRF');
    // Yanlış köken
    const evil = await s.app.inject({ method: 'POST', url: '/admin/api/customers', payload: { name: 'Kötü' }, cookies: { lic_admin: c.cookie }, headers: { [CSRF_HEADER]: CSRF_VALUE, origin: 'https://kotu.example' } });
    expect(evil.statusCode).toBe(403);
    // Aynı köken kabul
    const same = await s.app.inject({ method: 'POST', url: '/admin/api/customers', payload: { name: 'İyi' }, cookies: { lic_admin: c.cookie }, headers: { [CSRF_HEADER]: CSRF_VALUE, origin: 'http://localhost:4000', host: 'localhost:4000' } });
    expect(same.statusCode).toBe(201);
  });
});

describe('müşteri ve lisans yönetimi', () => {
  it('lisans oluşturulur; etkinleştirme kodu yalnızca bir kez döner ve hiçbir yerde tekrar görünmez', async () => {
    const c = await adminClient(s);
    const cust = (await c.post('/admin/api/customers', { name: 'Yıldız Market', email: 'y@ornek.com' })).json().customer;
    const created = await c.post('/admin/api/licenses', { customerId: cust.id, sectors: ['RETAIL_MARKET'], deviceLimit: 5, validUntil: '2030-12-31' });
    expect(created.statusCode).toBe(201);
    const { license, activationCode } = created.json();
    expect(activationCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(license).toMatchObject({ kind: 'commercial', deviceLimit: 5, companyLimit: 1, status: 'active', leaseDays: 7, graceDays: 14, maxActivations: 1 });
    expect(license.validUntil).toBe('2030-12-31T23:59:59.999Z');

    for (const url of [`/admin/api/licenses/${license.id}`, '/admin/api/licenses', `/admin/api/customers/${cust.id}`]) {
      const body = (await c.get(url)).body;
      expect(body, url).not.toContain(activationCode);
      expect(body, url).not.toMatch(/code_?hash|codeHash/i);
    }
    // Döndürülen kod gerçekten çalışır
    expect((await activate(s, makeInstallation(), activationCode)).res.statusCode).toBe(200);
  });

  it('doğrulama: geçersiz sektör/cihaz/tarih ve bilinmeyen müşteri reddedilir', async () => {
    const c = await adminClient(s);
    const cust = (await c.post('/admin/api/customers', { name: 'Doğrulama Ltd.' })).json().customer;
    const base = { customerId: cust.id, sectors: ['COMMERCE'], deviceLimit: 1, validUntil: '2030-01-01' };
    expect((await c.post('/admin/api/licenses', { ...base, sectors: ['BILINMEYEN'] })).statusCode).toBe(400);
    expect((await c.post('/admin/api/licenses', { ...base, sectors: [] })).statusCode).toBe(400);
    expect((await c.post('/admin/api/licenses', { ...base, sectors: ['COMMERCE', 'COMMERCE'] })).statusCode).toBe(400);
    expect((await c.post('/admin/api/licenses', { ...base, deviceLimit: 0 })).statusCode).toBe(400);
    expect((await c.post('/admin/api/licenses', { ...base, validUntil: 'yarın' })).statusCode).toBe(400);
    const past = await c.post('/admin/api/licenses', { ...base, validUntil: '2001-01-01' });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.code).toBe('VALID_UNTIL_PAST');
    expect((await c.post('/admin/api/licenses', { ...base, customerId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
  });

  it('güncelleme ve uzatma bir sonraki kirada yansır; askıya alma/devam/iptal; iptal geri alınamaz', async () => {
    const c = await adminClient(s);
    const { license, code } = await issueLicense(s, { leaseDays: 3, graceDays: 30, deviceIdleDays: 60, kind: 'trial', offlineAllowed: true, maxActivations: 2 });
    const inst = makeInstallation();
    await activate(s, inst, code);

    const before = (await c.get(`/admin/api/licenses/${license.id}`)).json().license;
    const upd = await c.patch(`/admin/api/licenses/${license.id}`, { sectors: ['CONSTRUCTION', 'COMMERCE'], deviceLimit: 12, companyLimit: 3 });
    expect(upd.statusCode).toBe(200);
    // Kısmi güncelleme yalnızca verilen alanları değiştirir (varsayılanlar diğer alanları sıfırlamaz)
    const { sectors: _s, deviceLimit: _d, companyLimit: _c, updatedAt: _u, customer: _n, ...untouched } = before;
    expect(upd.json().license).toMatchObject(untouched);
    s.clock.t += 1000;
    expect((await heartbeat(s, inst)).lease).toMatchObject({ sectors: ['CONSTRUCTION', 'COMMERCE'], deviceLimit: 12, companyLimit: 3 });

    const ext = await c.post(`/admin/api/licenses/${license.id}/extend`, { validUntil: '2040-01-01' });
    expect(ext.json().license.validUntil).toBe('2040-01-01T23:59:59.999Z');

    expect((await c.post(`/admin/api/licenses/${license.id}/suspend`)).json().license.status).toBe('suspended');
    s.clock.t += 1000;
    expect((await heartbeat(s, inst)).lease).toMatchObject({ status: 'suspended' });
    expect((await c.post(`/admin/api/licenses/${license.id}/resume`)).json().license.status).toBe('active');
    expect((await c.post(`/admin/api/licenses/${license.id}/revoke`)).json().license.status).toBe('revoked');
    const reopen = await c.post(`/admin/api/licenses/${license.id}/resume`);
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json().error.code).toBe('LICENSE_REVOKED');
    expect((await c.patch(`/admin/api/licenses/${license.id}`, {})).statusCode).toBe(400);
  });

  it('kodu yenileme eski kodu geçersiz kılar, mevcut etkinleştirme etkilenmez', async () => {
    const c = await adminClient(s);
    const { license, code } = await issueLicense(s, { maxActivations: 2 });
    const inst = makeInstallation();
    await activate(s, inst, code);
    const fresh = (await c.post(`/admin/api/licenses/${license.id}/regenerate-code`)).json().activationCode as string;
    expect((await activate(s, makeInstallation(), code)).res.statusCode).toBe(404);
    expect((await activate(s, makeInstallation(), fresh)).res.statusCode).toBe(200);
    s.clock.t += 1000;
    expect((await heartbeat(s, inst)).res.statusCode).toBe(200);
  });

  it('etkinleştirmeler listelenir; taşıma (devre dışı bırakma) ve klon işareti temizleme çalışır', async () => {
    const c = await adminClient(s);
    const { license, code } = await issueLicense(s);
    const inst = makeInstallation();
    await activate(s, inst, code);
    const detail = (await c.get(`/admin/api/licenses/${license.id}`)).json();
    expect(detail.activations).toHaveLength(1);
    const act = detail.activations[0];
    expect(act).toMatchObject({ installationId: inst.installationId, status: 'active', fingerprintPrefix: inst.fingerprint.slice(0, 12) });
    expect(JSON.stringify(detail)).not.toContain(inst.publicKey);

    const moved = await c.post(`/admin/api/activations/${act.id}/deactivate`);
    expect(moved.json().activation.status).toBe('deactivated');
    expect((await c.get(`/admin/api/licenses/${license.id}`)).json().license.transfersUsed).toBe(1);
    expect((await activate(s, makeInstallation(), code)).res.statusCode).toBe(200);
    expect((await c.post(`/admin/api/activations/${act.id}/clear-flag`)).statusCode).toBe(200);
    expect((await c.post('/admin/api/activations/00000000-0000-4000-8000-000000000000/deactivate')).statusCode).toBe(404);
  });

  it('özet sayaçlar, müşteri arama ve denetim kaydı (yönetici kimliğiyle)', async () => {
    const c = await adminClient(s);
    const cust = (await c.post('/admin/api/customers', { name: 'Özel_%Arama Ltd.' })).json().customer;
    await c.post('/admin/api/licenses', { customerId: cust.id, sectors: ['COMMERCE'], deviceLimit: 1, validUntil: new Date(s.clock.t + 10 * DAY).toISOString() });
    const dash = (await c.get('/admin/api/dashboard')).json();
    expect(dash.customers).toBeGreaterThan(0);
    expect(dash.licenses.active).toBeGreaterThan(0);
    expect(dash.expiringIn30Days).toBeGreaterThan(0);
    // LIKE joker karakterleri kaçışlı
    expect((await c.get('/admin/api/customers?q=' + encodeURIComponent('%Arama'))).json().customers.map((x: { id: string }) => x.id)).toContain(cust.id);
    expect((await c.get('/admin/api/customers?q=' + encodeURIComponent('%'))).json().customers.every((x: { name: string }) => x.name.includes('%'))).toBe(true);
    const audit = (await c.get('/admin/api/audit?limit=10')).json().entries;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.some((e: { action: string; adminId: string }) => e.action === 'license.create' && e.adminId)).toBe(true);
  });
});

describe('çevrimdışı etkinleştirme', () => {
  it('izin verilen lisans için imzalı, yenilenemez çevrimdışı kira üretir; istek kimliği nonce olarak gömülür', async () => {
    const c = await adminClient(s);
    const { license } = await issueLicense(s, { offlineAllowed: true });
    const inst = makeInstallation();
    const { code, requestId } = offlineRequestCode(inst, s.clock.t);
    const res = await c.post(`/admin/api/licenses/${license.id}/offline-lease`, { requestCode: code, days: 120 });
    expect(res.statusCode).toBe(200);
    const lease = parseLeaseToken(res.json().lease, s.ring);
    expect(lease).toMatchObject({ typ: 'offline-lease', installationId: inst.installationId, fingerprint: inst.fingerprint, nonce: requestId, status: 'active' });
    expect(lease.leaseUntil - s.clock.t).toBe(120 * DAY);
    // Kurulum açık anahtarı sabitlendi ve etkinleştirme sayıldı
    const detail = (await c.get(`/admin/api/licenses/${license.id}`)).json();
    expect(detail.activations[0]).toMatchObject({ offline: true, installationId: inst.installationId });
  });

  it('kira süresi lisans bitişini aşamaz; izin verilmeyen lisans, eski/kurcalanmış kod ve yuva sınırı reddedilir', async () => {
    const c = await adminClient(s);
    const short = await issueLicense(s, { offlineAllowed: true, validUntil: new Date(s.clock.t + 30 * DAY) });
    const r = await c.post(`/admin/api/licenses/${short.license.id}/offline-lease`, { requestCode: offlineRequestCode(makeInstallation(), s.clock.t).code, days: 300 });
    expect(parseLeaseToken(r.json().lease, s.ring).leaseUntil).toBe(short.license.validUntil.getTime());

    const closed = await issueLicense(s, { offlineAllowed: false });
    const no = await c.post(`/admin/api/licenses/${closed.license.id}/offline-lease`, { requestCode: offlineRequestCode(makeInstallation(), s.clock.t).code });
    expect(no.statusCode).toBe(409);
    expect(no.json().error.code).toBe('OFFLINE_NOT_ALLOWED');

    const ok = await issueLicense(s, { offlineAllowed: true });
    const stale = await c.post(`/admin/api/licenses/${ok.license.id}/offline-lease`, { requestCode: offlineRequestCode(makeInstallation(), s.clock.t - 8 * DAY).code });
    expect(stale.json().error.code).toBe('REQUEST_CODE_EXPIRED');
    const good = offlineRequestCode(makeInstallation(), s.clock.t).code.split('.');
    good[1] = Buffer.from('{"installationId":"x"}').toString('base64url');
    expect((await c.post(`/admin/api/licenses/${ok.license.id}/offline-lease`, { requestCode: good.join('.') })).json().error.code).toBe('INVALID_REQUEST_CODE');

    // maxActivations=1: ikinci kurulum reddedilir
    expect((await c.post(`/admin/api/licenses/${ok.license.id}/offline-lease`, { requestCode: offlineRequestCode(makeInstallation(), s.clock.t).code })).statusCode).toBe(200);
    const second = await c.post(`/admin/api/licenses/${ok.license.id}/offline-lease`, { requestCode: offlineRequestCode(makeInstallation(), s.clock.t).code });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ACTIVATION_LIMIT');
  });
});

describe('oturum temizliği', () => {
  it('oturum tablosunda yalnızca özet saklanır (çerez değeri düz metin değildir)', async () => {
    const c = await adminClient(s);
    const rows = await s.handle.db.select().from(adminSessions);
    expect(rows.some((r) => r.id === c.cookie)).toBe(false);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.id))).toBe(true);
  });
});
