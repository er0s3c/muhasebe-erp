import { expect, test, type Page } from '@playwright/test';

async function signUpWithCompany(page: Page, tag: string) {
  const email = `e2e-${tag}-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Kemal Aydın');
  await page.getByLabel('Firma / kuruluş adı').fill('Aydın Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Aydın İnşaat Ltd.');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Kemal' })).toBeVisible();
}

test('stok: kart aç → giriş → çıkış → kritik seviye → stok durumu → sayım', async ({ page }) => {
  await signUpWithCompany(page, 'stok');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // 1) Stok kartı aç (kritik seviye 8)
  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await expect(page.getByText('Henüz stok kartı yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni stok kartı' }).first().click();
  await page.getByLabel('Ürün / hizmet adı').fill('Çimento 50 kg');
  await page.getByLabel('Birim', { exact: true }).selectOption('cuval');
  await page.getByLabel('Kritik stok seviyesi').fill('8');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Çimento 50 kg', level: 1 })).toBeVisible();
  await expect(page.getByText('ST-000001').first()).toBeVisible();

  // 2) Stok girişi: 10 çuval, birim maliyet 10 ₺
  await page.getByRole('button', { name: 'Stok girişi' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Stok kartı 1' })).toHaveValue(/Çimento 50 kg/);
  await dialog.getByLabel('Miktar 1').fill('10');
  await dialog.getByLabel('Birim maliyet 1').fill('10');
  await expect(dialog.getByLabel('Tutar (TRY) 1')).toHaveText('100,00');
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(page.getByText(/Stok hareketi kaydedildi: SH-\d{4}-000001/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 3) Çıkış: 4 çuval → kalan 6, ortalama maliyetle 60,00
  await page.getByRole('button', { name: 'Çıkış / sarf' }).click();
  await dialog.getByLabel('Miktar 1').fill('4');
  await expect(dialog.getByText('Depoda: 10 çuval')).toBeVisible();
  await dialog.getByRole('button', { name: 'Hareketi kaydet' }).click();
  await expect(page.getByText(/Stok hareketi kaydedildi: SH-\d{4}-000002/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('6 çuval').first()).toBeVisible();
  await expect(page.getByText('Kritik stok', { exact: true })).toBeVisible(); // 6 ≤ 8

  // 4) Depoda olandan fazlası girilemez (negatif stok kapalı)
  await page.getByRole('button', { name: 'Çıkış / sarf' }).click();
  await dialog.getByLabel('Miktar 1').fill('50');
  await expect(dialog.getByText('Depoda yetersiz')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Hareketi kaydet' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // 5) Stok durumu: kritik rozeti, toplam değer ve muhasebe mutabakat uyarısı
  await nav.getByRole('link', { name: 'Stok durumu' }).click();
  const row = page.getByRole('row', { name: /Çimento 50 kg/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('Kritik')).toBeVisible();
  await expect(page.getByRole('cell', { name: '60,00' }).first()).toBeVisible();
  await expect(page.getByText('Stok değeri ile muhasebe bakiyesi arasında fark var')).toBeVisible();

  // 6) Sayım: 7 çuval sayıldı → 1 fazla, işlenince stok 7
  await nav.getByRole('link', { name: 'Sayımlar' }).click();
  await page.getByRole('button', { name: 'Yeni sayım' }).first().click();
  await dialog.getByRole('button', { name: 'Sayımı aç' }).click();
  await expect(page.getByRole('heading', { name: 'Sayım (taslak)', level: 1 })).toBeVisible();
  await page.getByLabel('Sayılan: Çimento 50 kg').fill('7');
  await expect(page.getByText('+1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sayımı işle' }).click();
  await dialog.getByRole('button', { name: 'Sayımı işle' }).click();
  await expect(page.getByText(/Sayım işlendi: SY-\d{4}-000001/)).toBeVisible();

  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await expect(page.getByRole('row', { name: /Çimento 50 kg/ })).toContainText('7 çuval');
});
