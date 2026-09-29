import { readFileSync, statSync } from 'node:fs';
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

/** "Dışa aktar" menüsünden bir biçim seçer ve inen dosyayı yerel yola kaydeder. */
async function downloadVia(page: Page, itemName: RegExp) {
  await page.getByRole('button', { name: 'Dışa aktar' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: itemName }).click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), path };
}

test('raporlar: yevmiye defteri, mizan dışa aktarma (xlsx/csv), yazdır başlığı ve tam veri dosyası', async ({ page }) => {
  await signUpWithCompany(page, 'rapor');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });

  // 1) Dövizsiz bir yevmiye: 102 borç / 500 alacak 1.234,50 TRY
  await nav.getByRole('link', { name: 'Yevmiye kayıtları' }).click();
  await page.getByRole('button', { name: 'Yeni yevmiye' }).first().click();
  await page.getByRole('textbox', { name: /^Açıklama/ }).fill('Ortak sermaye girişi');
  const pickAccount = async (index: number, search: string) => {
    const box = page.getByRole('combobox', { name: `Hesap ${index}` });
    await box.click();
    await box.fill(search);
    await page.getByRole('listbox').getByRole('option').first().click();
  };
  await pickAccount(1, '100');
  await page.getByLabel('Borç 1').fill('1.234,50');
  await pickAccount(2, '500');
  await page.getByLabel('Alacak 2').fill('1.234,50');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByText(/Yevmiye kaydedildi: YV-\d{4}-000001/)).toBeVisible();
  await page.keyboard.press('Escape');

  // 2) Yeni "Raporlar" grubundaki yevmiye defteri fişin iki satırını gösterir
  await nav.getByRole('link', { name: 'Yevmiye defteri' }).click();
  await expect(page.getByRole('heading', { name: 'Yevmiye defteri', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: /YV-\d{4}-000001.*Kasa/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /YV-\d{4}-000001.*Sermaye/ })).toBeVisible();
  const book = await downloadVia(page, /\.xlsx/);
  expect(book.name).toMatch(/^yevmiye-defteri-\d{4}-01-01_\d{4}-\d{2}-\d{2}\.xlsx$/);

  // 3) Mizan Excel: geçerli bir zip (xlsx) dosyası iner, adı dönemi taşır
  await nav.getByRole('link', { name: 'Mizan' }).click();
  await expect(page.getByText('Mizan dengeli: borç ve alacak eşit')).toBeVisible();
  const xlsx = await downloadVia(page, /\.xlsx/);
  expect(xlsx.name).toMatch(/^mizan-\d{4}-01-01_\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(statSync(xlsx.path).size).toBeGreaterThan(1000);
  expect(readFileSync(xlsx.path).subarray(0, 2).toString('latin1')).toBe('PK');

  // 4) Mizan CSV: BOM'lu, noktalı virgüllü, Türkçe biçimli tutarlar
  const csv = await downloadVia(page, /CSV/);
  expect(csv.name).toMatch(/^mizan-.*\.csv$/);
  const csvText = readFileSync(csv.path, 'utf8');
  expect(csvText.charCodeAt(0)).toBe(0xfeff);
  expect(csvText).toContain(';');
  expect(csvText).toContain('1.234,50');

  // 5) Yazdırma görünümü: ekranda gizli başlık (şirket, dönem, yazdırma tarihi) baskıda görünür; filtreler gizlenir
  const printedAt = page.getByText(/^Yazdırma tarihi:/);
  await expect(printedAt).toBeHidden();
  await page.emulateMedia({ media: 'print' });
  await expect(printedAt).toBeVisible();
  await expect(page.locator('main').getByText('Yücel İnşaat Ltd.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dışa aktar' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expect(printedAt).toBeHidden();

  // 6) Veri dışa aktarma: tüm veriler tek xlsx
  await nav.getByRole('link', { name: 'Veri dışa aktarma' }).click();
  await expect(page.getByText('Dosya şirketin tüm verisini içerir')).toBeVisible();
  const all = await downloadVia(page, /\.xlsx/);
  expect(all.name).toMatch(/^tum-veriler-\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(statSync(all.path).size).toBeGreaterThan(1000);
});
