import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const directory = '.cache/ui-audit/details';
const results: {
  path: string;
  viewport: number;
  uuid: string[];
  raw: string[];
  overflow: boolean;
  error: boolean;
}[] = [];
async function inspect(page: Page, path: string) {
  await page.goto(path, { timeout: 20_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    const result = await page.locator('main').evaluate((main) => ({
      uuid:
        main.innerText.match(
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        ) ?? [],
      raw: main.innerText
        .split(/\s+/)
        .filter((v) =>
          /^(cancelled|published|draft|completed|configured|disconnected|quarantine|no_data|actual|standard)$/.test(
            v,
          ),
        ),
      overflow: document.documentElement.scrollWidth > innerWidth + 2,
      mainOverflow: main.scrollWidth > main.clientWidth + 2,
      error: /Beklenmeyen bir hata oluştu|Sayfa bulunamadı|Bu bölüm şirketinizde etkin değil/.test(
        main.innerText,
      ),
    }));
    results.push({ path, viewport: width, ...result });
    mkdirSync(directory, { recursive: true });
    await page.screenshot({
      path: `${directory}/${path.replace(/[^a-z0-9]+/gi, '-')}-${width}.png`,
    });
    writeFileSync(`${directory}/report.json`, JSON.stringify(results, null, 2));
    expect.soft(result.uuid, path).toEqual([]);
    expect.soft(result.raw, path).toEqual([]);
    expect.soft(result.overflow, path).toBe(false);
    expect.soft(result.mainOverflow, path + ' içerik yatay taşması').toBe(false);
    expect.soft(result.error, path).toBe(false);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
}

test('kayıt ayrıntıları, yeni belge ekranları ve nakit tahmini seçenekleri', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await page.goto('/login');
  await page.getByLabel('E-posta').fill('demo@ornek.local');
  await page.getByLabel('Şifre', { exact: true }).fill('Demo-Sifre-123');
  const logged = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  const auth = { authorization: 'Bearer ' + (await (await logged).json()).accessToken };
  await page.getByRole('button', { name: 'Şirket değiştir' }).click();
  await page.getByRole('menuitem', { name: /Örnek İnşaat Ltd/ }).click();
  const me = await (await request.get('/api/me', { headers: auth })).json();
  const company = me.companies.find((c: { name: string }) => c.name === 'Örnek İnşaat Ltd.');
  const headers = { ...auth, 'x-company-id': company.id };
  for (const [api, path] of [
    ['/api/parties', '/parties/'],
    ['/api/items', '/inventory/items/'],
    ['/api/invoices', '/invoices/'],
    ['/api/delivery-notes', '/delivery-notes/'],
    ['/api/price-lists', '/price-lists/'],
    ['/api/treasury/accounts', '/treasury/accounts/'],
    ['/api/projects', '/projects/'],
    ['/api/subcontracts', '/subcontracts/'],
    ['/api/employees', '/hr/employees/'],
    ['/api/directory/contacts', '/directory/contacts/'],
    ['/api/directory/organizations', '/directory/organizations/'],
  ]) {
    const response = await request.get(api!, { headers });
    expect(response.ok(), api + ' ' + (await response.text())).toBeTruthy();
    const body = await response.json();
    const records = Object.values(body).find(Array.isArray) as { id: string }[] | undefined;
    expect(records?.[0]?.id, api + ' demo kaydı').toBeTruthy();
    await inspect(page, path + records![0]!.id);
  }
  for (const path of [
    '/invoices/new',
    '/delivery-notes/new',
    '/sales/docs/new',
    '/inventory/imports/new',
    '/account/security',
    '/settings/notifications',
  ])
    await inspect(page, path);
  await inspect(page, '/treasury/cash-forecast');
  const changed = page.waitForResponse(
    (r) => r.url().includes('/api/cash-forecast?') && r.url().includes('timing=conservative'),
  );
  await page.getByLabel('Tahmin yöntemi').selectOption('conservative');
  expect((await changed).ok()).toBeTruthy();
  const delayed = page.waitForResponse(
    (r) => r.url().includes('/api/cash-forecast?') && r.url().includes('collectionDelayDays=14'),
  );
  await page.getByLabel('Ek tahsilat gecikmesi (gün)').selectOption('14');
  expect((await delayed).ok()).toBeTruthy();
  await expect(page.getByText('Tahminin dayanağı', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Tahmin yöntemi')).toHaveValue('conservative');
});

test('deri uzmanlaşması ve mağaza alt ekranları tasarım dilini korur', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const email = `ui-leather-${Date.now()}@example.com`,
    password = 'Sifre-12345-xyz';
  const registered = await request.post('/api/auth/register', {
    data: {
      email,
      password,
      fullName: 'Arayüz incelemesi',
      organizationName: 'Arayüz test kuruluşu',
    },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const headers = { authorization: 'Bearer ' + (await registered.json()).accessToken };
  const created = await request.post('/api/companies', {
    headers,
    data: { name: 'Deri arayüz test şirketi', sector: 'LEATHER_FASHION' },
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.getByRole('button', { name: 'Şirket değiştir' }).waitFor();
  for (const path of [
    '/leather',
    '/leather/models',
    '/leather/materials',
    '/leather/production',
    '/leather/subcontracts',
    '/leather/quality',
    '/leather/custom-orders',
    '/leather/service',
    '/pos',
    '/pos/sessions',
    '/pos/settings',
  ]) {
    await inspect(page, path);
    if (path.startsWith('/pos')) {
      await expect(
        page.getByRole('navigation', { name: 'Mağaza ekranları' }).locator('[aria-current="page"]'),
      ).toHaveAttribute('href', path);
    }
  }
});

test('depo sekmeleri ilgili formu gösterir ve kalite işlemi yan panelde açılır', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill('demo@ornek.local');
  await page.getByLabel('Şifre', { exact: true }).fill('Demo-Sifre-123');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.getByRole('button', { name: 'Şirket değiştir' }).click();
  await page.getByRole('menuitem', { name: /Ada Üretim ve Toptan Ticaret Demo/ }).click();
  await page.goto('/wms');
  await page.waitForLoadState('networkidle');
  for (const [tab, form] of [
    ['Partiler', 'Kabul partisi ekle'],
    ['Raflar', 'Raf ekle'],
    ['Yerleştirmeler', 'Rafa yerleştir'],
  ]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('main').getByRole('form')).toHaveCount(1);
    await expect(page.getByRole('form', { name: form })).toBeVisible();
    if (tab === 'Yerleştirmeler') {
      await expect(page.getByRole('columnheader', { name: 'Yerleştirilen miktar' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Kalan miktar' })).toHaveCount(0);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)).toBe(
      false,
    );
    await page.screenshot({ path: `${directory}/wms-${tab}-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.screenshot({ path: `${directory}/wms-${tab}.png` });
  }
  await page.getByRole('tab', { name: 'Partiler', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Kalite kararı', exact: true }).first();
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'Kalite kararı' });
  await expect(panel.getByRole('spinbutton', { name: 'Serbest miktar' })).toBeVisible();
  await expect(panel.getByRole('form')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)).toBe(
    false,
  );
  await page.screenshot({ path: `${directory}/wms-quality-panel-mobile.png` });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
