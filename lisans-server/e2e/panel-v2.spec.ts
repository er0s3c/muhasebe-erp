import { expect, test, type Page } from '@playwright/test';

const customer = { id: 'customer-fixture', name: 'Örnek müşteri', contactName: 'İlgili kişi', email: 'fixture@example.com', phone: null, notes: null, createdAt: '2026-10-01T10:00:00Z' };
const license = { id: 'license-fixture', customerId: customer.id, customer: customer.name, kind: 'commercial', status: 'active', sectors: ['COMMERCE'], deviceLimit: 3, companyLimit: 1, deviceIdleDays: 30, validUntil: '2027-10-01T23:59:59Z', leaseDays: 7, validityMode: 'subscription', graceDays: 15, maxActivations: 1, offlineAllowed: false, codePrefix: 'FIXTURE', transfersUsed: 0, notes: null, createdAt: customer.createdAt, updatedAt: customer.createdAt };
const release = { id: 'release-fixture', version: '1.2.3', notes: 'Arayüz fixture sürümü', status: 'draft', sourceCommit: null, ciRun: null, testsPassed: false, installerFile: null, installerSignature: null, manifest: null, files: [{ target: 'win-x64', name: 'muhasebe-erp-1.2.3-win-x64.zip', sha256: 'a'.repeat(64), size: 100 }], createdAt: customer.createdAt, publishedAt: null, sentLicenses: 0, installedActivations: 0 };

async function fixtures(page: Page, options: { adminId?: () => string; unauthorized?: boolean; setup?: boolean } = {}) {
  await page.route('**/admin/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/admin/api/me') return options.unauthorized ? json({ error: { code: 'UNAUTHORIZED', message: 'Oturum gerekli' } }, 401) : json({ admin: { id: options.adminId?.() ?? 'admin-fixture', email: 'admin@example.com', fullName: 'Panel yöneticisi' } });
    if (path === '/admin/api/setup') return json({ needed: options.setup ?? false });
    if (path === '/admin/api/dashboard') return json({ customers: 1, licenses: { active: 1 }, activations: { active: 0, flagged: 0, reportedDevices: 0 }, expiringIn30Days: 0 });
    if (path === '/admin/api/customers') return json({ customers: [customer] });
    if (path === '/admin/api/licenses') return json({ licenses: [license] });
    if (path === '/admin/api/licenses/license-fixture') return json({ license, activations: [] });
    if (path === '/admin/api/releases') return json({ releases: [release], chunkBytes: 1024 });
    if (path === '/admin/api/feedback') return json({ feedback: [], total: 0, counts: { new: 0, in_review: 0, resolved: 0 } });
    if (path === '/admin/api/audit') return json({ entries: [] });
    if (path === '/admin/api/passkeys') return json({ passkeys: [] });
    return json({});
  });
}

test('panel V2: all existing page URLs, Ada ERP identity and desktop/mobile themes stay usable', async ({ page }) => {
  await fixtures(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [path, title] of [['/', 'Özet'], ['/customers', 'Müşteriler'], ['/licenses', 'Lisanslar'], ['/licenses/license-fixture', customer.name], ['/releases', 'Sürümler ve uzaktan güncelleme'], ['/feedback', 'Geri bildirimler'], ['/audit', 'Denetim kaydı'], ['/security', 'Güvenlik']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Ada ERP', exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${path}, ${width}`).toBe(true);
      await page.getByRole('button', { name: 'Temayı değiştir' }).click();
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
    }
  }
  expect(errors).toEqual([]);
});

test('panel V2: authentication redirect and setup URL preserve compulsory TOTP fields', async ({ page }) => {
  await fixtures(page, { unauthorized: true });
  await page.goto('/licenses');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Doğrulama kodu')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Giriş yap', exact: true })).toBeDisabled();
  await page.unroute('**/admin/api/**');
  await fixtures(page, { setup: true });
  await page.goto('/login');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'İlk kurulum', exact: true })).toBeVisible();
});

