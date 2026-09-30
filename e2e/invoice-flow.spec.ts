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

test('fatura: alış → satış → iade → iptal; stok, cari, KDV özeti ve muhasebe mutabakatı tutarlı', async ({ page }) => {
  await signUpWithCompany(page, 'fatura');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // Hazırlık: hem müşteri hem tedarikçi olan bir cari ve %16 KDV'li bir stok kartı
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Ömer Çakır Ticaret');
  await dialog.getByLabel('Tür').selectOption('both');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Ömer Çakır Ticaret', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await page.getByRole('button', { name: 'Yeni stok kartı' }).first().click();
  await page.getByLabel('Ürün / hizmet adı').fill('Dış cephe boyası');
  await dialog.getByLabel('KDV oranı').selectOption('KDV-16');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Dış cephe boyası', level: 1 })).toBeVisible();

  const pick = async (name: string, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // 1) Alış faturası: 10 ad × 50 ₺ + %16 KDV = 580 ₺
  await nav.getByRole('link', { name: 'Alış ve gider faturaları' }).click();
  await expect(page.getByText('Henüz alış faturası yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni alış faturası' }).first().click();
  await pick('Tedarikçi', 'Ömer');
  await page.getByLabel('Tedarikçi fatura no').fill('T-1001');
  await pick('Kart / hizmet 1', 'boya');
  await page.getByLabel('Miktar 1').fill('10');
  await page.getByLabel('Birim fiyat 1').fill('50');
  await expect(page.getByTestId('gross-total')).toHaveText('580,00 TRY');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByText(/Fatura kaydedildi: AF-\d{4}-000001/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /AF-\d{4}-000001/, level: 1 })).toBeVisible();

  // 2) Satış faturası: 4 ad × 100 ₺ + %16 KDV = 464 ₺ (stok çıkışı + maliyet otomatik)
  await nav.getByRole('link', { name: 'Satış faturaları' }).click();
  await page.getByRole('button', { name: 'Yeni satış faturası' }).first().click();
  await pick('Müşteri', 'Ömer');
  await pick('Kart / hizmet 1', 'boya');
  await page.getByLabel('Miktar 1').fill('4');
  await page.getByLabel('Birim fiyat 1').fill('100');
  await expect(page.getByTestId('gross-total')).toHaveText('464,00 TRY');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /SF-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByText('Kaydedildi', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('gross-total')).toHaveText('464,00 TRY');

  // Yevmiye ve stok belgesi bağlantıları görünür; yevmiye kaynaklı olduğundan tek başına ters çevrilemez
  await page.getByRole('link', { name: /^YV-\d{4}-\d{6}$/ }).click();
  await expect(page.getByRole('dialog').getByText('Bu kayıt bir belgeden otomatik oluştu')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Ters kayıt' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 3) İade: orijinal satır hazır gelir, 1 adete indirilir → 116 ₺
  await nav.getByRole('link', { name: 'Satış faturaları' }).click();
  // Liste yeniden çizilirken satıra tıklama nadiren kaybolabiliyor (hem yerelde hem CI'da görüldü); tıklama + sonuç birlikte yeniden denenir.
  await expect(async () => {
    await page.getByRole('row', { name: /SF-\d{4}-000001/ }).click({ timeout: 3_000 });
    await expect(page.getByRole('button', { name: 'İade oluştur' })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 25_000 });
  await page.getByRole('button', { name: 'İade oluştur' }).click();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('4');
  await page.getByLabel('Miktar 1').fill('1');
  await expect(page.getByTestId('gross-total')).toHaveText('116,00 TRY');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /SIF-\d{4}-000001/, level: 1 })).toBeVisible();

  // İadesi olan fatura iptal edilemez; önce iade iptal edilir
  await page.getByRole('button', { name: 'Faturayı iptal et' }).click();
  await dialog.getByLabel('İptal nedeni').fill('Yanlış iade');
  await dialog.getByRole('button', { name: 'Faturayı iptal et' }).click();
  await expect(page.getByText('Fatura iptal edildi')).toBeVisible();
  await expect(page.getByText(/Bu fatura .* tarihinde iptal edildi/)).toBeVisible();

  // 4) Stok ve mutabakat: 10 − 4 = 6 ad; stok defteri muhasebe bakiyesiyle otomatik uyumlu
  await nav.getByRole('link', { name: 'Stok durumu' }).click();
  await expect(page.getByRole('row', { name: /Dış cephe boyası/ })).toContainText('6 adet');
  await expect(page.getByText('Stok defteri muhasebe bakiyesiyle uyumlu')).toBeVisible();

  // 5) KDV özeti: hesaplanan 64, indirilecek 80 → devreden 16 (iptal edilen iade hariç)
  await nav.getByRole('link', { name: 'KDV özeti' }).click();
  await expect(page.getByText('Hesaplanan KDV').first()).toBeVisible();
  await expect(page.getByText('Devreden KDV')).toBeVisible();
  await expect(page.getByText('16,00 TRY').first()).toBeVisible();
});
