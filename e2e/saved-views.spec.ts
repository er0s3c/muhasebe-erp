import { type Page } from '@playwright/test';
import { expect, test, withOpenMenu } from './fixtures';

const PASSWORD = 'Sifre-12345-xyz';

async function signUpWithCompany(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Selin Yücel');
  await page.getByLabel('Firma / kuruluş adı').fill('Yücel Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel İnşaat Ltd.');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
}

/**
 * Öneri 5 / F2a bitiş ölçütü: bir cihazda kaydedilen görünüm, aynı kullanıcı başka cihazda (yerel depolaması boş ayrı
 * tarayıcı bağlamında) girince açılır ve aynı filtreyi uygular.
 */
test('kayıtlı görünüm başka cihazda da açılır', async ({ page, browser }) => {
  const email = `e2e-gorunum-${Date.now()}@example.com`;
  await signUpWithCompany(page, email);
  await page.goto('/parties');
  await expect(page.getByRole('heading', { name: 'Cari hesaplar', level: 1 })).toBeVisible();
  await page.getByLabel('Tür', { exact: true }).selectOption('supplier');
  await page.getByRole('button', { name: 'Görünümü kaydet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Filtre görünümünü kaydet' });
  await dialog.getByLabel('Görünüm adı').fill('Tedarikçiler');
  await dialog.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // İkinci cihaz: ayrı bağlam (çerez ve yerel depo boş), aynı kullanıcı
  const other = await withOpenMenu(await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Nicosia' }));
  const second = await other.newPage();
  await second.goto('/login');
  await second.getByLabel('E-posta').fill(email);
  await second.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
  await second.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(second.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
  await second.goto('/parties');
  const kind = second.getByLabel('Tür', { exact: true });
  await expect(kind).toHaveValue('');
  await second.getByLabel('Kayıtlı görünüm uygula').selectOption({ label: 'Tedarikçiler' });
  await expect(kind).toHaveValue('supplier');
  await other.close();
});