test('panel V2: a failed session query shows retry and successfully recovers', async ({ page }) => {
  await fixtures(page);
  let failing = true;
  await page.route('**/admin/api/me', async route => route.fulfill({ status: failing ? 429 : 200, contentType: 'application/json', body: JSON.stringify(failing ? { error: { code: 'RATE_LIMITED', message: 'Kısa süre sonra yeniden deneyin.' } } : { admin: { id: 'admin-fixture', email: 'admin@example.com', fullName: 'Panel yöneticisi' } }) }));
  await page.goto('/customers');
  await expect(page.getByText('Yönetici oturumu yüklenemedi')).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: 'Yeniden dene', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Müşteriler', exact: true, level: 1 })).toBeVisible();
});

test('panel V2: dirty sheet confirmation, server validation, pending lock and successful-save cleanup', async ({ page }) => {
  await fixtures(page);
  let submits = 0;
  let reject = true;
  let complete: (() => void) | undefined;
  await page.route('**/admin/api/customers', async route => {
    if (route.request().method() === 'GET') return route.fallback();
    submits++;
    if (reject) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Alanları kontrol edin.', details: [{ path: 'email', message: 'E-posta adresini kontrol edin.' }] } }) });
    await new Promise<void>(resolve => { complete = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ customer }) });
  });
  await page.goto('/customers');
  await page.getByRole('button', { name: 'Yeni müşteri', exact: true }).click();
  await page.getByLabel('Ad / unvan').fill('Kaybolmayan taslak');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Kaydedilmemiş değişiklikler' })).toBeVisible();
  await page.getByRole('button', { name: 'Düzenlemeye devam et' }).click();
  await page.getByLabel('E-posta', { exact: true }).fill('invalid@example.com');
  await page.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(page.getByText('E-posta adresini kontrol edin.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('E-posta', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Ad / unvan')).toHaveValue('Kaybolmayan taslak');
  reject = false;
  await page.getByLabel('E-posta', { exact: true }).fill('valid@example.com');
  await page.getByRole('button', { name: 'Ekle', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ekle', exact: true })).toBeDisabled();
  await page.getByLabel('Ad / unvan').press('Enter');
  expect(submits).toBe(2);
  complete?.();
  await expect(page.getByRole('dialog', { name: 'Yeni müşteri', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Lisanslar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lisanslar', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Kaydedilmemiş değişiklikler' })).toHaveCount(0);
});

test('panel V2: saved license filters stay local to the administrator and avoid customer data', async ({ page }) => {
  let adminId = 'admin-one';
  await fixtures(page, { adminId: () => adminId });
  await page.goto('/licenses?status=suspended&customerId=private-customer');
  await page.getByRole('button', { name: 'Görünümü kaydet' }).click();
  await page.getByLabel('Görünüm adı').fill('Askıdaki lisanslar');
  await page.getByRole('dialog', { name: 'Filtre görünümünü kaydet' }).getByRole('button', { name: 'Kaydet', exact: true }).click();
  await page.goto('/licenses');
  const views = page.getByRole('combobox', { name: 'Kayıtlı görünüm uygula' });
  await views.selectOption({ label: 'Askıdaki lisanslar' });
  await expect(page.getByRole('combobox', { name: 'Durum süzgeci' })).toHaveValue('suspended');
  expect(await page.evaluate(() => localStorage.getItem('ada:views:v1:license-admin:admin-one:licenses'))).not.toContain('private-customer');
  adminId = 'admin-two';
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Kayıtlı görünüm uygula' })).toHaveCount(0);
});

test('panel V2: release deletion requires concrete confirmation before the API call', async ({ page }) => {
  await fixtures(page);
  let deletes = 0;
  await page.route('**/admin/api/releases/release-fixture', async route => { deletes++; await route.fulfill({ contentType: 'application/json', body: '{}' }); });
  await page.goto('/releases');
  await page.getByRole('row', { name: /1.2.3/ }).click();
  await page.getByRole('button', { name: 'Taslağı sil', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sürüm taslağı silinsin mi?' });
  await expect(dialog).toBeVisible();
  expect(deletes).toBe(0);
  await dialog.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  expect(deletes).toBe(0);
  await page.getByRole('button', { name: 'Taslağı sil', exact: true }).click();
  await dialog.getByRole('button', { name: 'Taslağı sil', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(deletes).toBe(1);
});
