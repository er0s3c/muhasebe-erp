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

test('modüller: bağımlılık korumalı kapatma, menü/panel/sayfa kapıları ve yeniden açma', async ({ page }) => {
  await signUpWithCompany(page, 'moduller');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  await expect(nav.getByRole('link', { name: 'Satış faturaları' })).toBeVisible();
  await expect(page.getByText('Bu ay satışlar (net)')).toBeVisible();

  await nav.getByRole('link', { name: 'Modüller' }).click();
  await expect(page.getByRole('heading', { name: 'Modüller', level: 1 })).toBeVisible();

  // Zorunlu modüller ve başka modüllerin gerektirdiği modüller kapatılamaz; nedeni yazar
  await expect(page.getByRole('switch', { name: /^Genel bakış/ })).toBeDisabled();
  await expect(page.getByRole('switch', { name: /^Ayarlar/ })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Stok: Kapat' })).toBeDisabled();
  await expect(page.getByTestId('module-core.inventory')).toContainText('Önce bu modüle bağlı şu modülleri kapatın');
  // Planlı modül "yakında" olarak görünür ve açılamaz
  await expect(page.getByTestId('module-construction.projects')).toContainText('Yakında');
  await expect(page.getByRole('switch', { name: /^Şantiye ve projeler/ })).toBeDisabled();

  // Faturayı kapat: menü grubu, panel sayaçları ve sayfa kalkar
  await page.getByRole('switch', { name: 'Fatura ve irsaliye: Kapat' }).click();
  await expect(page.getByText('Fatura ve irsaliye kapatıldı')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Satış faturaları' })).toHaveCount(0);
  // Faturaya bağlı olanlar artık serbest: stok kapatılabilir hale gelir (kasa ve banka hâlâ açık)
  await expect(page.getByRole('switch', { name: 'Stok: Kapat' })).toBeEnabled();
  await expect(page.getByRole('switch', { name: 'Fatura ve irsaliye: Aç' })).toBeEnabled();
  await page.getByRole('link', { name: 'Genel bakış' }).first().click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
  await expect(page.getByText('Bu ay satışlar (net)')).toHaveCount(0);
  await page.goto('/invoices/sales');
  await expect(page.getByText('Bu bölüm şirketinizde etkin değil')).toBeVisible();

  // Stoğu da kapat; sonra faturayı açmak için önce stoğun açılması gerektiği söylenir
  await nav.getByRole('link', { name: 'Modüller' }).click();
  await page.getByRole('switch', { name: 'Stok: Kapat' }).click();
  await expect(page.getByText('Stok kapatıldı')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Stok kartları' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Fatura ve irsaliye: Aç' })).toBeDisabled();
  await expect(page.getByTestId('module-core.invoices')).toContainText('Açmak için önce şunları açın');

  // Sırayla geri aç
  await page.getByRole('switch', { name: 'Stok: Aç' }).click();
  await expect(page.getByText('Stok açıldı')).toBeVisible();
  await page.getByRole('switch', { name: 'Fatura ve irsaliye: Aç' }).click();
  await expect(page.getByText('Fatura ve irsaliye açıldı')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Satış faturaları' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Stok kartları' })).toBeVisible();
});
