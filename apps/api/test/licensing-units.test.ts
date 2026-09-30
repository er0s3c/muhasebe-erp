import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeFingerprint, generateKeyPair, signEnvelope, loadPrivateKey } from '@erp/license-core';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { createLicenseService, resolveEnforced, resolveKeyring } from '../src/licensing';
import { readClusterId, readMachineId, serverFingerprint } from '../src/licensing/fingerprint';
import { keyringUsable, parseKeyring } from '../src/licensing/keyring';
import { LicenseServerError, LicenseUnreachableError, httpTransport } from '../src/licensing/transport';

const baseEnv = {
  DATABASE_URL: 'postgres://erp_app:erp_app@localhost:5432/erp_test',
  JWT_SECRET: 'Zx9kQ2mVb7LpR4nTc8Yw3HaEd6JfUg5Ns1Xo0AiBq',
};

describe('lisans yapılandırması ve derleme zamanı zorlaması', () => {
  it('üretim kipinde LICENSE_ENFORCEMENT_DEV yok sayılır; yalnızca derleme sabiti denetimi açar', () => {
    const prod = loadConfig({ ...baseEnv, NODE_ENV: 'production', LICENSE_ENFORCEMENT_DEV: 'true', COOKIE_SECURE: 'true' });
    // derleme sabiti (BUILD_ENFORCED) testte tanımsız: üretim kipi ortam değişkeniyle açılıp kapatılamaz
    expect(resolveEnforced(prod)).toBe(false);
    const dev = loadConfig({ ...baseEnv, NODE_ENV: 'development', LICENSE_ENFORCEMENT_DEV: 'true' });
    expect(resolveEnforced(dev)).toBe(true);
    expect(resolveEnforced(loadConfig({ ...baseEnv, NODE_ENV: 'development' }))).toBe(false);
    expect(resolveEnforced(loadConfig({ ...baseEnv, NODE_ENV: 'test' }), true)).toBe(true);
  });

  it('üretimde geliştirme açık anahtar halkası ve düz http lisans sunucusu adresi reddedilir', () => {
    const prod = { ...baseEnv, NODE_ENV: 'production', COOKIE_SECURE: 'true' };
    expect(() => loadConfig({ ...prod, LICENSE_DEV_KEYRING: '{}' })).toThrow(/LICENSE_DEV_KEYRING/);
    expect(() => loadConfig({ ...prod, LICENSE_SERVER_URL: 'http://lisans.ornek.com' })).toThrow(/https/);
    expect(loadConfig({ ...prod, LICENSE_SERVER_URL: 'https://lisans.ornek.com' }).LICENSE_SERVER_URL).toBe('https://lisans.ornek.com');
    expect(loadConfig({ ...prod, LICENSE_SERVER_URL: 'http://lisans.ornek.com', LICENSE_ALLOW_INSECURE_URL: 'true' }).LICENSE_SERVER_URL).toBeTruthy();
    // geliştirmede düz http serbest
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'development', LICENSE_SERVER_URL: 'http://localhost:4000' }).LICENSE_SERVER_URL).toBeTruthy();
  });

  it('açık anahtar halkası: geçersiz JSON/anahtar/kimlik hata verir, boş ya da tümü iptal edilmiş halka kullanılamaz', () => {
    const k = generateKeyPair().publicKey;
    expect(keyringUsable(parseKeyring(JSON.stringify({ keys: { a1: k } })))).toBe(true);
    expect(keyringUsable(parseKeyring(JSON.stringify({ keys: { a1: k }, revoked: ['a1'] })))).toBe(false);
    expect(keyringUsable(parseKeyring(JSON.stringify({ keys: {} })))).toBe(false);
    expect(() => parseKeyring('{bozuk')).toThrow(/JSON/);
    expect(() => parseKeyring(JSON.stringify({ keys: { a1: 'kisa' } }))).toThrow();
    expect(() => parseKeyring(JSON.stringify({ keys: { 'kötü kimlik': k } }))).toThrow();
    expect(() => parseKeyring(JSON.stringify({ keys: { a1: 'B'.repeat(43) } }))).toThrow(); // 43 karakter ama kanonik base64url değil
  });

  it('denetim açıkken güvenilir anahtar yoksa hizmet kurulamaz; dev halkası yalnızca üretim dışında okunur', () => {
    const cfg = loadConfig({ ...baseEnv, NODE_ENV: 'test' });
    const db = {} as never;
    expect(() => createLicenseService({ db, config: cfg, setup: { enforced: true } })).toThrow(/açık anahtar/);
    const k = generateKeyPair().publicKey;
    const withKeys = loadConfig({ ...baseEnv, NODE_ENV: 'test', LICENSE_DEV_KEYRING: JSON.stringify({ keys: { dev1: k } }) });
    expect(Object.keys(resolveKeyring(withKeys).keys)).toEqual(['dev1']);
    expect(createLicenseService({ db, config: withKeys, setup: { enforced: true } }).enforced).toBe(true);
  });
});

