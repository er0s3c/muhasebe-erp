/**
 * Videoda kullanılan ekran görüntülerini çalışan uygulamadan (demo verisiyle) alır → public/shots/*.png
 *
 * Önkoşul (depo kökünde): npm install, demo verisi (npm run db:seed) ve npm run dev.
 *   npm run shots            (PW_CHROMIUM_PATH ile hazır bir Chromium gösterilebilir)
 *
 * Not: Demo verisi bugünün tarihine göre üretilir; ekranlardaki tarihler çekim gününe bağlıdır.
 */
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.SHOTS_BASE ?? 'http://localhost:5173';
const OUT = new URL('../public/shots/', import.meta.url).pathname;
const EMAIL = 'demo@ornek.local';
const PASSWORD = 'Demo-Sifre-123';

const ROUTES: [string, string][] = [
  ['/accounting/journal', 'journal'],
  ['/settings/currencies', 'currencies'],
  ['/treasury/accounts', 'treasury'],
  ['/treasury/transactions', 'treasury-tx'],
  ['/subcontracts', 'subcontracts'],
  ['/real-estate/contracts', 'contracts'],
  ['/settings/members', 'members'],
  ['/invoices/sales', 'sales-invoices'],
];

const settle = (p: Page, ms = 1200) => p.waitForLoadState('networkidle').then(() => p.waitForTimeout(ms));

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'tr-TR', timezoneId: 'Europe/Nicosia', deviceScaleFactor: 1.2 });
const page = await context.newPage();

await page.goto(`${BASE}/login`);
await settle(page);
await page.getByLabel('E-posta').fill(EMAIL);
await page.getByLabel('Şifre').fill(PASSWORD);
await page.getByRole('button', { name: 'Giriş yap' }).click();
await page.getByRole('heading', { name: /Merhaba/ }).waitFor();
await settle(page, 1500);
await page.screenshot({ path: `${OUT}dashboard.png` });

// Sayfa yenilemek oturumu düşürebildiği için uygulama içi yönlendirme (history) kullanılır.
const open = async (path: string) => {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await settle(page, 1500);
  if (page.url().includes('/login')) throw new Error(`Oturum düştü: ${path}`);
};

for (const [path, name] of ROUTES) {
  await open(path);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('  ✓', name);
}

await open('/projects');
await page.locator('tbody tr').first().click();
await page.getByRole('heading', { level: 1 }).first().waitFor();
await settle(page, 1500);
await page.screenshot({ path: `${OUT}project-detail.png` });
console.log('  ✓ project-detail');

await open('/invoices/sales');
await page.locator('tbody tr').first().click();
await settle(page, 1500);
await page.screenshot({ path: `${OUT}invoice-detail.png` });
console.log('  ✓ invoice-detail');

await browser.close();
