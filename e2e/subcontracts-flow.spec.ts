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

test('taşeron: sözleşme → BOQ onayı → hakediş (kümülatif) → onay → maliyet raporunda taahhüt, Excel', async ({ page }) => {
  await signUpWithCompany(page, 'tasaron');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (name: string | RegExp, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: taşeron cari (tedarikçi)
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Elektrik Taşeron Ltd.');
  await dialog.getByLabel('Tür').selectOption('supplier');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Elektrik Taşeron Ltd.', level: 1 })).toBeVisible();

  // Hazırlık: proje + iş kalemi 03 Elektrik
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

  // 1) Sözleşme aç
  await nav.getByRole('link', { name: 'Taşeron sözleşmeleri' }).click();
  await expect(page.getByText('Henüz taşeron sözleşmesi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni sözleşme' }).first().click();
  await dialog.getByRole('combobox', { name: /Proje/ }).click();
  await dialog.getByRole('combobox', { name: /Proje/ }).fill('Güneş');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByRole('combobox', { name: /Taşeron/ }).click();
  await dialog.getByRole('combobox', { name: /Taşeron/ }).fill('Elektrik');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('İş tanımı').fill('Elektrik tesisatı');
  await dialog.getByLabel('Teminat %').fill('5');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Elektrik tesisatı/, level: 1 })).toBeVisible();
  await expect(page.getByText(/^TSZ-0001$/).first()).toBeVisible();

  // 2) BOQ: iki satır; onay ekrandaki son hâli kaydeder ve sözleşmeyi yürürlüğe alır
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
  await expect(page.getByText('Yürürlükte', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('8.000,00').first()).toBeVisible(); // 1.000×3 + 10×500

  // 3) Hakediş: kümülatif 500 m + 4 adet = 1.500 + 2.000 = 3.500; teminat %5 = 175; net 3.325
  await page.getByRole('tab', { name: 'Hakedişler' }).click();
  await page.getByRole('button', { name: 'Yeni hakediş' }).first().click();
  await page.getByLabel('Bu dönem küm. 1').fill('500');
  await page.getByLabel('Bu dönem küm. 2').fill('4');
  await expect(page.getByText('3.325,00').first()).toBeVisible();
  // Sözleşme miktarı aşılamaz: kullanıcıya anlaşılır rozet, gönderme kapalı
  await page.getByLabel('Bu dönem küm. 2').fill('11');
  await expect(page.getByText('Sözleşmeyi aşıyor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Onaya gönder' })).toBeDisabled();
  await page.getByLabel('Bu dönem küm. 2').fill('4');
  await page.getByRole('button', { name: 'Onaya gönder' }).click();
  await expect(page.getByText('Hakediş onaya gönderildi')).toBeVisible();
  await expect(page.getByText('Onayda', { exact: true }).first()).toBeVisible();

  // 4) Onay: varsayılan tek adım; onay izni olan kullanıcı (sahip) onaylar → yevmiye aynı işlemde
  await page.getByRole('button', { name: 'Onayla', exact: true }).click();
  await expect(page.getByText('Onaylandı', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/HKD-\d{4}-000001/).first()).toBeVisible();
  await expect(page.getByText('Kaydedildi', { exact: true }).first()).toBeVisible();

  // 5) Proje maliyet raporu: gerçekleşen 3.500 (brüt), kalan taahhüt 4.500
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('row', { name: /Güneş Sitesi/ }).click();
  await expect(page.getByRole('heading', { name: 'Güneş Sitesi', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: /03 Elektrik/ });
  await expect(row).toContainText('3.500,00');
  await expect(row).toContainText('4.500,00');
  await expect(page.getByText('Kalan taahhüt', { exact: true }).first()).toBeVisible();

  // 6) Dışa aktarma: sözleşme listesi Excel olarak iner
  await nav.getByRole('link', { name: 'Taşeron sözleşmeleri' }).click();
  await page.getByRole('button', { name: /Dışa aktar/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/tasaron-sozlesmeleri-.*\.xlsx$/);
});
