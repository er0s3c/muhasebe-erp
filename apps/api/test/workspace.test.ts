import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addMember, client, createCompany, makeApp, registerUser } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = (await makeApp()).app;
});
describe('Çalışma alanı', () => {
  it('teknik, kalite ve güvenlik kayıtları çözüm olmadan kapanmaz; kapsam ve arşiv yetkileri korunur', async () => {
    const user = await registerUser(app, 'Control');
    const company = await createCompany(app, user.token);
    const c = client(app, user.token, company.id);
    const project = (
      await c.post('/api/projects', { code: 'CTR', name: 'Kontrol projesi', kind: 'own' })
    ).json().project;
    const base = {
      title: 'Kontrol takip kaydı',
      projectId: project.id,
      eventDate: '2026-10-05',
      dueDate: '2026-10-05',
    };
    const cases = [
      {
        kind: 'rfi',
        payload: { discipline: 'civil', question: 'Donatı detayı nedir?' },
        finish: { response: 'Çizim A-03 uygulanacak.' },
      },
      {
        kind: 'site_instruction',
        payload: { location: 'A blok', instruction: 'Drenaj hattını tamamlayın.' },
        finish: { completionNote: 'Hat tamamlandı.' },
      },
      {
        kind: 'quality_check',
        payload: {
          location: 'A blok',
          checkType: 'concrete',
          result: 'fail',
          findings: 'Yüzeyde boşluk',
        },
        finish: { resolution: 'Tamir kontrol edildi.' },
      },
      {
        kind: 'safety',
        payload: {
          location: 'A blok',
          severity: 'critical',
          eventType: 'inspection',
          observation: 'Korkuluk eksik',
          correctiveAction: 'Korkuluk takılacak',
        },
        finish: { resolution: 'Korkuluk takıldı ve kontrol edildi.' },
      },
    ];
    let rfiId = '';
    for (const test of cases) {
      const body = { ...base, kind: test.kind, payload: test.payload };
      const created = await c.post('/api/workspace/operations', body);
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().item.id;
      if (test.kind === 'rfi') rfiId = id;
      expect(
        (await c.put(`/api/workspace/operations/${id}`, { ...body, version: 1, status: 'done' }))
          .statusCode,
      ).toBe(400);
      const done = await c.put(`/api/workspace/operations/${id}`, {
        ...body,
        payload: { ...test.payload, ...test.finish },
        version: 1,
        status: 'done',
      });
      expect(done.statusCode, done.body).toBe(200);
      expect(
        (
          await c.put(`/api/workspace/operations/${id}`, {
            ...body,
            payload: { ...test.payload, ...test.finish },
            version: 1,
            status: 'done',
          })
        ).statusCode,
      ).toBe(409);
    }
    const summary = await c.get(`/api/workspace/construction-summary?projectId=${project.id}`);
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().items.find((r: { kind: string }) => r.kind === 'rfi')).toMatchObject({
      total: 1,
      done: 1,
      open: 0,
    });
    expect(
      (await c.get('/api/workspace/operations?kind=rfi&status=open')).json().items,
    ).toHaveLength(0);
    expect(
      (await c.get('/api/workspace/operations?kind=rfi&q=bulunmayacak')).json().items,
    ).toHaveLength(0);
    const upload = {
      record: { kind: 'rfi', id: rfiId },
      filename: 'teknik.pdf',
      mime: 'application/pdf',
      base64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'),
    };
    expect((await c.post('/api/workspace/documents', upload)).statusCode).toBe(201);
    const archive = await c.get('/api/workspace/documents?latest=true&q=teknik');
    expect(archive.statusCode, archive.body).toBe(200);
    expect(archive.json().items[0]).toMatchObject({ recordKind: 'rfi', isLatest: true });
    const task = await c.post('/api/workspace/tasks', {
      title: 'Teknik takip',
      dueDate: '2000-01-01',
      record: { kind: 'rfi', id: rfiId },
    });
    expect(task.statusCode, task.body).toBe(201);
    const edited = await c.patch(`/api/workspace/tasks/${task.json().item.id}`, {
      version: 1,
      title: 'Teknik yanıt kontrolü',
      record: null,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().item).toMatchObject({
      title: 'Teknik yanıt kontrolü',
      recordKind: null,
      recordId: null,
    });
    const filtered = await c.get('/api/workspace/tasks?q=yanıt&due=overdue');
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().counts.overdue).toBe(1);
    const viewer = await addMember(app, c, company.id, 'viewer');
    expect(
      (await viewer.client.post('/api/workspace/operations', { ...base, ...cases[0] })).statusCode,
    ).toBe(403);
    const denied = await c.put(`/api/company/members/${viewer.userId}/module-access`, {
      levels: { 'construction.projects': 'none' },
    });
    expect(denied.statusCode, denied.body).toBe(200);
    expect(
      (await viewer.client.get('/api/workspace/documents?q=teknik')).json().items,
    ).toHaveLength(0);
    expect(
      (await viewer.client.get('/api/workspace/construction-summary'))
        .json()
        .items.some((r: { kind: string }) => r.kind === 'rfi'),
    ).toBe(false);
    const other = await createCompany(app, user.token);
    const foreign = client(app, user.token, other.id);
    expect((await foreign.get('/api/workspace/documents')).json().items).toHaveLength(0);
    expect(
      (await foreign.get(`/api/workspace/construction-summary?projectId=${project.id}`)).statusCode,
    ).toBe(404);
  });
  it('ekipman proje kontrolü ve çözüm açıklamalı kusur teslim tutanağı', async () => {
    const user = await registerUser(app, 'Handover');
    const company = await createCompany(app, user.token);
    const c = client(app, user.token, company.id);
    const project = (
      await c.post('/api/projects', { code: 'TES', name: 'Teslim projesi', kind: 'own' })
    ).json().project;
    const other = (
      await c.post('/api/projects', { code: 'DIG', name: 'Diğer proje', kind: 'own' })
    ).json().project;
    const base = { projectId: project.id, eventDate: '2026-10-05', dueDate: '2026-10-06' };
    const equipment = await c.post('/api/workspace/operations', {
      ...base,
      kind: 'equipment',
      title: 'Saha aracı',
      payload: { code: 'AR-1', category: 'vehicle' },
    });
    expect(equipment.statusCode, equipment.body).toBe(201);
    const log = {
      ...base,
      kind: 'equipment_log',
      title: 'Yakıt kaydı',
      payload: {
        equipmentId: equipment.json().item.id,
        hours: 8,
        fuelLiters: '20',
        cost: '1000',
        currency: 'TRY',
        expenseType: 'fuel',
      },
    };
    expect((await c.post('/api/workspace/operations', log)).statusCode).toBe(201);
    expect(
      (await c.post('/api/workspace/operations', { ...log, projectId: other.id })).statusCode,
    ).toBe(400);
    const unit = await c.post('/api/real-estate/units', { projectId: project.id, unitNo: 'A-1' });
    expect(unit.statusCode, unit.body).toBe(201);
    const body = {
      ...base,
      kind: 'defect',
      title: 'Kapı ayarı',
      payload: { unitId: unit.json().unit.id, location: 'Giriş' },
    };
    expect(
      (await c.post('/api/workspace/operations', { ...body, projectId: other.id })).statusCode,
    ).toBe(404);
    const defect = await c.post('/api/workspace/operations', body);
    expect(defect.statusCode, defect.body).toBe(201);
    const path = `/api/workspace/operations/${defect.json().item.id}`;
    expect((await c.put(path, { ...body, version: 1, status: 'done' })).statusCode).toBe(400);
    const done = await c.put(path, {
      ...body,
      version: 1,
      status: 'done',
      payload: { ...body.payload, resolution: 'Menteşe ayarlandı.' },
    });
    expect(done.statusCode, done.body).toBe(200);
    const handover = await c.get(`/api/workspace/handover/${unit.json().unit.id}`);
    expect(handover.statusCode, handover.body).toBe(200);
    expect(handover.json().defects).toHaveLength(1);
    expect(handover.json().defects[0]).toMatchObject({
      status: 'done',
      resolution: 'Menteşe ayarlandı.',
    });
    const foreign = await createCompany(app, user.token);
    expect(
      (
        await client(app, user.token, foreign.id).get(
          `/api/workspace/handover/${unit.json().unit.id}`,
        )
      ).statusCode,
    ).toBe(404);
  });
  it('saha tekrar gönderimi, proje izolasyonu ve program bağımlılıkları', async () => {
    const user = await registerUser(app, 'Ops');
    const company = await createCompany(app, user.token);
    const c = client(app, user.token, company.id);
    const project = (
      await c.post('/api/projects', { code: 'OPS', name: 'Saha projesi', kind: 'own' })
    ).json().project;
    const body = {
      id: randomUUID(),
      kind: 'site_report',
      title: 'Günlük imalat',
      projectId: project.id,
      eventDate: '2026-10-05',
      dueDate: '2026-10-06',
      payload: { workers: 4, workDone: 'Beton döküldü' },
    };
    const created = await c.post('/api/workspace/operations', body);
    expect(created.statusCode, created.body).toBe(201);
    const replay = await c.post('/api/workspace/operations', body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(
      (await c.post('/api/workspace/operations', { ...body, title: 'Farklı imalat' })).statusCode,
    ).toBe(409);
    const aBody = {
      kind: 'schedule',
      title: 'Kalıp işleri',
      projectId: project.id,
      eventDate: '2026-10-05',
      dueDate: '2026-10-06',
      payload: { start: '2026-10-05', end: '2026-10-06', progress: 0, dependencies: [] },
    };
    const a = await c.post('/api/workspace/operations', aBody);
    expect(a.statusCode, a.body).toBe(201);
    const b = await c.post('/api/workspace/operations', {
      ...aBody,
      title: 'Beton işleri',
      payload: { ...aBody.payload, dependencies: [a.json().item.id] },
    });
    expect(b.statusCode, b.body).toBe(201);
    const cycle = await c.put(`/api/workspace/operations/${a.json().item.id}`, {
      ...aBody,
      version: 1,
      status: 'open',
      payload: { ...aBody.payload, dependencies: [b.json().item.id] },
    });
    expect(cycle.statusCode, cycle.body).toBe(400);
    const completed = await c.put(`/api/workspace/operations/${a.json().item.id}`, {
      ...aBody,
      version: 1,
      status: 'done',
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().item.payload.progress).toBe(100);
    const foreignCompany = await createCompany(app, user.token);
    expect(
      (
        await client(app, user.token, foreignCompany.id).get(
          `/api/workspace/schedule/${project.id}`,
        )
      ).statusCode,
    ).toBe(404);
    const site = await addMember(app, c, company.id, 'site_manager');
    expect(
      (
        await site.client.post('/api/workspace/operations', {
          kind: 'collection',
          title: 'İzinsiz takip',
          partyId: randomUUID(),
          eventDate: '2026-10-05',
          dueDate: '2026-10-05',
          payload: { promiseAmount: '10', currency: 'TRY', promiseDate: '2026-10-05' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await c.get('/api/workspace/alerts')).statusCode).toBe(200);
    expect((await c.get('/api/workspace/setup')).statusCode).toBe(200);
    const scenario = await c.post('/api/workspace/cash-scenarios/preview', {
      name: 'Gecikme',
      delayDays: 30,
      outflowIncreasePct: 15,
      weeks: 13,
    });
    expect(scenario.statusCode, scenario.body).toBe(200);
  });
  it('portal sadece seçilen cariyi gösterir; yanlış parola, belge ve iptal engellenir', async () => {
    const user = await registerUser(app, 'Portal');
    const company = await createCompany(app, user.token);
    const c = client(app, user.token, company.id);
    const party = await c.post('/api/parties', {
      code: 'P001',
      name: 'Portal müşterisi',
      kind: 'customer',
    });
    expect(party.statusCode, party.body).toBe(201);
    const partyId = party.json().party.id;
    const other = await c.post('/api/parties', {
      code: 'P002',
      name: 'Gizli diğer müşteri',
      kind: 'customer',
    });
    expect(other.statusCode, other.body).toBe(201);
    const password = 'Portal-Password-12345';
    const created = await c.post('/api/workspace/portal-links', {
      partyId,
      label: 'Müşteri portalı',
      password,
      days: 7,
    });
    expect(created.statusCode, created.body).toBe(201);
    const credentials = { token: created.json().token, password };
    const view = () =>
      app.inject({ method: 'POST', url: '/api/portal/view', payload: credentials });
    const viewed = await view();
    expect(viewed.statusCode, viewed.body).toBe(200);
    expect(viewed.json().party.name).toBe('Portal müşterisi');
    expect(viewed.body).not.toContain('Gizli diğer müşteri');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/portal/view',
          payload: { ...credentials, password: 'wrong-password-123' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/portal/view',
          payload: { ...credentials, documentId: randomUUID() },
        })
      ).statusCode,
    ).toBe(404);
    const revoke = await c.post(`/api/workspace/portal-links/${created.json().id}/revoke`);
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await view()).statusCode).toBe(401);
  });
  it('görev izolasyonu, atama ve eşzamanlı düzenleme koruması', async () => {
    const user = await registerUser(app, 'Work');
    const company = await createCompany(app, user.token);
    const c = client(app, user.token, company.id);
    const other = await createCompany(app, user.token);
    const sales = await addMember(app, c, company.id, 'sales');
    const created = await c.post('/api/workspace/tasks', {
      title: 'Dekont kontrolü',
      dueDate: '2026-10-10',
    });
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json().item;
    expect((await sales.client.get('/api/workspace/tasks')).json().items).toHaveLength(0);
    expect(
      (
        await client(app, user.token, other.id).patch(`/api/workspace/tasks/${task.id}`, {
          status: 'done',
          version: 1,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await c.patch(`/api/workspace/tasks/${task.id}`, { status: 'done', version: 1 })).statusCode,
    ).toBe(200);
    expect(
      (await c.patch(`/api/workspace/tasks/${task.id}`, { status: 'open', version: 1 })).statusCode,
    ).toBe(409);
    expect(
      (
        await sales.client.post('/api/workspace/tasks', {
          title: 'Atama',
          dueDate: '2026-10-10',
          ownerId: user.userId,
        })
      ).statusCode,
    ).toBe(403);
    const assigned = await c.post('/api/workspace/tasks', {
      title: 'Satış takibi',
      dueDate: '2026-10-10',
      ownerId: sales.userId,
    });
    expect(assigned.statusCode, assigned.body).toBe(201);
    expect((await sales.client.get('/api/workspace/tasks')).json().items).toHaveLength(1);
  });
  it('belge sürümleri ve bağlı kayıt erişimi; yabancı şirket engeli', async () => {
    const user = await registerUser(app, 'Doc');
    const company = await createCompany(app, user.token);
    const c = client(app, user.token, company.id);
    const project = await c.post('/api/projects', {
      code: 'DOC',
      name: 'Belge projesi',
      kind: 'own',
    });
    expect(project.statusCode, project.body).toBe(201);
    const id = project.json().project.id;
    const body = {
      record: { kind: 'project', id },
      filename: 'sozlesme.pdf',
      mime: 'application/pdf',
      base64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'),
    };
    const uploaded = await c.post('/api/workspace/documents', body);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const documentId = uploaded.json().id;
    const version = await c.post('/api/workspace/documents', { ...body, previousId: documentId });
    expect(version.statusCode, version.body).toBe(201);
    expect(
      (await c.post('/api/workspace/documents', { ...body, previousId: documentId })).statusCode,
    ).toBe(409);
    expect((await c.get(`/api/workspace/documents/${documentId}/download`)).statusCode).toBe(200);
    const sales = await addMember(app, c, company.id, 'sales');
    expect(
      (await sales.client.get(`/api/workspace/documents/${documentId}/download`)).statusCode,
    ).toBe(403);
    expect((await sales.client.get('/api/workspace/search?q=DOC')).json().items).toHaveLength(0);
    const other = await createCompany(app, user.token);
    const oc = client(app, user.token, other.id);
    expect((await oc.get(`/api/workspace/documents/${documentId}/download`)).statusCode).toBe(404);
    expect((await oc.post('/api/workspace/documents', body)).statusCode).toBe(404);
    expect(
      (
        await c.post('/api/workspace/documents', {
          ...body,
          base64: Buffer.from('not a PDF').toString('base64'),
        })
      ).statusCode,
    ).toBe(400);
  });
});
