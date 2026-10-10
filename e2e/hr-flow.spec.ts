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
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
}

test('personel: kart aç → hassas alan maskeli → gerekçeyle göster → erişim günlüğü → veri dışa aktar', async ({ page }) => {
  await signUpWithCompany(page, 'hr');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  await nav.getByRole('link', { name: 'Personel' }).click();
  await page.getByRole('button', { name: 'Yeni personel' }).first().click();
  await dialog.getByLabel('Ad soyad').fill('Ali Demir');
  await dialog.getByLabel('Kimlik / pasaport no').fill('12345678901');
  await dialog.getByLabel('Departman').fill('Şantiye');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Ali Demir/, level: 1 })).toBeVisible();

  // Maskeli
  await expect(page.getByText('•••8901')).toBeVisible();
  await expect(page.getByText('12345678901')).toHaveCount(0);

  // Gerekçeyle göster
  await page.getByRole('button', { name: /Göster: Kimlik/ }).click();
  await dialog.getByLabel('Gerekçe').fill('SGK bildirimi hazırlığı');
  await dialog.getByRole('button', { name: 'Göster', exact: true }).click();
  await expect(page.getByText('12345678901')).toBeVisible();

  // Veri koruma: erişim günlüğünde görünür
  await nav.getByRole('link', { name: 'Veri koruma' }).click();
  await page.getByRole('tab', { name: 'Erişim günlüğü' }).click();
  await expect(page.getByRole('row', { name: /Ali Demir.*SGK bildirimi hazırlığı/ })).toBeVisible();

  // Talep + veri dışa aktarma
  await page.getByRole('tab', { name: 'Talepler' }).click();
  await page.getByRole('button', { name: 'Talep ekle' }).first().click();
  await dialog.getByLabel('Talep eden').fill('Ali Demir');
  await dialog.getByLabel('Tür').selectOption('export');
  await dialog.getByLabel('Kişi').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Talep kaydedildi')).toBeVisible();
  await page.getByRole('button', { name: 'Veriyi dışa aktar' }).click();
  await dialog.getByRole('button', { name: 'İndir' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Veriyi dışa aktar' })).toContainText('Ali Demir');
});
