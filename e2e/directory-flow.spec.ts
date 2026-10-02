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

test('rehber: kurum + kişi ekle → görüşme notu → takip görevi ajandada → dışa aktarma', async ({ page }) => {
  await signUpWithCompany(page, 'rehber');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // Kurum
  await nav.getByRole('link', { name: 'Kurum rehberi' }).click();
  await page.getByRole('button', { name: 'Kurum ekle' }).first().click();
  await dialog.getByLabel('Kurum adı').fill('Örnek Bankası');
  await dialog.getByLabel('Kategori').fill('Banka');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Örnek Bankası', level: 1 })).toBeVisible();

  // Kişi
  await nav.getByRole('link', { name: 'Kişi rehberi' }).click();
  await expect(page.getByRole('heading', { name: 'Kişi rehberi', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Kişi ekle' }).first().click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Ad soyad').fill('Ahmet Yılmaz');
  await dialog.getByLabel('Telefon', { exact: true }).fill('0392 222 00 00');
  await dialog.getByLabel('E-posta', { exact: true }).fill('ahmet@ornek.com');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Ahmet Yılmaz', level: 1 })).toBeVisible();

  // Görüşme notu
  await page.getByRole('button', { name: 'Not ekle' }).first().click();
  await dialog.getByLabel('Özet').fill('Kredi limiti görüşüldü');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Kredi limiti görüşüldü')).toBeVisible();

  // Takip görevi
  await page.getByRole('button', { name: 'Takip görevi' }).first().click();
  await dialog.getByRole('button', { name: 'Görev oluştur' }).click();
  await expect(page.getByText('Takip görevi ajandaya eklendi')).toBeVisible();

  // Ajanda: bugün
  await nav.getByRole('link', { name: 'Ajanda' }).click();
  await expect(page.getByTestId('agenda-today').getByText('Takip: Ahmet Yılmaz')).toBeVisible();

  // Dışa aktarma (kişiler)
  await nav.getByRole('link', { name: 'Kişi rehberi' }).click();
  await expect(page.getByRole('row', { name: /Ahmet Yılmaz/ })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Dışa aktar' }).click();
  await page.getByRole('menuitem', { name: /Excel \(\.xlsx\)/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^rehber-kisiler-.*\.xlsx$/);
});
