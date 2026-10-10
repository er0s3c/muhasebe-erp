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

test('işveren hakedişi: contract projesi → işveren sözleşmesi + BOQ → alınan hakediş → onay → proje özeti ve gelir', async ({ page }) => {
  await signUpWithCompany(page, 'isveren');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (name: string | RegExp, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: işveren (müşteri carisi)
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Deniz Yatırım Ltd.');
  await dialog.getByLabel('Tür').selectOption('customer');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Deniz Yatırım Ltd.', level: 1 })).toBeVisible();

  // Proje: işverene yapılan iş + iş kalemi 01
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('button', { name: 'Yeni proje' }).first().click();
  await dialog.getByLabel('Proje adı').fill('Kuzey Villa');
  await dialog.getByRole('tab', { name: 'İşverene yapılan iş' }).click();
  await dialog.getByRole('combobox', { name: /İşveren/ }).click();
  await dialog.getByRole('combobox', { name: /İşveren/ }).fill('Deniz');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Kuzey Villa', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Başlat' }).click();
  await expect(page.getByText('Proje durumu: Aktif')).toBeVisible();
  await page.getByRole('tab', { name: 'İş kırılımı' }).click();
  await page.getByRole('button', { name: 'İş kalemi ekle' }).first().click();
  await dialog.getByLabel('Kod').fill('01');
  await dialog.getByRole('textbox', { name: /^Ad/ }).fill('Kaba inşaat');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('row', { name: /01 Kaba inşaat/ })).toBeVisible();

  // 1) İşveren sözleşmesi proje sekmesinden açılır (işveren cari kendiliğinden gelir)
  await page.getByRole('tab', { name: 'İşveren sözleşmesi' }).click();
  await expect(page.getByText('Bu projede işveren sözleşmesi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni işveren sözleşmesi' }).first().click();
  await dialog.getByLabel('İş tanımı').fill('Anahtar teslim villa');
  await dialog.getByLabel('Teminat %').fill('10');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Anahtar teslim villa/, level: 1 })).toBeVisible();
  await expect(page.getByText(/^IVS-0001$/).first()).toBeVisible();

  // 2) BOQ: götürü 1.000 × 1.000 = 1.000.000; onayla ve yürürlüğe al
  await page.getByRole('button', { name: 'Satır ekle' }).first().click();
  await page.getByLabel('Tanım 1').fill('Temel ve kaba inşaat');
  await page.getByLabel('Birim 1').fill('m²');
  await page.getByLabel('Miktar 1').fill('1000');
  await page.getByLabel('Birim fiyat 1').fill('1000');
  await pick('İş kalemi 1', '01');
  await page.getByRole('button', { name: 'Onayla ve yürürlüğe al' }).click();
  await expect(page.getByText('Revizyon onaylandı')).toBeVisible();

  // 3) Alınan hakediş: 250 m² → brüt 250.000, teminat %10 = 25.000, net 225.000
  await page.getByRole('tab', { name: 'Hakedişler' }).click();
  await page.getByRole('button', { name: 'Yeni hakediş' }).first().click();
  await expect(page.getByRole('heading', { name: 'Yeni işveren hakedişi', level: 1 })).toBeVisible();
  await page.getByLabel('Bu dönem küm. 1').fill('250');
  await expect(page.getByText('Tahsil edilecek net')).toBeVisible();
  await expect(page.getByText('225.000,00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Onaya gönder' }).click();
  await expect(page.getByText('Hakediş onaya gönderildi')).toBeVisible();
  await page.getByRole('button', { name: 'Onayla', exact: true }).click();
  await expect(page.getByText(/AHK-\d{4}-000001/).first()).toBeVisible();
  await expect(page.getByText('Kaydedildi', { exact: true }).first()).toBeVisible();

  // 4) Menü ve listeler: işveren hakedişleri ayrı; proje özeti kalan alacağı gösterir
  await nav.getByRole('link', { name: 'İşveren hakedişleri' }).click();
  await expect(page.getByRole('row', { name: /AHK-\d{4}-000001/ })).toContainText('225.000,00');
  await nav.getByRole('link', { name: 'Hakedişler', exact: true }).click();
  await expect(page.getByText('Henüz hakediş yok')).toBeVisible(); // taşeron hakedişleri ayrı
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('row', { name: /Kuzey Villa/ }).click();
  await page.getByRole('tab', { name: 'İşveren sözleşmesi' }).click();
  await expect(page.getByText('Kümülatif hakediş (brüt)')).toBeVisible();
  await expect(page.getByText('250.000,00').first()).toBeVisible();
  await expect(page.getByText('Kalan alacak')).toBeVisible();

  // 5) Gelir proje maliyet raporunda: gelir (etiketli) 250.000; gerçekleşen maliyet 0
  await page.getByRole('tab', { name: 'Özet', exact: true }).click();
  await expect(page.getByText('Etiketli gelir', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('250.000,00').first()).toBeVisible();
});
