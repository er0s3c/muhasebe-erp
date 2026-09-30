import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { evaluateLease } from '@erp/license-core';
import { activations, auditLog, licenses } from '../src/db/schema';
import { DAY, activate, activateRequest, deactivateRequest, heartbeat, heartbeatRequest, issueLicense, makeInstallation, makeServer } from './helpers';

const s = await makeServer();
const ctxOf = (lease: { installationId: string; fingerprint: string }, now: number) => ({ now, highWater: now, installationId: lease.installationId, fingerprint: lease.fingerprint });

describe('etkinleştirme', () => {
  it('geçerli kodla imzalı, kuruluma ve parmak izine bağlı kira döner; istemci nonce\'u yansıtılır', async () => {
    const { code, license, customer } = await issueLicense(s, { sectors: ['RETAIL_MARKET', 'COMMERCE'], deviceLimit: 4, companyLimit: 2 });
    const inst = makeInstallation();
    const { res, lease, nonce } = await activate(s, inst, code);
    expect(res.statusCode).toBe(200);
    expect(lease).toMatchObject({
      licenseId: license.id,
      customer: customer.name,
      status: 'active',
      sectors: ['RETAIL_MARKET', 'COMMERCE'],
      deviceLimit: 4,
      companyLimit: 2,
      installationId: inst.installationId,
      fingerprint: inst.fingerprint,
      nonce,
      typ: 'lease',
    });
    expect(lease!.leaseUntil - s.clock.t).toBe(7 * DAY);
    expect(evaluateLease(lease!, ctxOf(lease!, s.clock.t)).state).toBe('active');
    // Etkinleştirme kaydı pinlenmiş açık anahtarla oluştu
    const [act] = await s.handle.db.select().from(activations).where(eq(activations.installationId, inst.installationId));
    expect(act).toMatchObject({ publicKey: inst.publicKey, status: 'active', fingerprint: inst.fingerprint });
  });

  it('küçük harfli/boşluklu/karışan karakterli kod kabul edilir; hatalı biçim ve bilinmeyen kod reddedilir', async () => {
    const { code } = await issueLicense(s);
    const messy = code.toLowerCase().replaceAll('-', ' ');
    expect((await activate(s, makeInstallation(), messy)).res.statusCode).toBe(200);
    const bad = await activate(s, makeInstallation(), 'hatalı-kod-biçimi-123');
    expect(bad.res.statusCode).toBe(400);
    expect(bad.res.json().error.code).toBe('INVALID_CODE');
    const unknown = await activate(s, makeInstallation(), '0'.repeat(25));
    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.res.json().error.code).toBe('INVALID_CODE');
  });

  it('imza başka anahtarla atılmışsa ya da yük kurcalanmışsa reddedilir (kurulum sahipliği kanıtı)', async () => {
    const { code } = await issueLicense(s);
    const inst = makeInstallation();
    const other = makeInstallation();
    const { body } = activateRequest(inst, code, { ts: s.clock.t });
    // pub başka bir anahtar → imza doğrulanamaz
    const res = await s.app.inject({ method: 'POST', url: '/v1/activate', payload: { ...body, pub: other.publicKey } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_SIGNATURE');
    // pub yok
    const nopub = await s.app.inject({ method: 'POST', url: '/v1/activate', payload: { p: body.p, s: body.s } });
    expect(nopub.statusCode).toBe(400);
    expect(nopub.json().error.code).toBe('PUBKEY_REQUIRED');
    // yük değiştirilmiş (başka kod)
    const tampered = { ...body, p: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body.p, 'base64url').toString()), fingerprint: 'c'.repeat(64) })).toString('base64url') };
    expect((await s.app.inject({ method: 'POST', url: '/v1/activate', payload: tampered })).json().error.code).toBe('BAD_SIGNATURE');
  });

  it('saat farkı 10 dakikadan büyükse reddedilir ve satıcı saati bildirilir', async () => {
    const { code } = await issueLicense(s);
    const { res } = await activate(s, makeInstallation(), code, { ts: s.clock.t - 11 * 60_000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CLOCK_SKEW');
    expect(res.json().error.details.serverTime).toBe(s.clock.t);
    expect((await activate(s, makeInstallation(), code, { ts: s.clock.t + 9 * 60_000 })).res.statusCode).toBe(200);
  });

  it('süresi dolmuş, askıya alınmış ve iptal edilmiş lisans etkinleştirilemez', async () => {
    const expired = await issueLicense(s, { validUntil: new Date(s.clock.t + 1000) });
    s.clock.t += 2000;
    const r1 = await activate(s, makeInstallation(), expired.code);
    expect(r1.res.statusCode).toBe(403);
    expect(r1.res.json().error.code).toBe('LICENSE_EXPIRED');
    for (const [status, code] of [['suspended', 'LICENSE_SUSPENDED'], ['revoked', 'LICENSE_REVOKED']] as const) {
      const l = await issueLicense(s);
      await s.handle.db.update(licenses).set({ status }).where(eq(licenses.id, l.license.id));
      const r = await activate(s, makeInstallation(), l.code);
      expect(r.res.statusCode).toBe(403);
      expect(r.res.json().error.code).toBe(code);
    }
  });

  it('sunucu sınırı: ikinci kurulum reddedilir; aynı kurulum yeniden etkinleştirilebilir; başka açık anahtar reddedilir', async () => {
    const { code } = await issueLicense(s, { maxActivations: 1 });
    const a = makeInstallation();
    expect((await activate(s, a, code)).res.statusCode).toBe(200);
    expect((await activate(s, a, code)).res.statusCode).toBe(200); // idempotent
    const b = makeInstallation();
    const r = await activate(s, b, code);
    expect(r.res.statusCode).toBe(409);
    expect(r.res.json().error.code).toBe('ACTIVATION_LIMIT');
    // Aynı installationId, başka anahtarla (kimlik çalma denemesi)
    const hijack = { ...makeInstallation(), installationId: a.installationId };
    const h = await activate(s, hijack, code);
    expect(h.res.statusCode).toBe(409);
    expect(h.res.json().error.code).toBe('INSTALLATION_KEY_MISMATCH');
  });

  it('iki sunuculuk lisans iki kurulumu kabul eder, üçüncüyü reddeder', async () => {
    const { code } = await issueLicense(s, { maxActivations: 2 });
    expect((await activate(s, makeInstallation(), code)).res.statusCode).toBe(200);
    expect((await activate(s, makeInstallation(), code)).res.statusCode).toBe(200);
    expect((await activate(s, makeInstallation(), code)).res.statusCode).toBe(409);
  });

  it('parmak izi değişirse yeniden etkinleştirme güncellenir; sık değişim işaretlenir', async () => {
    const { code } = await issueLicense(s);
    const inst = makeInstallation();
    await activate(s, inst, code);
    for (let i = 0; i < 4; i++) {
      const { body } = activateRequest(inst, code, { ts: s.clock.t + i, fingerprint: String(i + 1).repeat(64) });
      expect((await s.app.inject({ method: 'POST', url: '/v1/activate', payload: body })).statusCode).toBe(200);
    }
    const [act] = await s.handle.db.select().from(activations).where(eq(activations.installationId, inst.installationId));
    expect(act!.fingerprintChanges).toBe(4);
    expect(act!.flagged).toBe(true);
  });

  it('başarısız denemeler IP başına engellenir (kod tahmini)', async () => {
    const rl = await makeServer({ rateLimit: true });
    for (let i = 0; i < 10; i++) expect((await activate(rl, makeInstallation(), '0'.repeat(25), { ip: '10.9.9.9' })).res.statusCode).toBe(404);
    const blocked = await activate(rl, makeInstallation(), '0'.repeat(25), { ip: '10.9.9.9' });
    expect(blocked.res.statusCode).toBe(429);
    // Başka IP etkilenmez
    expect((await activate(rl, makeInstallation(), '0'.repeat(25), { ip: '10.9.9.10' })).res.statusCode).toBe(404);
  });
});

