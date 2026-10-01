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

test('malzeme mahsubu: taşerona malzeme ver → bakiye → hakedişte mahsup → net', async ({ page }) => {
  await signUpWithCompany(page, 'malzeme');
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


  // Stok kartı + giriş: 100 adet × 50 ₺
  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await page.getByRole('button', { name: 'Yeni stok kartı' }).first().click();
  await page.getByLabel('Ürün / hizmet adı').fill('NYY kablo');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'NYY kablo', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Stok girişi' }).click();
  await dialog.getByLabel('Miktar 1').fill('100');
  await dialog.getByLabel('Birim maliyet 1').fill('50');
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(page.getByText(/Stok hareketi kaydedildi/)).toBeVisible();
  await page.keyboard.press('Escape');

  // Sözleşmeye dön, bakiyeler sekmesinden malzeme ver: 20 adet = 1.000 ₺
  await nav.getByRole('link', { name: 'Taşeron sözleşmeleri' }).click();
  await page.getByRole('row', { name: /Elektrik tesisatı/ }).click();
  await page.getByRole('tab', { name: 'Avans ve teminat' }).click();
  await page.getByRole('button', { name: 'Malzeme ver' }).click();
  await dialog.getByRole('combobox', { name: 'Stok kartı 1' }).click();
  await dialog.getByRole('combobox', { name: 'Stok kartı 1' }).fill('NYY');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('Miktar 1').fill('20');
  await dialog.getByRole('combobox', { name: /İş kalemi 1/ }).click();
  await dialog.getByRole('combobox', { name: /İş kalemi 1/ }).fill('03');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Malzeme verildi', { exact: true })).toBeVisible();
  await expect(page.getByText('Kalan malzeme mahsubu')).toBeVisible();
  await expect(page.getByText('1.000,00').first()).toBeVisible();

  // Hakediş: 500 m = 1.500 brüt; malzeme mahsubu 1.000 → net 500; bakiyeyi aşan tutar engellenir
  await page.getByRole('tab', { name: 'Hakedişler' }).click();
  await page.getByRole('button', { name: 'Yeni hakediş' }).first().click();
  await page.getByLabel('Bu dönem küm. 1').fill('500');
  await page.getByLabel('Malzeme mahsubu').first().fill('1500');
  await expect(page.getByText(/Mahsup, kalan malzeme bakiyesini/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Onaya gönder' })).toBeDisabled();
  await page.getByLabel('Malzeme mahsubu').first().fill('1000');
  await expect(page.getByRole('button', { name: 'Onaya gönder' })).toBeEnabled();
  await expect(page.getByText(/−\s*₺1\.000,00/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Onaya gönder' }).click();
  await expect(page.getByText('Hakediş onaya gönderildi')).toBeVisible();
  await page.getByRole('button', { name: 'Onayla', exact: true }).click();
  await expect(page.getByText('Kaydedildi', { exact: true }).first()).toBeVisible();
  // Net 500 ve kalan malzeme 0
  await expect(page.getByText('500,00').first()).toBeVisible();
  await page.getByRole('link', { name: /TSZ-0001/ }).first().click();
  await page.getByRole('tab', { name: 'Avans ve teminat' }).click();
  await expect(page.getByText(/Verilen\s*₺1\.000,00 · mahsup\s*₺1\.000,00/)).toBeVisible();
});
