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

/** Tutarlar YALNIZCA TEST AMAÇLIDIR; KDV oranı sistemin tohumladığı doğrulanmamış varsayılandır, hesap eşlemeleri doğrulanmamıştır. */
test('ithalat maliyet dağıtımı: alış faturası → dosya → navlun/gümrük dağıtımı → muhasebeleştir → rapor → iptal; gider kartı → gider fişi → rapor', async ({ page }) => {
  test.setTimeout(180_000);
  await signUpWithCompany(page, 'ithalat-gider');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (name: string, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Menü bağlantısına tıklama sayfa çizilirken nadiren kaybolabiliyor: tıklama + sonuç başlığı birlikte yeniden denenir
  const go = async (link: string, heading: string) => {
    await expect(async () => {
      await nav.getByRole('link', { name: link, exact: true }).click({ timeout: 3_000 });
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 25_000 });
  };

  // Hazırlık: tedarikçi, stok kartı, 10 × 100 ₺ alış faturası
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Dış Ticaret Ltd.');
  await dialog.getByLabel('Tür').selectOption('supplier');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Dış Ticaret Ltd.', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await page.getByRole('button', { name: 'Yeni stok kartı' }).first().click();
  await page.getByLabel('Ürün / hizmet adı').fill('Seramik karo');
  await dialog.getByLabel('KDV oranı').selectOption('KDV-16');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Seramik karo', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Alış ve gider faturaları' }).click();
  await page.getByRole('button', { name: 'Yeni alış faturası' }).first().click();
  await pick('Tedarikçi', 'Dış');
  await page.getByLabel('Tedarikçi fatura no').fill('TF-1');
  await pick('Kart / hizmet 1', 'seramik');
  await page.getByLabel('Miktar 1').fill('10');
  await page.getByLabel('Birim fiyat 1').fill('100');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /AF-\d{4}-000001/, level: 1 })).toBeVisible();

  // 1) İthalat dosyası: kaynak satır + navlun 150 ₺ + gümrük vergisi 50 ₺ (kullanıcı girişi)
  await nav.getByRole('link', { name: 'İthalat maliyet dosyaları' }).click();
  await expect(page.getByText('Henüz ithalat dosyası yok')).toBeVisible();
  await expect(page.getByText('mali müşavirce doğrulanmamıştır').first()).toBeVisible();
  await page.getByRole('button', { name: 'Yeni ithalat dosyası' }).first().click();
  await page.getByLabel('Dosya adı').fill('Mersin sevkiyatı');
  await page.getByLabel('Beyanname / referans').fill('BYN-1');
  await page.getByRole('button', { name: 'Satır ekle' }).click();
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Seçilenleri ekle' }).click();
  await expect(page.getByRole('row', { name: /Seramik karo/ })).toContainText('1.000,00');
  await page.getByRole('button', { name: 'Kalem ekle' }).click();
  await page.getByLabel('Açıklama 1').fill('Deniz navlunu');
  await page.getByLabel('Tutar 1').fill('150');
  await page.getByRole('button', { name: 'Kalem ekle' }).click();
  await page.getByLabel('Tür 2').selectOption('customs_duty');
  await page.getByLabel('Açıklama 2').fill('Gümrük vergisi (beyan)');
  await page.getByLabel('Tutar 2').fill('50');
  // Önizleme: tek satır olduğundan her kalem tamamen o satıra düşer
  await expect(page.getByText('Önizleme (kaydedilmemiş hesap)')).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText('İthalat dosyası oluşturuldu')).toBeVisible();
  await expect(page.getByRole('heading', { name: /ITH-\d{4}-000001/, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Dağıt' }).click();
  await expect(page.getByText('Maliyetler dağıtıldı')).toBeVisible();
  await expect(page.getByText('Dağıtım sonucu')).toBeVisible();
  await page.getByRole('button', { name: 'Muhasebeleştir' }).first().click();
  await dialog.getByRole('button', { name: 'Muhasebeleştir' }).click();
  await expect(page.getByText('Muhasebeleştirildi', { exact: true }).first()).toBeVisible();
  // Rapor: birim maliyet 100 → 120 (1.000 + 200 / 10)
  const reportRow = page.getByRole('row', { name: /Seramik karo/ }).last();
  await expect(reportRow).toContainText('100,0000');
  await expect(reportRow).toContainText('120,0000');
  await expect(page.getByRole('link', { name: /^YV-\d{4}-\d{6}$/ })).toBeVisible();

  // Stok durumu: değer 1.200, muhasebe ile uyumlu
  await go('Stok durumu', 'Stok durumu');
  await expect(page.getByRole('row', { name: /Seramik karo/ })).toContainText('1.200,00');
  await expect(page.getByText('Stok defteri muhasebe bakiyesiyle uyumlu')).toBeVisible();

  // Kart bazında rapor sekmesi
  await nav.getByRole('link', { name: 'İthalat maliyet dosyaları' }).click();
  await page.getByRole('tab', { name: 'Kart bazında maliyet' }).click();
  await expect(page.getByRole('row', { name: /Seramik karo/ })).toContainText('120,0000');

  // İptal: stok değeri 1.000'e döner
  await page.getByRole('tab', { name: 'Dosyalar' }).click();
  await page.getByRole('link', { name: /ITH-\d{4}-000001/ }).click();
  await page.getByRole('button', { name: 'İptal et' }).first().click();
  await dialog.getByLabel('İptal nedeni').fill('Yanlış beyan');
  await dialog.getByRole('button', { name: 'İptal et' }).click();
  await expect(page.getByText('Dosya iptal edildi')).toBeVisible();
  await go('Stok durumu', 'Stok durumu');
  await expect(page.getByRole('row', { name: /Seramik karo/ })).toContainText('1.000,00');

  // 2) Gider kartı: kira (KDV yok), banka hesabı, gider fişi
  await nav.getByRole('link', { name: 'Hesaplar', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni hesap' }).first().click();
  await dialog.getByLabel('Hesap adı').fill('KTB TL');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'KTB TL', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Giderler' }).click();
  await page.getByRole('tab', { name: 'Gider türleri' }).click();
  await expect(page.getByText('Henüz gider kartı yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni gider kartı' }).first().click();
  await dialog.getByLabel(/^Kod/).fill('NKL');
  await dialog.getByLabel(/^Ad/).fill('Nakliye');
  const account = dialog.getByRole('combobox', { name: 'Gider hesabı' });
  await account.click();
  await account.fill('632');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('KDV kodu').selectOption('KDV-16');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Gider kartı kaydedildi')).toBeVisible();
  await expect(page.getByRole('row', { name: /Nakliye/ })).toContainText('KDV-16');

  await nav.getByRole('link', { name: 'Gider fişleri' }).click();
  await expect(page.getByText('Henüz gider fişi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni gider' }).first().click();
  await pick('Gider kartı', 'nakliye');
  await dialog.getByLabel(/^Açıklama/).fill('Şantiye nakliyesi');
  await dialog.getByLabel('KDV hariç tutar').fill('1000');
  await expect(dialog).toContainText('1.160,00');
  await dialog.getByLabel('Kasa / banka hesabı').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Gideri kaydet' }).click();
  await expect(page.getByText('Gider kaydedildi')).toBeVisible();
  await expect(page.getByRole('row', { name: /GDF-\d{4}-000001/ })).toContainText('1.160,00');

  // 3) Gider raporu: karta göre toplam 1.000 (KDV hariç), 160 KDV
  await nav.getByRole('link', { name: 'Gider raporları' }).click();
  await expect(page.getByRole('row', { name: /Nakliye/ })).toContainText('1.000,00');
  await expect(page.getByRole('row', { name: /Nakliye/ })).toContainText('160,00');
  await page.getByRole('tab', { name: 'Aylık eğilim' }).click();
  await expect(page.getByRole('row', { name: /Toplam/ })).toContainText('1.160,00');
  await page.getByRole('tab', { name: 'En yüksek giderler' }).click();
  await expect(page.getByRole('row', { name: /Şantiye nakliyesi/ })).toBeVisible();

  // İptal edilen gider rapordan düşer
  await nav.getByRole('link', { name: 'Gider fişleri' }).click();
  await page.getByRole('row', { name: /GDF-\d{4}-000001/ }).getByRole('button', { name: 'İptal' }).click();
  await dialog.getByLabel('İptal nedeni').fill('Çift giriş');
  await dialog.getByRole('button', { name: 'İptal', exact: true }).click();
  await expect(page.getByText('Gider fişi iptal edildi')).toBeVisible();
  await nav.getByRole('link', { name: 'Gider raporları' }).click();
  await expect(page.getByText('Bu dönemde gider fişi yok')).toBeVisible();
});
