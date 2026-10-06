import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll } from 'vitest';
import {
  base32Decode,
  encodeRequestCode,
  generateKeyPair,
  generateTotpSecret,
  hotp,
  loadPrivateKey,
  parseLeaseToken,
  signEnvelope,
  totpCounter,
  type Lease,
  type PublicKeyring,
} from '@erp/license-core';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { encryptSecret } from '../src/crypto';
import { createDb, type DbHandle } from '../src/db/client';
import { admins } from '../src/db/schema';
import { ephemeralSigner } from '../src/signer';
import { createCustomer, createLicense, type CreateLicenseInput } from '../src/modules/licenses';
import { CSRF_HEADER, CSRF_VALUE } from '../src/modules/admin-auth';

export const DATA_KEY = 'test-data-key-test-data-key-test-data-key';
export const DAY = 86_400_000;

export interface Server {
  app: FastifyInstance;
  handle: DbHandle;
  ring: PublicKeyring;
  config: Config;
  /** Değiştirilebilir satıcı saati. */
  clock: { t: number };
  routes: { method: string | string[]; url: string; handler?: unknown }[];
}

export async function makeServer(opts: { rateLimit?: boolean; env?: Record<string, string> } = {}): Promise<Server> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    LICENSE_DATA_KEY: DATA_KEY,
    RATE_LIMIT_ENABLED: opts.rateLimit ? 'true' : 'false',
    ...opts.env,
  });
  const handle = createDb(config.DATABASE_URL);
  const signer = ephemeralSigner('k-test');
  const clock = { t: Date.now() };
  const routes: Server['routes'] = [];
  const app = await buildApp({ db: handle.db, config, signer, logger: false, now: () => clock.t, onRoute: (r) => routes.push({ method: r.method, url: r.url, handler: r.handler }) });
  await app.ready();
  afterAll(async () => {
    await app.close();
    await handle.close();
  });
  return { app, handle, ring: { keys: { 'k-test': signer.publicKey } }, config, clock, routes };
}

export interface Installation {
  installationId: string;
  fingerprint: string;
  publicKey: string;
  privateKeyPem: string;
}

export function makeInstallation(): Installation {
  const pair = generateKeyPair();
  return { installationId: randomUUID(), fingerprint: randomBytes(32).toString('hex'), publicKey: pair.publicKey, privateKeyPem: pair.privateKeyPem };
}

const nonce = () => randomBytes(16).toString('base64url');

export function activateRequest(inst: Installation, code: string, o: { ts: number; nonce?: string; fingerprint?: string }) {
  const n = o.nonce ?? nonce();
  const env = signEnvelope('activate', { installationId: inst.installationId, fingerprint: o.fingerprint ?? inst.fingerprint, appVersion: '1.0.0-test', code, nonce: n, ts: o.ts }, loadPrivateKey(inst.privateKeyPem));
  return { body: { ...env, pub: inst.publicKey }, nonce: n };
}

export function heartbeatRequest(inst: Installation, o: { ts: number; nonce?: string; devices?: number; companies?: number; fingerprint?: string }) {
  const n = o.nonce ?? nonce();
  const env = signEnvelope(
    'heartbeat',
    { installationId: inst.installationId, fingerprint: o.fingerprint ?? inst.fingerprint, appVersion: '1.0.0-test', nonce: n, ts: o.ts, stats: { devices: o.devices ?? 0, companies: o.companies ?? 0 } },
    loadPrivateKey(inst.privateKeyPem),
  );
  return { body: env, nonce: n };
}

export function deactivateRequest(inst: Installation, ts: number) {
  return signEnvelope('deactivate', { installationId: inst.installationId, nonce: nonce(), ts }, loadPrivateKey(inst.privateKeyPem));
}

export function offlineRequestCode(inst: Installation, ts: number, requestId = nonce()) {
  return { code: encodeRequestCode({ installationId: inst.installationId, fingerprint: inst.fingerprint, appVersion: '1.0.0-test', requestId, ts }, inst.privateKeyPem), requestId };
}

