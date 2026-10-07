import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encodeRequestCode, loadPrivateKey, parseLeaseToken, signEnvelope } from '@erp/license-core';
import { SECTORS } from '@erp/shared';
import { activate, adminClient, issueLicense, makeInstallation, makeServer } from './helpers';

const server = await makeServer();
const nonce = () => randomBytes(16).toString('base64url');

describe('leather license issuance and client compatibility', () => {
  it.each(['LEATHER_FASHION','MANUFACTURING_WHOLESALE'] as const)('issues %s; missing capability cannot activate, a capable signed request can', async sector => {
    const issued = await issueLicense(server, { sectors: [sector] });
    const inst = makeInstallation();
    const old = await activate(server, inst, issued.code);
    expect(old.res.statusCode).toBe(409);
    expect(old.res.json().error.code).toBe('CLIENT_UPDATE_REQUIRED');
    const body = signEnvelope('activate', { installationId: inst.installationId, fingerprint: inst.fingerprint, appVersion: 'leather', supportedSectors: [...SECTORS], code: issued.code, nonce: nonce(), ts: server.clock.t }, loadPrivateKey(inst.privateKeyPem));
    const result = await server.app.inject({ method: 'POST', url: '/v1/activate', payload: { ...body, pub: inst.publicKey } });
    expect(result.statusCode, result.body).toBe(200);
    expect(parseLeaseToken(result.json().lease, server.ring).sectors).toEqual([sector]);
    const heartbeatBody = { installationId: inst.installationId, fingerprint: inst.fingerprint, appVersion: 'leather', nonce: nonce(), ts: server.clock.t + 1, stats: { devices: 0, companies: 0 } };
    const heartbeat = (data: object) => server.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: signEnvelope('heartbeat', data, loadPrivateKey(inst.privateKeyPem)) });
    expect((await heartbeat(heartbeatBody)).json().error.code).toBe('CLIENT_UPDATE_REQUIRED');
    const renewed = await heartbeat({ ...heartbeatBody, supportedSectors: [...SECTORS] });
    expect(renewed.statusCode, renewed.body).toBe(200); // rejected request did not consume the timestamp
  });
  it.each(['LEATHER_FASHION','MANUFACTURING_WHOLESALE'] as const)('offline issuance for %s applies the same signed capability gate', async sector => {
    const issued = await issueLicense(server, { sectors: [sector], offlineAllowed: true });
    const admin = await adminClient(server);
    const inst = makeInstallation();
    const payload = { installationId: inst.installationId, fingerprint: inst.fingerprint, appVersion: 'leather', requestId: nonce(), ts: server.clock.t };
    const send = (data: object) => admin.post(`/admin/api/licenses/${issued.license.id}/offline-lease`, { requestCode: encodeRequestCode(data, inst.privateKeyPem), days: 30 });
    const old = await send(payload);
    expect(old.statusCode, old.body).toBe(409);
    expect(old.json().error.code).toBe('CLIENT_UPDATE_REQUIRED');
    const supported = await send({ ...payload, supportedSectors: [...SECTORS] });
    expect(supported.statusCode, supported.body).toBe(200);
    expect(parseLeaseToken(supported.json().lease, server.ring).sectors).toEqual([sector]);
  });
  it('existing sector licenses still accept older clients', async () => {
    const issued = await issueLicense(server, { sectors: ['CONSTRUCTION', 'COMMERCE', 'RETAIL_MARKET'] });
    expect((await activate(server, makeInstallation(), issued.code)).res.statusCode).toBe(200);
  });
});
