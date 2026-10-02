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

test('satın alma zinciri: talep → onay → RFQ + teklif → sipariş → mal kabul → proje taahhüdü', async ({ page }) => {
  await signUpWithCompany(page, 'satinalma');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (name: string | RegExp, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: tedarikçi
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Hazır Beton Ltd.');
  await dialog.getByLabel('Tür').selectOption('supplier');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Hazır Beton Ltd.', level: 1 })).toBeVisible();

  // Hazırlık: proje + iş kalemi 02 Betonarme
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('button', { name: 'Yeni proje' }).first().click();
  await dialog.getByLabel('Proje adı').fill('Güneş Sitesi');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Güneş Sitesi', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Başlat' }).click();
  await expect(page.getByText('Proje durumu: Aktif')).toBeVisible();
  await page.getByRole('tab', { name: 'İş kırılımı' }).click();
  await page.getByRole('button', { name: 'İş kalemi ekle' }).first().click();
  await dialog.getByLabel('Kod').fill('02');
  await dialog.getByRole('textbox', { name: /^Ad/ }).fill('Betonarme');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('row', { name: /02 Betonarme/ })).toBeVisible();

  // 1) Talep: 100 m³ × 3.000 tahmini; onaya gönder, yetkili (sahip) onaylar
  await nav.getByRole('link', { name: 'Satın alma talepleri' }).click();
  await expect(page.getByText('Henüz satın alma talebi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni talep' }).first().click();
  await pick(/^Proje/, 'Güneş');
  await page.getByLabel(/^Başlık/).fill('Karkas betonu');
  await page.getByLabel('Açıklama 1').fill('C30 hazır beton');
  await page.getByLabel('Birim 1').fill('m³');
  await page.getByLabel('Miktar 1').fill('100');
  await page.getByLabel('Tahmini birim fiyat 1').fill('3000');
  await pick('İş kalemi 1', '02');
  await page.getByRole('button', { name: 'Onaya gönder' }).click();
  await expect(page.getByText('Talep onaya gönderildi')).toBeVisible();
  await page.getByRole('button', { name: 'Onayla', exact: true }).click();
  await expect(page.getByText('Onaylandı', { exact: true }).first()).toBeVisible();

  // 2) RFQ aç ve teklif gir
  await page.getByRole('button', { name: 'Teklif iste (RFQ)' }).first().click();
  await dialog.getByRole('button', { name: 'Teklif iste (RFQ)' }).click();
  await expect(page.getByRole('heading', { name: /RFQ-/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Teklif ekle' }).first().click();
  await dialog.getByRole('combobox', { name: /Tedarikçi/ }).click();
  await dialog.getByRole('combobox', { name: /Tedarikçi/ }).fill('Hazır');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('Teslim süresi (gün)').fill('3');
  await dialog.getByLabel('Birim fiyat 1').fill('2900');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('290.000,00').first()).toBeVisible();
  await expect(page.getByText('En ucuz', { exact: true })).toBeVisible();

  // 3) Teklifi seç → sipariş taslağı; siparişi ver
  await page.getByRole('button', { name: /Seç ve sipariş aç Hazır Beton/ }).click();
  await expect(page.getByRole('heading', { name: /SIP-|PO-/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Siparişi ver' }).click();
  await expect(page.getByText('Sipariş verildi').first()).toBeVisible();

  // 4) Kısmi mal kabul: 40 m³ (stoksuz satır → irsaliye gerekmez)
  await page.getByRole('button', { name: 'Mal kabul' }).first().click();
  await dialog.getByLabel('Gelen miktar 1').fill('40');
  await dialog.getByRole('button', { name: 'Mal kabul' }).click();
  await expect(page.getByText('Mal kabul kaydedildi')).toBeVisible();
  await expect(page.getByText('Kısmen geldi')).toBeVisible();
  await expect(page.getByText(/MK-\d{4}-000001/)).toBeVisible();

  // 5) Sipariş listesi ve proje taahhüdü: kalan 60 × 2.900 = 174.000
  await nav.getByRole('link', { name: 'Siparişler', exact: true }).click();
  await expect(page.getByRole('row', { name: /Hazır Beton Ltd\./ })).toContainText('40 / 100');
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('row', { name: /Güneş Sitesi/ }).click();
  await page.getByRole('tab', { name: 'Özet', exact: true }).click();
  await expect(page.getByText('174.000,00').first()).toBeVisible();
});
