import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';

const companyId = '019b29e1-7ac3-7000-8000-000000000001', userId = '019b29e1-7ac3-7000-8000-000000000002';
const warehouseId = '019b29e1-7ac3-7000-8000-000000000003', itemId = '019b29e1-7ac3-7000-8000-000000000004';
const resultId = '019b29e1-7ac3-7000-8000-000000000005';
async function fixture(page: Page) {
  const syncs: unknown[] = [];
  const state = { fail: true };
  await page.addInitScript(() => localStorage.setItem('activeCompanyId', '019b29e1-7ac3-7000-8000-000000000001'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const company = { id: companyId, name: 'Çevrimdışı Ticaret ve Üretim Deneme Şirketi', sector: 'COMMERCE', baseCurrency: 'TRY', reportingCurrency: null, role: 'owner', jurisdiction: 'TR', timeZone: 'Europe/Istanbul' };
    if (path === '/api/auth/refresh') return json({ accessToken: 'fixture' });
    if (path === '/api/public-config') return json({ version: '0.1.0', registrationEnabled: true, license: { enforced: false, state: 'active' } });
    if (path === '/api/license') return json({ enforced: false, state: 'active', usage: { companies: 1, devices: 1 }, isOwner: true });
    if (path === '/api/me') return json({ user: { id: userId, fullName: 'Depo görevlisi', email: 'offline@example.com', emailVerified: true, mustChangePassword: false }, companies: [company] });
    if (path === '/api/navigation') return json({ company, role: 'owner', permissions: ['workspace.use', 'settings.read', 'inventory.read', 'inventory.move'], modules: ['core.dashboard', 'core.settings', 'core.inventory'], moduleAccess: {}, groups: [] });
    if (path === '/api/company/branches') return json({ branches: [] });
    if (path === '/api/company') return json({ company: { ...company, taxOffice: null, taxNumber: null, address: null } });
    if (path.includes('notifications')) return json({ count: 0, unread: 0, critical: 0, hasCritical: false, notifications: [] });
    if (path === '/api/offline-drafts/bootstrap') return json({ companyId, userId, companyName: company.name, branchSelection: 'all', timeZone: company.timeZone, today: '2026-10-09', kinds: ['stock_count', 'field_task'], warehouses: [{ id: warehouseId, name: 'Ana depo — uzun depo adı, toptan ticaret ürünleri' }], items: [{ id: itemId, code: 'STK-1', name: 'Uzun isimli seri takipli deneme ürünü ve yedek aksesuar', unit: 'adet' }], truncated: false });
    if (path === '/api/offline-drafts/sync') {
      syncs.push(route.request().postDataJSON());
      if (state.fail) return json({ error: { code: 'WAREHOUSE_NOT_FOUND', message: 'Depoya erişiminiz değişti. Yöneticiyle kontrol edin.' } }, 422);
      return json({ clientId: (syncs.at(-1) as { clientId: string }).clientId, resultId, resultPath: `/inventory/counts/${resultId}`, replayed: true });
    }
    return json({});
  });
  return { syncs, state };
}
async function prepare(page: Page) {
  await page.goto('/workspace/offline');
  await expect(page.getByRole('heading', { name: 'Çevrimdışı depo ve saha' })).toBeVisible({ timeout: 10000 }).catch(async error => { throw new Error(String(error) + '\n' + await page.locator('body').textContent()); });
  await page.getByLabel('Cihaz kodu', { exact: true }).fill('Depo-Cihaz-123');
  await page.getByRole('button', { name: 'Paketi indir / yenile' }).click();
  await expect(page.getByText('Paket hazır.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Çevrimdışı taslakları aç' }).click();
  await page.getByLabel('Cihaz kodu', { exact: true }).fill('Depo-Cihaz-123');
  await page.getByRole('button', { name: 'Paketi aç', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Taslak kuyruğu' })).toBeVisible();
}

test('şifreli cihaz kuyruğu, tekrar eşitleme, mobil tema ve oturum kilidi', async ({ page }) => {
  test.setTimeout(90_000);
  const { syncs, state } = await fixture(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page);
  await page.getByLabel('Stok kartı 1').selectOption(itemId);
  await page.getByLabel('Sayılan miktar').fill('4,25');
  await page.getByRole('button', { name: 'Cihazda taslak kaydet' }).click();
  await expect(page.getByText('1 taslak eşitleme bekliyor', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Bekleyenleri eşitle (1)' }).click();
  await expect(page.getByText('Depoya erişiminiz değişti. Yöneticiyle kontrol edin.')).toBeVisible();
  state.fail = false;
  await page.getByRole('button', { name: 'Bekleyenleri eşitle (1)' }).click();
  await expect(page.getByRole('link', { name: 'Sunucudaki taslağı aç' })).toBeVisible();
  expect(syncs).toHaveLength(2); expect(syncs[0]).toEqual(syncs[1]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.getByRole('button', { name: 'Ekranı kilitle', exact: true }).click();
  await page.getByLabel('Cihaz kodu', { exact: true }).fill('Yanlis-Cihaz-Kodu');
  await page.getByRole('button', { name: 'Paketi aç', exact: true }).click();
  await expect(page.getByText('Cihaz kodu yanlış veya çevrimdışı paket bozuk.')).toBeVisible();
  await page.getByLabel('Cihaz kodu', { exact: true }).fill('Depo-Cihaz-123');
  await page.getByRole('button', { name: 'Paketi aç', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sunucudaki taslağı aç' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('erp-session-cleared')));
  await expect(page.getByRole('heading', { name: 'Taslak kuyruğu' })).toHaveCount(0);
  await expect(page.getByLabel('Cihaz kodu', { exact: true })).toHaveValue('');
  const envelope = await page.evaluate(async () => {
    const request = indexedDB.open('erp-offline-drafts-v1', 1);
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const result = await new Promise<unknown>(resolve => { const read = db.transaction('packages').objectStore('packages').get('package'); read.onsuccess = () => resolve(read.result); });
    db.close(); return JSON.stringify(result);
  });
  expect(envelope).not.toContain('Depo-Cihaz-123'); expect(envelope).not.toContain('stock_count'); expect(envelope).not.toContain(companyId);
  expect(errors).toEqual([]);
});

test('iki sekme aynı cihaz paketinin taslaklarını sessizce ezmez', async ({ page, context }) => {
  test.setTimeout(90_000);
  await fixture(page); await prepare(page);
  const second = await context.newPage(); await fixture(second); await second.goto('/offline-drafts');
  await second.getByLabel('Cihaz kodu', { exact: true }).fill('Depo-Cihaz-123');
  await second.getByRole('button', { name: 'Paketi aç', exact: true }).click();
  await page.getByLabel('Taslak türü').selectOption('field_task');
  await page.getByLabel('Görev başlığı').fill('İlk sekmenin saha görevi');
  await page.getByRole('button', { name: 'Cihazda taslak kaydet' }).click();
  await expect(page.getByText('1 taslak eşitleme bekliyor', { exact: false })).toBeVisible();
  await second.getByLabel('Taslak türü').selectOption('field_task');
  await second.getByLabel('Görev başlığı').fill('İkinci sekmenin saha görevi');
  await second.getByRole('button', { name: 'Cihazda taslak kaydet' }).click();
  await expect(second.getByText('Paket başka bir sekmede değişti. Ekranı kilitleyip yeniden açın.')).toBeVisible();
  await second.getByRole('button', { name: 'Ekranı kilitle', exact: true }).click();
  await second.getByLabel('Cihaz kodu', { exact: true }).fill('Depo-Cihaz-123');
  await second.getByRole('button', { name: 'Paketi aç', exact: true }).click();
  await expect(second.getByText('İlk sekmenin saha görevi', { exact: false })).toBeVisible();
  await second.close();
});

test('hazırlanmış üretim ekranı internet kesildikten sonra yeniden açılır ve taslağı saklar', async ({ page, context }) => {
  test.skip(process.env.OFFLINE_PRODUCTION_QA !== '1', 'Üretim dosyalarıyla çevrimdışı yeniden yükleme kontrolü.');
  test.setTimeout(90_000);
  await fixture(page); await prepare(page);
  await page.unroute('**/api/**');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Çevrimdışı taslaklar' })).toBeVisible();
  await page.getByLabel('Cihaz kodu', { exact: true }).fill('Depo-Cihaz-123');
  await page.getByRole('button', { name: 'Paketi aç', exact: true }).click();
  await page.getByLabel('Taslak türü').selectOption('field_task');
  await page.getByLabel('Görev başlığı').fill('İnternet yokken kaydedilen görev');
  await page.getByRole('button', { name: 'Cihazda taslak kaydet' }).click();
  await expect(page.getByText('1 taslak eşitleme bekliyor', { exact: false })).toBeVisible();
  expect(await page.getByRole('button', { name: 'Bekleyenleri eşitle (1)' }).isDisabled()).toBe(true);
  const cached = await page.evaluate(async () => { const cache = await caches.open('erp-field-shell-v1'); return (await cache.keys()).map(request => new URL(request.url).pathname); });
  expect(cached).toContain('/offline-drafts'); expect(cached.some(path => path.startsWith('/api/'))).toBe(false);
});