describe('sunucu parmak izi', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-fp-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('ana makine kimliği dosyası (32 hex) okunur; geçersiz içerik kullanılmaz', () => {
    const good = join(dir, 'machine-id');
    writeFileSync(good, `${'AB'.repeat(16)}\n`);
    expect(readMachineId(good)).toBe('ab'.repeat(16));
    const bad = join(dir, 'bad-id');
    writeFileSync(bad, 'bu bir makine kimliği değil');
    expect(readMachineId(bad)).not.toBe('bu bir makine kimliği değil');
  });

  it('veritabanı küme kimliği ile birleşir: kararlı, 64 hex, ana makine kimliği değişince değişir', async () => {
    const handle = createDb(baseEnv.DATABASE_URL, { max: 1 });
    try {
      const clusterId = await readClusterId(handle.db);
      expect(clusterId).toMatch(/^\d{10,}$/);
      const a = await serverFingerprint(handle.db);
      const b = await serverFingerprint(handle.db);
      expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(a).toEqual(b);
      const file = join(dir, 'other-id');
      writeFileSync(file, 'c'.repeat(32));
      const c = await serverFingerprint(handle.db, file);
      expect(c.strength).toBe('strong');
      expect(c.fingerprint).toBe(computeFingerprint('c'.repeat(32), clusterId));
      expect(c.fingerprint).not.toBe(computeFingerprint('d'.repeat(32), clusterId));
    } finally {
      await handle.close();
    }
  });
});

describe('HTTPS taşıması', () => {
  const servers: http.Server[] = [];
  afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const env = signEnvelope('heartbeat', { a: 1 }, loadPrivateKey(generateKeyPair().privateKeyPem));

  it('başarılı yanıt: kira döner, gövde JSON olarak gönderilir', async () => {
    let seen = '';
    const url = await serve((req, res) => {
      req.on('data', (c) => (seen += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ lease: 'erp1.x.y.z' }));
      });
    });
    const t = httpTransport(url);
    expect(await t.heartbeat(env)).toEqual({ lease: 'erp1.x.y.z' });
    expect(JSON.parse(seen)).toEqual(env);
    expect(await httpTransport(url).deactivate(env)).toEqual({ ok: true });
  });

  it('4xx satıcı hatası LicenseServerError (kod ve mesajla); 5xx ulaşılamaz sayılır', async () => {
    const url = await serve((req, res) => {
      const bad = req.url === '/v1/activate';
      res.statusCode = bad ? 404 : 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'INVALID_CODE', message: 'Etkinleştirme kodu geçersiz' } }));
    });
    const t = httpTransport(url);
    await expect(t.activate({ ...env, pub: 'x'.repeat(43) })).rejects.toMatchObject({ status: 404, code: 'INVALID_CODE', message: 'Etkinleştirme kodu geçersiz' });
    await expect(t.activate({ ...env, pub: 'x'.repeat(43) })).rejects.toBeInstanceOf(LicenseServerError);
    await expect(t.heartbeat(env)).rejects.toBeInstanceOf(LicenseUnreachableError);
  });

  it('bağlantı reddi, zaman aşımı, JSON olmayan/çok büyük yanıt ve yönlendirme ulaşılamaz sayılır', async () => {
    const hang = await serve(() => {
      /* yanıt verme */
    });
    await expect(httpTransport(hang, { timeoutMs: 150 }).heartbeat(env)).rejects.toBeInstanceOf(LicenseUnreachableError);

    const html = await serve((_req, res) => res.end('<html>merhaba</html>'));
    await expect(httpTransport(html).heartbeat(env)).rejects.toBeInstanceOf(LicenseUnreachableError);

    const huge = await serve((_req, res) => res.end(JSON.stringify({ lease: 'x'.repeat(200_000) })));
    await expect(httpTransport(huge).heartbeat(env)).rejects.toBeInstanceOf(LicenseUnreachableError);

    const redirect = await serve((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/');
      res.end();
    });
    await expect(httpTransport(redirect).heartbeat(env)).rejects.toBeInstanceOf(LicenseUnreachableError);

    const noLease = await serve((_req, res) => res.end(JSON.stringify({ ok: true })));
    await expect(httpTransport(noLease).heartbeat(env)).rejects.toBeInstanceOf(LicenseUnreachableError);

    const closed = await serve((_req, res) => res.end('{}'));
    const dead = closed.replace(/:\d+$/, ':1'); // dinleyen yok
    await expect(httpTransport(dead).heartbeat(env)).rejects.toBeInstanceOf(LicenseUnreachableError);
  });
});
