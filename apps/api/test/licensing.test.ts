import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DAY_MS, licenseOwnerSql, useLicenseDatabase, useLicensedApp, type LicensedApp } from './license-helpers';
import { addMember, client, createCompany, PASSWORD, registerUser } from './helpers';
import { LicenseService } from '../src/licensing/service';
import { LicenseServerError } from '../src/licensing/transport';
import pg from 'pg';

useLicenseDatabase();

const APP_URL = process.env.TEST_LICENSE_API_DATABASE_URL ?? 'postgres://erp_app:erp_app@localhost:5432/erp_license_apitest';

const activate = (c: LicensedApp, code: string, token?: string) =>
  c.app.inject({ method: 'POST', url: '/api/license/activate', payload: { code }, headers: token ? { authorization: `Bearer ${token}` } : {} });
const status = async (c: LicensedApp, token: string) => (await client(c.app, token).get('/api/license')).json();
const leaseToken = async () => (await licenseOwnerSql('select lease_token from license_state')).rows[0].lease_token as string;
const setLease = (token: string | null) => licenseOwnerSql('update license_state set lease_token = $1', [token]);
const DAY = DAY_MS;
/** Dondurulmuş test saatinde art arda kalp atışı: satıcının yeniden oynatma koruması ts'nin artmasını ister. */
const beat = (c: LicensedApp) => {
  c.clock.t += 1000;
  return c.service.heartbeat();
};

/** Etkinleştirir, bir sahip kaydeder ve bir şirket açar. */
async function licensedOwner(c: LicensedApp, license = c.vendor.issue(), sector = 'RETAIL_MARKET') {
  if ((await c.service.current()).state === 'unlicensed') {
    const res = await activate(c, license.code);
    expect(res.statusCode, res.body).toBe(200);
  }
  const owner = await registerUser(c.app, 'Sahip');
  const company = await createCompany(c.app, owner.token, { sector });
  return { license, owner, company, api: client(c.app, owner.token, company.id) };
}

