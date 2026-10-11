import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';

const PASSWORD = 'Sifre-12345-xyz';

async function signUpWithCompany(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Deniz Aksoy');
  await page.getByLabel('Firma / kuruluş adı').fill('Aksoy Ticaret');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Aksoy Ticaret Ltd.');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Deniz' })).toBeVisible();
}

/** Öneri 24: temel görünüm boş ikincil alanları gizler; zorunlu alanlar kalır; seçim hesapta saklanır. */
test('temel form görünümü ikincil alanları gizler ve seçim saklanır', async ({ page }) => {
  await signUpWithCompany(page, `e2e-form-${Date.now()}@example.com`);
  await page.goto('/invoices/new?type=sales');
  await expect(page.getByLabel('Vade tarihi')).toBeVisible();
  await expect(page.getByLabel('Para birimi', { exact: true })).toBeVisible();

  const saved = page.waitForResponse((r) => r.url().includes('/api/me/preferences/form.detail') && r.request().method() === 'PUT' && r.ok());
  await page.getByRole('button', { name: 'Temel', exact: true }).click();
  await saved;
  await expect(page.getByLabel('Vade tarihi')).toHaveCount(0);
  await expect(page.getByLabel('Para birimi', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Açıklama', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Fatura tarihi')).toBeVisible();
  await expect(page.getByLabel('Miktar 1')).toBeVisible();

  // Sunucuda saklanır: yeniden açılışta temel görünüm gelir
  await page.reload();
  await expect(page.getByRole('button', { name: 'Temel', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Vade tarihi')).toHaveCount(0);

  // Değer taşıyan alan temel görünümde de gizlenmez: ayrıntılıda doldurulan açıklama temel görünümde kalır
  await page.getByRole('button', { name: 'Ayrıntılı', exact: true }).click();
  await page.getByLabel('Açıklama', { exact: true }).fill('Şube teslimi');
  await page.getByRole('button', { name: 'Temel', exact: true }).click();
  await expect(page.getByLabel('Açıklama', { exact: true })).toHaveValue('Şube teslimi');
  await expect(page.getByLabel('Vade tarihi')).toHaveCount(0);
});
