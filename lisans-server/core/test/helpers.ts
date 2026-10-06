import { randomUUID } from 'node:crypto';
import { DAY_MS, generateKeyPair, loadPrivateKey, signToken, type Lease, type PublicKeyring, type Signer, type TokenKind } from '../src';

export function makeVendor(kid = 'k-test') {
  const pair = generateKeyPair();
  const signer: Signer = { kid, privateKey: loadPrivateKey(pair.privateKeyPem) };
  const ring: PublicKeyring = { keys: { [kid]: pair.publicKey } };
  return { signer, ring, pair };
}

export const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
export const INSTALLATION = randomUUID();
export const FINGERPRINT = 'a'.repeat(64);

export function makeLease(over: Partial<Lease> = {}): Lease {
  return {
    v: 1,
    typ: 'lease',
    licenseId: randomUUID(),
    customer: 'Örnek Market Ltd.',
    kind: 'commercial',
    status: 'active',
    sectors: ['RETAIL_MARKET'],
    deviceLimit: 3,
    companyLimit: 1,
    deviceIdleDays: 30,
    validUntil: NOW + 365 * DAY_MS,
    leaseUntil: NOW + 7 * DAY_MS,
    graceDays: 14,
    issuedAt: NOW,
    serverTime: NOW,
    installationId: INSTALLATION,
    fingerprint: FINGERPRINT,
    nonce: 'n'.repeat(24),
    ...over,
  };
}

export const tokenOf = (lease: Lease, signer: Signer, kind: TokenKind = lease.typ) => signToken(kind, lease, signer);