describe('lisanssız kurulum', () => {
  const t = useLicensedApp();

  it('altyapı ve genel yapılandırma açık, iş uçları 402 LICENSE_REQUIRED', async () => {
    const { app } = t.ctx;
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(200);
    const cfg = await app.inject({ method: 'GET', url: '/api/public-config' });
    expect(cfg.json().license).toEqual({ enforced: true, state: 'unlicensed', reason: null });

    for (const [method, url] of [
      ['POST', '/api/auth/register'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/refresh'],
      ['GET', '/api/me'],
      ['GET', '/api/accounts'],
      ['POST', '/api/companies'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(402);
      expect(res.json().error.code).toBe('LICENSE_REQUIRED');
    }
  });

  it('web arayüzü yolları (api dışı) kapıya takılmaz: etkinleştirme sayfası yüklenebilmeli', async () => {
    const res = await t.ctx.app.inject({ method: 'GET', url: '/etkinlestir' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('geçersiz kod reddedilir; hata kaydedilir ve hâlâ lisanssızdır', async () => {
    const { app, vendor, service } = t.ctx;
    vendor.issue();
    const res = await activate(t.ctx, 'YANLIS-KOD-YANLIS-KOD');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_CODE');
    const snap = await service.current();
    expect(snap.state).toBe('unlicensed');
    expect(snap.lastError?.code).toBe('INVALID_CODE');
    expect((await app.inject({ method: 'GET', url: '/api/public-config' })).json().license.state).toBe('unlicensed');
  });

  it('lisans sunucusuna ulaşılamazsa 502 ve açık bir mesaj', async () => {
    const { vendor } = t.ctx;
    const license = vendor.issue();
    vendor.offline = true;
    const res = await activate(t.ctx, license.code);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('LICENSE_SERVER_UNREACHABLE');
    vendor.offline = false;
  });

  it('sunucu adresi tanımsızsa çevrimiçi etkinleştirme 409 (çevrimdışı yol kalır)', async () => {
    const svc = new LicenseService({
      db: t.ctx.handle.db,
      keyring: t.ctx.vendor.keyring,
      enforced: true,
      transport: null,
      appVersion: 'test',
      fingerprint: async () => ({ fingerprint: 'b'.repeat(64), strength: 'strong' }),
    });
    await expect(svc.activate('HERHANGI-BIR-KOD-123')).rejects.toMatchObject({ status: 409, code: 'LICENSE_SERVER_NOT_CONFIGURED' });
  });
});

describe('etkinleştirme ve yönetim yetkisi', () => {
  const t = useLicensedApp();

  it('kimliksiz etkinleştirme yalnızca lisanssızken; sonrasında şirket sahibi gerekir', async () => {
    const c = t.ctx;
    const license = c.vendor.issue();
    const first = await activate(c, license.code);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().state).toBe('active');
    expect(first.json().license.customer).toBe('Deneme Müşterisi Ltd.');
    expect(first.json().license.sectors).toEqual(['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE']);

    // artık bir kira var: kimliksiz çağrı kabul edilmez
    expect((await activate(c, license.code)).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'POST', url: '/api/license/refresh' })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'POST', url: '/api/license/deactivate' })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'POST', url: '/api/license/offline-request' })).statusCode).toBe(401);

    // kayıt, giriş ve şirket artık çalışır
    const owner = await registerUser(c.app, 'Sahip');
    const company = await createCompany(c.app, owner.token, { sector: 'CONSTRUCTION' });
    const api = client(c.app, owner.token, company.id);
    expect((await api.get('/api/accounts')).statusCode).toBe(200);

    // şirket sahibi yenileyebilir ve ayrıntıları görür
    const mine = await status(c, owner.token);
    expect(mine.isOwner).toBe(true);
    expect(mine.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mine.usage.companies).toBe(1);
    expect((await client(c.app, owner.token).post('/api/license/refresh')).statusCode).toBe(200);

    // sahip olmayan üye durumu görür ama ayrıntıları ve yönetimi göremez
    const viewer = await addMember(c.app, api, company.id, 'viewer');
    const vs = await status(c, viewer.token);
    expect(vs.isOwner).toBe(false);
    expect(vs.state).toBe('active');
    expect(vs.installationId).toBeUndefined();
    expect(vs.lastError).toBeUndefined();
    for (const url of ['/api/license/refresh', '/api/license/deactivate', '/api/license/offline-request']) {
      const res = await client(c.app, viewer.token).post(url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('OWNER_ONLY');
    }
    expect((await client(c.app, viewer.token).post('/api/license/activate', { code: license.code })).statusCode).toBe(403);
  });

  it('kurulum kimliği kalıcıdır; etkinleştirme ve yenileme güvenlik olayı olarak kaydedilir', async () => {
    const c = t.ctx;
    const row = (await licenseOwnerSql('select installation_id, public_key from license_state')).rows[0];
    expect(row.installation_id).toBeTruthy();
    const snap = await c.service.current();
    expect(snap.installationId).toBe(row.installation_id);
    const events = (await licenseOwnerSql(`select event, user_id from security_events where event like 'license_%' order by at`)).rows;
    expect(events.map((e) => e.event)).toEqual(['license_activated', 'license_refreshed']);
    expect(events[0].user_id).toBeNull(); // kimliksiz etkinleştirme
    expect(events[1].user_id).toBeTruthy(); // sahibin yenilemesi
  });
});

