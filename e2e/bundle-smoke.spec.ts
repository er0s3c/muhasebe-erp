import { expect, test } from './fixtures';

// Yalnızca üretim paketi modunda (E2E_TARGET=bundle) koşar: arayüzü API sunar, CSP ve önbellek başlıkları gerçektir.
test.skip(process.env.E2E_TARGET !== 'bundle', 'Üretim paketi modunda çalışır');

test('üretim paketi: CSP ihlali yok, tema betiği ilk boyamadan önce çalışır, başlıklar doğru', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  // Ana betik engellenirse React hiç çalışmaz; yine de koyu tema uygulanmış olmalı (theme-init.js CSP'ye takılmamalı)
  await page.goto('/login');
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.route('**/assets/index-*.js', (r) => r.abort());
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.unroute('**/assets/index-*.js');

  // Normal yükleme: arayüz açılır, CSP ihlali yok
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hesabınıza giriş yapın', level: 1 })).toBeVisible();
  expect(problems).toEqual([]);

  // Başlıklar: index.html her seferinde doğrulanır, özetli varlık 1 yıl değişmez, olmayan varlık gerçek 404
  const index = await page.request.get('/', { headers: { accept: 'text/html' } });
  expect(index.headers()['cache-control']).toBe('no-cache');
  expect(index.headers()['content-security-policy']).toContain("script-src 'self'");
  const asset = /\/assets\/index-[^"']+\.js/.exec(await index.text())?.[0];
  expect(asset).toBeTruthy();
  expect((await page.request.get(asset!)).headers()['cache-control']).toContain('immutable');
  const missing = await page.request.get('/assets/eski-yok.js', { headers: { accept: 'text/html' } });
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toContain('application/json');
});
