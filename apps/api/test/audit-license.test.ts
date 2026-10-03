import { describe, expect, it } from 'vitest';
import { base32Decode, hotp, totpCounter } from '@erp/license-core';
import { addMember, client, createCompany, orgOf, registerUser } from './helpers';
import { Browser, licenseOwnerSql, useLicenseDatabase, useLicensedApp } from './license-helpers';

useLicenseDatabase();

/**
 * Güvenlik denetimi SEC-1 (kurulum yönetimi yalnızca kurulumun sahibi kuruluşa) ve SEC-6 (salt-okunurken MFA ile giriş)
 * regresyon testleri; lisans denetimi açık uygulamayla.
 */
describe('denetim düzeltmeleri: kurulumun sahibi kuruluş (SEC-1)', () => {
  const t = useLicensedApp();

  it('açık kayıtla gelen başka kuruluşun şirket sahibi lisansı yönetemez; müşteri sahibi yönetir', async () => {
    const c = t.ctx;
    const lic = c.vendor.issue();
    expect((await c.app.inject({ method: 'POST', url: '/api/license/activate', payload: { code: lic.code } })).statusCode).toBe(200);
    const owner = await registerUser(c.app, 'Musteri');
    const co = await createCompany(c.app, owner.token, { sector: 'COMMERCE' });
    // İlk şirketle kurulumun sahibi kuruluş sabitlenir
    const pinned = (await licenseOwnerSql('select owner_org_id from license_state where id = 1')).rows[0].owner_org_id;
    expect(pinned).toBe(await orgOf(c.app, owner.token));

    const stranger = await registerUser(c.app, 'Yabanci');
    await createCompany(c.app, stranger.token, { sector: 'COMMERCE' });
    const sc = client(c.app, stranger.token);
    const info = (await sc.get('/api/license')).json();
    expect(info.isOwner).toBe(false);
    expect(info.installationId).toBeUndefined();
    for (const r of [await sc.post('/api/license/deactivate'), await sc.post('/api/license/refresh')]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('OWNER_ONLY');
    }
    expect((await sc.get('/api/system/update')).statusCode).toBe(403);
    expect((await sc.get('/api/devices')).json().error.code).toBe('DEVICE_ADMIN_ONLY');
    // Müşterinin işleri sürer; sahibi kurulumu yönetir, yöneticisi cihazları yönetir
    expect((await client(c.app, owner.token, co.id).get('/api/accounts')).statusCode).toBe(200);
    expect((await client(c.app, owner.token).get('/api/license')).json().isOwner).toBe(true);
    const admin = await addMember(c.app, client(c.app, owner.token, co.id), co.id, 'admin');
    expect((await client(c.app, admin.token).get('/api/devices')).statusCode).toBe(200);
    expect((await client(c.app, admin.token).post('/api/license/refresh')).statusCode).toBe(403);
    expect((await client(c.app, owner.token).post('/api/license/refresh')).statusCode).toBe(200);
  });

  it('uygulama rolü sabitlenmiş sahip kuruluşu değiştiremez', async () => {
    const c = t.ctx;
    const other = await registerUser(c.app, 'Baska');
    const res = await c.handle.pool.query('update license_state set owner_org_id = $1 where id = 1', [await orgOf(c.app, other.token)]).catch((e: { code: string }) => e);
    expect((res as { code?: string }).code).toBe('ERP08');
  });
});

describe('denetim düzeltmeleri: salt-okunur lisansta iki adımlı giriş (SEC-6)', () => {
  const t = useLicensedApp();

  it('MFA kullanıcısı salt-okunur modda girişi tamamlayabilir', async () => {
    const c = t.ctx;
    const lic = c.vendor.issue();
    await c.app.inject({ method: 'POST', url: '/api/license/activate', payload: { code: lic.code } });
    const b = new Browser(c.app);
    const reg = await b.register('MfaSalt');
    const tok = reg.json().accessToken as string;
    const email = reg.json().user.email as string;
    await createCompany(c.app, tok, { sector: 'COMMERCE' });
    const secret = (await client(c.app, tok).post('/api/auth/mfa/setup')).json().secret as string;
    expect((await client(c.app, tok).post('/api/auth/mfa/enable', { code: hotp(base32Decode(secret), totpCounter(Date.now())) })).statusCode).toBe(200);
    lic.status = 'suspended';
    c.clock.t += 1000;
    expect((await c.service.heartbeat()).state).toBe('restricted');
    const l = await b.login(email);
    expect(l.json().mfaRequired).toBe(true);
    // (TOTP sunucu saatine göre doğrulanır; bir sonraki adımın kodu tolerans penceresindedir)
    const v = await b.post('/api/auth/mfa/verify', { mfaToken: l.json().mfaToken, code: hotp(base32Decode(secret), totpCounter(Date.now()) + 1) });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().accessToken).toBeTruthy();
  });
});
