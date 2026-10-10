import { readFileSync, statSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';

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

test('projeler: iş kırılımı → bütçe onayı → yevmiye, gider faturası ve stok sarfında proje seçimi → maliyet raporu, ilerleme, Excel', async ({ page }) => {
  await signUpWithCompany(page, 'proje');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  const pick = async (name: string | RegExp, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: tedarikçi (gider faturası için) ve stok kartı + girişi (proje sarfı için)
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Kazı Hizmetleri Ltd.');
  await dialog.getByLabel('Tür').selectOption('supplier');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Kazı Hizmetleri Ltd.', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await page.getByRole('button', { name: 'Yeni stok kartı' }).first().click();
  await page.getByLabel('Ürün / hizmet adı').fill('Çimento 50 kg');
  await page.getByLabel('Birim', { exact: true }).selectOption('cuval');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Çimento 50 kg', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Stok girişi' }).click();
  await dialog.getByLabel('Miktar 1').fill('10');
  await dialog.getByLabel('Birim maliyet 1').fill('10');
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(page.getByText(/Stok hareketi kaydedildi: SH-\d{4}-000001/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 1) Proje aç (kendi projesi); başlat
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await expect(page.getByText('Henüz proje yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni proje' }).first().click();
  await dialog.getByLabel('Proje adı').fill('Güneş Sitesi');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Güneş Sitesi', level: 1 })).toBeVisible();
  await expect(page.getByText('PRJ-0001').first()).toBeVisible();
  await page.getByRole('button', { name: 'Başlat' }).click();
  await expect(page.getByText('Proje durumu: Aktif')).toBeVisible();

  // 2) İş kırılımı: 01 Kaba inşaat → 01.01 Temel, 01.02 Karkas
  await page.getByRole('tab', { name: 'İş kırılımı' }).click();
  await page.getByRole('button', { name: 'İş kalemi ekle' }).first().click();
  await dialog.getByLabel('Kod').fill('01');
  await dialog.getByRole('textbox', { name: /^Ad/ }).fill('Kaba inşaat');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('row', { name: /01 Kaba inşaat/ })).toBeVisible();
  for (const [code, name] of [['01.01', 'Temel'], ['01.02', 'Karkas']]) {
    await page.getByRole('button', { name: 'Alt iş ekle: 01', exact: true }).click();
    await dialog.getByLabel('Kod').fill(code!);
    await dialog.getByRole('textbox', { name: /^Ad/ }).fill(name!);
    await dialog.getByRole('button', { name: 'Kaydet' }).click();
    await expect(page.getByRole('row', { name: new RegExp(`${code!.replace('.', '\\.')} ${name}`) })).toBeVisible();
  }

  // 3) Bütçe: yalnızca yaprak iş kalemlerine tutar; onay sonrası yürürlükte
  await page.getByRole('tab', { name: 'Bütçe' }).click();
  await page.getByRole('button', { name: 'Bütçe oluştur' }).first().click();
  await expect(page.getByText('Rev. 1 taslağı açıldı')).toBeVisible();
  await expect(page.getByLabel('Bütçe 01', { exact: true })).toHaveCount(0); // üst düğüme bütçe girilmez
  await page.getByLabel('Bütçe 01.01').fill('100000');
  await page.getByLabel('Bütçe 01.02').fill('200000');
  await page.getByRole('button', { name: 'Taslağı kaydet' }).click();
  await expect(page.getByText('Taslak kaydedildi')).toBeVisible();
  await page.getByRole('button', { name: 'Onayla' }).first().click();
  await dialog.getByRole('button', { name: 'Onayla' }).click();
  await expect(page.getByText('Bütçe onaylandı')).toBeVisible();
  await expect(page.getByText('Yürürlükte', { exact: true })).toBeVisible();

  // 4) Yevmiye: 770 gideri Temel iş kalemine etiketli (40.000 ₺, karşı hesap sermaye)
  await nav.getByRole('link', { name: 'Yevmiye kayıtları' }).click();
  await page.getByRole('button', { name: 'Yeni yevmiye' }).first().click();
  await page.getByRole('textbox', { name: /^Açıklama/ }).fill('Temel işçiliği');
  await pick('Hesap 1', '770');
  await page.getByLabel('Borç 1').fill('40000');
  // Gider hesabı seçilince proje alanı çıkar; bilanço hesabında çıkmaz
  await pick('Proje 1', 'Güneş');
  await pick('İş kalemi 1', '01.01');
  await pick('Hesap 2', '500');
  await expect(page.getByRole('combobox', { name: 'Proje 2' })).toHaveCount(0);
  await page.getByLabel('Alacak 2').fill('40000');
  await expect(page.getByText('Dengeli', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByText(/Yevmiye kaydedildi: YV-\d{4}-\d{6}/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/PRJ-0001 · 01\.01/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 5) Gider faturası: serbest satır 10.000 ₺ + KDV, Karkas iş kalemine etiketli
  await page.goto('/invoices/new?type=expense');
  await pick('Tedarikçi', 'Kazı');
  await page.getByLabel('Tedarikçi fatura no').fill('KH-7001');
  await page.getByLabel('Açıklama 1').fill('İş makinesi kiralama');
  await page.getByLabel('Miktar 1').fill('1');
  await page.getByLabel('Birim fiyat 1').fill('10000');
  await pick('Proje 1', 'Güneş');
  await pick('İş kalemi 1', '01.02');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByText(/Fatura kaydedildi: GF-\d{4}-000001/)).toBeVisible();
  await expect(page.getByText(/Proje:.*PRJ-0001.*01\.02/).first()).toBeVisible();

  // 6) Stok çıkışı: 4 çuval × 10 ₺ = 40 ₺ Temel iş kalemine (sarf anında projeye yazılır)
  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await page.getByRole('row', { name: /Çimento 50 kg/ }).click();
  await page.getByRole('button', { name: 'Çıkış / sarf' }).click();
  await dialog.getByLabel('Miktar 1').fill('4');
  await pick('Proje 1', 'Güneş');
  await pick('İş kalemi 1', '01.01');
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(page.getByText(/Stok hareketi kaydedildi: SH-\d{4}-000002/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 7) Özet: gerçekleşen 40.000 + 10.000 + 40 = 50.040; ilerleme girilmeyen iş kaleminde kalan = bütçe − gerçekleşen
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('row', { name: /Güneş Sitesi/ }).click();
  await expect(page.getByRole('heading', { name: 'Güneş Sitesi', level: 1 })).toBeVisible();
  const summary = page.getByText('Gerçekleşen maliyet', { exact: true }).locator('xpath=ancestor::*[self::div or self::section][1]');
  await expect(summary).toContainText('50.040,00');
  await expect(page.getByRole('row', { name: /01\.01 Temel/ })).toContainText('40.040,00');
  await expect(page.getByRole('row', { name: /01\.02 Karkas/ })).toContainText('10.000,00');

  // 8) İlerleme girişi: Temel %50
  await page.getByRole('tab', { name: 'İş kırılımı' }).click();
  await page.getByRole('button', { name: 'İlerleme gir' }).click();
  await dialog.getByLabel('Yeni % 01.01').fill('50');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('İlerleme kaydedildi')).toBeVisible();
  await page.getByRole('tab', { name: 'Özet' }).click();
  // Temel: ETC = 100.000 × %50 = 50.000 → EAC 90.040; Karkas: ilerleme yok → ETC = 200.000 − 10.000 = 190.000 → EAC 200.000
  await expect(page.getByRole('row', { name: /01\.01 Temel/ })).toContainText('90.040,00');
  await expect(page.getByRole('row', { name: /01\.02 Karkas/ })).toContainText('200.000,00');
  await expect(page.getByText('Tahmini toplam maliyet', { exact: true }).locator('xpath=ancestor::*[self::div or self::section][1]')).toContainText('290.040,00');

  // 9) Hareketler sekmesi: etiketli üç kaynak satırı
  await page.getByRole('tab', { name: 'Hareketler' }).click();
  await expect(page.getByText('Temel işçiliği')).toBeVisible();

  // 10) Excel dışa aktarma (proje maliyet raporu)
  await page.getByRole('tab', { name: 'Özet' }).click();
  await page.getByRole('button', { name: 'Dışa aktar', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /\.xlsx/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const file = await download.path();
  expect(statSync(file).size).toBeGreaterThan(1000);
  expect(readFileSync(file).subarray(0, 2).toString()).toBe('PK'); // xlsx = zip

  // 11) Tamamlanan proje seçicide çıkmaz (yeni etiket yazılamaz)
  await page.getByRole('button', { name: 'Tamamla' }).click();
  await dialog.getByRole('button', { name: 'Tamamla' }).click();
  await expect(page.getByText('Proje durumu: Tamamlandı')).toBeVisible();
  await nav.getByRole('link', { name: 'Yevmiye kayıtları' }).click();
  await page.getByRole('button', { name: 'Yeni yevmiye' }).first().click();
  await pick('Hesap 1', '770');
  await page.getByRole('combobox', { name: 'Proje 1' }).click();
  await expect(page.getByRole('listbox').getByRole('option', { name: /Güneş Sitesi/ })).toHaveCount(0);
});
