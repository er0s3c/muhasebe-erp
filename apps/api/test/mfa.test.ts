import { describe, expect, it } from 'vitest';
import { base32Decode, hotp, totpCounter } from '@erp/license-core';
import { PASSWORD, addMember, client, createCompany, execAsOwner, makeApp, registerUser } from './helpers';

/** Şimdiki adımdan `offset` adım ilerideki kod (tekrar kullanım denetimini sınamak için). */
const codeAt = (secret: string, offset = 0) => hotp(base32Decode(secret), totpCounter(Date.now()) + offset);

describe('uygulama kullanıcıları için MFA (TOTP)', async () => {
  const { app } = await makeApp();
  const login = (email: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const verify = (mfaToken: string, code: string) => app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken, code } });

  async function enrolled(name: string) {
    const s = await registerUser(app, name);
    const c = client(app, s.token);
    const setup = (await c.post('/api/auth/mfa/setup')).json() as { secret: string; otpauthUri: string };
    const enable = await c.post('/api/auth/mfa/enable', { code: codeAt(setup.secret) });
    expect(enable.statusCode).toBe(200);
    return { ...s, c, secret: setup.secret, recoveryCodes: enable.json().recoveryCodes as string[] };
  }

  it('kurulum → etkinleştirme: sır şifreli saklanır, kurtarma kodları bir kez döner', async () => {
    const s = await registerUser(app, 'MfaKur');
    const c = client(app, s.token);
    expect((await c.get('/api/auth/mfa')).json()).toEqual({ enabled: false, pending: false, recoveryCodesLeft: 0 });
    const setup = (await c.post('/api/auth/mfa/setup')).json();
    expect(setup.otpauthUri).toContain('otpauth://totp/');
    expect(setup.otpauthUri).toContain(setup.secret);
    // Bekleyen kurulumda giriş zorlanmaz.
    expect((await login(s.email)).json().accessToken).toBeTruthy();
    expect((await c.post('/api/auth/mfa/enable', { code: '000000' })).json().error.code).toBe('MFA_CODE_INVALID');
    const en = await c.post('/api/auth/mfa/enable', { code: codeAt(setup.secret) });
    expect(en.statusCode).toBe(200);
    expect(en.json().recoveryCodes).toHaveLength(8);
    expect((await c.get('/api/auth/mfa')).json()).toEqual({ enabled: true, pending: false, recoveryCodesLeft: 8 });
    const raw = await execAsOwner('select secret_enc, recovery_hashes from user_mfa where user_id = $1', [s.userId]);
    expect(raw.rows[0].secret_enc).not.toContain(setup.secret);
    expect(JSON.stringify(raw.rows[0].recovery_hashes)).not.toContain(en.json().recoveryCodes[0]);
    expect((await c.post('/api/auth/mfa/setup')).json().error.code).toBe('MFA_ALREADY_ENABLED');
  });

  it('MFA açıkken giriş oturum vermez; kodla ikinci adım oturum açar, aynı kod yeniden kullanılamaz', async () => {
    const u = await enrolled('MfaGiris');
    const first = (await login(u.email)).json();
    expect(first.mfaRequired).toBe(true);
    expect(first.accessToken).toBeUndefined();
    // MFA belirteci korumalı uçlarda geçmez.
    expect((await client(app, first.mfaToken).get('/api/me')).statusCode).toBe(401);
    expect((await verify(first.mfaToken, '123456')).json().error.code).toBe('MFA_CODE_INVALID');
    const code = codeAt(u.secret, 1);
    const ok = await verify(first.mfaToken, code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTruthy();
    expect(ok.cookies.some((c) => c.name === 'refresh_token')).toBe(true);
    expect((await client(app, ok.json().accessToken).get('/api/me')).statusCode).toBe(200);
    // Aynı (ve daha eski) kod tekrar geçmez.
    const second = (await login(u.email)).json();
    expect((await verify(second.mfaToken, code)).json().error.code).toBe('MFA_CODE_INVALID');
    expect((await verify(second.mfaToken, codeAt(u.secret))).json().error.code).toBe('MFA_CODE_INVALID');
  });

  it('erişim belirteci mfa ucunda, mfa belirteci başka uçlarda geçersizdir', async () => {
    const u = await enrolled('MfaTok');
    const r = await verify(u.token, codeAt(u.secret, 1));
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('MFA_TOKEN_INVALID');
  });

  it('kurtarma kodu tek kullanımlıktır', async () => {
    const u = await enrolled('MfaKurt');
    const rc = u.recoveryCodes[0]!;
    const a = (await login(u.email)).json();
    expect((await verify(a.mfaToken, rc.toUpperCase())).statusCode).toBe(200);
    const b = (await login(u.email)).json();
    expect((await verify(b.mfaToken, rc)).json().error.code).toBe('MFA_CODE_INVALID');
    expect((await u.c.get('/api/auth/mfa')).json().recoveryCodesLeft).toBe(7);
  });

  it('kapatma parola + kod ister; kurtarma kodları yenilenir', async () => {
    const u = await enrolled('MfaKapat');
    expect((await u.c.post('/api/auth/mfa/disable', { password: 'yanlis-sifre-123', code: codeAt(u.secret, 1) })).statusCode).toBe(401);
    const regen = await u.c.post('/api/auth/mfa/recovery-codes', { code: codeAt(u.secret, 1) });
    expect(regen.statusCode).toBe(200);
    const fresh = regen.json().recoveryCodes as string[];
    expect(fresh).not.toContain(u.recoveryCodes[0]);
    // Eski kurtarma kodu artık geçmez.
    const t = (await login(u.email)).json().mfaToken as string;
    expect((await verify(t, u.recoveryCodes[0]!)).statusCode).toBe(401);
    const off = await u.c.post('/api/auth/mfa/disable', { password: PASSWORD, code: fresh[0] });
    expect(off.statusCode).toBe(200);
    expect((await login(u.email)).json().accessToken).toBeTruthy();
    const ev = await execAsOwner(`select event from security_events where user_id = $1 and event like 'mfa_%' order by at`, [u.userId]);
    expect(ev.rows.map((r) => r.event)).toEqual(expect.arrayContaining(['mfa_enabled', 'mfa_failed', 'mfa_recovery_regenerated', 'mfa_disabled']));
  });

  it('şirket yöneticisi üyenin MFA\'sını sıfırlar; yalnızca yetkili ve kendi şirketinin üyesi için', async () => {
    const owner = await registerUser(app, 'MfaSahip');
    const company = await createCompany(app, owner.token);
    const oc = client(app, owner.token, company.id);
    const m = await addMember(app, oc, company.id, 'accountant');
    const c = client(app, m.token);
    const setup = (await c.post('/api/auth/mfa/setup')).json();
    expect((await c.post('/api/auth/mfa/enable', { code: codeAt(setup.secret) })).statusCode).toBe(200);
    const list = (await oc.get('/api/company/members')).json().members as { userId: string; mfaEnabled: boolean }[];
    expect(list.find((x) => x.userId === m.userId)?.mfaEnabled).toBe(true);
    expect((await m.client.delete(`/api/company/members/${m.userId}/mfa`)).statusCode).toBe(403);
    expect((await oc.delete(`/api/company/members/${m.userId}/mfa`)).statusCode).toBe(200);
    expect((await login(m.email)).json().accessToken).toBeTruthy();
    // Başka şirketin üyesi sıfırlanamaz.
    const other = await enrolled('MfaYabanci');
    expect((await oc.delete(`/api/company/members/${other.userId}/mfa`)).statusCode).toBe(404);
  });
});

describe('MFA hatalı kod sınırı', async () => {
  const { app } = await makeApp({ configOverrides: { RATE_LIMIT_ENABLED: true } });
  it('5 hatalı koddan sonra doğru kod bile 429 alır', async () => {
    const s = await registerUser(app, 'MfaLimit');
    const c = client(app, s.token);
    const setup = (await c.post('/api/auth/mfa/setup')).json();
    expect((await c.post('/api/auth/mfa/enable', { code: codeAt(setup.secret) })).statusCode).toBe(200);
    const t = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.email, password: PASSWORD } })).json().mfaToken as string;
    const v = (code: string) => app.inject({ method: 'POST', url: '/api/auth/mfa/verify', payload: { mfaToken: t, code } });
    for (let i = 0; i < 5; i++) expect((await v('000000')).statusCode).toBe(401);
    const blocked = await v(codeAt(setup.secret, 1));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
  });
});
