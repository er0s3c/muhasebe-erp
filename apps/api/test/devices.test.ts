import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { Browser, DAY_MS, licenseOwnerSql, useLicenseDatabase, useLicensedApp, type LicensedApp } from './license-helpers';
import { PASSWORD, client } from './helpers';

useLicenseDatabase();

const APP_URL = process.env.TEST_LICENSE_API_DATABASE_URL ?? 'postgres://erp_app:erp_app@localhost:5432/erp_license_apitest';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function activate(c: LicensedApp, deviceLimit: number, extra: object = {}) {
  const license = c.vendor.issue({ deviceLimit, ...extra });
  const res = await c.app.inject({ method: 'POST', url: '/api/license/activate', payload: { code: license.code } });
  expect(res.statusCode, res.body).toBe(200);
  return license;
}

/** Yeni bir tarayıcıdan (cihaz) sahip olarak kayıt olur ve bir şirket açar. */
async function registerOwner(c: LicensedApp, browser = new Browser(c.app)) {
  const reg = await browser.register('Sahip');
  expect(reg.statusCode, reg.body).toBe(201);
  const body = reg.json();
  const co = await client(c.app, body.accessToken).post('/api/companies', { name: 'Cihaz Ltd.', sector: 'COMMERCE' });
  expect(co.statusCode, co.body).toBe(201);
  return { browser, token: body.accessToken as string, email: body.user.email as string, companyId: co.json().company.id as string };
}

const deviceCount = async () => Number((await licenseOwnerSql('select count(*)::int as n from devices')).rows[0].n);
const events = async (name: string) => Number((await licenseOwnerSql('select count(*)::int as n from security_events where event = $1', [name])).rows[0].n);

