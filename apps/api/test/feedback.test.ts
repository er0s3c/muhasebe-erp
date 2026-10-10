import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PublicKeyring } from '@erp/license-core';
import type { DbHandle as VendorDbHandle } from '../../../lisans-server/server/src/db/client';
import { feedback as vendorFeedback, licenses as vendorLicenses } from '../../../lisans-server/server/src/db/schema';
import { resetSchema, runMigrations } from '../../../lisans-server/server/src/db/migrate';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { LicenseService } from '../src/licensing/service';
import { httpTransport } from '../src/licensing/transport';
import { addMember, client, createCompany, registerUser, type Session } from './helpers';

interface VendorTestServer {
  app: FastifyInstance; handle: VendorDbHandle; ring: PublicKeyring; clock: { t: number };
}
// Keep each project's Fastify declaration merging in its own TypeScript program.
// The runtime integration still uses the real vendor app and its database helpers.
const vendorHelpersPath = new URL('../../../lisans-server/server/test/helpers.ts', import.meta.url).href;
const { adminClient, issueLicense, makeServer } = await import(vendorHelpersPath) as {
  makeServer(opts: { env: Record<string, string> }): Promise<VendorTestServer>;
  issueLicense(server: VendorTestServer, input: { sectors: string[]; deviceLimit: number; companyLimit: number }, name: string): Promise<{ code: string; license: { id: string } }>;
  adminClient(server: VendorTestServer): Promise<{ cookie: string; get(url: string): Promise<LightMyRequestResponse>; patch(url: string, input: unknown): Promise<LightMyRequestResponse> }>;
};

const VENDOR_APP = process.env.TEST_LICENSE_DATABASE_URL ?? 'postgres://erp_app:erp_app@localhost:5432/erp_license_test';
const VENDOR_OWNER = process.env.TEST_LICENSE_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_license_test';
const vendor = await makeServer({ env: { DATABASE_URL: VENDOR_APP } });
const config = loadConfig();
const handle = createDb(config.DATABASE_URL);
let failNetwork = false;
const transport = httpTransport('http://vendor.test', { fetchImpl: async (input, init) => {
  if (failNetwork) throw new TypeError('test connection unavailable');
  const res = await vendor.app.inject({ method: 'POST', url: new URL(String(input)).pathname, payload: JSON.parse(String(init?.body)) });
  return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
} });
const service = new LicenseService({ db: handle.db, keyring: vendor.ring, enforced: true, transport, appVersion: '2.3.4-test', fingerprint: async () => ({ fingerprint: 'b'.repeat(64), strength: 'strong' }), now: () => vendor.clock.t });
const app = await buildApp({ db: handle.db, config, logger: false, license: { service } });
await app.ready();
let owner: Session, company: { id: string; name: string }, licenseId: string;
const report = () => ({ requestId: randomUUID(), pagePath: '/manufacturing/execution', pageTitle: 'Atölye iş ekranı', message: 'İşe başlama düğmesine basınca beklenmedik bir hata gördüm.', steps: 'Üretim emrini seçtim ve başlat düğmesine bastım.', expected: 'İşin başlamasını bekliyordum.' });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

beforeAll(async () => {
  await resetSchema(VENDOR_OWNER);
  await runMigrations(VENDOR_OWNER);
  const issued = await issueLicense(vendor, { sectors: ['CONSTRUCTION'], deviceLimit: 10000, companyLimit: 10000 }, 'Gerçek Satıcı Müşterisi');
  licenseId = issued.license.id;
  await service.activate(issued.code);
  owner = await registerUser(app, 'GeriBildirim');
  company = await createCompany(app, owner.token, { name: 'Müşteri Şirketi' });
});
afterAll(async () => { await app.close(); await handle.close(); });