describe('sektör kilidi ve şirket sınırı', () => {
  const t = useLicensedApp();

  it('şirket yalnızca lisanslı sektörlerde açılır; sınır aşılamaz', async () => {
    const c = t.ctx;
    const license = c.vendor.issue({ sectors: ['RETAIL_MARKET'], companyLimit: 2 });
    const { owner, company } = await licensedOwner(c, license, 'RETAIL_MARKET');

    const wrong = await client(c.app, owner.token).post('/api/companies', { name: 'İnşaat A.Ş.', sector: 'CONSTRUCTION' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('LICENSE_SECTOR_MISMATCH');

    await createCompany(c.app, owner.token, { sector: 'RETAIL_MARKET', name: 'İkinci Market' });
    const over = await client(c.app, owner.token).post('/api/companies', { name: 'Üçüncü', sector: 'RETAIL_MARKET' });
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe('LICENSE_COMPANY_LIMIT');
    expect((await licenseOwnerSql('select count(*)::int as n from companies')).rows[0].n).toBe(2);

    // başka kuruluşun şirketi de kurulum genelindeki sınıra sayılır (RLS'i aşan sayım)
    const other = await registerUser(c.app, 'Diger');
    const res = await client(c.app, other.token).post('/api/companies', { name: 'Başka Market', sector: 'RETAIL_MARKET' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LICENSE_COMPANY_LIMIT');
    void company;
  });

  it('eşzamanlı iki şirket açma son yer için yarışınca yalnızca biri kazanır', async () => {
    const c = t.ctx;
    const other = await registerUser(c.app, 'Yaris');
    // mevcut: 2 şirket, limit 2 → önce limiti 3'e çıkar (satıcı lisansı günceller, kalp atışı getirir)
    const license = [...c.vendor.licenses.values()][0]!;
    license.companyLimit = 3;
    expect((await beat(c)).lease?.companyLimit).toBe(3);
    const results = await Promise.all(
      [1, 2, 3].map((i) => client(c.app, other.token).post('/api/companies', { name: `Yarış ${i}`, sector: 'RETAIL_MARKET' })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(2);
    expect((await licenseOwnerSql('select count(*)::int as n from companies')).rows[0].n).toBe(3);
  });

  it('veritabanında şirketin sektörünü elle değiştirmek yetki kazandırmaz (LICENSE_SECTOR_MISMATCH)', async () => {
    const c = t.ctx;
    const { rows } = await licenseOwnerSql(`select id from companies order by created_at limit 1`);
    const companyId = rows[0].id as string;
    // şirketin sahibini bul
    const owner = (await licenseOwnerSql(`select u.email from memberships m join users u on u.id = m.user_id where m.company_id = $1 and m.role = 'owner'`, [companyId])).rows[0];
    const login = await c.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: PASSWORD } });
    const api = client(c.app, login.json().accessToken, companyId);
    expect((await api.get('/api/accounts')).statusCode).toBe(200);
    await licenseOwnerSql(`update companies set sector = 'CONSTRUCTION' where id = $1`, [companyId]);
    const res = await api.get('/api/accounts');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LICENSE_SECTOR_MISMATCH');
    await licenseOwnerSql(`update companies set sector = 'RETAIL_MARKET' where id = $1`, [companyId]);
    expect((await api.get('/api/accounts')).statusCode).toBe(200);
  });

  it('satıcı lisansın sektörlerini daraltırsa, kapsam dışı kalan şirketler kalp atışından sonra kapanır', async () => {
    const c = t.ctx;
    const license = [...c.vendor.licenses.values()][0]!;
    license.sectors = ['COMMERCE'];
    const snap = await beat(c);
    expect(snap.lease?.sectors).toEqual(['COMMERCE']);
    const { rows } = await licenseOwnerSql(`select id from companies order by created_at limit 1`);
    const owner = (await licenseOwnerSql(`select u.email from memberships m join users u on u.id = m.user_id where m.company_id = $1 and m.role = 'owner'`, [rows[0].id])).rows[0];
    const login = await c.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: PASSWORD } });
    const res = await client(c.app, login.json().accessToken, rows[0].id).get('/api/accounts');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('LICENSE_SECTOR_MISMATCH');
  });
});

describe('süre, tolerans ve salt-okunur mod', () => {
  const t = useLicensedApp({ heartbeatIntervalMs: 12 * 60 * 60 * 1000 });

  it('aktif → tolerans → salt-okunur; okuma, dışa aktarma ve giriş çalışır, yazma 402', async () => {
    const c = t.ctx;
    const { owner, api, company } = await licensedOwner(c);
    const start = c.clock.t;
    expect((await c.service.current()).state).toBe('active');

    c.clock.t = start + 6 * DAY;
    expect((await c.service.current()).state).toBe('active');

    // kira bitti (7 gün), tolerans (14 gün) içinde tam işlevli
    c.clock.t = start + 10 * DAY;
    expect((await c.service.current()).state).toBe('grace');
    const inGrace = await api.post('/api/parties', { name: 'Tolerans Cari', type: 'customer' });
    expect(inGrace.statusCode, inGrace.body).toBe(201);
    expect((await status(c, owner.token)).state).toBe('grace');

    // tolerans da bitti → salt-okunur
    c.clock.t = start + 22 * DAY;
    const snap = await c.service.current();
    expect(snap.state).toBe('restricted');
    expect(snap.reason).toBe('expired');

    const blocked = await api.post('/api/parties', { name: 'Yasak Cari', type: 'customer' });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe('LICENSE_RESTRICTED');
    expect(blocked.json().error.details.reason).toBe('expired');
    for (const [method, url] of [
      ['PUT', '/api/company/modules/core.treasury'],
      ['DELETE', '/api/parties/00000000-0000-0000-0000-000000000000'],
      ['POST', '/api/companies'],
      ['POST', '/api/auth/register'],
    ] as const) {
      const res = await client(c.app, owner.token, company.id)[method === 'POST' ? 'post' : method === 'PUT' ? 'put' : 'delete'](url, {});
      expect(res.statusCode, `${method} ${url}`).toBe(402);
    }

    // okuma + dışa aktarma + oturum açma çalışır
    expect((await api.get('/api/parties')).statusCode).toBe(200);
    expect((await api.get(`/api/reports/trial-balance?from=${new Date(c.clock.t - 400 * DAY).toISOString().slice(0, 10)}&to=${new Date(c.clock.t).toISOString().slice(0, 10)}`)).statusCode).toBe(200);
    const exp = await api.get(`/api/exports/trial-balance?format=csv&from=${new Date(c.clock.t - 400 * DAY).toISOString().slice(0, 10)}&to=${new Date(c.clock.t).toISOString().slice(0, 10)}`);
    expect(exp.statusCode, exp.body.slice(0, 200)).toBe(200);
    const login = await c.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner.email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect((await c.app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `refresh_token=${owner.cookie}` } })).statusCode).toBe(200);
    const st = await status(c, owner.token);
    expect(st.state).toBe('restricted');
    expect(st.reason).toBe('expired');
    expect(st.message).toMatch(/süreniz doldu/);

    // yenileme (kalp atışı) salt-okunur moddan çıkarır
    const refreshed = await client(c.app, owner.token).post('/api/license/refresh');
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().state).toBe('active');
    expect((await api.post('/api/parties', { name: 'Yenileme Sonrası', type: 'customer' })).statusCode).toBe(201);
  });

  it('abonelik bitişi kirayı keser: validUntil geçince kalp atışı yeni süre vermez', async () => {
    const c = t.ctx;
    const start = c.clock.t;
    const license = [...c.vendor.licenses.values()][0]!;
    license.validUntil = start + 3 * DAY;
    const snap = await beat(c);
    expect(snap.lease?.leaseUntil).toBe(start + 3 * DAY);
    c.clock.t = start + 3 * DAY + 14 * DAY + 60_000;
    expect((await c.service.current()).reason).toBe('expired');
  });
});

