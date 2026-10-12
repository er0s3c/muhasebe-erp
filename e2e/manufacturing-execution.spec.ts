import { mkdirSync } from 'node:fs';
import { test, expect } from './fixtures';

test('yürütme ekranları, açık üretim taahhüdü ve sarf edilmemiş demo teslimi', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  mkdirSync('.cache/ui-audit/execution', { recursive: true });
  await page.goto('/login');
  await page.getByLabel('E-posta').fill('demo@ornek.local');
  await page.getByLabel('Şifre', { exact: true }).fill('Demo-Sifre-123');
  const login = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  const token = (await (await login).json()).accessToken;
  await page.getByRole('button', { name: 'Şirket değiştir' }).click();
  await page.getByRole('menuitem', { name: /Ada Üretim ve Toptan Ticaret Demo/ }).click();
  const me = await (
    await request.get('/api/me', { headers: { authorization: 'Bearer ' + token } })
  ).json();
  const company = me.companies.find(
    (c: { sector: string }) => c.sector === 'MANUFACTURING_WHOLESALE',
  );
  const headers = { authorization: 'Bearer ' + token, 'x-company-id': company.id };
  const orders = await (
    await request.get('/api/manufacturing/production/orders', { headers })
  ).json();
  const delivered = orders.orders.find((o: { note: string }) => o.note?.includes('Atölye teslimi'));
  expect(delivered).toBeTruthy();
  const execution = await (
    await request.get(`/api/manufacturing/production/orders/${delivered.id}/execution`, { headers })
  ).json();
  const deliveredMaterial = execution.materials.find((m: { handed: string }) => Number(m.handed) > 0);
  expect(deliveredMaterial?.itemName).toBeTruthy();
  const promiseLookups = await (await request.get('/api/manufacturing/promise/lookups', { headers })).json();
  const allocations = await (await request.get('/api/manufacturing/allocations', { headers })).json();
  const promiseOrder = promiseLookups.orders.find((o: { code: string }) => o.code === allocations.records[0]?.orderCode);
  expect(promiseOrder).toBeTruthy();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const [path, title] of [
    ['/manufacturing/promise', 'Sipariş taahhüdü ve tahsis'],
    ['/manufacturing/shop-floor', 'Atölye iş ekranı'],
    ['/manufacturing/supply', 'Tedarik ve stok politikaları'],
    ['/manufacturing/exceptions', 'Müdahale bekleyen işler'],
    ['/manufacturing/planning', 'Kapasite ve termin planlama'],
    ['/integrations', 'Entegrasyonlar'],
  ]) {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    if (path.endsWith('promise')) {
      await page.getByLabel(/^Onaylı sipariş/).selectOption(promiseOrder.id);
      await page.getByLabel(/^Mamul deposu/).selectOption(promiseLookups.warehouses[0].id);
      const response = page.waitForResponse(r => r.url().endsWith('/api/manufacturing/promise') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Taahhüt hesapla', exact: true }).click();
      const result = await (await response).json();
      expect(Number(result.lines[0].openProductionQty)).toBeGreaterThan(0);
      expect(result.lines[0].expectedAt).toBeNull();
      await expect(page.getByRole('columnheader', { name: 'Açık üretimden', exact: true })).toBeVisible();
      await expect(page.getByRole('main')).toContainText('yayımlanmış gelecek plan yok');
    }
    if (path.endsWith('shop-floor')) {
      await page.getByLabel('Atanmış üretim emri', { exact: true }).selectOption(delivered.id);
      await expect(
        page.getByRole('heading', { name: 'Malzeme sarf ve iade mutabakatı', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('columnheader', { name: 'Atölyeye teslim', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('row').filter({ hasText: deliveredMaterial.itemName }).first(),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Üretim partisi oluştur', exact: true })).toBeVisible();
    }
    await expect(page.getByRole('main')).not.toContainText(
      /Beklenmeyen bir hata|Durum belirtilmedi/,
    );
    await expect(page.getByRole('main')).not.toContainText(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    const file = path.replaceAll('/', '-');
    await page.getByRole('main').evaluate(e => { e.scrollTop = 0; });
    await page.screenshot({
      path: '.cache/ui-audit/execution/desktop' + file + '.png',
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow, path).toBe(false);
    expect(await page.getByRole('main').evaluate(main => main.scrollWidth > main.clientWidth + 2), path + ' içerik taşması').toBe(false);
    await page.getByRole('main').evaluate(e => { e.scrollTop = 0; });
    await page.screenshot({
      path: '.cache/ui-audit/execution/mobile' + file + '.png',
      fullPage: false,
    });
    if (path.endsWith('shop-floor') || path.endsWith('promise')) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
        const main = page.getByRole('main');
        const bounds = await main.evaluate(e => ({ height: e.clientHeight, total: e.scrollHeight }));
        for (let y = bounds.height - 100, section = 1; y < bounds.total; y += bounds.height - 100, section++) {
          await main.evaluate((e, offset) => { e.scrollTop = offset; }, y);
          await page.screenshot({ path: `.cache/ui-audit/execution/${width === 390 ? 'mobile' : 'desktop'}${file}-section-${section}.png` });
        }
      }
    }
  }
  expect(errors).toEqual([]);
});
