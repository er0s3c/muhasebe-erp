import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
async function setup(page: Page) {
  const email = `workspace-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const registered = await page.request.post('/api/auth/register', {
    data: {
      email,
      password: 'Workspace-Test-12345',
      fullName: 'Deniz Test',
      organizationName: 'Test Holding',
    },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const token = (await registered.json()).accessToken as string;
  const made = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'Çalışma Alanı Test İnşaat', sector: 'CONSTRUCTION' },
  });
  expect(made.status(), await made.text()).toBe(201);
  const company = (await made.json()).company;
  const headers = { authorization: `Bearer ${token}`, 'x-company-id': company.id };
  const project = await page.request.post('/api/projects', {
    headers,
    data: { code: 'SAHA-TEST', name: 'Deneme şantiyesi', kind: 'own' },
  });
  expect(project.status(), await project.text()).toBe(201);
  const party = await page.request.post('/api/parties', {
    headers,
    data: { code: 'M-TEST', name: 'Deneme müşterisi', kind: 'customer' },
  });
  expect(party.status(), await party.text()).toBe(201);
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: 'Bugünkü işlerim', exact: true })).toBeVisible();
  return { headers, project: (await project.json()).project, party: (await party.json()).party };
}
test('görev, kayıt araması, belge sürümü ve portal akışı', async ({ page }, info) => {
  const { party } = await setup(page);
  await page.getByRole('button', { name: 'Yeni görev', exact: true }).first().click();
  await page.getByLabel('Başlık', { exact: true }).fill('Ödeme dekontunu kontrol et');
  await page.getByRole('button', { name: 'Görev oluştur', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ödeme dekontunu kontrol et' })).toBeVisible();
  await page.getByRole('button', { name: 'Tamamla', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ödeme dekontunu kontrol et' })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Deneme müşterisi');
  await expect(page.getByRole('option', { name: /M-TEST.*Deneme müşterisi/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`/workspace/documents?kind=party&id=${party.id}`);
  await expect(page.getByRole('link', { name: 'Belge arşivi', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('link', { name: 'Bugünkü işlerim', exact: true }),
  ).not.toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Yeni belge', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'dekont.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\n%%EOF'),
  });
  await page.getByRole('button', { name: 'Belge yükle' }).click();
  await expect(page.getByRole('heading', { name: 'dekont.pdf' })).toBeVisible();
  await page.getByRole('button', { name: 'Yeni sürüm', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'dekont-v2.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nVersion2\n%%EOF'),
  });
  await page.getByRole('button', { name: 'Belge yükle' }).click();
  await expect(page.getByRole('heading', { name: 'dekont-v2.pdf' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'İndir', exact: true }).first().click();
  expect((await download).suggestedFilename()).toBe('dekont-v2.pdf');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('documents.png'),
    fullPage: true,
  });
  await page.goto('/workspace/portal');
  await page.getByRole('button', { name: 'Yeni erişim', exact: true }).click();
  await page.getByLabel('İlgili kayıt ara').fill('Deneme müşterisi');
  await page.getByRole('button', { name: 'M-TEST · Deneme müşterisi', exact: true }).click();
  await page.getByLabel('Erişim adı').fill('Müşteri inceleme');
  await page.getByLabel('Portal parolası').fill('Portal-Test-12345');
  await page.getByRole('button', { name: 'Erişim oluştur' }).click();
  await expect(page.getByLabel('Portal bağlantısı')).toBeVisible();
  const url = await page.getByLabel('Portal bağlantısı').inputValue();
  await page.goto(url);
  await page.getByLabel('Portal parolası', { exact: true }).fill('Portal-Test-12345');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('heading', { name: 'Ödemeniz gereken açık kalemler' })).toBeVisible();
  await expect(page.getByText('Deneme müşterisi', { exact: false })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('portal.png'),
    fullPage: true,
  });
});
test('mobil saha taslağı, bağımlı iş programı ve nakit senaryosu', async ({ page }, info) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workspace/operations?kind=site_report');
  await page.getByRole('button', { name: 'Yeni kayıt', exact: true }).first().click();
  await page.getByLabel('Başlık', { exact: true }).fill('Günlük beton dökümü');
  await page.getByLabel('Proje ara').fill('Deneme şantiyesi');
  await page.getByRole('button', { name: 'SAHA-TEST · Deneme şantiyesi', exact: true }).click();
  await page.getByLabel('Çalışan sayısı').fill('8');
  await page.getByLabel('Yapılan işler').fill('Zemin kat döşemesi tamamlandı.');
  await page.getByRole('button', { name: 'Taslağı cihazda sakla' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Yeni kayıt', exact: true }).first().click();
  await page.getByRole('button', { name: 'Taslağı yükle' }).click();
  await expect(page.getByLabel('Başlık', { exact: true })).toHaveValue('Günlük beton dökümü');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Günlük beton dökümü' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('mobile-site.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/workspace/operations?kind=schedule');
  await page.getByRole('button', { name: 'Yeni kayıt', exact: true }).first().click();
  await page.getByLabel('Başlık', { exact: true }).fill('Kalıp programı');
  await page.getByLabel('Proje ara').fill('Deneme şantiyesi');
  await page.getByRole('button', { name: 'SAHA-TEST · Deneme şantiyesi', exact: true }).click();
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kalıp programı' })).toBeVisible();
  await page.goto('/workspace/scenarios');
  await page.getByRole('button', { name: 'Karşılaştır', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Senaryo kapanış' })).toBeVisible();
  await page.getByRole('button', { name: 'Varsayımları sakla' }).click();
  await expect(page.getByText('Senaryo varsayımları saklandı.')).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('scenarios.png'),
    fullPage: true,
  });
});

test('çalışma alanı sınırlı veriyle eşzamanlı okuma ölçümü', async ({ page }, info) => {
  const { headers, project } = await setup(page);
  const date = new Date().toISOString().slice(0, 10);
  for (let offset = 0; offset < 120; offset += 4) {
    await Promise.all(
      Array.from({ length: 4 }, async (_, i) => {
        const response = await page.request.post('/api/workspace/operations', {
          headers,
          data: {
            kind: 'site_report',
            title: `Ölçüm saha raporu ${offset + i}`,
            projectId: project.id,
            eventDate: date,
            dueDate: date,
            payload: { workers: 8, workDone: 'Yerel test kaydı' },
          },
        });
        expect(response.status(), await response.text()).toBe(201);
      }),
    );
  }
  const listing = await page.request.get('/api/workspace/operations?kind=site_report', { headers });
  expect((await listing.json()).items).toHaveLength(100);
  expect((await listing.json()).hasMore).toBe(true);
  const results = [];
  for (const path of [
    '/api/workspace/tasks',
    '/api/workspace/search?q=Ölçüm',
    '/api/workspace/alerts',
    '/api/workspace/operations?kind=site_report',
  ]) {
    const latencies: number[] = [];
    let bytes = 0;
    for (let batch = 0; batch < 8; batch++) {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const start = performance.now();
          const response = await page.request.get(path, { headers });
          bytes = Math.max(bytes, (await response.body()).byteLength);
          latencies.push(performance.now() - start);
          expect(response.status(), await response.text()).toBe(200);
        }),
      );
    }
    latencies.sort((a, b) => a - b);
    results.push({
      path,
      requests: latencies.length,
      p50Ms: Math.round(latencies[16]!),
      p95Ms: Math.round(latencies[30]!),
      maxBytes: bytes,
      errors: 0,
    });
  }
  const report = {
    scope: 'Local smoke measurement; not a production capacity guarantee',
    records: 120,
    concurrency: 4,
    results,
  };
  await writeFile(info.outputPath('performance.json'), JSON.stringify(report, null, 2));
  await info.attach('performance', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});

test('inşaat kontrol merkezi, teknik yanıt, tahsilat filtresi ve mobil güvenlik', async ({
  page,
}, info) => {
  const { headers, project, party } = await setup(page);
  await page.getByRole('button', { name: 'Yeni görev', exact: true }).first().click();
  await page.getByLabel('Başlık', { exact: true }).fill('Haftalık saha toplantısını hazırla');
  await page.getByRole('button', { name: 'Görev oluştur', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Haftalık saha toplantısını hazırla' }),
  ).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('work-redesign.png'),
    fullPage: true,
  });
  await page.goto(`/workspace/operations?kind=rfi&projectId=${project.id}`);
  await page.getByRole('button', { name: 'Yeni kayıt', exact: true }).first().click();
  await page.getByLabel('Başlık', { exact: true }).fill('Temel donatı detayı');
  await page
    .getByLabel('Teknik soru', { exact: true })
    .fill('Temel birleşim detayı hangi çizimde?');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Temel donatı detayı' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Düzenle / durum' }).click();
  await page.getByLabel('Durum', { exact: true }).selectOption('done');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByText('Talebi kapatmak için teknik yanıt girin.'),
  ).toBeVisible();
  await page
    .getByLabel('Teknik yanıt', { exact: true })
    .fill('Statik S-12 revizyon B uygulanacak.');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Durum filtresi', { exact: true }).selectOption('open');
  await expect(page.getByRole('heading', { name: 'Temel donatı detayı' })).toHaveCount(0);
  await page.getByLabel('Durum filtresi', { exact: true }).selectOption('all');
  await expect(page.getByRole('heading', { name: 'Temel donatı detayı' })).toBeVisible();
  await page.goto('/workspace/construction');
  await page.getByLabel('Proje kapsamı', { exact: true }).selectOption(project.id);
  await expect(page.getByRole('heading', { name: 'Teknik bilgi talepleri' })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('construction-redesign.png'),
    fullPage: true,
  });
  const date = new Date().toISOString().slice(0, 10);
  const collection = await page.request.post('/api/workspace/operations', {
    headers,
    data: {
      kind: 'collection',
      title: 'Taksit görüşmesi',
      partyId: party.id,
      eventDate: date,
      dueDate: date,
      payload: {
        promiseAmount: '150000',
        currency: 'TRY',
        promiseDate: date,
        contactNote: 'Banka havalesi bekleniyor',
        channel: 'phone',
        outcome: 'promised',
      },
    },
  });
  expect(collection.status(), await collection.text()).toBe(201);
  await page.goto('/workspace/operations?kind=collection');
  await expect(page.getByRole('heading', { name: 'Taksit görüşmesi' })).toBeVisible();
  await expect(page.getByText('₺150.000,00').first()).toBeVisible();
  await page.getByLabel('Listede ara').fill('bulunmayacak');
  await expect(page.getByRole('heading', { name: 'Taksit görüşmesi' })).toHaveCount(0);
  await page.getByLabel('Listede ara').fill('');
  await expect(page.getByRole('heading', { name: 'Taksit görüşmesi' })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('collection-redesign.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/workspace/operations?kind=safety&projectId=${project.id}`);
  await page.getByRole('button', { name: 'Yeni kayıt', exact: true }).first().click();
  await page.getByLabel('Başlık', { exact: true }).fill('Kat kenarı korkuluk kontrolü');
  await page.getByLabel('Risk konumu', { exact: true }).fill('A blok 2. kat');
  await page.getByLabel('Risk seviyesi', { exact: true }).selectOption('critical');
  await page.getByLabel('Tespit / gözlem', { exact: true }).fill('Kat kenarında korkuluk eksik.');
  await page
    .getByLabel('Alınacak önlem', { exact: true })
    .fill('Alan kapatılıp korkuluk takılacak.');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kat kenarı korkuluk kontrolü' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('mobile-safety.png'),
    fullPage: true,
  });
});

