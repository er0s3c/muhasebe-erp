import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadPrivateKey, signEnvelope, verifyToken, type FeedbackRequest } from '@erp/license-core';
import { activate, issueLicense, makeInstallation, makeServer } from './helpers';

const s = await makeServer();
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const request = (installation: ReturnType<typeof makeInstallation>): FeedbackRequest => ({
  installationId: installation.installationId, fingerprint: installation.fingerprint,
  nonce: randomBytes(16).toString('base64url'), ts: s.clock.t, appVersion: 'feedback-test',
  reporter: { id: randomUUID(), name: 'Müşteri Kullanıcısı', email: 'musteri@example.com' },
  company: { id: randomUUID(), name: 'Gerçek Şirket', sector: 'RETAIL_MARKET' },
  feedback: { requestId: randomUUID(), pagePath: '/pos', pageTitle: 'Kasa', message: 'Ürünü ekleyemedim.', steps: '', expected: '' },
});
const send = (input: FeedbackRequest, installation: ReturnType<typeof makeInstallation>) => s.app.inject({ method: 'POST', url: '/v1/feedback', payload: signEnvelope('feedback', input, loadPrivateKey(installation.privateKeyPem)) });

describe('kurulum imzalı müşteri desteği güvenliği', () => {
  it('pinlenmiş anahtar, etkin kurulum ve parmak izi gerekir; payload değiştirilemez', async () => {
    const issued = await issueLicense(s), installation = makeInstallation();
    expect((await activate(s, installation, issued.code)).res.statusCode).toBe(200);
    const input = request(installation);
    const other = makeInstallation();
    const forged = await send(input, other);
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe('BAD_SIGNATURE');
    const wrongFingerprint = await send({ ...input, fingerprint: 'c'.repeat(64) }, installation);
    expect(wrongFingerprint.json().error.code).toBe('FINGERPRINT_CHANGED');
    const unknown = await send(request(other), other);
    expect(unknown.json().error.code).toBe('UNKNOWN_INSTALLATION');
    const env = signEnvelope('feedback', input, loadPrivateKey(installation.privateKeyPem));
    const changed = { ...env, p: Buffer.from(JSON.stringify({ ...input, feedback: { ...input.feedback, message: 'Kurcalandı' } })).toString('base64url') };
    expect((await s.app.inject({ method: 'POST', url: '/v1/feedback', payload: changed })).json().error.code).toBe('BAD_SIGNATURE');
    const deactivated = signEnvelope('deactivate', { installationId: installation.installationId, nonce: randomBytes(16).toString('base64url'), ts: s.clock.t }, loadPrivateKey(installation.privateKeyPem));
    expect((await s.app.inject({ method: 'POST', url: '/v1/deactivate', payload: deactivated })).statusCode).toBe(200);
    expect((await send(input, installation)).json().error.code).toBe('DEACTIVATED');
  });

  it('eski saat/yeniden kullanılan nonce reddedilir; aynı rapor eşzamanlı yeniden gönderilirse tek kayıt oluşur', async () => {
    const issued = await issueLicense(s), installation = makeInstallation();
    await activate(s, installation, issued.code);
    const input = request(installation);
    const stale = await send({ ...input, ts: s.clock.t - 11 * 60_000 }, installation);
    expect(stale.json().error.code).toBe('CLOCK_SKEW');
    const [first, retry] = await Promise.all([send(input, installation), send(input, installation)]);
    expect(first.statusCode, first.body).toBe(201);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(first.json().feedback.id).toBe(retry.json().feedback.id);
    const nonceReplay = await send({ ...input, feedback: { ...input.feedback, requestId: randomUUID() } }, installation);
    expect(nonceReplay.json().error.code).toBe('REPLAY');
  });

  it('rastgele bir v2 zaman kanıtı kabul edilmez; sunucunun bu kuruluma verdiği kanıt bir kez kullanılır', async () => {
    const issued = await issueLicense(s), installation = makeInstallation();
    await activate(s, installation, issued.code);
    const input = request(installation);
    const invalid = await send({ ...input, protocolVersion: 2, timeNonce: randomBytes(16).toString('base64url') }, installation);
    expect(invalid.json().error.code).toBe('TIME_PROOF_REQUIRED');
    const timeNonce = randomBytes(16).toString('base64url');
    const time = await s.app.inject({ method: 'POST', url: '/v2/time', payload: { installationId: installation.installationId, nonce: timeNonce } });
    const proof = verifyToken('server-time', time.json().token, s.ring) as { serverTime: number };
    const proven = { ...input, protocolVersion: 2 as const, timeNonce, ts: proof.serverTime };
    expect((await send(proven, installation)).statusCode).toBe(201);
    expect((await send(proven, installation)).json().error.code).toBe('TIME_PROOF_REQUIRED');
  });

  it('doğrudan imzalı istemci bile hatalı görsel veya boş bildirim kaydedemez', async () => {
    const issued = await issueLicense(s), installation = makeInstallation();
    await activate(s, installation, issued.code);
    const input = request(installation);
    const blank = await send({ ...input, feedback: { ...input.feedback, message: '', steps: 'Yalnız adımlar' } }, installation);
    expect(blank.statusCode).toBe(400);
    const invalid = await send({ ...input, feedback: { ...input.feedback, screenshot: { name: 'hata.png', mime: 'image/png', base64: Buffer.from('<html>fake</html>').toString('base64') } } }, installation);
    expect(invalid.json().error.code).toBe('INVALID_SCREENSHOT');
    const valid = await send({ ...input, feedback: { ...input.feedback, message: '', screenshot: { name: 'hata.png', mime: 'image/png', base64: PNG } } }, installation);
    expect(valid.statusCode, valid.body).toBe(201);
  });
});
