import { describe, expect, it } from 'vitest';
import { generateKeyPair, loadPrivateKey, releaseFileName, signToken } from '@erp/license-core';
import { buildApp } from '../src/app';
import { nextNightWindow } from '../src/modules/system/updates';
import { addMember, client, createCompany, registerUser } from './helpers';
import { licenseOwnerSql, useLicenseDatabase, useLicensedApp, type LicensedApp } from './license-helpers';

useLicenseDatabase();

const TOKEN = 'u'.repeat(48);
const SERVER = 'https://lisans.ornek.com';

function manifest(c: LicensedApp, version: string, signer = { kid: c.vendor.kid, privateKey: loadPrivateKey(c.vendor.pair.privateKeyPem) }) {
  return signToken(
    'release',
    {
      v: 1,
      typ: 'release',
      version,
      notes: 'Üçlü eşleştirme ve hata düzeltmeleri',
      publishedAt: c.clock.t,
      files: [{ target: 'linux-x64', name: releaseFileName(version, 'linux-x64'), sha256: 'b'.repeat(64), size: 1234 }],
    },
    signer,
  );
}
const beat = (c: LicensedApp) => {
  c.clock.t += 1000;
  return c.service.heartbeat();
};

describe('uzaktan güncelleme: teklif → sahip onayı → güncelleyici', () => {
  const t = useLicensedApp({ configOverrides: { ERP_KIT_TARGET: 'linux-x64', ERP_UPDATER_TOKEN: TOKEN, LICENSE_SERVER_URL: SERVER, APP_VERSION: '1.0.0' } });
  const updater = (c: LicensedApp, method: 'GET' | 'POST', url: string, payload?: object, token = TOKEN) =>
    c.app.inject({ method, url, payload, headers: token ? { 'x-updater-token': token } : {} });

  it('teklif imzası doğrulanır; sahip onaylar; güncelleyici indirir ve durumu bildirir', async () => {
    const c = t.ctx;
    const lic = c.vendor.issue();
    expect((await c.app.inject({ method: 'POST', url: '/api/license/activate', payload: { code: lic.code } })).statusCode).toBe(200);
    const owner = await registerUser(c.app, 'Sahip');
    const company = await createCompany(c.app, owner.token, { sector: 'CONSTRUCTION' });
    const oc = client(c.app, owner.token);
    expect((await oc.get('/api/system/update')).json()).toMatchObject({ currentVersion: '1.0.0', platform: 'linux-x64', updaterReady: true, offer: null });

    // Sahte imzalı teklif yok sayılır (kalp atışı yine başarılı)
    const rogue = generateKeyPair();
    c.vendor.update = { manifest: manifest(c, '9.9.9', { kid: c.vendor.kid, privateKey: loadPrivateKey(rogue.privateKeyPem) }), downloadToken: 'x'.repeat(40) };
    await beat(c);
    expect((await licenseOwnerSql('select count(*)::int as n from app_updates')).rows[0].n).toBe(0);

    c.vendor.update = { manifest: manifest(c, '1.1.0'), downloadToken: 'tok-'.repeat(10) };
    await beat(c);
    expect(c.vendor.platforms.at(-1)).toBe('linux-x64');
    const ov = (await oc.get('/api/system/update')).json();
    expect(ov.offer).toMatchObject({ version: '1.1.0', status: 'offered', notes: 'Üçlü eşleştirme ve hata düzeltmeleri' });

    // Yalnızca sahip görür ve onaylar
    const acc = await addMember(c.app, client(c.app, owner.token, company.id), company.id, 'admin');
    expect((await client(c.app, acc.token).get('/api/system/update')).json().error.code).toBe('OWNER_ONLY');

    // Güncelleyici: belirteçsiz 401, onay yokken iş yok
    expect((await updater(c, 'GET', '/api/system/updater/pending', undefined, 'yanlis')).statusCode).toBe(401);
    expect((await updater(c, 'GET', '/api/system/updater/pending')).json().update).toBeNull();

    const req = await oc.post(`/api/system/update/${ov.offer.id}/request`, { when: 'now' });
    expect(req.statusCode, req.body).toBe(200);
    expect(req.json().update.status).toBe('requested');
    const pending = (await updater(c, 'GET', '/api/system/updater/pending')).json().update;
    expect(pending).toMatchObject({ version: '1.1.0', file: 'muhasebe-erp-1.1.0-linux-x64.tar.gz' });
    expect(pending.downloadUrl).toBe(`${SERVER}/v1/releases/1.1.0/muhasebe-erp-1.1.0-linux-x64.tar.gz?t=${encodeURIComponent('tok-'.repeat(10))}`);

    // Durum geçişleri; çalışan sürüm 1.0.0 iken "bitti" kabul edilmez
    expect((await updater(c, 'POST', '/api/system/updater/report', { id: pending.id, status: 'downloading' })).statusCode).toBe(200);
    expect((await updater(c, 'POST', '/api/system/updater/report', { id: pending.id, status: 'applying' })).statusCode).toBe(200);
    expect((await oc.get('/api/me')).statusCode).toBe(200);
    expect((await oc.post('/api/companies', { name: 'Bakım sırasında açılamaz', sector: 'CONSTRUCTION', jurisdiction: 'KKTC', baseCurrency: 'TRY' })).json().error.code).toBe('UPDATE_MAINTENANCE');
    expect((await updater(c, 'POST', '/api/system/updater/report', { id: pending.id, status: 'done' })).json().error.code).toBe('UPDATE_VERSION_MISMATCH');
    expect((await oc.post(`/api/system/update/${ov.offer.id}/cancel`)).json().error.code).toBe('UPDATE_MAINTENANCE');

    // Yeni sürüm ayağa kalkınca (APP_VERSION 1.1.0) güncelleyici "bitti" bildirir
    const v2 = await buildApp({ db: c.handle.db, config: { ...c.config, APP_VERSION: '1.1.0' }, logger: false, license: { service: c.service } });
    await v2.ready();
    try {
      const done = await v2.inject({ method: 'POST', url: '/api/system/updater/report', payload: { id: pending.id, status: 'done', log: 'tamam' }, headers: { 'x-updater-token': TOKEN } });
      expect(done.statusCode, done.body).toBe(200);
      const after = (await client(v2, owner.token).get('/api/system/update')).json();
      expect(after.currentVersion).toBe('1.1.0');
      expect(after.offer).toBeNull();
      expect(after.history[0]).toMatchObject({ version: '1.1.0', status: 'done', fromVersion: '1.0.0' });
    } finally {
      await v2.close();
    }
    const ev = await licenseOwnerSql(`select count(*)::int as n from security_events where event = 'update_requested'`);
    expect(ev.rows[0].n).toBe(1);
  });

  it('başarısız güncelleme yeniden onaylanır; gece penceresi zamanı gelmeden verilmez; iptal edilir', async () => {
    const c = t.ctx;
    c.vendor.update = { manifest: manifest(c, '1.2.0'), downloadToken: 'tok2-'.repeat(8) };
    await beat(c);
    const owner = (await licenseOwnerSql(`select u.email from users u join memberships m on m.user_id = u.id where m.role = 'owner' limit 1`)).rows[0].email as string;
    const login = await c.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner, password: 'Sifre-12345-xyz' } });
    const oc = client(c.app, login.json().accessToken);
    const offer = (await oc.get('/api/system/update')).json().offer;
    expect(offer.version).toBe('1.2.0');
    await oc.post(`/api/system/update/${offer.id}/request`, { when: 'now' });
    const p = (await updater(c, 'GET', '/api/system/updater/pending')).json().update;
    expect((await updater(c, 'POST', '/api/system/updater/report', { id: p.id, status: 'failed', message: 'Migration başarısız; önceki sürüm geri alındı' })).statusCode).toBe(200);
    expect((await oc.get('/api/system/update')).json().offer).toMatchObject({ status: 'failed', message: 'Migration başarısız; önceki sürüm geri alındı' });

    const night = await oc.post(`/api/system/update/${offer.id}/request`, { when: 'tonight' });
    expect(new Date(night.json().update.scheduledFor).getTime()).toBeGreaterThan(Date.now());
    expect((await updater(c, 'GET', '/api/system/updater/pending')).json().update).toBeNull();
    expect((await oc.post(`/api/system/update/${offer.id}/cancel`)).json().update.status).toBe('cancelled');
  });

  it('sürüm düşürme: eski/aynı sürüm teklifi saklanmaz, onaylanamaz ve güncelleyiciye verilmez', async () => {
    const c = t.ctx;
    for (const v of ['1.0.0', '0.9.0', '1.0.0-rc.9']) {
      c.vendor.update = { manifest: manifest(c, v), downloadToken: 'old-'.repeat(10) };
      await beat(c);
    }
    expect((await licenseOwnerSql(`select count(*)::int as n from app_updates where version in ('1.0.0','0.9.0','1.0.0-rc.9')`)).rows[0].n).toBe(0);
    // Eski bir kayıt (ör. elle yükseltmeden önce gelmiş teklif) onaylanamaz
    await licenseOwnerSql(
      `insert into app_updates (id, version, manifest, files, download_token) values (gen_random_uuid(), '0.9.0', 'x', '[{"target":"linux-x64","name":"muhasebe-erp-0.9.0-linux-x64.tar.gz","sha256":"${'b'.repeat(64)}","size":1}]'::jsonb, 'tok')`,
    );
    const owner = (await licenseOwnerSql(`select u.email from users u join memberships m on m.user_id = u.id where m.role = 'owner' limit 1`)).rows[0].email as string;
    const login = await c.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: owner, password: 'Sifre-12345-xyz' } });
    const oc = client(c.app, login.json().accessToken);
    const old = (await licenseOwnerSql(`select id from app_updates where version = '0.9.0'`)).rows[0].id as string;
    const res = await oc.post(`/api/system/update/${old}/request`, { when: 'now' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UPDATE_NOT_NEWER');
    // Doğrudan "requested" yapılmış olsa bile güncelleyiciye verilmez
    await licenseOwnerSql(`update app_updates set status = 'requested', scheduled_for = now() - interval '1 minute' where version = '0.9.0'`);
    expect((await updater(c, 'GET', '/api/system/updater/pending')).json().update).toBeNull();
    await licenseOwnerSql(`update app_updates set status = 'cancelled' where version = '0.9.0'`);
  });

  it('gece penceresi: 02:00 geçtiyse ertesi gün', () => {
    const at = (h: number) => {
      const d = new Date(2026, 9, 1, h, 0, 0);
      return nextNightWindow(d);
    };
    expect(at(1).getDate()).toBe(1);
    expect(at(1).getHours()).toBe(2);
    expect(at(3).getDate()).toBe(2);
  });
});

describe('güncelleyici yapılandırılmamış kurulum', () => {
  const t = useLicensedApp({ configOverrides: { APP_VERSION: '1.0.0' } });
  it('onay reddedilir, güncelleyici uçları kapalıdır', async () => {
    const c = t.ctx;
    const lic = c.vendor.issue();
    await c.app.inject({ method: 'POST', url: '/api/license/activate', payload: { code: lic.code } });
    const owner = await registerUser(c.app, 'Sahip2');
    await createCompany(c.app, owner.token);
    c.vendor.update = { manifest: manifest(c, '1.1.0'), downloadToken: 'tok-'.repeat(10) };
    await beat(c);
    const oc = client(c.app, owner.token);
    const ov = (await oc.get('/api/system/update')).json();
    expect(ov.updaterReady).toBe(false);
    expect((await oc.post(`/api/system/update/${ov.offer.id}/request`, { when: 'now' })).json().error.code).toBe('UPDATER_NOT_CONFIGURED');
    expect((await c.app.inject({ method: 'GET', url: '/api/system/updater/pending', headers: { 'x-updater-token': TOKEN } })).statusCode).toBe(401);
  });
});