describe('kalp atışı', () => {
  async function activated() {
    const l = await issueLicense(s);
    const inst = makeInstallation();
    await activate(s, inst, l.code);
    return { ...l, inst };
  }

  it('yeni kira verir, istemci sayılarını kaydeder ve kira süresini yeniler', async () => {
    const { inst, license } = await activated();
    s.clock.t += 3 * DAY;
    const { res, lease, nonce } = await heartbeat(s, inst, { devices: 2, companies: 1 });
    expect(res.statusCode).toBe(200);
    expect(lease).toMatchObject({ nonce, status: 'active', licenseId: license.id });
    expect(lease!.leaseUntil).toBe(s.clock.t + 7 * DAY);
    const [act] = await s.handle.db.select().from(activations).where(eq(activations.installationId, inst.installationId));
    expect(act).toMatchObject({ reportedDevices: 2, reportedCompanies: 1 });
  });

  it('yeniden oynatılan ya da eski zamanlı istek reddedilir (aynı zarf iki kez, eşzamanlı çift istek)', async () => {
    const { inst } = await activated();
    s.clock.t += 1000;
    const req = heartbeatRequest(inst, { ts: s.clock.t });
    const first = await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: req.body });
    expect(first.statusCode).toBe(200);
    const replay = await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: req.body });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('REPLAY');
    // Daha eski ts
    const older = await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: heartbeatRequest(inst, { ts: s.clock.t - 500 }).body });
    expect(older.statusCode).toBe(409);
    // Eşzamanlı iki istek, aynı ts: yalnızca biri kazanır
    s.clock.t += 1000;
    const same = heartbeatRequest(inst, { ts: s.clock.t }).body;
    const both = await Promise.all([s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: same }), s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: same })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('başka anahtarla imzalı, kurcalanmış ve bilinmeyen kuruluma ait istekler reddedilir', async () => {
    const { inst } = await activated();
    s.clock.t += 1000;
    const impostor = { ...makeInstallation(), installationId: inst.installationId, fingerprint: inst.fingerprint };
    const forged = await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: heartbeatRequest(impostor, { ts: s.clock.t }).body });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe('BAD_SIGNATURE');
    const unknown = await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: heartbeatRequest(makeInstallation(), { ts: s.clock.t }).body });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('UNKNOWN_INSTALLATION');
    const good = heartbeatRequest(inst, { ts: s.clock.t }).body;
    const tampered = { ...good, p: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(good.p, 'base64url').toString()), stats: { devices: 0, companies: 0 }, nonce: 'x'.repeat(20) })).toString('base64url') };
    expect((await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: tampered })).json().error.code).toBe('BAD_SIGNATURE');
  });

  it('iptal ve askı bildirimi imzalı döner (kurulum hemen salt-okunura geçer); geri açılınca normale döner', async () => {
    const { inst, license } = await activated();
    await s.handle.db.update(licenses).set({ status: 'suspended' }).where(eq(licenses.id, license.id));
    s.clock.t += 1000;
    const a = await heartbeat(s, inst);
    expect(a.lease).toMatchObject({ status: 'suspended' });
    expect(evaluateLease(a.lease!, ctxOf(a.lease!, s.clock.t))).toMatchObject({ state: 'restricted', reason: 'suspended' });
    await s.handle.db.update(licenses).set({ status: 'active' }).where(eq(licenses.id, license.id));
    s.clock.t += 1000;
    expect((await heartbeat(s, inst)).lease).toMatchObject({ status: 'active' });
    await s.handle.db.update(licenses).set({ status: 'revoked' }).where(eq(licenses.id, license.id));
    s.clock.t += 1000;
    const r = await heartbeat(s, inst);
    expect(evaluateLease(r.lease!, ctxOf(r.lease!, s.clock.t))).toMatchObject({ state: 'restricted', reason: 'revoked' });
  });

  it('abonelik bitince kira validUntil ile sınırlanır; uzatılınca yeni bitiş yansır, sektör/cihaz değişikliği bir sonraki kirada gelir', async () => {
    const { inst, license } = await activated();
    await s.handle.db.update(licenses).set({ validUntil: new Date(s.clock.t + 2 * DAY) }).where(eq(licenses.id, license.id));
    s.clock.t += 1000;
    const short = await heartbeat(s, inst);
    expect(short.lease!.leaseUntil).toBe(short.lease!.validUntil);
    await s.handle.db.update(licenses).set({ validUntil: new Date(s.clock.t + 400 * DAY), sectors: ['CONSTRUCTION'], deviceLimit: 9 }).where(eq(licenses.id, license.id));
    s.clock.t += 1000;
    const renewed = await heartbeat(s, inst);
    expect(renewed.lease).toMatchObject({ sectors: ['CONSTRUCTION'], deviceLimit: 9 });
    expect(renewed.lease!.leaseUntil - s.clock.t).toBe(7 * DAY);
  });

  it('parmak izi değiştiyse 409 FINGERPRINT_CHANGED (kopyalanmış kurulum)', async () => {
    const { inst } = await activated();
    s.clock.t += 1000;
    const res = await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: heartbeatRequest(inst, { ts: s.clock.t, fingerprint: 'd'.repeat(64) }).body });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('FINGERPRINT_CHANGED');
  });

  it('aynı kurulum kimliğinden 24 saatte 3+ farklı IP ile kalp atışı klon şüphesi olarak işaretlenir', async () => {
    const { inst } = await activated();
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      s.clock.t += 1000;
      expect((await heartbeat(s, inst, { ip })).res.statusCode).toBe(200);
    }
    const [act] = await s.handle.db.select().from(activations).where(eq(activations.installationId, inst.installationId));
    expect(act!.flagged).toBe(true);
    expect(act!.flagReason).toMatch(/farklı IP/);
  });
});

