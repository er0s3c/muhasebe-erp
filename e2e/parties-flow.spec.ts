import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function signUpWithCompany(page: Page, tag: string) {
  const email = `e2e-${tag}-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Zeynep Arslan');
  await page.getByLabel('Firma / kuruluş adı').fill('Arslan Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Arslan İnşaat Ltd.');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Zeynep' })).toBeVisible();
}

test('cari: kart aç → cariye bağlı yevmiye (zorunlu) → ekstre ve yaşlandırma', async ({ page }) => {
  await signUpWithCompany(page, 'cari');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });

  // 1) Cari kartı aç
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await expect(page.getByText('Henüz cari yok')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Ömer Çakır');
  await page.getByLabel('Telefon').fill('0533 555 44 33');
  await page.getByRole('dialog').getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Ömer Çakır', level: 1 })).toBeVisible();
  await expect(page.getByText('CR-000001').first()).toBeVisible();

  // 2) Satış kaydı: 120 (cari hesap) borç / 600 alacak
  await nav.getByRole('link', { name: 'Yevmiye kayıtları' }).click();
  await page.getByRole('button', { name: 'Yeni yevmiye' }).first().click();
  await page.getByRole('textbox', { name: /^Açıklama/ }).fill('Daire satışı');
  const pick = async (n: number, q: string) => {
    const box = page.getByRole('combobox', { name: `Hesap ${n}` });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };
  await pick(1, '120');
  await page.getByLabel('Borç 1').fill('1.000,00');
  await pick(2, '600');
  await page.getByLabel('Alacak 2').fill('1.000,00');
  await expect(page.getByText('Dengeli', { exact: true })).toBeVisible();

  // Cari seçmeden kaydedilemez: cari satırı görünür ve istemci uyarısı çıkar
  await expect(page.getByRole('combobox', { name: 'Cari 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByText('Cari hesaplarda (120, 320…) cari seçilmeli')).toBeVisible();

  // Cariyi seç, vade gir, kaydet
  const party = page.getByRole('combobox', { name: 'Cari 1' });
  await party.click();
  await party.fill('Ömer');
  await page.getByRole('listbox').getByRole('option').first().click();
  // Uygulama gününü Europe/Nicosia saatiyle sayar; UTC günü gece 21:00'den sonra bir gün geride kalır
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Nicosia' });
  const due = new Date(`${today}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() - 40); // 40 gün önce vadesi dolmuş
  await page.getByLabel('Vade tarihi 1').fill(due.toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByText(/Yevmiye kaydedildi: YV-\d{4}-000001/)).toBeVisible();
  // Detayda cari adı bağlantı olarak görünür
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Ömer Çakır' })).toBeVisible();
  await page.keyboard.press('Escape');

  // 3) Cari ekstresi ve bakiye
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('cell', { name: /Ömer Çakır/ }).click();
  await expect(page.getByRole('heading', { name: 'Ömer Çakır', level: 1 })).toBeVisible();
  await expect(page.getByText('Bize borçlu')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Daire satışı' })).toBeVisible();
  await expect(page.getByText('1.000,00').first()).toBeVisible();

  // 4) Açık kalem: 40 gün gecikmiş
  await page.getByRole('tab', { name: 'Açık kalemler' }).click();
  await expect(page.getByText('40 gün')).toBeVisible();

  // 5) Yaşlandırma raporu: 31–60 gün sütununda
  await nav.getByRole('link', { name: 'Yaşlandırma raporu' }).click();
  await expect(page.getByRole('heading', { name: 'Cari yaşlandırma raporu', level: 1 })).toBeVisible();
  const row = page.getByRole('row', { name: /Ömer Çakır/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole('cell', { name: '1.000,00' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Borçlar' }).click();
  await expect(page.getByText('Bu tarihte açık kalem yok')).toBeVisible();

  // 6) Genel bakışta toplam alacak
  await nav.getByRole('link', { name: 'Genel bakış' }).click();
  // V3 panosu: "Açık alacaklar" kartı; ayrıntı bağlantısı kartın tamamını kaplar
  await expect(page.getByRole('link', { name: 'Açık alacaklar ayrıntıları' }).locator('xpath=..')).toContainText('1.000,00');
});
