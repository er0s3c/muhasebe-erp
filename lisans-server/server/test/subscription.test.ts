import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadPrivateKey, parseLeaseToken, signEnvelope, verifyToken } from '@erp/license-core';
import { issueLicense, makeInstallation, makeServer } from './helpers';

describe('subscription protocol', () => {
  it('anchors to signed server time and refuses reused challenges; legacy leases remain short', async () => {
    const s = await makeServer();
    try {
      const inst = makeInstallation(); const { code, license } = await issueLicense(s, { validityMode: 'subscription', graceDays: 7 });
      const nonce = randomBytes(16).toString('base64url');
      const response = await s.app.inject({ method: 'POST', url: '/v2/time', payload: { installationId: inst.installationId, nonce } });
      expect(response.statusCode).toBe(200);
      const proof = verifyToken('server-time', response.json().token, s.ring) as { serverTime: number };
      const body = { installationId: inst.installationId, fingerprint: inst.fingerprint, appVersion: '1.0.0', code, nonce: randomBytes(16).toString('base64url'), ts: proof.serverTime, protocolVersion: 2 as const, timeNonce: nonce };
      const signed = { ...signEnvelope('activate', body, loadPrivateKey(inst.privateKeyPem)), pub: inst.publicKey };
      const activated = await s.app.inject({ method: 'POST', url: '/v1/activate', payload: signed });
      expect(activated.statusCode).toBe(200);
      const lease = parseLeaseToken(activated.json().lease, s.ring);
      expect(lease.v).toBe(2); expect(lease.leaseUntil).toBe(license.validUntil.getTime()); expect(lease.graceDays).toBe(7);
      const replay = await s.app.inject({ method: 'POST', url: '/v1/activate', payload: signed }); expect(replay.statusCode).toBe(409);
    } finally { await s.app.close(); await s.handle.close(); }
  });
});
