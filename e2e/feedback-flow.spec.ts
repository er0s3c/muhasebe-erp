import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkVYAAAAASUVORK5CYII=', 'base64');
const receipt = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reference: 'GB-2026-000001', status: 'new', createdAt: '2026-10-08T12:00:00Z' };

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill('demo@ornek.local');
  await page.getByLabel('Şifre', { exact: true }).fill('Demo-Sifre-123');
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Şirket değiştir', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Şirket değiştir', exact: true }).click();
  await page.getByRole('menuitem', { name: /Ada Üretim ve Toptan Ticaret Demo/ }).click();
  await expect(page.locator('main h1')).toBeVisible();
}

test('müşteri geri bildirimi: yönlendirici sorular, hata sonrası korunma ve tekrar gönderim', async ({ page }) => {
  await page.route('**/api/feedback/availability', route => route.fulfill({ json: { available: true } }));
  const submitted: { body: Record<string, unknown>; company: string | undefined; url: string }[] = [];
  await page.route('**/api/companies/*/feedback', async route => {
    submitted.push({ body: route.request().postDataJSON(), company: route.request().headers()['x-company-id'], url: route.request().url() });
    if (submitted.length === 1) await route.fulfill({ status: 503, json: { error: { code: 'FEEDBACK_UNREACHABLE', message: 'Destek sunucusuna ulaşılamadı. Yeniden deneyin.' } } });
    else await route.fulfill({ status: 201, json: { feedback: receipt } });
  });
  await login(page);
  await page.goto('/manufacturing/maintenance');
  await expect(page.locator('main h1')).toBeVisible();
  const title = await page.locator('main h1').innerText();
  await page.getByRole('button', { name: 'Geri bildirim gönder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Geri bildirim gönder', exact: true });
  await expect(dialog.getByLabel('Sorunla hangi ekranda karşılaştınız?')).toHaveValue(title);
  mkdirSync('.cache/feedback-review', { recursive: true });
  await page.screenshot({ path: '.cache/feedback-review/customer-desktop-top.png', animations: 'disabled' });
  const send = dialog.getByRole('button', { name: 'Gönder', exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByLabel('Ne oldu?', { exact: true }).fill('Başlangıç saatini seçemiyorum.');
  await dialog.getByText('Biraz daha ayrıntı ekle', { exact: false }).click();
  await dialog.getByLabel('Sorundan hemen önce ne yapıyordunuz?').fill('Bakım kaydı açıp saat alanına bastım.');
  await dialog.getByLabel('Ne olmasını bekliyordunuz?').fill('Saat seçicinin açılmasını bekledim.');
  mkdirSync('.cache/feedback-review', { recursive: true });
  await page.screenshot({ path: '.cache/feedback-review/customer-desktop.png', animations: 'disabled' });
  await send.click();
  await expect(dialog.getByText('Destek sunucusuna ulaşılamadı. Yeniden deneyin.')).toBeVisible();
  await expect(dialog.getByLabel('Ne oldu?', { exact: true })).toHaveValue('Başlangıç saatini seçemiyorum.');
  await send.click();
  await expect(page.getByRole('dialog', { name: 'Geri bildiriminiz alındı' })).toBeVisible();
  await expect(page.getByText(receipt.reference, { exact: true })).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[0].body).toEqual(submitted[1].body);
  expect(submitted[0].body.pagePath).toBe('/manufacturing/maintenance');
  expect(submitted[0].body.message).toBe('Başlangıç saatini seçemiyorum.');
  expect(submitted[0].body.steps).toContain('Bakım kaydı');
  expect(submitted[0].url).toContain(`/companies/${submitted[0].company}/feedback`);
  expect(submitted[0].body).not.toHaveProperty('reporterEmail');
  await page.getByRole('button', { name: 'Tamam', exact: true }).click();
  await page.getByRole('button', { name: 'Geri bildirim gönder', exact: true }).click();
  await expect(dialog.getByLabel('Ne oldu?', { exact: true })).toHaveValue('');
});

test('yalnız ekran görüntüsü veya açıklama ve görsel; mobil/koyu mod ve taslak korunması', async ({ page }) => {
  await page.route('**/api/feedback/availability', route => route.fulfill({ json: { available: true } }));
  let payload: Record<string, unknown> | undefined;
  await page.route('**/api/companies/*/feedback', async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { feedback: receipt } });
  });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Tema', exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.locator('header button').evaluateAll(elements => elements.filter(element => element.getClientRects().length && (element.getBoundingClientRect().right > innerWidth + 2 || element.getBoundingClientRect().left < -2 || element.scrollWidth > element.clientWidth + 2)).map(element => element.getAttribute('aria-label')))).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Geri bildirim gönder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Geri bildirim gönder', exact: true });
  const upload = dialog.getByLabel('Ekran görüntüsü yükle');
  await upload.setInputFiles({ name: 'uygunsuz.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(dialog.getByText('PNG veya JPG biçiminde bir ekran görüntüsü seçin.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Gönder', exact: true })).toBeDisabled();
  await upload.setInputFiles({ name: 'hata.png', mimeType: 'image/png', buffer: screenshot });
  await expect(dialog.getByRole('img', { name: 'Göndereceğiniz ekran görüntüsü' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Gönder', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Daha sonra', exact: true }).click();
  await page.getByRole('button', { name: 'Geri bildirim gönder', exact: true }).click();
  await expect(dialog.getByRole('img')).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 2)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)).toBe(false);
    mkdirSync('.cache/feedback-review', { recursive: true });
    await page.screenshot({ path: `.cache/feedback-review/customer-dark-${width}.png`, animations: 'disabled' });
  }
  await dialog.getByRole('button', { name: 'Ekran görüntüsünü kaldır' }).click();
  await expect(dialog.getByRole('button', { name: 'Gönder', exact: true })).toBeDisabled();
  await upload.setInputFiles({ name: 'hata.png', mimeType: 'image/png', buffer: screenshot });
  await dialog.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Geri bildiriminiz alındı' })).toBeVisible();
  expect(payload?.message).toBe('');
  expect(payload?.screenshot).toMatchObject({ name: 'hata.png', mime: 'image/png', base64: screenshot.toString('base64') });
  const firstRequest = payload?.requestId;
  await page.getByRole('button', { name: 'Tamam', exact: true }).click();
  await page.getByRole('button', { name: 'Geri bildirim gönder', exact: true }).click();
  await dialog.getByLabel('Ne oldu?', { exact: true }).fill('Bu görseldeki düğme görünmüyor.');
  await upload.setInputFiles({ name: 'ayrinti.png', mimeType: 'image/png', buffer: screenshot });
  await dialog.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Geri bildiriminiz alındı' })).toBeVisible();
  expect(payload?.message).toBe('Bu görseldeki düğme görünmüyor.');
  expect(payload?.screenshot).toMatchObject({ name: 'ayrinti.png' });
  expect(payload?.requestId).not.toBe(firstRequest);
});

