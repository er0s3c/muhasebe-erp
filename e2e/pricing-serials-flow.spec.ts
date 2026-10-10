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

/** Tutarlar YALNIZCA TEST AMAÇLIDIR; KDV oranı sistemin tohumladığı doğrulanmamış varsayılandır. */
test('fiyat listesi ve cari iskonto satıra yansır; seri takipli kart: giriş → satış → sorgu → iptal', async ({ page }) => {
  test.setTimeout(180_000);
  await signUpWithCompany(page, 'fiyat-seri');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (name: string, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: müşteri ve seri takipli, satış fiyatı 100 ₺ olan stok kartı
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Ömer Çakır Ticaret');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Ömer Çakır Ticaret', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await page.getByRole('button', { name: 'Yeni stok kartı' }).first().click();
  await page.getByLabel('Ürün / hizmet adı').fill('Dizüstü bilgisayar');
  await dialog.getByLabel('KDV oranı').selectOption('KDV-16');
  await dialog.getByLabel('Satış fiyatı').fill('100');
  await dialog.getByRole('checkbox', { name: /Seri no takibi/ }).check();
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Dizüstü bilgisayar', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Seri takipli' })).toBeVisible();

  // Seri takipli kartta miktar kadar seri no gerekir
  await page.getByRole('button', { name: 'Stok girişi' }).click();
  await dialog.getByLabel('Miktar 1').fill('2');
  await dialog.getByLabel('Birim maliyet 1').fill('50');
  await expect(dialog.getByTestId('serial-count')).toHaveText('Seri no: 0/2');
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(dialog.getByText(/kadar seri no girilmeli/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Seri no gir 1' }).click();
  await page.getByRole('textbox', { name: "Seri no'lar" }).fill('sn-100\nsn-101');
  await page.getByRole('button', { name: "2 seri no'yu uygula" }).click();
  await expect(dialog.getByTestId('serial-count')).toHaveText('Seri no: 2/2');
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(page.getByText(/Stok hareketi kaydedildi: SH-\d{4}-000001/)).toBeVisible();
  await page.keyboard.press('Escape');

  // Fiyat listesi: Bayi listesinde kart 90 ₺
  await nav.getByRole('link', { name: 'Fiyat listeleri' }).click();
  await expect(page.getByText('Henüz fiyat listesi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni liste' }).first().click();
  await dialog.getByLabel('Kod').fill('BAYI');
  await dialog.getByLabel('Ad').fill('Bayi listesi');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Bayi listesi', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Fiyat satırı ekle' }).first().click();
  const itemBox = dialog.getByRole('combobox', { name: 'Stok kartı' });
  await itemBox.click();
  await itemBox.fill('dizüstü');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('Birim fiyat').fill('90');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Fiyat satırı eklendi')).toBeVisible();
  await expect(page.getByRole('row', { name: /Dizüstü bilgisayar/ })).toContainText('90');

  // Cariye liste ve %5 genel iskonto ata
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('row', { name: /Ömer Çakır Ticaret/ }).click();
  await page.getByRole('tab', { name: 'Kart bilgileri' }).click();
  await page.getByLabel('Satış fiyat listesi').selectOption({ index: 1 });
  await page.getByLabel('Satış genel iskontosu %').fill('5');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Fiyat ayarları kaydedildi')).toBeVisible();

  // Teklif satırı: fiyat 90 (cari listesi), iskonto %5; kaynağı görünür; elle değişir
  await nav.getByRole('link', { name: 'Satış teklifleri' }).click();
  await page.getByRole('button', { name: 'Yeni teklif' }).first().click();
  await pick('Müşteri', 'Ömer');
  await pick('Kart / hizmet 1', 'dizüstü');
  await expect(page.getByLabel('Birim fiyat 1')).toHaveValue('90,00');
  await expect(page.getByLabel('İskonto % 1')).toHaveValue('5');
  await expect(page.getByTestId('price-source')).toContainText('cari listesi: Bayi listesi');
  await page.getByLabel('Birim fiyat 1').fill('80');
  await expect(page.getByTestId('price-source')).toHaveCount(0);

  // Satış faturası: seri no zorunlu; SN-100 satılır, kaynak/iskonto görünür
  await nav.getByRole('link', { name: 'Satış faturaları' }).click();
  await page.getByRole('button', { name: 'Yeni satış faturası' }).first().click();
  await pick('Müşteri', 'Ömer');
  await pick('Kart / hizmet 1', 'dizüstü');
  await expect(page.getByLabel('Birim fiyat 1')).toHaveValue('90,00');
  await page.getByRole('button', { name: 'Seri no gir 1' }).click();
  await page.getByRole('textbox', { name: "Seri no'lar" }).fill('sn-100');
  await page.getByRole('button', { name: "1 seri no'yu uygula" }).click();
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /SF-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByTestId('line-serials')).toContainText('SN-100');

  // Seri no sorgula: SN-100 müşteriye çıktı; geçmişte giriş ve çıkış
  await nav.getByRole('link', { name: 'Seri no sorgula' }).click();
  await page.getByLabel('Seri no ara').fill('sn-10');
  await expect(page.getByRole('row', { name: /SN-100/ })).toContainText('Müşteriye çıktı');
  await expect(page.getByRole('row', { name: /SN-101/ })).toContainText('Depoda');
  await page.getByRole('button', { name: 'SN-100' }).click();
  await expect(page.getByRole('dialog')).toContainText('Ömer Çakır Ticaret');
  await expect(page.getByRole('dialog').getByRole('row', { name: /Giriş/ })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('row', { name: /Çıkış/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Fatura iptali serileri depoya döndürür
  await nav.getByRole('link', { name: 'Satış faturaları' }).click();
  await page.getByRole('row', { name: /SF-\d{4}-000001/ }).click();
  await page.getByRole('button', { name: 'Faturayı iptal et' }).click();
  await dialog.getByLabel('İptal nedeni').fill('Hatalı fatura');
  await dialog.getByRole('button', { name: 'Faturayı iptal et' }).click();
  await expect(page.getByText('Fatura iptal edildi')).toBeVisible();
  await nav.getByRole('link', { name: 'Seri no sorgula' }).click();
  await page.getByLabel('Seri no ara').fill('sn-100');
  await expect(page.getByRole('row', { name: /SN-100/ })).toContainText('Depoda');
});
