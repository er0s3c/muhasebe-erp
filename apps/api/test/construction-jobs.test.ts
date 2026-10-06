import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { processConstructionJobs, ocrSuggestions } from '../src/modules/construction-control/jobs';
import { makeApp, registerUser, createCompany, client } from './helpers';
const python = resolve('../../.runtime/construction/Scripts/python.exe'),
  lang = resolve('data/construction-runtime/tessdata');
describe('IFC/OCR kalıcı işlem kuyruğu', () => {
  it('öneriler kesin veri sayılmaz; sayı ve tarih kaynağı korunur', () => {
    expect(
      ocrSuggestions('Fatura No: TEST2026000001\n06.10.2026\nTRY\nGrand Total: 999.99'),
    ).toMatchObject({
      date: '2026-10-06',
      currency: 'TRY',
      externalNo: 'TEST2026000001',
      totalText: '999.99',
    });
    expect(ocrSuggestions('unclear document')).toMatchObject({
      date: null,
      currency: null,
      totalText: null,
      externalNo: null,
    });
  });
  it('eksik yerel çalışma zamanı anlaşılır hata, yetki ve tekrar deneme', async () => {
    const { app } = await makeApp({
        configOverrides: {
          CONSTRUCTION_STORAGE_DIR: await mkdtemp(join(tmpdir(), 'erp-jobs-')),
          CONSTRUCTION_PYTHON: 'missing-erp-python-runtime',
        },
      }),
      owner = await registerUser(app, 'JobMissing'),
      company = await createCompany(app, owner.token),
      c = client(app, owner.token, company.id);
    const project = (await c.post('/api/projects', { name: 'İş kuyruğu', kind: 'own' })).json()
      .project;
    const file = (
      await c.post('/api/construction/assets', {
        projectId: project.id,
        filename: 'bad.ifc',
        mime: 'application/x-step',
        base64: Buffer.from('ISO-10303-21;\ninvalid').toString('base64'),
      })
    ).json().item;
    const queued = await c.post('/api/construction/jobs', { assetId: file.id, kind: 'ifc' });
    expect(queued.statusCode, queued.body).toBe(201);
    const job = queued.json().item;
    expect(
      (await c.post('/api/construction/jobs', { assetId: file.id, kind: 'ifc' })).json().item.id,
    ).toBe(job.id);
    await processConstructionJobs(app);
    const failed = (await c.get(`/api/construction/jobs?projectId=${project.id}`)).json().items[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Python');
    expect(
      (await c.post(`/api/construction/jobs/${job.id}/retry`, { version: 1 })).statusCode,
    ).toBe(409);
    expect(
      (await c.post(`/api/construction/jobs/${job.id}/retry`, { version: failed.version }))
        .statusCode,
    ).toBe(200);
    const other = await createCompany(app, owner.token);
    expect(
      (await client(app, owner.token, other.id).get(`/api/construction/jobs/${job.id}/result`))
        .statusCode,
    ).toBe(404);
  });
  it.runIf(existsSync(python) && existsSync(join(lang, 'tur.traineddata.gz')))(
    'gerçek IFC geometri, taranmış belge OCR, kaynak ve insan doğrulaması',
    async () => {
      const { app } = await makeApp({
          configOverrides: {
            CONSTRUCTION_STORAGE_DIR: await mkdtemp(join(tmpdir(), 'erp-jobs-real-')),
            CONSTRUCTION_PYTHON: python,
            CONSTRUCTION_TESSDATA_DIR: lang,
          },
        }),
        owner = await registerUser(app, 'JobActual'),
        company = await createCompany(app, owner.token),
        c = client(app, owner.token, company.id);
      const project = (
        await c.post('/api/projects', { name: 'Yerel model ve OCR', kind: 'own' })
      ).json().project;
      for (const [name, mime, kind] of [
        ['model.ifc', 'application/x-step', 'ifc'],
        ['invoice.png', 'image/png', 'ocr'],
        ['invoice-scanned.pdf', 'application/pdf', 'ocr'],
      ]) {
        const upload = await c.post('/api/construction/assets', {
          projectId: project.id,
          filename: name,
          mime,
          base64: (await readFile(resolve('test/fixtures/construction', name!))).toString('base64'),
        });
        expect(upload.statusCode, upload.body).toBe(201);
        const queued = (
          await c.post('/api/construction/jobs', { assetId: upload.json().item.id, kind })
        ).json().item;
        for (let turn = 0; turn < 4; turn++) await processConstructionJobs(app);
        const item = (await c.get(`/api/construction/jobs?projectId=${project.id}`))
          .json()
          .items.find((j: any) => j.id === queued.id);
        expect(item.status, item.error).toBe('completed');
        const result = await c.get(`/api/construction/jobs/${item.id}/result`);
        expect(result.statusCode, result.body).toBe(200);
        if (kind === 'ifc') {
          expect(result.json().elements.length).toBe(2);
          expect(result.json().elements[0].faces.length).toBeGreaterThan(0);
          expect(
            (
              await c.put(`/api/construction/jobs/${item.id}/model-links`, {
                guid: 'fake',
                wbsId: null,
                operationId: null,
                version: 0,
              })
            ).statusCode,
          ).toBe(400);
          const guid = result.json().elements[0].guid;
          expect(
            (
              await c.put(`/api/construction/jobs/${item.id}/model-links`, {
                guid,
                wbsId: null,
                operationId: null,
                version: 0,
              })
            ).statusCode,
          ).toBe(200);
          expect(
            (
              await c.put(`/api/construction/jobs/${item.id}/model-links`, {
                guid,
                wbsId: null,
                operationId: null,
                version: 0,
              })
            ).statusCode,
          ).toBe(409);
        } else {
          expect(result.json().text).toContain('999.99');
          expect(
            (
              await c.post(`/api/construction/jobs/${item.id}/review`, {
                version: item.version,
                type: 'report',
                input: {
                  title: 'OCR raporu',
                  date: '2026-10-06',
                  workDone: 'Kontrol edilen saha bilgisi',
                },
                confirmation: false,
              })
            ).statusCode,
          ).toBe(400);
          const review = await c.post(`/api/construction/jobs/${item.id}/review`, {
            version: item.version,
            type: 'report',
            input: {
              title: 'OCR raporu',
              date: '2026-10-06',
              workDone: 'Kontrol edilen saha bilgisi',
            },
            confirmation: true,
          });
          expect(review.statusCode, review.body).toBe(200);
          expect(review.json().recordKind).toBe('site_report');
          expect(
            (
              await c.post(`/api/construction/jobs/${item.id}/review`, {
                version: item.version,
                type: 'report',
                input: { title: 'Tekrar', date: '2026-10-06', workDone: 'Yinelenen saha bilgisi' },
                confirmation: true,
              })
            ).statusCode,
          ).toBe(409);
        }
      }
      const answer = await c.post('/api/construction/assistant', {
        projectId: project.id,
        question: 'TEST2026000001 faturası',
      });
      expect(answer.statusCode, answer.body).toBe(200);
      expect(answer.json().sources.length).toBeGreaterThan(0);
      expect(
        (
          await c.post('/api/construction/assistant', {
            projectId: project.id,
            question: 'bilinmeyen zxzxyyzzzz',
          })
        ).json().sources.length,
      ).toBe(0);
    },
    90000,
  );
});
