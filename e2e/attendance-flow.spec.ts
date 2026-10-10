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

/** Şirket saat dilimine göre bu ay (YYYY-AA): sayfa da aynı ayla açılır. */
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Nicosia', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

test('puantaj: çizelgeyi boya → kaydet → günlük giriş → özet ve işçilik → ayı kapat → gerekçeyle yeniden aç', async ({ page }) => {
  await signUpWithCompany(page, 'att');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const month = thisMonth();
  const saved = page.getByText('Puantaj kaydedildi').first();

  // Personel: işe giriş tarihi ayın 1'i (puantaj için gerekli)
  await nav.getByRole('link', { name: 'Personel' }).click();
  await page.getByRole('button', { name: 'Yeni personel' }).first().click();
  await dialog.getByLabel('Ad soyad').fill('Ali Demir');
  await dialog.getByLabel('İşe giriş tarihi').fill(`${month}-01`);
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Ali Demir/, level: 1 })).toBeVisible();

  // Aylık çizelge: fırça = çalıştı 8 saat → 1. ve 2. gün; fırça = yıllık izin → 3. gün
  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await expect(page.getByRole('heading', { name: 'Puantaj', level: 1 })).toBeVisible();
  await expect(page.getByText('Ay açık', { exact: true })).toBeVisible();
  await page.getByLabel('Normal saat', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Ali Demir, 1: boş', exact: true }).click();
  await page.getByRole('button', { name: 'Ali Demir, 2: boş', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ali Demir, 2: Çalıştı 8 s', exact: true })).toBeVisible();
  await page.getByLabel('Fırça', { exact: true }).selectOption('annual_leave');
  await page.getByRole('button', { name: 'Ali Demir, 3: boş', exact: true }).click();
  await expect(page.getByText('3 değişiklik bekliyor')).toBeVisible();
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(saved).toBeVisible();
  await expect(page.getByText('3 değişiklik bekliyor')).toHaveCount(0);

  // Kalıcı: sayfayı yenileyince kayıtlar yerinde
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ali Demir, 3: Yıllık izin', exact: true })).toBeVisible();

  // Günlük giriş: 1. gün fazla mesai 2 saat
  await page.getByRole('tab', { name: 'Günlük giriş' }).click();
  await page.getByLabel('Tarih', { exact: true }).fill(`${month}-01`);
  await expect(page.getByLabel('Gün türü Ali Demir')).toHaveValue('worked');
  await page.getByLabel('Fazla mesai saati Ali Demir').fill('2');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(saved).toBeVisible();

  // Aylık özet: 2 gün çalıştı, 1 gün yıllık izin, 16 normal + 2 fazla mesai saati
  await page.getByRole('tab', { name: 'Aylık özet' }).click();
  const row = page.getByRole('row', { name: /Ali Demir/ });
  await expect(row).toContainText('16,00');
  await expect(row).toContainText('2,00');

  // İşçilik saatleri: etiketsiz satır
  await page.getByRole('tab', { name: 'İşçilik saatleri' }).click();
  await expect(page.getByRole('row', { name: /Etiketsiz/ })).toContainText('16,00');

  // Ayı kapat → çizelge salt okunur
  await page.getByRole('button', { name: 'Ayı kapat' }).click();
  await dialog.getByLabel('Not (isteğe bağlı)').fill('Bordroya gitti');
  await dialog.getByRole('button', { name: 'Ayı kapat' }).click();
  await expect(page.getByText('Ay kapalı', { exact: true })).toBeVisible();
  await expect(page.getByText(/Puantaj değiştirilemez/)).toBeVisible();
  await page.getByRole('tab', { name: 'Aylık çizelge' }).click();
  await expect(page.getByRole('button', { name: 'Ali Demir, 4: boş', exact: true })).toBeDisabled();

  // Gerekçesiz açılmaz; gerekçeyle açılır ve kayda geçer
  await page.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await expect(dialog.getByRole('button', { name: 'Ayı yeniden aç' })).toBeDisabled();
  await dialog.getByLabel('Gerekçe').fill('Eksik mesai girişi');
  await dialog.getByRole('button', { name: 'Ayı yeniden aç' }).click();
  await expect(page.getByText('Ay açık', { exact: true })).toBeVisible();
  await expect(page.getByText(/1 kez yeniden açıldı.*Eksik mesai girişi/)).toBeVisible();
  // Çizelge yeniden düzenlenebilir (fırça saat girilmeden de izin/hafta tatili boyar)
  await page.getByLabel('Fırça', { exact: true }).selectOption('weekly_rest');
  await expect(page.getByRole('button', { name: 'Ali Demir, 4: boş', exact: true })).toBeEnabled();
});
