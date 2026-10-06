import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMember, client, createCompany, makeApp, registerUser } from './helpers';
let app: FastifyInstance;
beforeAll(async () => {
  app = (
    await makeApp({
      configOverrides: {
        CONSTRUCTION_STORAGE_DIR: await mkdtemp(join(tmpdir(), 'erp-construction-')),
      },
    })
  ).app;
});
describe('Çizim ve saha kontrol merkezi', () => {
  it('konum, dosya, revizyon, işaret ve fotoğraf uçtan uca; yetki ve şirket izolasyonu', async () => {
    const owner = await registerUser(app, 'Drawings');
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);
    const project = (
      await c.post('/api/projects', { code: 'DRAW', name: 'Çizim projesi', kind: 'own' })
    ).json().project;
    const other = (
      await c.post('/api/projects', { code: 'OTHER', name: 'Diğer proje', kind: 'own' })
    ).json().project;
    const b = await c.post('/api/construction/locations', {
      projectId: project.id,
      kind: 'building',
      name: 'A blok',
    });
    expect(b.statusCode, b.body).toBe(201);
    expect(
      (
        await c.post('/api/construction/locations', {
          projectId: project.id,
          kind: 'zone',
          name: 'Mutfak',
          parentId: b.json().item.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await c.post('/api/construction/locations', {
          projectId: other.id,
          kind: 'level',
          name: 'Kat 1',
          parentId: b.json().item.id,
        })
      ).statusCode,
    ).toBe(404);
    const f = (
      await c.post('/api/construction/locations', {
        projectId: project.id,
        kind: 'level',
        name: 'Kat 1',
        parentId: b.json().item.id,
      })
    ).json().item;
    const zone = (
      await c.post('/api/construction/locations', {
        projectId: project.id,
        kind: 'zone',
        name: 'Mutfak',
        parentId: f.id,
      })
    ).json().item;
    const pdf = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');
    expect(
      (
        await c.post('/api/construction/assets', {
          projectId: project.id,
          filename: 'fake.pdf',
          mime: 'application/pdf',
          base64: Buffer.from('not pdf').toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
    const file = await c.post('/api/construction/assets', {
      projectId: project.id,
      filename: 'plan.pdf',
      mime: 'application/pdf',
      base64: pdf,
    });
    expect(file.statusCode, file.body).toBe(201);
    expect(
      (await c.get(`/api/construction/assets/${file.json().item.id}/download`)).body,
    ).toContain('%PDF-');
    const input = {
      projectId: project.id,
      assetId: file.json().item.id,
      code: 'A-01',
      title: 'Kat planı',
      discipline: 'architecture',
      revision: '01',
    };
    const created = await c.post('/api/construction/drawings', input);
    expect(created.statusCode, created.body).toBe(201);
    const d = created.json().item;
    const manager = await addMember(app, c, company.id, 'site_manager');
    const mc = client(app, manager.token, company.id);
    expect(
      (
        await mc.post(`/api/construction/drawings/${d.id}/decision`, {
          version: 1,
          status: 'approved',
          note: 'Kontrol edildi',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await c.post(`/api/construction/drawings/${d.id}/decision`, {
          version: 1,
          status: 'approved',
          note: 'Kontrol edildi',
        })
      ).statusCode,
    ).toBe(200);
    const op = (
      await c.post('/api/workspace/operations', {
        kind: 'rfi',
        projectId: project.id,
        title: 'Donatı sorusu',
        eventDate: '2026-01-01',
        dueDate: '2026-01-02',
        payload: { discipline: 'civil', question: 'Detay nasıl uygulanacak?' },
      })
    ).json().item;
    const pin = {
      drawingId: d.id,
      page: 1,
      x: 0.4,
      y: 0.3,
      recordKind: 'rfi',
      recordId: op.id,
      locationId: zone.id,
      label: 'Donatı sorusu',
      clientId: randomUUID(),
    };
    const added = await c.post('/api/construction/pins', pin);
    expect(added.statusCode, added.body).toBe(201);
    expect((await c.post('/api/construction/pins', pin)).json().item.id).toBe(added.json().item.id);
    expect((await c.post('/api/construction/pins', { ...pin, x: 0.6 })).statusCode).toBe(409);
    expect(
      (await c.get(`/api/construction/record-links?kind=rfi&id=${op.id}`)).json().items[0]
        .drawingId,
    ).toBe(d.id);
    expect((await c.get(`/api/construction/drawings/${d.id}/pins`)).json().items).toHaveLength(1);
    const next = (
      await c.post('/api/construction/drawings', { ...input, revision: '02', previousId: d.id })
    ).json().item;
    expect(
      (
        await c.post(`/api/construction/drawings/${next.id}/decision`, {
          version: 1,
          status: 'approved',
          note: 'Yeni detay onayı',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await c.post('/api/construction/pins', { ...pin, clientId: randomUUID() })).statusCode,
    ).toBe(400);
    expect(
      (await c.get(`/api/construction/drawings?projectId=${project.id}`))
        .json()
        .items.find((x: { id: string }) => x.id === d.id).status,
    ).toBe('obsolete');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    const image = (
      await c.post('/api/construction/assets', {
        projectId: project.id,
        filename: 'saha.png',
        mime: 'image/png',
        base64: png,
      })
    ).json().item;
    expect(
      (
        await c.post('/api/construction/photos', {
          projectId: project.id,
          locationId: zone.id,
          assetId: image.id,
          date: '2026-10-06',
          caption: 'Donatı öncesi',
          operationId: op.id,
        })
      ).statusCode,
    ).toBe(201);
    const cockpit = await c.get(`/api/construction/cockpit?projectId=${project.id}`);
    expect(cockpit.statusCode, cockpit.body).toBe(200);
    expect(cockpit.json().counts).toMatchObject({ drawings: 1, photos: 1, overdue: 1 });
    expect(cockpit.json().risks[0].reason).toContain('Teknik');
    expect(
      (await c.post('/api/construction/snapshots', { projectId: project.id })).statusCode,
    ).toBe(200);
    const stranger = await registerUser(app, 'Stranger');
    const sc = await createCompany(app, stranger.token);
    const foreign = client(app, stranger.token, sc.id);
    expect((await foreign.get(`/api/construction/assets/${image.id}/download`)).statusCode).toBe(
      404,
    );
    expect(
      (await foreign.get(`/api/construction/drawings?projectId=${project.id}`)).statusCode,
    ).toBe(404);
    const viewer = await addMember(app, c, company.id, 'viewer');
    expect(
      (
        await client(app, viewer.token, company.id).post('/api/construction/locations', {
          projectId: project.id,
          kind: 'building',
          name: 'B blok',
        })
      ).statusCode,
    ).toBe(403);
  });
});
