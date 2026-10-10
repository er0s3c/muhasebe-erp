import { expect, test } from './fixtures';

test('sol üstteki logo ve ad ana sayfaya götürür', async ({ page }) => {
  const email = `e2e-logo-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Selin Yücel');
  await page.getByLabel('Firma / kuruluş adı').fill('Yücel Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel İnşaat Ltd.');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Cari hesaplar' }).click();
  await expect(page).toHaveURL(/\/parties/);
  await page.getByRole('link', { name: 'Ana sayfa' }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
});