describe('kalp atışı', () => {
  const t = useLicensedApp({ heartbeatIntervalMs: 12 * 60 * 60 * 1000 });

  it('ne zaman atılacağı: aralık dolunca; başarısızlıktan sonra 30 dakika beklenir; lisanssızken hiç', async () => {
    const c = t.ctx;
    expect(await c.service.shouldHeartbeat()).toBe(false); // lisanssız
    await licensedOwner(c);
    expect(await c.service.shouldHeartbeat()).toBe(false);
    c.clock.t += 13 * 60 * 60 * 1000;
    expect(await c.service.shouldHeartbeat()).toBe(true);

    c.vendor.offline = true;
    await expect(beat(c)).rejects.toMatchObject({ status: 502 });
    expect(await c.service.shouldHeartbeat()).toBe(false);
    c.clock.t += 31 * 60_000;
    expect(await c.service.shouldHeartbeat()).toBe(true);
    c.vendor.offline = false;
    const snap = await beat(c);
    expect(snap.lastError).toBeNull();
    expect(await c.service.shouldHeartbeat()).toBe(false);
  });

  it('ağ kesilince mevcut kira geçerli kaldıkça çalışmaya devam edilir; hata kaydedilir', async () => {
    const c = t.ctx;
    c.vendor.offline = true;
    const before = await c.service.current();
    await expect(beat(c)).rejects.toMatchObject({ code: 'LICENSE_SERVER_UNREACHABLE' });
    const after = await c.service.current();
    expect(after.state).toBe(before.state);
    expect(after.lastError?.code).toBe('LICENSE_SERVER_UNREACHABLE');
    c.vendor.offline = false;
  });

  it('satıcı iptal edince bir sonraki kalp atışında hemen salt-okunur; askı kalkınca geri döner', async () => {
    const c = t.ctx;
    const license = [...c.vendor.licenses.values()][0]!;
    const { owner } = await (async () => {
      const o = await registerUser(c.app, 'Iptal');
      await createCompany(c.app, o.token, { sector: 'COMMERCE', name: 'Iptal Ltd.' });
      return { owner: o };
    })();
    license.status = 'suspended';
    let snap = await beat(c);
    expect(snap).toMatchObject({ state: 'restricted', reason: 'suspended' });
    expect((await client(c.app, owner.token).post('/api/companies', { name: 'X', sector: 'COMMERCE' })).statusCode).toBe(402);
    license.status = 'active';
    snap = await beat(c);
    expect(snap.state).toBe('active');
    license.status = 'revoked';
    snap = await beat(c);
    expect(snap).toMatchObject({ state: 'restricted', reason: 'revoked' });
    // iptal edilmiş lisansla yeniden etkinleştirme satıcıda reddedilir
    const res = await client(c.app, owner.token).post('/api/license/activate', { code: license.code });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('LICENSE_REVOKED');
  });

  it('satıcı yanıtı bu isteğe ait değilse (yeniden oynatma) ya da başka anahtarla imzalıysa reddedilir', async () => {
    const c = t.ctx;
    const license = [...c.vendor.licenses.values()][0]!;
    license.status = 'active';
    await beat(c);
    const snap = await c.service.current();
    const inst = { installationId: snap.installationId, fingerprint: c.fingerprint.value };
    const real = c.vendor.transport.heartbeat;
    // eski (geçerli imzalı) bir kirayı yeniden oynatan sahte aracı
    const replayed = c.vendor.signLease('lease', license, inst, 'eski-nonce-eski-nonce-1234');
    c.vendor.transport.heartbeat = async () => ({ lease: replayed });
    await expect(beat(c)).rejects.toMatchObject({ status: 422, code: 'LICENSE_INVALID' });
    // satıcı anahtarı olmayan birinin imzaladığı kira
    c.vendor.transport.heartbeat = async (env) => {
      const r = await real(env);
      void r;
      return { lease: c.vendor.signForged(license, inst, JSON.parse(Buffer.from(env.p, 'base64url').toString()).nonce) };
    };
    await expect(beat(c)).rejects.toMatchObject({ status: 422, code: 'LICENSE_INVALID' });
    c.vendor.transport.heartbeat = real;
    expect((await beat(c)).state).toBe('active');
  });

  it('başka bir sunucu için (parmak izi) imzalanmış kira kabul edilmez', async () => {
    const c = t.ctx;
    const license = [...c.vendor.licenses.values()][0]!;
    const snap = await c.service.current();
    const real = c.vendor.transport.heartbeat;
    c.vendor.transport.heartbeat = async (env) => {
      await real(env);
      const nonce = JSON.parse(Buffer.from(env.p, 'base64url').toString()).nonce as string;
      return { lease: c.vendor.signLease('lease', license, { installationId: snap.installationId, fingerprint: 'c'.repeat(64) }, nonce) };
    };
    await expect(beat(c)).rejects.toMatchObject({ code: 'LICENSE_NOT_FOR_THIS_SERVER' });
    c.vendor.transport.heartbeat = real;
  });

  it('satıcı saati ile sunucu saati arası 10 dakikadan fazlaysa kira kabul edilmez (CLOCK_SKEW)', async () => {
    const c = t.ctx;
    const license = [...c.vendor.licenses.values()][0]!;
    const snap = await c.service.current();
    const real = c.vendor.transport.heartbeat;
    c.vendor.transport.heartbeat = async (env) => {
      await real(env);
      const nonce = JSON.parse(Buffer.from(env.p, 'base64url').toString()).nonce as string;
      c.clock.t += 30 * 60_000; // satıcı 30 dk ileride imzalıyor
      const lease = c.vendor.signLease('lease', license, { installationId: snap.installationId, fingerprint: c.fingerprint.value }, nonce);
      c.clock.t -= 30 * 60_000;
      return { lease };
    };
    await expect(beat(c)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });
    c.vendor.transport.heartbeat = real;
  });

  it('eşzamanlı iki kalp atışı seri çalışır (satıcıda yeniden oynatma olmaz)', async () => {
    const c = t.ctx;
    // gerçek hayatta iki çağrı arasında zaman geçer; dondurulmuş saatte, her satıcı yanıtından sonra saati ilerlet
    c.clock.t += 1000;
    const real = c.vendor.transport.heartbeat;
    c.vendor.transport.heartbeat = async (env) => {
      const r = await real(env);
      c.clock.t += 1000;
      return r;
    };
    const [a, b] = await Promise.all([c.service.heartbeat(), c.service.heartbeat()]);
    c.vendor.transport.heartbeat = real;
    expect(a.state).toBe('active');
    expect(b.state).toBe('active');
    expect(c.vendor.calls.heartbeat).toBeGreaterThanOrEqual(2);
  });
});

