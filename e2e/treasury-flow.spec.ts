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

test('kasa ve banka: dövizli fatura → farklı kurlu tahsilat (kur kârı) → ekstre → iptal → kalem geri gelir', async ({ page }) => {
  await signUpWithCompany(page, 'kasa');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // 1) Bugünün kuru: 1 GBP = 45 TRY (tahsilat günü kuru)
  await nav.getByRole('link', { name: 'Para birimi ve kurlar' }).click();
  await page.getByLabel('Alış', { exact: true }).first().fill('45');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Kur kaydedildi')).toBeVisible();

  // 2) Müşteri ve 100 GBP'lik satış faturası, fatura kuru 40 (4.000 TL alacak)
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Sarah Thompson');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Sarah Thompson', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Satış faturaları' }).click();
  await page.getByRole('button', { name: 'Yeni satış faturası' }).first().click();
  const customer = page.getByRole('combobox', { name: 'Müşteri' });
  await customer.click();
  await customer.fill('Sarah');
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('Para birimi', { exact: true }).selectOption('GBP');
  await page.getByLabel('Kur', { exact: true }).fill('40');
  await page.getByLabel('Açıklama 1').fill('Seramik satışı');
  await page.getByLabel('Miktar 1').fill('1');
  await page.getByLabel('Birim fiyat 1').fill('100');
  await expect(page.getByTestId('gross-total')).toHaveText('100,00 GBP');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /SF-\d{4}-000001/, level: 1 })).toBeVisible();

  // 3) Kasa/banka hesabı: boş durumdan GBP banka hesabı açılır
  await nav.getByRole('link', { name: 'Hesaplar', exact: true }).click();
  await expect(page.getByText('Henüz kasa veya banka hesabı yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni hesap' }).first().click();
  await dialog.getByLabel('Hesap adı').fill('KTB GBP');
  await dialog.getByLabel('Para birimi', { exact: true }).selectOption('GBP');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'KTB GBP', level: 1 })).toBeVisible();
  await expect(page.getByText('102.001').first()).toBeVisible();

  // 4) Tahsilat: fatura kalemi seçilir; 100 GBP × 45 = 4.500 TL, kalem 4.000 TL taşır → 500 TL kambiyo kârı
  await page.getByRole('button', { name: 'Tahsilat', exact: true }).click();
  const customerBox = dialog.getByRole('combobox', { name: 'Müşteri' });
  await customerBox.click();
  await customerBox.fill('Sarah');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Tümünü seç' }).click();
  await expect(dialog.getByLabel('Tahsil edilen tutar (GBP)')).toHaveValue('100,00');
  await expect(dialog.getByText('+500,00 TRY')).toBeVisible();
  await dialog.getByRole('button', { name: 'Kaydet', exact: true }).click();

  // Kayıttan sonra hareket ayrıntısı açılır: numara, kambiyo kârı ve kapatılan kalem
  await expect(dialog.getByText(/TAH-\d{4}-000001/).first()).toBeVisible();
  await expect(dialog.getByText('Kambiyo kârı')).toBeVisible();
  await expect(dialog.getByText('500,00 TRY').first()).toBeVisible();
  await expect(dialog.getByText('Kapatılan kalemler')).toBeVisible();
  await page.keyboard.press('Escape');

  // 5) Ekstre: 100 GBP bakiye, defter değeri 4.500 TL
  await expect(page.getByText('100,00 GBP').first()).toBeVisible();
  await expect(page.getByText('4.500,00 TRY').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /Tahsilat TAH-\d{4}-000001/ })).toBeVisible();

  // 6) Cari açık kalemi kapandı
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  // Liste yeniden çizilirken satıra tıklama nadiren kaybolabiliyor; tıklama + sonuç birlikte yeniden denenir.
  await expect(async () => {
    await page.getByRole('cell', { name: /Sarah Thompson/ }).click({ timeout: 3_000 });
    await expect(page.getByRole('tab', { name: 'Açık kalemler' })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 25_000 });
  await page.getByRole('tab', { name: 'Açık kalemler' }).click();
  await expect(page.getByText('Açık kalem yok')).toBeVisible();

  // 7) Hareketi iptal et (ters kayıt): kalem yeniden açılır, numara serinin parçası kalır
  await nav.getByRole('link', { name: 'Hareketler', exact: true }).click();
  await page.getByRole('row', { name: /TAH-\d{4}-000001/ }).click();
  await page.getByRole('button', { name: 'İptal et' }).click();
  const cancelDialog = page.getByRole('dialog', { name: 'Hareketi iptal et' });
  await cancelDialog.getByLabel('İptal nedeni').fill('Yanlış hesaba girildi');
  await cancelDialog.getByRole('button', { name: 'İptal et' }).click();
  await expect(page.getByText('Hareket iptal edildi')).toBeVisible();
  await expect(page.getByText(/tarihinde iptal edildi/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /TAH-\d{4}-000001/ })).toContainText('İptal');

  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  // Liste yeniden çizilirken satıra tıklama nadiren kaybolabiliyor; tıklama + sonuç birlikte yeniden denenir.
  await expect(async () => {
    await page.getByRole('cell', { name: /Sarah Thompson/ }).click({ timeout: 3_000 });
    await expect(page.getByRole('tab', { name: 'Açık kalemler' })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 25_000 });
  await page.getByRole('tab', { name: 'Açık kalemler' }).click();
  await expect(page.getByText('100,00 GBP').first()).toBeVisible();

  // 8) Cari sayfasından "Tahsilat al": cari hazır gelir
  await page.getByRole('button', { name: 'Tahsilat al' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Müşteri' })).toHaveValue('Sarah Thompson');
});
