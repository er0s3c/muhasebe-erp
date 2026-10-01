import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPrivateKey, parseReleaseManifest, releaseFileName, signEnvelope } from '@erp/license-core';
import { CSRF_HEADER, CSRF_VALUE } from '../src/modules/admin-auth';
import { activate, adminClient, issueLicense, makeInstallation, makeServer, type Installation, type Server } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'erp-releases-'));
const s = await makeServer({ env: { RELEASES_DIR: dir } });
let admin = await adminClient(s);

function putChunk(id: string, name: string, body: Buffer, q: string) {
  return s.app.inject({
    method: 'PUT',
    url: `/admin/api/releases/${id}/files/${name}?${q}`,
    payload: body,
    headers: { 'content-type': 'application/octet-stream', [CSRF_HEADER]: CSRF_VALUE },
    cookies: { lic_admin: admin.cookie },
  });
}

function beat(server: Server, inst: Installation, o: { appVersion?: string; platform?: string } = {}) {
  server.clock.t += 1000;
  const env = signEnvelope(
    'heartbeat',
    { installationId: inst.installationId, fingerprint: inst.fingerprint, appVersion: o.appVersion ?? '1.0.0', nonce: `n${Math.random().toString(36).slice(2)}abcdefghijk`, ts: server.clock.t, stats: { devices: 1, companies: 1 }, ...(o.platform ? { platform: o.platform } : {}) },
    loadPrivateKey(inst.privateKeyPem),
  );
  return server.app.inject({ method: 'POST', url: '/v1/heartbeat', payload: env });
}

describe('uzaktan güncelleme: sürüm yayımı, gönderim, teklif ve indirme', () => {
  it('parçalı yükleme → yayımla → gönder → kalp atışında teklif → belirteçle indirme', async () => {
    const created = await admin.post('/admin/api/releases', { version: '1.1.0', notes: 'Hata düzeltmeleri' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().release.id as string;
    expect((await admin.post('/admin/api/releases', { version: '1.1.0' })).json().error.code).toBe('RELEASE_EXISTS');

    const name = releaseFileName('1.1.0', 'linux-x64');
    const data = Buffer.from('kit-icerigi-'.repeat(1000));
    const a = data.subarray(0, 5000);
    const b = data.subarray(5000);
    expect((await putChunk(id, 'yanlis.tar.gz', a, 'offset=0')).json().error.code).toBe('RELEASE_FILE_NAME');
    expect((await putChunk(id, name, a, 'offset=0')).json()).toEqual({ received: 5000, done: false });
    // Sıra bozuk parça: beklenen konum döner
    const bad = await putChunk(id, name, b, 'offset=10');
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.details.expectedOffset).toBe(5000);
    const done = await putChunk(id, name, b, `offset=5000&final=1&size=${data.length}`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().file).toEqual({ target: 'linux-x64', name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });

    // Yayımlamadan gönderilemez; yayımlayınca imzalı manifesto
    expect((await admin.post(`/admin/api/releases/${id}/send`, { all: true })).json().error.code).toBe('RELEASE_NOT_PUBLISHED');
    const pub = await admin.post(`/admin/api/releases/${id}/publish`, {});
    expect(pub.json().release.status).toBe('published');
    expect((await putChunk(id, name, a, 'offset=0')).json().error.code).toBe('RELEASE_NOT_DRAFT');

    // Lisans + etkin kurulum
    const lic = await issueLicense(s);
    const inst = makeInstallation();
    expect((await activate(s, inst, lic.code)).res.statusCode).toBe(200);
    // Gönderilmeden teklif yok
    const before = await beat(s, inst, { platform: 'linux-x64' });
    expect(before.json().update).toBeUndefined();

    const sent = await admin.post(`/admin/api/releases/${id}/send`, { licenseIds: [lic.license.id] });
    expect(sent.json().sent).toBe(1);
    const targets = (await admin.get('/admin/api/update-targets')).json().licenses as { id: string; updateVersion: string; installations: { platform: string }[] }[];
    expect(targets.find((t) => t.id === lic.license.id)).toMatchObject({ updateVersion: '1.1.0', installations: [{ platform: 'linux-x64' }] });

    const hb = await beat(s, inst, { platform: 'linux-x64' });
    expect(hb.statusCode, hb.body).toBe(200);
    const offer = hb.json().update as { manifest: string; downloadToken: string };
    const manifest = parseReleaseManifest(offer.manifest, s.ring);
    expect(manifest).toMatchObject({ version: '1.1.0', notes: 'Hata düzeltmeleri', files: [{ name, size: data.length }] });

    const dl = await s.app.inject({ method: 'GET', url: `/v1/releases/1.1.0/${name}?t=${encodeURIComponent(offer.downloadToken)}` });
    expect(dl.statusCode).toBe(200);
    expect(createHash('sha256').update(dl.rawPayload).digest('hex')).toBe(manifest.files[0]!.sha256);
    // Bozuk ya da başka sürüme ait belirteç
    expect((await s.app.inject({ method: 'GET', url: `/v1/releases/1.1.0/${name}?t=${offer.downloadToken.slice(0, -3)}abc` })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'GET', url: `/v1/releases/1.2.0/${releaseFileName('1.2.0', 'linux-x64')}?t=${encodeURIComponent(offer.downloadToken)}` })).statusCode).toBe(403);
    // Süresi dolan belirteç
    s.clock.t += 25 * 60 * 60 * 1000;
    expect((await s.app.inject({ method: 'GET', url: `/v1/releases/1.1.0/${name}?t=${encodeURIComponent(offer.downloadToken)}` })).statusCode).toBe(403);
    admin = await adminClient(s); // saat ilerledi: yönetici oturumu da doldu

    // Platformu için dosya olmayan (Windows) ya da zaten bu sürümdeki kuruluma teklif yok
    expect((await beat(s, inst, { platform: 'win-x64' })).json().update).toBeUndefined();
    expect((await beat(s, inst, { platform: 'linux-x64', appVersion: '1.1.0' })).json().update).toBeUndefined();
    expect((await beat(s, inst, { platform: 'linux-x64', appVersion: '1.2.0' })).json().update).toBeUndefined();

    // Geri çekilen sürüm: hedef temizlenir, teklif kesilir; içerik değişmez, silinemez
    expect((await admin.post(`/admin/api/releases/${id}/withdraw`, {})).json().release.status).toBe('withdrawn');
    expect((await beat(s, inst, { platform: 'linux-x64' })).json().update).toBeUndefined();
    expect((await admin.del(`/admin/api/releases/${id}`)).json().error.code).toBe('RELEASE_NOT_DRAFT');
    const audit = (await admin.get('/admin/api/audit')).json();
    expect(JSON.stringify(audit)).toContain('release.send');
  });

  it('taslak sürüm ve dosyası silinebilir; boş sürüm yayımlanamaz', async () => {
    const created = await admin.post('/admin/api/releases', { version: '2.0.0-rc.1' });
    const id = created.json().release.id as string;
    expect((await admin.post(`/admin/api/releases/${id}/publish`, {})).json().error.code).toBe('RELEASE_NO_FILES');
    expect((await admin.del(`/admin/api/releases/${id}`)).json()).toEqual({ ok: true });
  });
});
