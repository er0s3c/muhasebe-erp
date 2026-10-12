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

/** Odaktaki öğenin çerçevesi veya gölgesi görünür mü (WCAG 2.4.7 / 2.4.11). */
const focusVisible = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    const ring = s.boxShadow !== 'none' && s.boxShadow !== '';
    return outline || ring;
  });

/**
 * Öneri 21: kritik akış yalnız klavyeyle tamamlanabilir. İlk Tab "İçeriğe geç" bağlantısını gösterir; komut paleti Ctrl+K
 * ile açılır ve Enter ile sayfaya gider; kayıt penceresinde odak pencerenin içindedir, Enter kaydeder, Escape kapatır ve
 * odak açan düğmeye döner; klavye odağı görünürdür.
 */
test('klavye: içeriğe geç, komut paleti, kayıt penceresi ve görünür odak', async ({ page }) => {
  await signUpWithCompany(page, 'klavye');

  // 1) Yeni yüklenen sayfada ilk Tab: atlama bağlantısı görünür ve odakta; Enter ana içeriğe götürür
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'İçeriğe geç' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  expect(await focusVisible(page)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);

  // 2) Komut paleti: Ctrl+K arama kutusuna odaklanır; yazıp Enter sayfaya götürür
  await page.keyboard.press('Control+k');
  const search = page.getByLabel('Sayfa veya işlem ara');
  await expect(search).toBeFocused();
  await page.keyboard.type('Cari hesaplar');
  await expect(page.getByRole('option').first()).toContainText('Cari hesaplar');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/parties$/);
  await expect(page.getByRole('heading', { name: 'Cari hesaplar', level: 1 })).toBeVisible();

  // 3) Kayıt penceresi: düğme klavyeyle açılır, odak pencerenin içine geçer; Escape kapatır ve odak düğmeye döner
  const open = page.getByRole('button', { name: 'Yeni cari' }).first();
  await open.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();

  // 4) Yeniden açıp yalnız klavyeyle kaydet: ad yazılır, Enter birincil işlemi (Kaydet) çalıştırır
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Ünvan / ad soyad').focus();
  await page.keyboard.type('Klavye Ticaret');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Klavye Ticaret', level: 1 })).toBeVisible();

  // 5) Klavyeyle gelinen düğmede odak görünür
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  expect(await focusVisible(page), `odakta: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`).toBe(true);
});