test('destek bağlantısı olmayan kurulum başarı mesajı göstermez', async ({ page }) => {
  await page.route('**/api/feedback/availability', route => route.fulfill({ json: { available: false, reason: 'Merkezi destek bağlantısı bu kurulumda henüz etkin değil.' } }));
  await login(page);
  await page.getByRole('button', { name: 'Geri bildirim gönder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Geri bildirim gönder', exact: true });
  await dialog.getByLabel('Ne oldu?', { exact: true }).fill('Bir hata oluştu.');
  await expect(dialog.getByText('Merkezi destek bağlantısı bu kurulumda henüz etkin değil.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Gönder', exact: true })).toBeDisabled();
});

test('yanıt kaybolduktan sonra düzenlenen bildirim açık açıklamayla yeni kimlik alır', async ({ page }) => {
  await page.route('**/api/feedback/availability', route => route.fulfill({ json: { available: true } }));
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/companies/*/feedback', async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await route.fulfill({ status: 503, json: { error: { code: 'FEEDBACK_UNREACHABLE', message: 'Yanıt alınamadı.' } } });
    else if (bodies.length === 2) await route.fulfill({ status: 409, json: { error: { code: 'FEEDBACK_REQUEST_CONFLICT', message: 'Aynı bildirim kimliği farklı bir içerikle gönderilemez' } } });
    else await route.fulfill({ status: 201, json: { feedback: receipt } });
  });
  await login(page);
  await page.getByRole('button', { name: 'Geri bildirim gönder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Geri bildirim gönder', exact: true });
  await dialog.getByLabel('Ne oldu?', { exact: true }).fill('Kaydet düğmesi görünmüyor.');
  await dialog.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(dialog.getByText('Yanıt alınamadı.')).toBeVisible();
  await dialog.getByLabel('Ne oldu?', { exact: true }).fill('Kaydet düğmesi dar ekranda görünmüyor.');
  await dialog.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(dialog.getByText(/Önceki gönderiminiz alınmış/)).toBeVisible();
  await expect(dialog.getByLabel('Ne oldu?', { exact: true })).toHaveValue('Kaydet düğmesi dar ekranda görünmüyor.');
  await dialog.getByRole('button', { name: 'Gönder', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Geri bildiriminiz alındı' })).toBeVisible();
  expect(bodies[1].requestId).toBe(bodies[0].requestId);
  expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
  expect(bodies[2].message).toBe('Kaydet düğmesi dar ekranda görünmüyor.');
});