test('genel belge arşivi, son sürüm önizlemesi ve teslim tutanağı', async ({ page }, info) => {
  const { headers, project } = await setup(page);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=',
    'base64',
  );
  const body = {
    record: { kind: 'project', id: project.id },
    filename: 'plan-rev-a.png',
    mime: 'image/png',
    base64: png.toString('base64'),
  };
  const first = await page.request.post('/api/workspace/documents', { headers, data: body });
  expect(first.status(), await first.text()).toBe(201);
  const second = await page.request.post('/api/workspace/documents', {
    headers,
    data: { ...body, filename: 'plan-rev-b.png', previousId: (await first.json()).id },
  });
  expect(second.status(), await second.text()).toBe(201);
  await page.goto('/workspace/documents');
  await expect(page.getByRole('heading', { name: 'plan-rev-a.png' })).toBeVisible();
  await page.getByLabel('Yalnızca son sürümler', { exact: true }).check();
  await expect(page.getByRole('heading', { name: 'plan-rev-a.png' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Önizle', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: 'plan-rev-b.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Kapat', exact: true }).click();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('archive-redesign.png'),
    fullPage: true,
  });
  const unit = await page.request.post('/api/real-estate/units', {
    headers,
    data: { projectId: project.id, unitNo: 'A-101' },
  });
  expect(unit.status(), await unit.text()).toBe(201);
  const defect = await page.request.post('/api/workspace/operations', {
    headers,
    data: {
      kind: 'defect',
      title: 'Banyo silikon kontrolü',
      projectId: project.id,
      eventDate: '2026-10-05',
      dueDate: '2026-10-10',
      payload: { unitId: (await unit.json()).unit.id, location: 'Banyo' },
    },
  });
  expect(defect.status(), await defect.text()).toBe(201);
  await page.goto(`/workspace/handover?unit=${(await unit.json()).unit.id}`);
  await expect(page.getByRole('heading', { name: /Banyo silikon kontrolü/ })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByText('Teslim alan', { exact: false })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('handover-print.png'),
    fullPage: true,
  });
  await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce' });
  await page.goto('/workspace/construction');
  await page.getByRole('button', { name: 'Tema', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('construction-dark-mobile.png'),
    fullPage: true,
  });
});
