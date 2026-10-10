import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
async function setup(page: Page) {
  const r = await page.request.post('/api/auth/register', {
    data: {
      email: `construction-${Date.now()}-${Math.random()}@example.com`,
      password: 'Construction-Test-12345',
      fullName: 'Deniz Şantiye',
      organizationName: 'Şantiye Test',
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  const token = (await r.json()).accessToken;
  const c = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'İnşaat Kabul Testi', sector: 'CONSTRUCTION', jurisdiction: 'KKTC' },
  });
  expect(c.status()).toBe(201);
  const headers = { authorization: `Bearer ${token}`, 'x-company-id': (await c.json()).company.id };
  const p = await page.request.post('/api/projects', {
    headers,
    data: { name: 'Örnek konut projesi', kind: 'own' },
  });
  expect(p.status()).toBe(201);
  const project = (await p.json()).project;
  const l = await page.request.post('/api/construction/locations', {
    headers,
    data: { projectId: project.id, kind: 'building', name: 'A Blok' },
  });
  expect(l.status()).toBe(201);
  await page.goto(`/workspace/project-control?projectId=${project.id}&tab=drawings`);
  await expect(page.getByRole('heading', { name: 'Proje 360', exact: true })).toBeVisible();
  return { headers, project, location: (await l.json()).item };
}
async function uploadDrawing(page: Page) {
  await page.getByRole('button', { name: 'Çizim / revizyon ekle', exact: true }).click();
  await page.getByLabel('Çizim kodu').fill('A-01');
  await page.getByLabel('Başlık', { exact: true }).fill('Zemin kat planı');
  await page
    .locator('input[type=file]')
    .setInputFiles(resolve('apps/api/test/fixtures/construction/plan.pdf'));
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await page
    .getByLabel('Çizim seç', { exact: true })
    .selectOption({ label: 'A-01 · Zemin kat planı · Rev 01 · Taslak' });
  await page.getByRole('button', { name: 'Kullanım için onayla' }).click();
  await expect(page.getByText('Kullanım için onaylı', { exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
}
test('PDF, fotoğraflı plan sorunu, kaynaklı risk ve mobil tasarım', async ({ page }, info) => {
  const { project, location, headers } = await setup(page);
  await uploadDrawing(page);
  await page.getByRole('button', { name: 'Plana sorun işaretle' }).click();
  await page.locator('canvas').click({ position: { x: 150, y: 150 } });
  await page.getByLabel('Talep başlığı').fill('Donatı detayı eksik');
  await page.getByLabel('Teknik soru').fill('A Blok kolon donatı birleşim detayı bekleniyor.');
  await page.getByLabel('Termin', { exact: true }).fill('2026-01-01');
  await page.getByLabel('Konum', { exact: true }).selectOption(location.id);
  await page
    .getByLabel('Sorun fotoğrafı (isteğe bağlı)')
    .setInputFiles(resolve('apps/api/test/fixtures/construction/invoice.png'));
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`/workspace/project-control?projectId=${project.id}`);
  await expect(page.getByText('Donatı detayı eksik', { exact: true })).toBeVisible();
  await page.getByText('Donatı detayı eksik', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Donatı detayı eksik', exact: true }),
  ).toBeVisible();
  const photos = await page.request.get(`/api/construction/photos?projectId=${project.id}`, {
    headers,
  });
  expect((await photos.json()).items).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['overview', 'drawings', 'field', 'program', 'commercial', 'customer']) {
    await page.goto(`/workspace/project-control?projectId=${project.id}&tab=${tab}`);
    await expect(page.getByRole('heading', { name: 'Proje 360', exact: true })).toBeVisible();
    if (tab !== 'overview') {
      await expect(page.getByRole('button', { name: 'Yeni kayıt', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Yeni kayıt', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        tab + ' form',
      ).toBe(true);
      await page.getByRole('dialog').press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), tab).toBe(
      true,
    );
  }
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('project-360-mobile.png'),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('project-360-dark.png'),
    fullPage: true,
  });
});
test('çevrimdışı kapatıp açma, fotoğraflı kayıt, tek eşitleme ve şirket izolasyonu', async ({
  page,
  context,
}, info) => {
  const { project, location, headers } = await setup(page);
  await uploadDrawing(page);
  await page.getByRole('button', { name: 'Saha paketini indir', exact: true }).click();
  await page.getByLabel('Cihaz kodu (en az 8 karakter)').fill('Saha-Test-12345');
  await page.getByRole('button', { name: 'Paketi indir', exact: true }).click();
  await expect(page.getByText(/Saha paketi indirildi/)).toBeVisible();
  await context.setOffline(true);
  await page.close();
  let offline = await context.newPage();
  await offline.goto('/field-offline');
  await offline.getByLabel('Cihaz kodu', { exact: true }).fill('Saha-Test-12345');
  await offline.getByRole('button', { name: 'Saha paketini aç' }).click();
  await expect(offline.locator('canvas')).toBeVisible();
  await offline.locator('canvas').click({ position: { x: 150, y: 150 } });
  await offline.getByLabel('Başlık', { exact: true }).fill('Çevrimdışı kalıp kontrolü');
  await offline
    .getByLabel('Açıklama / yapılan işler')
    .fill('Kalıp bağlantılarının kontrolü isteniyor.');
  await offline.getByLabel('Konum', { exact: true }).selectOption(location.id);
  await offline.getByLabel('Fotoğraf', { exact: true }).setInputFiles({
    name: 'offline.png',
    mimeType: 'image/png',
    buffer: await readFile('apps/api/test/fixtures/construction/invoice.png'),
  });
  await offline.getByRole('button', { name: 'Cihazda kaydet' }).click();
  await expect(offline.getByRole('button', { name: 'Bekleyenleri eşitle (1)' })).toBeVisible();
  await offline.close();
  offline = await context.newPage();
  await offline.goto('/field-offline');
  await offline.getByLabel('Cihaz kodu', { exact: true }).fill('Saha-Test-12345');
  await offline.getByRole('button', { name: 'Saha paketini aç' }).click();
  await expect(offline.getByRole('button', { name: 'Bekleyenleri eşitle (1)' })).toBeVisible();
  await offline.screenshot({ path: info.outputPath('cold-offline.png'), fullPage: true });
  await context.setOffline(false);
  await offline.reload();
  await offline.getByLabel('Cihaz kodu', { exact: true }).fill('Saha-Test-12345');
  await offline.getByRole('button', { name: 'Saha paketini aç' }).click();
  await offline.getByRole('button', { name: 'Bekleyenleri eşitle (1)' }).click();
  await expect(offline.getByRole('button', { name: 'Bekleyenleri eşitle (0)' })).toBeVisible();
  await offline.getByRole('button', { name: 'Bekleyenleri eşitle (0)' }).click();
  const ops = await offline.request.get(
    `/api/workspace/operations?projectId=${project.id}&kind=rfi`,
    { headers },
  );
  expect(
    (await ops.json()).items.filter(
      (r: { title: string }) => r.title === 'Çevrimdışı kalıp kontrolü',
    ),
  ).toHaveLength(1);
  const photos = await offline.request.get(`/api/construction/photos?projectId=${project.id}`, {
    headers,
  });
  expect((await photos.json()).items).toHaveLength(1);
  const second = await offline.request.post('/api/companies', {
    headers,
    data: { name: 'Farklı Şirket', sector: 'CONSTRUCTION', jurisdiction: 'KKTC' },
  });
  expect(second.status()).toBe(201);
  await offline.goto(`/workspace/project-control?projectId=${project.id}`);
  await offline.getByRole('button', { name: 'Şirket değiştir', exact: true }).click();
  await offline.getByRole('menuitem', { name: 'Farklı Şirket', exact: true }).click();
  await offline.goto('/field-offline');
  await offline.getByLabel('Cihaz kodu', { exact: true }).fill('Saha-Test-12345');
  await offline.getByRole('button', { name: 'Saha paketini aç' }).click();
  await expect(offline.getByText('Bu cihazda indirilmiş saha paketi yok.')).toBeVisible();
});