describe('kurcalama ve klon: imzalı kira, parmak izi, saat', () => {
  const t = useLicensedApp({ each: true });

  it('veritabanındaki kirayı düzenlemek (süre uzatma, imza bozma) salt-okunura düşürür; kalp atışı onarır', async () => {
    const c = t.ctx;
    const { api, owner } = await licensedOwner(c);
    const good = await leaseToken();
    const [head, kid, payload, sig] = good.split('.') as [string, string, string, string];

    // 1) yükü düzenle (validUntil'i 10 yıl ileri al), imza aynı kalsın
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString());
    edited.validUntil = c.clock.t + 3650 * DAY;
    edited.leaseUntil = c.clock.t + 3650 * DAY;
    const forged = [head, kid, Buffer.from(JSON.stringify(edited)).toString('base64url'), sig].join('.');
    await setLease(forged);
    expect((await c.service.current())).toMatchObject({ state: 'restricted', reason: 'invalid_lease' });
    const w = await api.post('/api/parties', { name: 'Sahte', type: 'customer' });
    expect(w.statusCode).toBe(402);
    expect((await api.get('/api/parties')).statusCode).toBe(200);

    // 2) satıcı anahtarı olmayan birinin imzaladığı "geçerli" bir kira
    const snapInst = (await c.service.current()).installationId;
    await setLease(c.vendor.signForged([...c.vendor.licenses.values()][0]!, { installationId: snapInst, fingerprint: c.fingerprint.value }, 'x'.repeat(22)));
    expect((await c.service.current()).reason).toBe('invalid_lease');

    // 3) rastgele metin / boş imza
    await setLease('erp1.k-test.bozuk.bozuk');
    expect((await c.service.current()).reason).toBe('invalid_lease');

    // kalp atışı onarır (imzalı yeni kira)
    const healed = await client(c.app, owner.token).post('/api/license/refresh');
    expect(healed.statusCode, healed.body).toBe(200);
    expect(healed.json().state).toBe('active');
    expect((await api.post('/api/parties', { name: 'Onarıldı', type: 'customer' })).statusCode).toBe(201);
    void good;
  });

  it('kirayı lisanssız hale getirmek için silmek (NULL) kurulumu lisanssız yapar, bedava kullanım sağlamaz', async () => {
    const c = t.ctx;
    await licensedOwner(c);
    await setLease(null);
    const snap = await c.service.current();
    expect(snap.state).toBe('unlicensed');
    const res = await c.app.inject({ method: 'POST', url: '/api/auth/register', payload: {} });
    expect(res.statusCode).toBe(402);
  });

  it('eski (süresi dolmuş) ama imzalı bir kirayı geri koymak süresi dolmuş kalır; kalp atışı güncelini getirir', async () => {
    const c = t.ctx;
    const { owner } = await licensedOwner(c);
    const old = await leaseToken();
    c.clock.t += 30 * DAY;
    await beat(c); // yeni kira (30. gün)
    const fresh = await leaseToken();
    expect(fresh).not.toBe(old);
    c.clock.t += 60 * DAY; // 90. gün: yeni kira da bitti
    expect((await c.service.current()).state).toBe('restricted');
    await setLease(old);
    expect((await c.service.current())).toMatchObject({ state: 'restricted', reason: 'expired' });
    const res = await client(c.app, owner.token).post('/api/license/refresh');
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('active');
  });

  it('veritabanı başka sunucuya kopyalanınca (parmak izi değişti) salt-okunur; yeniden etkinleştirme açar', async () => {
    const c = t.ctx;
    const { license, owner, api } = await licensedOwner(c);
    c.fingerprint.value = 'd'.repeat(64); // taşındı/klonlandı
    const snap = await c.service.current();
    expect(snap).toMatchObject({ state: 'restricted', reason: 'fingerprint_mismatch' });
    expect((await api.post('/api/parties', { name: 'Klon', type: 'customer' })).statusCode).toBe(402);
    expect((await api.get('/api/parties')).statusCode).toBe(200);
    // kalp atışı da yeni parmak izini kabul etmez (satıcı eski parmak izini tanıyor): yeniden etkinleştirme gerekir
    await expect(beat(c)).rejects.toMatchObject({ code: 'FINGERPRINT_CHANGED' });
    const again = await client(c.app, owner.token).post('/api/license/activate', { code: license.code });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().state).toBe('active');
    expect((await api.post('/api/parties', { name: 'Yeni Sunucu', type: 'customer' })).statusCode).toBe(201);
  });

  it('saati geri almak kilitler; yeniden başlatma saat işaretini sıfırlamaz', async () => {
    const c = t.ctx;
    const { api } = await licensedOwner(c);
    const start = c.clock.t;
    c.clock.t = start + 2 * 60 * 60 * 1000;
    expect((await c.service.current()).state).toBe('active'); // işaret 2 saat ileri
    // kalıcılaşmayı bekle (saat işareti arka planda yazılır)
    for (let i = 0; i < 50; i++) {
      const hw = Number((await licenseOwnerSql('select high_water from license_state')).rows[0].high_water);
      if (hw >= start + 2 * 60 * 60 * 1000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    c.clock.t = start + 30 * 60 * 1000; // 90 dk geri
    expect((await c.service.current())).toMatchObject({ state: 'restricted', reason: 'clock_rollback' });
    expect((await api.post('/api/parties', { name: 'Saat', type: 'customer' })).statusCode).toBe(402);

    // süreç yeniden başlamış gibi taze bir hizmet: yine kilitli
    const fresh = new LicenseService({
      db: c.handle.db,
      keyring: c.vendor.keyring,
      enforced: true,
      transport: c.vendor.transport,
      appVersion: 'test',
      now: () => c.clock.t,
      fingerprint: async () => ({ fingerprint: c.fingerprint.value, strength: 'strong' }),
    });
    expect((await fresh.current())).toMatchObject({ state: 'restricted', reason: 'clock_rollback' });

    // saat düzelince (işaretin ötesine geçince) açılır
    c.clock.t = start + 3 * 60 * 60 * 1000;
    expect((await c.service.current()).state).toBe('active');
  });

  it('saati küçük oynatmak (NTP düzeltmesi, 10 dakikaya kadar) kilitlemez', async () => {
    const c = t.ctx;
    await licensedOwner(c);
    c.clock.t += 60 * 60 * 1000;
    await c.service.current();
    c.clock.t -= 5 * 60 * 1000;
    expect((await c.service.current()).state).toBe('active');
  });

  it('uygulama hesabı lisans durumunu silemez, kimliğini değiştiremez, saat işaretini geri alamaz (ERP08)', async () => {
    const c = t.ctx;
    await licensedOwner(c);
    const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
    try {
      for (const sql of [
        'delete from license_state',
        'truncate license_state',
        `update license_state set installation_id = '${randomUUID()}'`,
        `update license_state set public_key = 'x'`,
        `update license_state set high_water = 0`,
      ]) {
        await expect(pool.query(sql), sql).rejects.toMatchObject({ code: expect.stringMatching(/^(ERP08|42501)$/) });
      }
      // ileri taşıma serbest
      await expect(pool.query('update license_state set high_water = high_water + 1')).resolves.toBeTruthy();
    } finally {
      await pool.end();
    }
  });
});

