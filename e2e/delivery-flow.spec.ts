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

test('irsaliye: mal kabul → fiyat farklı fatura → sevk → kısmi fatura; stok ve mutabakat tutarlı', async ({ page }) => {
  await signUpWithCompany(page, 'irsaliye');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // Hazırlık: hem müşteri hem tedarikçi olan cari ve %16 KDV'li stok kartı
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

  // 1) Mal kabul: 10 ad × 50 ₺, tedarikçi irsaliye no zorunlu; stok hemen girer, yevmiye yok
  await nav.getByRole('link', { name: 'Alış irsaliyeleri' }).click();
  await expect(page.getByText('Henüz alış irsaliyesi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni alış irsaliyesi' }).first().click();
  await pick('Tedarikçi', 'Ömer');
  await page.getByLabel('Tedarikçi irsaliye no').fill('IRS-77');
  await pick('Stok kartı 1', 'boya');
  await page.getByLabel('Miktar 1').fill('10');
  await page.getByLabel('Birim maliyet 1').fill('50');
  await page.getByRole('button', { name: 'Kaydet ve stoğa işle' }).click();
  await expect(page.getByText(/İrsaliye kaydedildi: AIR-\d{4}-000001/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /AIR-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByText('Faturalanmadı').first()).toBeVisible();

  await nav.getByRole('link', { name: 'Stok durumu' }).click();
  await expect(page.getByRole('row', { name: /Dış cephe boyası/ })).toContainText('10 adet');
  // Fark yok sayılmaz ama açıklanır: yevmiye tedarikçi faturasıyla oluşacak
  await expect(page.getByText(/faturası henüz kesilmemiş irsaliyelerden kaynaklanıyor/)).toBeVisible();

  // 2) Tedarikçi faturası irsaliyeye bağlanır: satırlar hazır gelir, fiyat 60 ₺ → 696 ₺ (fark stok maliyetine)
  await nav.getByRole('link', { name: 'Alış irsaliyeleri' }).click();
  await page.getByRole('row', { name: /AIR-\d{4}-000001/ }).click();
  await page.getByRole('button', { name: 'Fatura oluştur' }).click();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('10');
  await page.getByLabel('Tedarikçi fatura no').fill('T-2001');
  await page.getByLabel('Birim fiyat 1').fill('60');
  await expect(page.getByTestId('gross-total')).toHaveText('₺696,00');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /AF-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /İrsaliye: AIR-\d{4}-000001/ })).toBeVisible();

  await nav.getByRole('link', { name: 'Stok durumu' }).click();
  const row = page.getByRole('row', { name: /Dış cephe boyası/ });
  await expect(row).toContainText('10 adet');
  await expect(row).toContainText('600,00'); // 500 + 100 fiyat farkı
  await expect(page.getByText('Stok defteri muhasebe bakiyesiyle uyumlu')).toBeVisible();

  // 3) Sevk irsaliyesi: 4 ad; sonra 3 adedi faturalanır (kısmi)
  await nav.getByRole('link', { name: 'Satış irsaliyeleri' }).click();
  await page.getByRole('button', { name: 'Yeni satış irsaliyesi' }).first().click();
  await pick('Müşteri', 'Ömer');
  await page.getByLabel('Araç plakası').fill('05 ABC 123');
  await pick('Stok kartı 1', 'boya');
  await page.getByLabel('Miktar 1').fill('4');
  await expect(page.getByText(/Eldeki: 10 adet/)).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet ve stoğa işle' }).click();
  await expect(page.getByRole('heading', { name: /SIR-\d{4}-000001/, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Fatura oluştur' }).click();
  await expect(page.getByLabel('Miktar 1')).toHaveValue('4');
  await page.getByLabel('Miktar 1').fill('3');
  await page.getByLabel('Birim fiyat 1').fill('100');
  await expect(page.getByTestId('gross-total')).toHaveText('₺348,00');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /SF-\d{4}-000001/, level: 1 })).toBeVisible();

  // İrsaliye kısmen faturalandı: kalan 1 adet; faturalı irsaliye iptal edilemez
  await nav.getByRole('link', { name: 'Satış irsaliyeleri' }).click();
  await expect(page.getByText(/1 irsaliye, kalan değer/)).toBeVisible();
  await page.getByRole('row', { name: /SIR-\d{4}-000001/ }).click();
  await expect(page.getByText('Kısmen faturalandı').first()).toBeVisible();
  await page.getByRole('button', { name: 'İrsaliyeyi iptal et' }).click();
  await dialog.getByLabel('İptal nedeni').fill('Sevk edilmedi');
  await dialog.getByRole('button', { name: 'İrsaliyeyi iptal et' }).click();
  await expect(page.getByText(/numaralı faturaya bağlı/)).toBeVisible();
});
