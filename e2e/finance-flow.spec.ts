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

test('finans: nakit projeksiyonu (elle kalem), proje kârlılığı raporu, fon/harç tarifesi (doğrulanmamış rozeti)', async ({ page }) => {
  await signUpWithCompany(page, 'finans');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // 1) Nakit projeksiyonu: 13 haftalık tablo, elle çıkış kalemi
  await nav.getByRole('link', { name: 'Nakit planlama' }).click();
  await expect(page.getByRole('heading', { name: 'Nakit planlama', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nakit projeksiyonu', level: 2 })).toBeVisible();
  await expect(page.getByText('Açılış bakiyesi').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /^13 / })).toBeVisible();
  await page.getByRole('button', { name: 'Kalem ekle' }).click();
  await dialog.getByLabel(/^Açıklama/).fill('Ofis kirası');
  await dialog.getByLabel(/^Tutar/).fill('5000');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Kalem kaydedildi')).toBeVisible();
  await expect(page.getByRole('row', { name: /Ofis kirası/ })).toContainText('Elle çıkış');
  await expect(page.getByRole('row', { name: /^1 / })).toContainText('5.000');

  // 2) Proje kârlılığı: proje satırı ve genel toplam
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('button', { name: 'Yeni proje' }).first().click();
  await dialog.getByLabel('Proje adı').fill('Güneş Sitesi');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Güneş Sitesi', level: 1 })).toBeVisible();
  await nav.getByRole('link', { name: 'Proje kârlılığı' }).click();
  await expect(page.getByRole('heading', { name: 'Proje kârlılığı', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: /Güneş Sitesi/ })).toContainText('Kendi projesi');
  await expect(page.getByText('Genel toplam')).toBeVisible();

  // 3) Fon/harç tarifesi: eklenir, doğrulanmamış rozetiyle görünür
  await nav.getByRole('link', { name: 'İnşaat ayarları' }).click();
  await expect(page.getByText('Altyapı fonları ve harçlar')).toBeVisible();
  const form = page.locator('form').filter({ has: page.getByLabel('Hesap tabanı') });
  await form.getByLabel('Kod', { exact: true }).fill('ELK');
  await form.getByLabel('Ad', { exact: true }).fill('Elektrik altyapı fonu');
  await form.getByLabel('Tutar', { exact: true }).fill('1500');
  await form.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Tarife eklendi')).toBeVisible();
  await expect(page.getByRole('row', { name: /ELK/ })).toContainText('Doğrulanmadı');
});