describe('çevrimdışı etkinleştirme', () => {
  const t = useLicensedApp({ noTransport: true });

  it('istek kodu → satıcı imzası → yapıştırma; yeniden oynatma ve yanlış istek reddedilir', async () => {
    const c = t.ctx;
    const license = c.vendor.issue({ customer: 'Ağsız Müşteri' });
    const noPending = await c.app.inject({ method: 'POST', url: '/api/license/offline-activate', payload: { lease: 'x'.repeat(60) } });
    expect(noPending.statusCode).toBe(409);
    expect(noPending.json().error.code).toBe('NO_PENDING_REQUEST');

    const req = await c.app.inject({ method: 'POST', url: '/api/license/offline-request' });
    expect(req.statusCode, req.body).toBe(200);
    const requestCode = req.json().requestCode as string;
    expect(requestCode).toMatch(/^erpreq1\./);

    // satıcı başka bir istek için imzalarsa kabul edilmez
    const req2 = await c.service.offlineRequest();
    const otherLease = c.vendor.signOffline(requestCode, license, 365); // eski istek kimliği
    const wrong = await c.app.inject({ method: 'POST', url: '/api/license/offline-activate', payload: { lease: otherLease } });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('LICENSE_INVALID');

    const good = c.vendor.signOffline(req2.requestCode, license, 365);
    const ok = await c.app.inject({ method: 'POST', url: '/api/license/offline-activate', payload: { lease: good } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: 'active', license: { customer: 'Ağsız Müşteri', offline: true } });

    // bir kez kullanıldı: bekleyen istek temizlendi, yeniden oynatma kabul edilmez (artık kimlik de gerekir)
    const replay = await c.app.inject({ method: 'POST', url: '/api/license/offline-activate', payload: { lease: good } });
    expect(replay.statusCode).toBe(401);

    // uzun süreli kira: kalp atışı olmadan aylarca çalışır
    const owner = await registerUser(c.app, 'Agsiz');
    await createCompany(c.app, owner.token, { sector: 'COMMERCE', name: 'Ağsız Ltd.' });
    c.clock.t += 300 * DAY;
    expect((await c.service.current()).state).toBe('active');
    // çevrimiçi yollar sunucu adresi olmadığı için kapalı
    const hb = await client(c.app, owner.token).post('/api/license/refresh');
    expect(hb.statusCode).toBe(409);
    expect(hb.json().error.code).toBe('LICENSE_SERVER_NOT_CONFIGURED');
  });

  it('başka bir sunucu için imzalanmış çevrimdışı kira kabul edilmez; çevrimiçi kira türü çevrimdışı yoldan girmez', async () => {
    const c = t.ctx;
    await resetAndReady(c);
    const license = c.vendor.issue();
    const { requestCode } = await c.service.offlineRequest();
    const pending = (await licenseOwnerSql('select pending_request_id from license_state')).rows[0].pending_request_id as string;
    const inst = (await c.service.current()).installationId;
    const foreign = c.vendor.signLease('offline-lease', license, { installationId: inst, fingerprint: 'e'.repeat(64) }, pending);
    const r1 = await c.app.inject({ method: 'POST', url: '/api/license/offline-activate', payload: { lease: foreign } });
    expect(r1.json().error.code).toBe('LICENSE_NOT_FOR_THIS_SERVER');
    const online = c.vendor.signLease('lease', license, { installationId: inst, fingerprint: c.fingerprint.value }, pending);
    const r2 = await c.app.inject({ method: 'POST', url: '/api/license/offline-activate', payload: { lease: online } });
    expect(r2.json().error.code).toBe('LICENSE_INVALID');
    void requestCode;
  });
});