describe('cihaz koltukları: kayıt, sınır, iptal, boşta düşme', () => {
  const t = useLicensedApp({ heartbeatIntervalMs: 12 * 60 * 60 * 1000 });
  const state = {} as {
    owner: Awaited<ReturnType<typeof registerOwner>>;
    viewer: { browser: Browser; token: string; email: string };
    third: Browser;
  };

  it('ilk giriş cihazı kaydeder ve çerez verir; aynı tarayıcıyla girişler yeni koltuk tüketmez', async () => {
    const c = t.ctx;
    await activate(c, 3);
    state.owner = await registerOwner(c);
    const { browser } = state.owner;
    expect(browser.deviceCookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(await deviceCount()).toBe(1);
    // çerez yalnızca oturum uçlarına gider ve JS'ten okunamaz
    const res = await browser.login(state.owner.email);
    expect(res.statusCode, res.body).toBe(200);
    const set = res.headers['set-cookie'] as string[];
    const cookieLine = set.find((l) => l.startsWith('erp_device='))!;
    expect(cookieLine).toMatch(/HttpOnly/i);
    expect(cookieLine).toMatch(/SameSite=Strict/i);
    expect(cookieLine).toMatch(/Path=\/api\/auth/);
    expect(await deviceCount()).toBe(1);
    // erişim belirteci cihazı taşır
    const decoded = c.app.jwt.decode<{ did?: string }>(res.json().accessToken)!;
    expect(decoded.did).toBe(browser.deviceId);
    expect(await events('device_registered')).toBe(1);
  });

  it('sahip olmayan kullanıcı cihazları göremez/yönetemez; sahip listeyi görür', async () => {
    const c = t.ctx;
    const owner = client(c.app, state.owner.token, state.owner.companyId);
    const email = `izleyici-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: 'İzleyici', role: 'viewer', password: PASSWORD, mustChangePassword: false });
    expect(add.statusCode, add.body).toBe(201);
    const viewerBrowser = new Browser(c.app, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605 Version/17 Safari/605');
    const login = await viewerBrowser.login(email);
    expect(login.statusCode, login.body).toBe(200);
    state.viewer = { browser: viewerBrowser, token: login.json().accessToken, email };

    const denied = await client(c.app, state.viewer.token).get('/api/devices');
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('DEVICE_ADMIN_ONLY');
    expect((await client(c.app, state.viewer.token).delete(`/api/devices/${state.owner.browser.deviceId}`)).statusCode).toBe(403);

    const list = await client(c.app, state.owner.token).get('/api/devices');
    expect(list.statusCode, list.body).toBe(200);
    const body = list.json();
    expect(body).toMatchObject({ enforced: true, limit: 3, active: 2 });
    expect(body.devices).toHaveLength(2);
    const mine = body.devices.find((d: any) => d.current);
    expect(mine).toMatchObject({ id: state.owner.browser.deviceId, name: 'Chrome · Windows', status: 'active' });
    expect(mine.lastUser.email).toBe(state.owner.email);
    expect(body.devices.find((d: any) => d.name === 'Safari · macOS')).toBeTruthy();
  });

  it('yeniden adlandırma', async () => {
    const c = t.ctx;
    const id = state.owner.browser.deviceId;
    const res = await client(c.app, state.owner.token).patch(`/api/devices/${id}`, { name: 'Muhasebe bilgisayarı' });
    expect(res.statusCode, res.body).toBe(200);
    const list = (await client(c.app, state.owner.token).get('/api/devices')).json();
    expect(list.devices.find((d: any) => d.id === id).name).toBe('Muhasebe bilgisayarı');
    expect((await client(c.app, state.owner.token).patch(`/api/devices/${id}`, { name: '   ' })).statusCode).toBe(400);
    expect((await client(c.app, state.owner.token).patch(`/api/devices/${randomUUID()}`, { name: 'x' })).statusCode).toBe(404);
  });

  it('sınır dolunca yeni cihaz DEVICE_LIMIT_REACHED alır; kayıtta hesap bile açılmaz', async () => {
    const c = t.ctx;
    state.third = new Browser(c.app, 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
    expect((await state.third.login(state.owner.email)).statusCode).toBe(200); // 3. koltuk
    expect(await deviceCount()).toBe(3);

    const fourth = new Browser(c.app);
    const denied = await fourth.login(state.owner.email);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('DEVICE_LIMIT_REACHED');
    expect(denied.json().error.message).toMatch(/en fazla 3 cihaz/);
    expect(fourth.deviceCookie).toBeUndefined();
    expect(await deviceCount()).toBe(3);
    expect(await events('device_limit_reached')).toBe(1);

    // yeni kuruluş kaydı da koltuk ister ve hesap oluşmadan reddedilir
    const before = Number((await licenseOwnerSql('select count(*)::int as n from users')).rows[0].n);
    const reg = await new Browser(c.app).register('Yetim');
    expect(reg.statusCode).toBe(403);
    expect(reg.json().error.code).toBe('DEVICE_LIMIT_REACHED');
    expect(Number((await licenseOwnerSql('select count(*)::int as n from users')).rows[0].n)).toBe(before);
  });

  it('cihazı kaldırmak: belirteç ve oturum ölür (toplu çıkış yok), koltuk boşalır', async () => {
    const c = t.ctx;
    const viewerDevice = state.viewer.browser.deviceId!;
    const before = await events('refresh_reuse_detected');
    const res = await client(c.app, state.owner.token).delete(`/api/devices/${viewerDevice}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, current: false });
    expect(await events('device_revoked')).toBe(1);

    const dead = await client(c.app, state.viewer.token).get('/api/me');
    expect(dead.statusCode).toBe(401);
    expect(dead.json().error.code).toBe('DEVICE_REVOKED');
    const refresh = await state.viewer.browser.refresh();
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().error.code).toBe('DEVICE_REVOKED');
    // yönetici işlemi çalınma sayılmaz: kullanıcının başka oturumları (ve sahibin oturumu) etkilenmez
    expect(await events('refresh_reuse_detected')).toBe(before);
    expect((await state.owner.browser.refresh()).statusCode).toBe(200);
    expect((await state.third.refresh()).statusCode).toBe(200);

    // koltuk boşaldı: yeni bir tarayıcı girebilir
    const fourth = new Browser(c.app);
    expect((await fourth.login(state.owner.email)).statusCode).toBe(200);
    expect(await deviceCount()).toBe(4); // iptal edilen kayıt silinmez
    const list = (await client(c.app, state.owner.token).get('/api/devices')).json();
    expect(list.active).toBe(3);
    expect(list.devices.filter((d: any) => d.status === 'revoked')).toHaveLength(1);
    expect(list.devices.at(-1).status).toBe('revoked'); // kaldırılanlar listenin sonunda
    // zaten iptal edilmiş cihazı yeniden iptal etmek 404
    expect((await client(c.app, state.owner.token).delete(`/api/devices/${viewerDevice}`)).statusCode).toBe(404);
  });

  it('iptal edilen cihazın eski çerezi yeniden etkinleştirmez; yeni cihaz olarak boş koltuk ister', async () => {
    const c = t.ctx;
    // iptal edilmiş cihazın çerezini geri koy
    const revoked = (await licenseOwnerSql('select id from devices where revoked_at is not null')).rows[0].id as string;
    const old = state.viewer.browser; // iptal edilmiş cihazın çerezini hâlâ taşıyor
    expect(old.deviceId).toBe(revoked);
    const res = await old.login(state.viewer.email);
    expect(res.statusCode).toBe(403); // koltuklar dolu (3 etkin)
    expect(res.json().error.code).toBe('DEVICE_LIMIT_REACHED');

    // bir koltuk boşaltılınca aynı kullanıcı yeni cihaz olarak girer; eski kimlik geri dönmez
    const list = (await client(c.app, state.owner.token).get('/api/devices')).json();
    const other = list.devices.find((d: any) => d.status === 'active' && !d.current);
    expect((await client(c.app, state.owner.token).delete(`/api/devices/${other.id}`)).statusCode).toBe(200);
    const ok = await old.login(state.viewer.email);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(old.deviceId).not.toBe(revoked);
    // DB: iptal geri alınamaz, cihazlar silinemez, gizli değer değiştirilemez (ERP08)
    const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
    try {
      for (const sql of [
        `update devices set revoked_at = null where id = '${revoked}'`,
        `update devices set secret_hash = 'x' where id = '${revoked}'`,
        'delete from devices',
        'truncate devices',
      ]) {
        await expect(pool.query(sql), sql).rejects.toMatchObject({ code: expect.stringMatching(/^(ERP08|42501)$/) });
      }
    } finally {
      await pool.end();
    }
  });

  it('boşta kalan cihaz koltuktan düşer; dönerken boş koltuk ister, bilinen cihaz kimliğini korur', async () => {
    const c = t.ctx;
    const owner = state.owner;
    const knownId = owner.browser.deviceId!;
    // abonelik sürsün: 31 gün sonra yeni kira al
    c.clock.t += 31 * DAY_MS;
    c.clock.t += 1000;
    await c.service.heartbeat();
    const before = (await client(c.app, owner.token).get('/api/devices')).json();
    expect(before.active).toBe(0); // hepsi 30 günden fazladır görülmedi
    expect(before.devices.filter((d: any) => d.status === 'idle').length).toBeGreaterThanOrEqual(3);

    // üç yeni tarayıcı girer (boş koltuklar); eski cihaz geri dönünce koltuk yok
    const fresh = [new Browser(c.app), new Browser(c.app), new Browser(c.app)];
    for (const b of fresh) expect((await b.login(owner.email)).statusCode).toBe(200);
    const back = await owner.browser.login(owner.email);
    expect(back.statusCode).toBe(403);
    expect(back.json().error.code).toBe('DEVICE_LIMIT_REACHED');

    // bir koltuk boşalınca eski cihaz KENDİ kimliğiyle döner (yeni kayıt açılmaz)
    const devicesBefore = await deviceCount();
    const freshId = fresh[0]!.deviceId!;
    const adminToken = (await fresh[1]!.login(owner.email)).json().accessToken as string;
    expect((await client(c.app, adminToken).delete(`/api/devices/${freshId}`)).statusCode).toBe(200);
    const again = await owner.browser.login(owner.email);
    expect(again.statusCode, again.body).toBe(200);
    expect(owner.browser.deviceId).toBe(knownId);
    expect(await deviceCount()).toBe(devicesBefore);
  });

  it('satıcıya bildirilen cihaz sayısı etkin koltuk sayısıdır; /api/license kullanımı gösterir', async () => {
    const c = t.ctx;
    c.clock.t += 1000;
    await c.service.heartbeat();
    const act = [...c.vendor.activations.values()][0]!;
    expect(act.stats?.devices).toBe(3);
    const token = (await state.owner.browser.login(state.owner.email)).json().accessToken as string;
    const info = (await client(c.app, token).get('/api/license')).json();
    expect(info.usage.devices).toBe(3);
    expect(info.license.deviceLimit).toBe(3);
  });

  it('lisans yenilemede sınır düşürülürse mevcut cihazlar çalışmaya devam eder, yeni cihaz alınmaz', async () => {
    const c = t.ctx;
    const license = [...c.vendor.licenses.values()][0]!;
    license.deviceLimit = 1;
    c.clock.t += 1000;
    await c.service.heartbeat();
    // mevcut (koltuk sayan) cihaz girmeye devam eder
    const known = (await state.owner.browser.login(state.owner.email)).statusCode;
    expect(known).toBe(200);
    // yeni cihaz alınmaz
    const res = await new Browser(c.app).login(state.owner.email);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/en fazla 1 cihaz/);
  });

  it('salt-okunur modda bile cihaz yönetimi açıktır (koltuk boşaltılabilsin)', async () => {
    const c = t.ctx;
    c.clock.t += 60 * DAY_MS; // kira ve tolerans bitti
    expect((await c.service.current()).state).toBe('restricted');
    const token = (await state.owner.browser.login(state.owner.email)).json().accessToken as string;
    const list = await client(c.app, token).get('/api/devices');
    expect(list.statusCode, list.body).toBe(200);
    const victim = list.json().devices.find((d: any) => !d.current && d.status !== 'revoked');
    expect(victim).toBeTruthy();
    expect((await client(c.app, token).delete(`/api/devices/${victim.id}`)).statusCode).toBe(200);
    // ama iş yazmaları kapalı
    expect((await client(c.app, token).post('/api/companies', { name: 'X', sector: 'COMMERCE' })).statusCode).toBe(402);
  });
});

