import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { writeXlsx } from '../apps/api/src/files/xlsx-write';

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
test('satış: teklif → kabul → sipariş → kısmi/tam teslim → toplu faturalama → iade irsaliyesi ve iade faturası; Excel ile fatura içe aktarma', async ({ page }) => {
  test.setTimeout(180_000); // uzun uçtan uca senaryo
  await signUpWithCompany(page, 'siparis');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (name: string, q: string) => {
    const box = page.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: müşteri, satış fiyatı 100 ₺ olan %16 KDV'li stok kartı, 20 adet stok (50 ₺ maliyet)
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Ömer Çakır Ticaret');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Ömer Çakır Ticaret', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await page.getByRole('button', { name: 'Yeni stok kartı' }).first().click();
  await page.getByLabel('Ürün / hizmet adı').fill('Dış cephe boyası');
  await dialog.getByLabel('KDV oranı').selectOption('KDV-16');
  await dialog.getByLabel('Satış fiyatı').fill('100');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Dış cephe boyası', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Stok girişi' }).click();
  await dialog.getByLabel('Miktar 1').fill('20');
  await dialog.getByLabel('Birim maliyet 1').fill('50');
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(page.getByText(/Stok hareketi kaydedildi: SH-\d{4}-000001/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 1) Teklif: fiyat kartın satış fiyatından gelir → gönder → kabul → siparişe dönüştür
  await nav.getByRole('link', { name: 'Satış teklifleri' }).click();
  await expect(page.getByText('Henüz satış teklifi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni teklif' }).first().click();
  await pick('Müşteri', 'Ömer');
  await pick('Kart / hizmet 1', 'boya');
  await page.getByLabel('Miktar 1').fill('10');
  await expect(page.getByLabel('Birim fiyat 1')).toHaveValue('100,00');
  await expect(page.getByTestId('gross-total')).toHaveText('₺1.160,00');
  await page.getByRole('button', { name: 'Kaydet ve gönder' }).click();
  await expect(page.getByRole('heading', { name: /TKL-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByText('Gönderildi', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Kabul edildi', exact: true }).click();
  await expect(page.getByText('Teklif kabul edildi')).toBeVisible();
  await page.getByRole('button', { name: 'Siparişe dönüştür' }).click();
  // Sipariş taslağı: onayla
  await expect(page.getByRole('heading', { name: /Sipariş \(taslak\)/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet ve onayla' }).click();
  await expect(page.getByRole('heading', { name: /SSP-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByText('Onaylandı', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Teslim: yok')).toBeVisible();

  // 2) Kısmi teslim: irsaliye taslağı siparişten gelir (10), 6'ya düşürülüp kaydedilir
  await page.getByRole('button', { name: 'İrsaliye oluştur' }).click();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('10');
  await page.getByLabel('Miktar 1').fill('6');
  await page.getByRole('button', { name: 'Kaydet ve stoğa işle' }).click();
  await expect(page.getByRole('heading', { name: /SIR-\d{4}-000001/, level: 1 })).toBeVisible();
  await page.getByRole('link', { name: /SSP-\d{4}-000001/ }).click();
  await expect(page.getByText('Teslim: kısmi')).toBeVisible();

  // 3) Kalan 4 teslim → tam
  await page.getByRole('button', { name: 'İrsaliye oluştur' }).click();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('4');
  await page.getByRole('button', { name: 'Kaydet ve stoğa işle' }).click();
  await expect(page.getByRole('heading', { name: /SIR-\d{4}-000002/, level: 1 })).toBeVisible();
  await page.getByRole('link', { name: /SSP-\d{4}-000001/ }).click();
  await expect(page.getByText('Teslim: tam')).toBeVisible();
  await expect(page.getByText('Fatura: yok')).toBeVisible();

  // 4) Toplu faturalama: iki irsaliye tek faturada (sipariş fiyatı), sonuç özeti
  await nav.getByRole('link', { name: 'Toplu faturalama' }).click();
  await expect(page.getByRole('heading', { name: 'Toplu faturalama', level: 1 })).toBeVisible();
  const party = page.getByTestId(/batch-party-/);
  await expect(party).toContainText('Ömer Çakır Ticaret');
  await expect(party).toContainText('1 fatura');
  await party.getByRole('checkbox', { name: /Ömer Çakır Ticaret irsaliyelerinin tümünü seç/ }).check();
  await expect(page.getByText('2 irsaliye seçili')).toBeVisible();
  await page.getByRole('button', { name: 'Seçilenleri faturala' }).click();
  const result = page.getByTestId('batch-result');
  await expect(result).toContainText('1 fatura oluşturuldu');
  await expect(result).toContainText('₺1.160,00');
  await result.getByRole('link', { name: /SF-\d{4}-000001/ }).click();
  await expect(page.getByRole('heading', { name: /SF-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /İrsaliye: SIR-\d{4}-00000[12]/ }).first()).toBeVisible();
  // İkinci çalıştırma yeni fatura üretmez: irsaliye kalmadı
  await nav.getByRole('link', { name: 'Toplu faturalama' }).click();
  await expect(page.getByText('Faturalanacak irsaliye yok')).toBeVisible();

  // 5) Sipariş artık tam teslim + tam fatura
  await nav.getByRole('link', { name: 'Satış siparişleri' }).click();
  await page.getByRole('row', { name: /SSP-\d{4}-000001/ }).click();
  await expect(page.getByText('Teslim: tam')).toBeVisible();
  await expect(page.getByText('Fatura: tam')).toBeVisible();

  // 6) İade irsaliyesi: ilk irsaliyeden 2 adet; kalan iade edilebilir miktar aşılamaz
  await nav.getByRole('link', { name: 'Satış irsaliyeleri' }).click();
  await page.getByRole('row', { name: /SIR-\d{4}-000001/ }).click();
  await page.getByRole('button', { name: 'İade irsaliyesi oluştur' }).click();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('6');
  await page.getByLabel('Miktar 1').fill('7');
  await page.getByRole('button', { name: 'Kaydet ve stoğa işle' }).click();
  await expect(page.getByText(/iade edilebilir miktarı aşıyor/)).toBeVisible();
  await page.getByLabel('Miktar 1').fill('2');
  await page.getByRole('button', { name: 'Kaydet ve stoğa işle' }).click();
  await expect(page.getByRole('heading', { name: /SIRI-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByText('Yevmiye yok')).toBeVisible();

  // İade faturası: iade irsaliyesine bağlı; stok yeniden hareket etmez
  await page.getByRole('button', { name: 'İade faturası oluştur' }).click();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('2');
  await page.getByLabel('Birim fiyat 1').fill('100');
  await expect(page.getByTestId('gross-total')).toHaveText('₺232,00');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /SIF-\d{4}-000001/, level: 1 })).toBeVisible();

  // Stok: 20 - 10 + 2 = 12; mutabakat tutarlı
  await nav.getByRole('link', { name: 'Stok durumu' }).click();
  await expect(page.getByRole('row', { name: /Dış cephe boyası/ })).toContainText('12 adet');
  await expect(page.getByText('Stok defteri muhasebe bakiyesiyle uyumlu')).toBeVisible();
  await nav.getByRole('link', { name: 'Satış iade irsaliyeleri' }).click();
  await expect(page.getByRole('row', { name: /SIRI-\d{4}-000001/ })).toContainText('Faturalandı');

  // 7) Excel ile fatura içe aktarma: cari metni eşleşmez → elle eşleme → taslak fatura
  const xlsx = writeXlsx([
    {
      key: 'f',
      title: 'Faturalar',
      plain: true,
      columns: ['Belge no', 'Fatura tarihi', 'Cari', 'Stok kartı', 'Miktar', 'Birim fiyat'].map((l) => ({ key: l, label: l, kind: 'text' as const })),
      rows: [
        { 'Belge no': 'IM-1', 'Fatura tarihi': '15.03.2026', Cari: 'Ömer Çakır', 'Stok kartı': 'ST-000001', Miktar: '3', 'Birim fiyat': '110' },
        { 'Belge no': 'IM-1', 'Fatura tarihi': '', Cari: '', 'Stok kartı': 'ST-000001', Miktar: '1', 'Birim fiyat': '110' },
      ],
    },
  ]);
  await nav.getByRole('link', { name: 'Satış faturaları' }).click();
  await page.getByRole('button', { name: "Excel'den içe aktar" }).click();
  await expect(dialog.getByRole('heading', { name: 'Satış faturaları — İçe aktar' })).toBeVisible();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'faturalar.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xlsx) });
  await expect(dialog.getByText('Sütunları eşleyin')).toBeVisible();
  await expect(dialog.getByLabel(/^Belge no/)).toHaveValue('0');
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  const unmatched = dialog.getByTestId('import-unmatched');
  await expect(unmatched).toContainText('Ömer Çakır');
  await expect(dialog.getByRole('button', { name: 'İçe aktar', exact: true })).toBeDisabled();
  const picker = unmatched.getByRole('combobox', { name: /Cari: Ömer Çakır/ });
  await picker.click();
  await picker.fill('Ömer');
  await page.getByRole('listbox').getByRole('option').first().click();
  await expect(dialog.getByText('Oluşacak taslak fatura')).toBeVisible();
  await dialog.getByRole('button', { name: 'İçe aktar', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'İçe aktarma tamamlandı' })).toBeVisible();
  await dialog.getByRole('link', { name: 'IM-1' }).click();
  // Taslak fatura düzenleme formu olarak açılır: cari ve içe aktarılan kalemler (3 + 1 satır, KDV dahil değil)
  await expect(page.getByRole('heading', { name: /\(taslak\)/, level: 1 })).toBeVisible();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('3');
  await expect(page.getByLabel('Miktar 2')).toHaveValue('1');
});