async function resetAndReady(c: LicensedApp) {
  await setLease(null);
  await licenseOwnerSql(`update license_state set pending_request_id = null`);
  await c.service.reload();
}

describe('devre dışı bırakma (sunucu taşıma)', () => {
  const t = useLicensedApp();

  it('sahip devre dışı bırakır → lisanssız; aynı kodla yeniden etkinleştirilir', async () => {
    const c = t.ctx;
    const { license, owner } = await licensedOwner(c);
    const res = await client(c.app, owner.token).post('/api/license/deactivate');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().state).toBe('unlicensed');
    expect(c.vendor.calls.deactivate).toBe(1);
    expect((await c.app.inject({ method: 'GET', url: '/api/accounts', headers: { authorization: `Bearer ${owner.token}` } })).statusCode).toBe(402);
    // kimliksiz yeniden etkinleştirme (artık lisanssız)
    const again = await activate(c, license.code);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().state).toBe('active');
  });

  it('satıcı kurulumu zaten tanımıyorsa yerel bağ yine de kaldırılır', async () => {
    const c = t.ctx;
    const { owner } = await licensedOwner(c, c.vendor.issue());
    c.vendor.failNext = new LicenseServerError(404, 'UNKNOWN_INSTALLATION', 'Bu kurulum tanınmıyor');
    const res = await client(c.app, owner.token).post('/api/license/deactivate');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().state).toBe('unlicensed');
  });

  it('ağ kesikken devre dışı bırakma reddedilir ve lisans yerinde kalır', async () => {
    const c = t.ctx;
    const { owner } = await licensedOwner(c, c.vendor.issue());
    c.vendor.offline = true;
    const res = await client(c.app, owner.token).post('/api/license/deactivate');
    expect(res.statusCode).toBe(502);
    c.vendor.offline = false;
    expect((await c.service.current()).state).toBe('active');
  });
});