describe('devre dışı bırakma (sunucu taşıma)', () => {
  it('yuvayı boşaltır, taşıma sayacını artırır; devre dışı kurulum kalp atışı gönderemez; yeni sunucu etkinleştirilebilir', async () => {
    const { code, license } = await issueLicense(s, { maxActivations: 1 });
    const old = makeInstallation();
    await activate(s, old, code);
    expect((await activate(s, makeInstallation(), code)).res.statusCode).toBe(409);

    s.clock.t += 1000;
    const res = await s.app.inject({ method: 'POST', url: '/v1/deactivate', payload: deactivateRequest(old, s.clock.t) });
    expect(res.statusCode).toBe(200);
    const [lic] = await s.handle.db.select().from(licenses).where(eq(licenses.id, license.id));
    expect(lic!.transfersUsed).toBe(1);

    s.clock.t += 1000;
    const hb = await heartbeat(s, old);
    expect(hb.res.statusCode).toBe(403);
    expect(hb.res.json().error.code).toBe('DEACTIVATED');
    expect((await activate(s, makeInstallation(), code)).res.statusCode).toBe(200);
    // Tekrar devre dışı bırakma sayacı artırmaz
    s.clock.t += 1000;
    await s.app.inject({ method: 'POST', url: '/v1/deactivate', payload: deactivateRequest(old, s.clock.t) });
  });
});

describe('denetim kaydı', () => {
  it('etkinleştirme ve devre dışı bırakma denetim kaydına yazılır; kayıt değiştirilemez ve silinemez', async () => {
    const { code } = await issueLicense(s);
    await activate(s, makeInstallation(), code);
    const rows = await s.handle.db.select().from(auditLog);
    expect(rows.some((r) => r.action === 'activation.create')).toBe(true);
    // Kodlar/gizli değerler denetim kaydında bulunmaz
    expect(JSON.stringify(rows)).not.toContain(code);
    const { Client } = await import('pg');
    const c = new Client({ connectionString: process.env.TEST_LICENSE_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_license_test' });
    await c.connect();
    try {
      await expect(c.query('update audit_log set action = action')).rejects.toMatchObject({ code: 'LIC01' });
      await expect(c.query('delete from audit_log')).rejects.toMatchObject({ code: 'LIC01' });
      await expect(c.query('delete from activations')).rejects.toMatchObject({ code: 'LIC02' });
    } finally {
      await c.end();
    }
  });
});