describe('cihaz koltukları: eşzamanlılık ve eski belirteçler', () => {
  const t = useLicensedApp();

  it('son koltuklar için eşzamanlı girişlerde yalnızca boş koltuk kadarı kazanır', async () => {
    const c = t.ctx;
    await activate(c, 3);
    const { email } = await registerOwner(c); // 1. koltuk
    const browsers = Array.from({ length: 8 }, () => new Browser(c.app));
    const results = await Promise.all(browsers.map((b) => b.login(email)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(6);
    expect(results.filter((r) => r.statusCode === 403).every((r) => r.json().error.code === 'DEVICE_LIMIT_REACHED')).toBe(true);
    const active = Number((await licenseOwnerSql(`select count(*)::int as n from devices where revoked_at is null`)).rows[0].n);
    expect(active).toBe(3);
  });

  it('koltuk kaydı doğrudan eşzamanlı çağrılınca da sınırı aşmaz (danışma kilidi: parola doğrulaması yarışı gizlemez)', async () => {
    const c = t.ctx;
    await licenseOwnerSql(`update devices set revoked_at = now() where revoked_at is null`);
    const fakeReq = () => ({ cookies: {}, headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' }, ip: '127.0.0.1' }) as never;
    const fakeReply = () => ({ setCookie: () => undefined }) as never;
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => c.app.devices.ensureForRequest(fakeReq(), fakeReply())));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'DEVICE_LIMIT_REACHED')).toHaveLength(17);
    expect(Number((await licenseOwnerSql(`select count(*)::int as n from devices where revoked_at is null`)).rows[0].n)).toBe(3);
  });

  it('aynı tarayıcıdan eşzamanlı girişler tek koltuk kullanır', async () => {
    const c = t.ctx;
    await licenseOwnerSql(`update devices set revoked_at = now() where revoked_at is null`); // temiz başla
    const b = new Browser(c.app);
    const { email } = await registerOwner(c, b);
    const same = await Promise.all([1, 2, 3, 4].map(() => b.post('/api/auth/login', { email, password: PASSWORD })));
    expect(same.every((r) => r.statusCode === 200)).toBe(true);
    const n = Number((await licenseOwnerSql(`select count(*)::int as n from devices where id = $1`, [b.deviceId])).rows[0].n);
    expect(n).toBe(1);
  });

  it('cihaz bilgisi olmayan eski belirteç reddedilir; cihazsız yenileme oturumu ilk yenilemede cihaz kazanır', async () => {
    const c = t.ctx;
    await licenseOwnerSql(`update devices set revoked_at = now() where revoked_at is null`);
    const b = new Browser(c.app);
    const { email, token } = await registerOwner(c, b);
    const userId = (c.app.jwt.decode<{ sub: string }>(token))!.sub;
    const org = (c.app.jwt.decode<{ org: string }>(token))!.org;
    const legacy = c.app.jwt.sign({ sub: userId, org });
    const res = await client(c.app, legacy).get('/api/me');
    expect(res.statusCode).toBe(401);

    // oturum çerezi var ama cihaz çerezi yok (denetim açılmadan önceki oturum): yenileme cihaz kaydeder
    const old = new Browser(c.app);
    const login = await old.login(email);
    expect(login.statusCode).toBe(200);
    old.jar.delete('erp_device');
    const before = Number((await licenseOwnerSql('select count(*)::int as n from devices')).rows[0].n);
    const refreshed = await old.refresh();
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(old.deviceCookie).toBeTruthy();
    expect(Number((await licenseOwnerSql('select count(*)::int as n from devices')).rows[0].n)).toBe(before + 1);
    expect(c.app.jwt.decode<{ did?: string }>(refreshed.json().accessToken)!.did).toBe(old.deviceId);
  });

  it('denetim kapalıyken (geliştirme) cihaz kaydı ve çerezi yoktur', async () => {
    // lisans denetimi kapalı uygulama: bu dosyadaki LicenseService yerine varsayılan yapılandırma
    const { makeApp } = await import('./helpers');
    const { app } = await makeApp();
    const b = new Browser(app);
    const reg = await b.register('Gelistirme');
    expect(reg.statusCode, reg.body).toBe(201);
    expect(b.deviceCookie).toBeUndefined();
    expect(app.jwt.decode<{ did?: string }>(reg.json().accessToken)!.did).toBeUndefined();
    const list = await app.inject({ method: 'GET', url: '/api/devices', headers: auth(reg.json().accessToken) });
    expect(list.statusCode).toBe(403); // henüz şirket sahibi/yönetici değil
  });
});