describe('etkinleştirme güvenliği', () => {
  const t = useLicensedApp({ each: true });

  it('sunucu başka bir anahtarla imzalanmış kira döndürürse etkinleşmez', async () => {
    const c = t.ctx;
    const license = c.vendor.issue();
    c.vendor.transport.activate = async (body) => {
      // gerçek akış yerine sahte satıcı: doğru nonce, yanlış imza anahtarı
      const { verifyEnvelope } = await import('@erp/license-core');
      const payload = verifyEnvelope('activate', body, body.pub) as { installationId: string; fingerprint: string; nonce: string };
      return { lease: c.vendor.signForged(license, payload, payload.nonce) };
    };
    const res = await activate(c, license.code);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('LICENSE_INVALID');
    expect((await c.service.current()).state).toBe('unlicensed');
  });

  it('bir lisans en fazla maxActivations sunucuda etkinleşir (satıcı kuralı iletilir)', async () => {
    const c = t.ctx;
    const license = c.vendor.issue({ maxActivations: 1 });
    expect((await activate(c, license.code)).statusCode).toBe(200);
    // başka bir kurulum (yeni kimlik) aynı kodu kullanmak isterse satıcı reddeder
    await licenseOwnerSql(`alter table license_state disable trigger license_state_guard; delete from license_state; alter table license_state enable trigger license_state_guard`);
    await c.service.reload();
    const res = await activate(c, license.code);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ACTIVATION_LIMIT');
  });
});

describe('genel durum uçları', () => {
  const t = useLicensedApp();

  it('salt-okunur modda bile sağlık ve genel yapılandırma açık; public-config durumu bildirir', async () => {
    const c = t.ctx;
    await licensedOwner(c);
    c.clock.t += 60 * DAY;
    const cfg = await c.app.inject({ method: 'GET', url: '/api/public-config' });
    expect(cfg.json().license).toEqual({ enforced: true, state: 'restricted', reason: 'expired' });
    expect((await c.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});