describe('gerçek imzalı satıcı geri bildirim akışı', () => {
  it('kurulum bağlantısını doğrular; kullanıcı/şirket/sürümü sunucudan alıp merkezi yönetici kutusuna gönderir', async () => {
    const api = client(app, owner.token, company.id);
    expect((await api.get('/api/feedback/availability')).json()).toEqual({ available: true });
    const input = report();
    const sent = await api.post(`/api/companies/${company.id}/feedback`, input);
    expect(sent.statusCode, sent.body).toBe(201);
    const receipt = sent.json().feedback;
    expect(receipt.reference).toMatch(/^GB-[A-F0-9]{12}$/);
    const admin = await adminClient(vendor);
    const result = (await admin.get(`/admin/api/feedback/${receipt.id}`)).json().feedback;
    expect(result).toMatchObject({ customerName: 'Gerçek Satıcı Müşterisi', companyName: company.name, reporterName: 'GeriBildirim Kullanıcı', reporterEmail: owner.email, appVersion: '2.3.4-test', ...input, status: 'new', screenshot: null });
    expect(result).not.toHaveProperty('nonce');
    expect(result).not.toHaveProperty('contentHash');
    const duplicate = await api.post(`/api/companies/${company.id}/feedback`, input);
    expect(duplicate.statusCode, duplicate.body).toBe(201);
    expect(duplicate.json().feedback.id).toBe(receipt.id);
    const changed = await api.post(`/api/companies/${company.id}/feedback`, { ...input, message: 'Farklı bir hata' });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('FEEDBACK_REQUEST_CONFLICT');
  });

  it('salt okunur üyeler gönderebilir; üyelik, kimlik ve kullanıcıdan gönderilen sahte bilgiler korunur', async () => {
    const ownerApi = client(app, owner.token, company.id);
    const viewer = await addMember(app, ownerApi, company.id, 'viewer', 'GeriBildirimIzleyici');
    const url = `/api/companies/${company.id}/feedback`;
    const response = await viewer.client.post(url, report());
    expect(response.statusCode, response.body).toBe(201);
    const spoof = await ownerApi.post(url, { ...report(), reporter: { email: 'sahte@example.com' } });
    expect(spoof.statusCode).toBe(400);
    const outsider = await registerUser(app, 'Outsider');
    expect((await client(app, outsider.token, company.id).post(url, report())).statusCode).toBe(403);
    expect((await ownerApi.post(`/api/companies/${randomUUID()}/feedback`, report())).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload: report() })).statusCode).toBe(401);
  });

  it('yalnız görüntü veya açıklama kabul eder; boş mesaj, yanlış içerik, query/url ve 5 MB aşımı reddedilir', async () => {
    const api = client(app, owner.token, company.id), url = `/api/companies/${company.id}/feedback`;
    const image = { name: 'hata.png', mime: 'image/png', base64: PNG };
    const sent = await api.post(url, { ...report(), message: '', screenshot: image });
    expect(sent.statusCode, sent.body).toBe(201);
    const admin = await adminClient(vendor);
    const shot = await admin.get(`/admin/api/feedback/${sent.json().feedback.id}/screenshot`);
    expect(shot.statusCode, shot.body).toBe(200);
    expect(shot.headers['content-type']).toContain('image/png');
    expect(shot.rawPayload).toEqual(Buffer.from(PNG, 'base64'));
    expect((await api.post(url, { ...report(), message: '   ' })).statusCode).toBe(400);
    expect((await api.post(url, { ...report(), screenshot: { ...image, base64: Buffer.from('<svg/>').toString('base64') } })).statusCode).toBe(400);
    expect((await api.post(url, { ...report(), pagePath: 'https://example.com' })).statusCode).toBe(400);
    expect((await api.post(url, { ...report(), pagePath: '/?secret=1' })).statusCode).toBe(400);
    const oversize = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    expect((await api.post(url, { ...report(), screenshot: { ...image, base64: oversize } })).statusCode).toBe(400);
  });

  it('destek satıcı hatasında başarısızlık verir; lisans hatası veya başarı durumu üretmez, yeniden denemede gönderilir', async () => {
    const api = client(app, owner.token, company.id), url = `/api/companies/${company.id}/feedback`, input = report();
    const before = await service.current();
    failNetwork = true;
    try {
      const response = await api.post(url, input);
      expect(response.statusCode, response.body).toBe(502);
      expect(response.json().error.code).toBe('FEEDBACK_UNREACHABLE');
    } finally { failNetwork = false; }
    expect((await service.current()).lastError).toEqual(before.lastError);
    expect((await api.post(url, input)).statusCode).toBe(201);
  });

  it('lisans salt okunur olsa da destek gönderilebilir; normal iş yazma kapısı kapalı kalır', async () => {
    const api = client(app, owner.token, company.id);
    await vendor.handle.db.update(vendorLicenses).set({ status: 'suspended' }).where(eq(vendorLicenses.id, licenseId));
    vendor.clock.t += 1000;
    await service.heartbeat();
    expect((await service.current()).state).toBe('restricted');
    expect((await api.post(`/api/companies/${company.id}/feedback`, report())).statusCode).toBe(201);
    expect((await client(app, owner.token).post('/api/companies', { name: 'Kapalı', sector: 'CONSTRUCTION', jurisdiction: 'KKTC' })).statusCode).toBe(402);
    await vendor.handle.db.update(vendorLicenses).set({ status: 'active' }).where(eq(vendorLicenses.id, licenseId));
    vendor.clock.t += 1000;
    await service.heartbeat();
  });

  it('merkezi kutu arama, filtre, durum ve özel notu yöneticiye gösterir; ekran görüntüleri kimliksiz okunamaz', async () => {
    const api = client(app, owner.token, company.id), sent = await api.post(`/api/companies/${company.id}/feedback`, report());
    expect(sent.statusCode, sent.body).toBe(201);
    const id = sent.json().feedback.id, admin = await adminClient(vendor);
    const updated = await admin.patch(`/admin/api/feedback/${id}`, { status: 'in_review', internalNote: 'Düzeltme hazırlanıyor.' });
    expect(updated.statusCode, updated.body).toBe(200);
    const inbox = (await admin.get(`/admin/api/feedback?status=in_review&q=${encodeURIComponent(company.name)}&limit=1`)).json();
    expect(inbox.feedback).toHaveLength(1);
    expect(inbox.feedback[0]).toMatchObject({ id, status: 'in_review', companyName: company.name });
    expect(inbox.counts.in_review).toBeGreaterThan(0);
    const detail = (await admin.get(`/admin/api/feedback/${id}`)).json().feedback;
    expect(detail.internalNote).toBe('Düzeltme hazırlanıyor.');
    expect((await vendor.app.inject({ method: 'GET', url: '/admin/api/feedback' })).statusCode).toBe(401);
    expect((await vendor.app.inject({ method: 'GET', url: `/admin/api/feedback/${id}/screenshot` })).statusCode).toBe(401);
    expect((await vendor.app.inject({ method: 'PATCH', url: `/admin/api/feedback/${id}`, cookies: { lic_admin: admin.cookie }, payload: { status: 'resolved' } })).statusCode).toBe(403);
    const [stored] = await vendor.handle.db.select({ count: vendorFeedback.id }).from(vendorFeedback).where(eq(vendorFeedback.id, id));
    expect(stored?.count).toBe(id);
  });
});
