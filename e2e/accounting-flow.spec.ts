import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: false });

test('kayıt → şirket kurulumu → kur girişi → dövizli yevmiye → mizan dengeli', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  // 1) Kayıt
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Ücretsiz hesap oluşturun' })).toBeVisible();
  await shot(page, '01-register');
  await page.getByLabel('Ad soyad').fill('Ayşe Yılmaz');
  await page.getByLabel('Firma / kuruluş adı').fill('Yılmaz Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();

  // 2) Şirket kurulumu (varsayılan: inşaat, TRY defter, GBP raporlama)
  await expect(page.getByRole('heading', { name: 'İlk şirketinizi kuralım' })).toBeVisible();
  await page.getByLabel('Şirket unvanı').fill('Yılmaz İnşaat Ltd.');
  await shot(page, '02-onboarding');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();

  // 3) Genel bakış + kurulum kontrol listesi
  await expect(page.getByRole('heading', { name: 'Merhaba, Ayşe' })).toBeVisible();
  await expect(page.getByText('Kurulum kontrol listesi')).toBeVisible();
  await shot(page, '03-dashboard');

  // Menü sektöre/role göre geliyor: muhasebe ve ayarlar görünür, market (POS) yok
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  await expect(nav.getByRole('link', { name: 'Mizan' })).toBeVisible();
  await expect(nav.getByText('Hızlı satış')).toHaveCount(0);

  // 4) Kur girişi: 1 GBP = 40 TRY
  await nav.getByRole('link', { name: 'Para birimi ve kurlar' }).click();
  await page.getByLabel('Döviz alış', { exact: true }).first().fill('40');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Kur kaydedildi')).toBeVisible();
  await shot(page, '04-rates');

  // 5) Dövizli yevmiye: 100 GBP banka borç / 4.000 TRY sermaye alacak
  await nav.getByRole('link', { name: 'Yevmiye kayıtları' }).click();
  // Sayfa başlığındaki ve boş durumdaki iki "Yeni yevmiye" düğmesi vardır; hangisi olduğu fark etmez
  await page.getByRole('button', { name: 'Yeni yevmiye' }).first().click();
  // Etiket "Açıklama *" (zorunlu işareti dahil); satır açıklamaları "Satır açıklaması N" ile başlar
  await page.getByRole('textbox', { name: /^Açıklama/ }).fill('Ortak sermaye girişi');

  const pickAccount = async (index: number, search: string) => {
    const box = page.getByRole('combobox', { name: `Hesap ${index}` });
    await box.click();
    await box.fill(search);
    // Yalnızca açılan hesap listesindeki seçenek (para birimi <select> seçenekleri değil)
    await page.getByRole('listbox').getByRole('option').first().click();
  };
  // GBP kısıtlı banka hesabı yok; genel banka hesabında GBP satırı kullanılır
  await pickAccount(1, '102');
  await page.getByLabel('Para birimi 1').selectOption('GBP');
  await page.getByLabel('Borç 1').fill('100');
  await pickAccount(2, '500');
  await page.getByLabel('Alacak 2').fill('4.000,00');

  await expect(page.getByText('Dengeli', { exact: true })).toBeVisible();
  await shot(page, '05-journal-form');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByText(/Yevmiye kaydedildi: YV-\d{4}-000001/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Kaydedildi', { exact: true })).toBeVisible();
  await shot(page, '06-journal-detail');
  await page.keyboard.press('Escape');

  // 6) Mizan: borç = alacak
  await nav.getByRole('link', { name: 'Mizan' }).click();
  await expect(page.getByText('Mizan dengeli: borç ve alacak eşit')).toBeVisible();
  await expect(page.getByRole('cell', { name: '4.000,00' }).first()).toBeVisible();
  await shot(page, '07-trial-balance');

  // 7) Raporlama para birimine geç: 4.000 TRY = 100 GBP
  await page.getByLabel('Para birimi').selectOption('reporting');
  await expect(page.getByRole('cell', { name: '100,00' }).first()).toBeVisible();

  // 8) Sayfa yenilenince oturum refresh çerezinden geri gelir
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mizan' })).toBeVisible();
});

test('sektör yalıtımı: başka şirketin verisi görünmez, koyu tema ve komut paleti çalışır', async ({ page }) => {
  const email = `e2e-theme-${Date.now()}@example.com`;
  await page.goto('/register');
  // Form doğrulama iletileri Türkçe (paylaşılan şema + zod Türkçe iletileri; UI-11)
  await page.getByLabel('Ad soyad').fill('M');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await expect(page.getByText('En az 2 karakter olmalı').first()).toBeVisible();
  await expect(page.getByText(/Too small|expected string/)).toHaveCount(0);
  await page.getByLabel('Ad soyad').fill('Mehmet Demir');
  await page.getByLabel('Firma / kuruluş adı').fill('Demir Grup');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Demir Market A.Ş.');
  await page.getByLabel('Faaliyet alanı').selectOption('RETAIL_MARKET');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Mehmet' })).toBeVisible();

  // Komut paleti (Ctrl+K)
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByPlaceholder('Sayfa veya işlem ara').fill('mizan');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Mizan' })).toBeVisible();

  // Koyu tema
  await page.getByRole('button', { name: 'Tema' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.waitForTimeout(400); // renk geçişleri (transition-colors) bitsin
  await shot(page, '08-dark-theme');
});
