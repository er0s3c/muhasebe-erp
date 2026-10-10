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

test('değişiklik emri: yürürlükteki taşeron sözleşmesi → DE (ek kalem + miktar + süre) → onay → güncel bedel ve bitiş, yazdırma', async ({ page }) => {
  await signUpWithCompany(page, 'de');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (name: string | RegExp, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: taşeron cari, proje + iş kalemi
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Elektrik Taşeron Ltd.');
  await dialog.getByLabel('Tür').selectOption('supplier');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Elektrik Taşeron Ltd.', level: 1 })).toBeVisible();
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('button', { name: 'Yeni proje' }).first().click();
  await dialog.getByLabel('Proje adı').fill('Güneş Sitesi');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Güneş Sitesi', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Başlat' }).click();
  await expect(page.getByText('Proje durumu: Aktif')).toBeVisible();
  await page.getByRole('tab', { name: 'İş kırılımı' }).click();
  await page.getByRole('button', { name: 'İş kalemi ekle' }).first().click();
  await dialog.getByLabel('Kod').fill('03');
  await dialog.getByRole('textbox', { name: /^Ad/ }).fill('Elektrik');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('row', { name: /03 Elektrik/ })).toBeVisible();

  // Sözleşme: bitiş 30.06.2027, BOQ 1000 m × 3 + 10 adet × 500 = 8.000
  await nav.getByRole('link', { name: 'Taşeron sözleşmeleri' }).click();
  await page.getByRole('button', { name: 'Yeni sözleşme' }).first().click();
  await dialog.getByRole('combobox', { name: /Proje/ }).click();
  await dialog.getByRole('combobox', { name: /Proje/ }).fill('Güneş');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByRole('combobox', { name: /Taşeron/ }).click();
  await dialog.getByRole('combobox', { name: /Taşeron/ }).fill('Elektrik');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('İş tanımı').fill('Elektrik tesisatı');
  await dialog.getByLabel('Başlangıç').fill('2027-01-01');
  await dialog.getByLabel('Bitiş').fill('2027-06-30');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Elektrik tesisatı/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Satır ekle' }).first().click();
  await page.getByLabel('Tanım 1').fill('Kablo çekimi');
  await page.getByLabel('Birim 1').fill('m');
  await page.getByLabel('Miktar 1').fill('1000');
  await page.getByLabel('Birim fiyat 1').fill('3');
  await pick('İş kalemi 1', '03');
  await page.getByRole('button', { name: 'Satır ekle' }).first().click();
  await page.getByLabel('Tanım 2').fill('Pano kurulumu');
  await page.getByLabel('Birim 2').fill('adet');
  await page.getByLabel('Miktar 2').fill('10');
  await page.getByLabel('Birim fiyat 2').fill('500');
  await pick('İş kalemi 2', '03');
  await page.getByRole('button', { name: 'Onayla ve yürürlüğe al' }).click();
  await expect(page.getByText('Revizyon onaylandı')).toBeVisible();
  // Yürürlükteki sözleşmede düz revizyon düğmesi yok
  await expect(page.getByRole('button', { name: 'Yeni revizyon' })).toHaveCount(0);

  // DE oluştur: süre uzatımı 15 gün
  await page.getByRole('tab', { name: 'Değişiklik emirleri' }).click();
  await expect(page.getByText('Değişiklik emri yok')).toBeVisible();
  await page.getByRole('button', { name: 'Değişiklik emri oluştur' }).click();
  await dialog.getByLabel('Konu').fill('Bahçe aydınlatması');
  await dialog.getByLabel('Gerekçe').selectOption('client_request');
  await dialog.getByLabel('Süre uzatımı (gün)').fill('15');
  await dialog.getByRole('button', { name: 'Oluştur' }).click();
  await expect(page.getByRole('heading', { name: /DE-0001/, level: 1 })).toBeVisible();

  // BOQ: pano 10 → 12 (+1.000), yeni kalem 20 adet × 250 (+5.000)
  await page.getByLabel('Miktar 2').fill('12');
  await page.getByRole('button', { name: 'Satır ekle' }).first().click();
  await page.getByLabel('Tanım 3').fill('Bahçe aydınlatma direği');
  await page.getByLabel('Birim 3').fill('adet');
  await page.getByLabel('Miktar 3').fill('20');
  await page.getByLabel('Birim fiyat 3').fill('250');
  await pick('İş kalemi 3', '03');
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText('Değişiklik emri kaydedildi')).toBeVisible();
  const compare = page.getByRole('table').last();
  await expect(compare.getByRole('row', { name: /Bahçe aydınlatma direği.*Eklendi/ })).toBeVisible();
  await expect(compare.getByRole('row', { name: /Pano kurulumu.*Değişti/ })).toBeVisible();
  await expect(page.getByText('Uygulanırsa bitiş 15.07.2027')).toBeVisible();

  // Gönder → kendi onay adımı (sahip) → uygulandı
  await page.getByRole('button', { name: 'Onaya gönder' }).click();
  await expect(page.getByText('Değişiklik emri onaya gönderildi')).toBeVisible();
  await expect(page.getByText('Onayda', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Onayla', exact: true }).click();
  await expect(page.getByText('Uygulandı', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Yeni bitiş 15.07.2027')).toBeVisible();

  // Yazdırma: imza blokları DOM'da
  await expect(page.locator('.print-signatures')).toContainText('Taşeron');

  // Sözleşme: güncel bedel 14.000, bitiş uzadı, DE listesinde
  await page.getByRole('link', { name: /Elektrik tesisatı/ }).click();
  await expect(page.getByText(/15\.07\.2027/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Değişiklik emirleri' }).click();
  await expect(page.getByText('Güncel sözleşme bedeli')).toBeVisible();
  await expect(page.getByText(/14\.000,00/).first()).toBeVisible();
  await expect(page.getByRole('row', { name: /DE-0001.*Bahçe aydınlatması.*Uygulandı/ })).toBeVisible();

  // Genel liste (Şantiye menüsü)
  await nav.getByRole('link', { name: 'Değişiklik emirleri' }).click();
  await expect(page.getByRole('row', { name: /DE-0001/ })).toBeVisible();
});