/** Bir müşteri ve lisans oluşturur; etkinleştirme kodunu döndürür. */
export async function issueLicense(s: Server, over: Partial<Omit<CreateLicenseInput, 'customerId'>> = {}, customerName = `Müşteri ${randomUUID().slice(0, 8)}`) {
  return s.handle.db.transaction(async (tx) => {
    const customer = await createCustomer(tx, { name: customerName }, { actor: 'cli' });
    return {
      customer,
      ...(await createLicense(
        tx,
        {
        customerId: customer.id,
        validityMode: 'lease',
          kind: 'commercial',
          sectors: ['RETAIL_MARKET'],
          deviceLimit: 3,
          companyLimit: 1,
          validUntil: new Date(s.clock.t + 365 * DAY),
          leaseDays: 7,
          graceDays: 14,
          deviceIdleDays: 30,
          maxActivations: 1,
          offlineAllowed: false,
          ...over,
        },
        { actor: 'cli' },
      )),
    };
  });
}

export async function activate(s: Server, inst: Installation, code: string, o: { ip?: string; ts?: number } = {}) {
  const { body, nonce: n } = activateRequest(inst, code, { ts: o.ts ?? s.clock.t });
  const res = await s.app.inject({ method: 'POST', url: '/v1/activate', payload: body, remoteAddress: o.ip });
  return { res, nonce: n, lease: res.statusCode === 200 ? (parseLeaseToken(res.json().lease, s.ring) as Lease) : undefined };
}

export async function heartbeat(s: Server, inst: Installation, o: { ts?: number; ip?: string; devices?: number; companies?: number } = {}) {
  const { body, nonce: n } = heartbeatRequest(inst, { ts: o.ts ?? s.clock.t, devices: o.devices, companies: o.companies });
  const res = await s.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: body, remoteAddress: o.ip });
  return { res, nonce: n, lease: res.statusCode === 200 ? (parseLeaseToken(res.json().lease, s.ring) as Lease) : undefined };
}

// ---- Yönetici oturumu ----------------------------------------------------------------------------------------
export interface AdminLogin {
  email: string;
  password: string;
  secret: string;
}

export async function createAdmin(s: Server, over: { password?: string } = {}): Promise<AdminLogin> {
  const email = `yonetici-${randomUUID().slice(0, 8)}@ornek.com`;
  const password = over.password ?? `Gizli-${randomBytes(9).toString('base64url')}`;
  const secret = generateTotpSecret();
  await s.handle.db.insert(admins).values({ email, fullName: 'Test Yönetici', passwordHash: await hash(password), totpSecretEnc: encryptSecret(secret, DATA_KEY) });
  return { email, password, secret };
}

export const totpNow = (secret: string, at: number, step = 0) => hotp(base32Decode(secret), totpCounter(at) + step);

export async function loginAdmin(s: Server, a: AdminLogin, o: { totp?: string; password?: string; ip?: string } = {}) {
  return s.app.inject({
    method: 'POST',
    url: '/admin/api/login',
    payload: { email: a.email, password: o.password ?? a.password, totp: o.totp ?? totpNow(a.secret, s.clock.t) },
    remoteAddress: o.ip,
  });
}

export async function adminClient(s: Server) {
  const a = await createAdmin(s);
  const res = await loginAdmin(s, a);
  if (res.statusCode !== 200) throw new Error(`yönetici girişi başarısız: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'lic_admin')!.value;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE') => (url: string, payload?: unknown) =>
    s.app.inject({ method, url, payload: payload as object | undefined, cookies: { lic_admin: cookie }, headers: method === 'GET' ? {} : { [CSRF_HEADER]: CSRF_VALUE } });
  return { admin: a, cookie, get: call('GET'), post: call('POST'), patch: call('PATCH'), del: call('DELETE') };
}
