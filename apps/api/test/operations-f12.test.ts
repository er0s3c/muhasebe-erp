import { describe, expect, it } from 'vitest';
import { addMember, client, createCompany, makeApp, registerUser, thisYear } from './helpers';

/** F12 işletim: arka plan raporu (20), teknik iz başlıkları (113), kurulum sahibine kapalı istatistik ve ön kontrol (114, 119). */
describe('büyük veri ve sürüm işletimi (F12)', async () => {
  const { app } = await makeApp();
  const owner = await registerUser(app, 'Isletim');
  const company = await createCompany(app, owner.token);
  const c = client(app, owner.token, company.id);

  it('arka plan raporu kuyruğa alınır, hazırlanır, yalnız isteyen indirir', async () => {
    const queued = await c.post('/api/report-jobs', { reportKey: 'trial-balance', format: 'xlsx', query: { from: `${thisYear}-01-01`, to: `${thisYear}-12-31` } });
    expect(queued.statusCode, queued.body).toBe(202);
    const id = queued.json().job.id as string;
    let job = queued.json().job;
    for (let i = 0; i < 60 && ['queued', 'running'].includes(job.status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await c.get(`/api/report-jobs/${id}`)).json().job;
    }
    expect(job).toMatchObject({ status: 'completed', progress: 100, format: 'xlsx' });
    expect(job.fileName).toMatch(/\.xlsx$/);
    const file = await c.get(`/api/report-jobs/${id}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    expect(file.rawPayload.length).toBeGreaterThan(100);
    expect((await c.post(`/api/report-jobs/${id}/cancel`, {})).json().error.code).toBe('REPORT_JOB_NOT_ACTIVE');
    // Başka kullanıcı işi göremez ve indiremez
    const other = await addMember(app, c, company.id, 'admin', 'BaskaKullanici');
    expect((await other.client.get(`/api/report-jobs/${id}`)).statusCode).toBe(404);
    expect((await other.client.get(`/api/report-jobs/${id}/download`)).statusCode).toBe(404);
    expect((await other.client.get('/api/report-jobs')).json().jobs).toEqual([]);
    // Bilinmeyen rapor ve izin dışı rapor
    expect((await c.post('/api/report-jobs', { reportKey: 'yok', query: {} })).json().error.code).toBe('REPORT_NOT_FOUND');
    const viewer = await addMember(app, c, company.id, 'operator', 'Operator');
    expect((await viewer.client.post('/api/report-jobs', { reportKey: 'trial-balance', query: { from: `${thisYear}-01-01`, to: `${thisYear}-12-31` } })).statusCode).toBe(403);
  });

  it('gelen iz korunur, yanıtta sunucu süresi döner', async () => {
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
    const r = await app.inject({ method: 'GET', url: '/api/accounts', headers: { authorization: `Bearer ${owner.token}`, 'x-company-id': company.id, traceparent: `00-${trace}-00f067aa0ba902b7-01` } });
    expect(r.headers.traceparent).toMatch(new RegExp(`^00-${trace}-[0-9a-f]{16}-01$`));
    expect(String(r.headers['server-timing'])).toMatch(/^app;dur=\d+(\.\d)?$/);
    const fresh = await c.get('/api/accounts');
    expect(fresh.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(fresh.headers.traceparent).not.toContain(trace);
  });

  it('veritabanı istatistikleri, yavaş istekler ve güncelleme ön kontrolü yalnız kurulum sahibine açıktır', async () => {
    const u = client(app, owner.token);
    for (const path of ['/api/system/db-stats', '/api/system/slow-requests', '/api/system/update/00000000-0000-4000-8000-000000000000/preflight']) {
      const r = await u.get(path);
      expect(r.statusCode, path).toBe(403);
      expect(r.json().error.code).toBe('OWNER_ONLY');
    }
  });
});
