import { test, expect } from './fixtures';

const password = 'Demo-Sifre-123',
  companyName = 'Ada Üretim ve Toptan Ticaret Demo';
test('demo hesabında şirket seçimi ve genel üretim ekranları', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('E-posta').fill('demo@ornek.local');
  await page.getByLabel('Şifre', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.getByRole('button', { name: 'Şirket değiştir' }).click();
  await page.getByRole('menuitem', { name: new RegExp(companyName) }).click();
  await page.goto('/manufacturing/mrp');
  await expect(
    page.getByRole('heading', { name: 'Malzeme ihtiyaç planlama', exact: true }),
  ).toBeVisible();
  const form = page.getByRole('form', { name: 'İhtiyaç hesapla' });
  await form.getByLabel(/^Ürün/).selectOption({ label: 'MAM-001 · Standart toptan ürün' });
  await form.getByLabel(/^Depo/).selectOption({ index: 1 });
  await form.getByLabel('Talep adedi').fill('500');
  await form.getByRole('button', { name: 'Hesapla' }).click();
  await expect(page.getByText('Net ihtiyaçlar', { exact: true })).toBeVisible();
  for (const [path, title] of [
    ['catalog', 'Deri model ve koleksiyon'],
    ['production', 'Deri üretim ve atölye'],
    ['planning', 'Kapasite ve termin planlama'],
    ['maintenance', 'Makine bakım ve arıza'],
  ] as const) {
    await page.goto('/manufacturing/' + path);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByText('Beklenmeyen bir hata oluştu', { exact: false })).toHaveCount(0);
    if (path === 'planning') {
      await page.getByRole('button', { name: 'Yeni plan oluştur', exact: true }).click();
      // Not: CI anlık görüntüsünde kontrol adımından sonra pencerenin erişilebilir adı görünmüyordu; başlıkla bulunur
      const plan = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Yeni plan oluştur', exact: true }) });
      const orderSelect = plan.getByLabel('Üretim emri', { exact: true });
      const [selectedOrder] = await orderSelect.selectOption({ label: 'URE-000001' });
      await plan.getByRole('button', { name: 'Ekle', exact: true }).click();
      await expect(orderSelect.locator(`option[value="${selectedOrder}"]`)).toHaveCount(0);
      await expect(plan.getByText('URE-000001', { exact: true })).toBeVisible();
      await plan.getByRole('button', { name: 'Tarihe geç', exact: true }).click();
      await plan.getByRole('button', { name: 'Planı kontrol et', exact: true }).click();
      await expect(plan.getByLabel('Süre (dakika)', { exact: true })).toHaveCount(2);
      const created = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/manufacturing/planning/schedules') &&
          r.request().method() === 'POST',
      );
      await plan.getByRole('button', { name: 'Taslak plan oluştur', exact: true }).click();
      const response = await created;
      expect(response.ok(), await response.text()).toBeTruthy();
      const scenario = (await response.json()).record;
      expect(scenario.operations).toHaveLength(2);
      const planCard = page.getByRole('article', { name: scenario.code, exact: true });
      const published = page.waitForResponse((r) =>
        r.url().endsWith(`/planning/schedules/${scenario.id}/publish`),
      );
      await planCard.getByRole('button', { name: 'Planı yayımla', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Planı yayımla', exact: true })
        .click();
      expect((await published).ok()).toBeTruthy();
      const cancelled = page.waitForResponse((r) =>
        r.url().endsWith(`/planning/schedules/${scenario.id}/cancel`),
      );
      await planCard.getByRole('button', { name: 'Planı iptal et' }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Kapasiteyi serbest bırak' })
        .click();
      expect((await cancelled).ok()).toBeTruthy();
    }
    void title;
  }
  await page.screenshot({ path: 'test-results/manufacturing-demo.png', fullPage: true });
});

test('dokuz demo profili yalnız üretim şirketine erişir; API izinleri menüyle uyumludur', async ({
  request,
  page,
}) => {
  const profiles = [
    ['planlama', '/api/manufacturing/catalog/models', '/api/journal-entries'],
    ['atolye', '/api/manufacturing/production/orders', '/api/manufacturing/costs/allocations'],
    ['depo', '/api/wms/lots', '/api/journal-entries'],
    ['kalite', '/api/manufacturing/quality/checks', '/api/journal-entries'],
    ['satis', '/api/parties', '/api/manufacturing/maintenance'],
    ['muhasebe', '/api/journal-entries', '/api/manufacturing/maintenance'],
    ['bakim', '/api/manufacturing/maintenance/resources', '/api/manufacturing/catalog/models'],
    ['kasiyer', '/api/pos/tills', '/api/treasury/accounts'],
    ['izleyici', '/api/manufacturing/production/orders', '/api/journal-entries'],
  ] as const;
  const owner = await request.post('/api/auth/login', {
    data: { email: 'demo@ornek.local', password },
  });
  expect(owner.ok(), await owner.text()).toBeTruthy();
  const me = await request.get('/api/me', {
    headers: { authorization: 'Bearer ' + (await owner.json()).accessToken },
  });
  const construction = (await me.json()).companies.find(
    (c: { name: string }) => c.name === 'Örnek İnşaat Ltd.',
  );
  for (const [key, allowed, denied] of profiles) {
    const login = await request.post('/api/auth/login', {
      data: { email: `uretim.${key}@ornek.local`, password },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    const token = (await login.json()).accessToken;
    const companies = (
      await (await request.get('/api/me', { headers: { authorization: 'Bearer ' + token } })).json()
    ).companies;
    expect(companies).toHaveLength(1);
    expect(companies[0].name).toBe(companyName);
    const headers = { authorization: 'Bearer ' + token, 'x-company-id': companies[0].id };
    expect((await request.get(allowed, { headers })).status(), key + ' allowed').toBe(200);
    expect((await request.get(denied, { headers })).status(), key + ' denied').toBe(403);
    expect(
      (
        await request.get('/api/company', {
          headers: { ...headers, 'x-company-id': construction.id },
        })
      ).status(),
    ).toBe(403);
  }
  await page.goto('/');
  await page.getByLabel('E-posta').fill('uretim.kasiyer@ornek.local');
  await page.getByLabel('Şifre', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.goto('/pos');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Kasa / Banka', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Muhasebe', exact: true })).toHaveCount(0);
});
