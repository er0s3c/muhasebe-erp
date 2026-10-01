import { expect, test, type Page } from '@playwright/test';

async function signUpWithCompany(page: Page, tag: string) {
  const email = `e2e-${tag}-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Selin Yücel');
  await page.getByLabel('Firma / kuruluş adı').fill('Yücel Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel İnşaat Ltd.');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
}

test('yazdırma: kabuk gizlenir, kurumsal antet ve tablo başlığı görünür, sayfa başlığı ve yönü ayarlanır, PDF üretilir', async ({ page }) => {
  await signUpWithCompany(page, 'yazdir');
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Mizan' }).click();
  await expect(page.getByRole('heading', { name: 'Mizan', level: 1 })).toBeVisible();

  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  // Ekran kabuğu basılmaz; antet ve rapor başlığı görünür
  await expect(page.getByRole('navigation', { name: 'Ana menü' })).toBeHidden();
  await expect(page.locator('.print-letterhead')).toBeVisible();
  await expect(page.locator('.print-letterhead')).toContainText('Yücel İnşaat Ltd.');
  await expect(page.getByRole('button', { name: /PDF olarak kaydet|Dışa aktar/ })).toBeHidden();
  // Yazdırma öncesi: belge başlığı rapor adından üretilir, sayfa kuralı eklenir
  expect(await page.title()).toContain('Mizan');
  expect(await page.locator('style[data-print-dynamic]').count()).toBe(1);
  expect(await page.locator('style[data-print-dynamic]').textContent()).toContain('Sayfa ');

  const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  expect(pdf.length).toBeGreaterThan(5_000);

  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  expect(await page.locator('style[data-print-dynamic]').count()).toBe(0);
});
