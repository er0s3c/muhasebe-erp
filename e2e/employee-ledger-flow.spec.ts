import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { setupKktcPayroll } from './country-payroll';

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

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Nicosia', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

/**
 * Personel cari ve avans (X5): personel + ücret şartı + puantaj → cari aç → banka hesabı → avans ver (bakiye: personel borçlu) →
 * taslak bordroda avans kesintisi (net düşer) → puantajı kapat, onayla → bakiye (şirket borçlu) → maaş öde → ekstre.
 * Tutarlar test değeridir; hesap eşlemeleri doğrulanmamış varsayılandır.
 */
test('personel cari ve avans: avans ver → bordrodan kesinti → onay → maaş ödemesi → ekstre', async ({ page }) => {
  await signUpWithCompany(page, 'empledger');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const month = thisMonth();

  // Personel + puantaj + ücret şartı
  await nav.getByRole('link', { name: 'Personel', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni personel' }).first().click();
  await dialog.getByLabel('Ad soyad').fill('Mehmet Kaya');
  await dialog.getByLabel('İşe giriş tarihi').fill(`${month}-01`);
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Mehmet Kaya/, level: 1 })).toBeVisible();

  // Cari aç (personel kartından): yalnızca ad kopyalanır
  await expect(page.getByText('Personel carisi henüz açılmamış.').or(page.getByRole('button', { name: 'Cari aç' })).first()).toBeVisible();
  await page.getByRole('button', { name: 'Cari aç' }).click();
  await expect(page.getByText('Personel carisi açıldı').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Personel carisini aç' })).toBeVisible();

  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByLabel('Normal saat', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Mehmet Kaya, 1: boş', exact: true }).click();
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Puantaj kaydedildi').first()).toBeVisible();

  await nav.getByRole('link', { name: 'İK ve bordro ayarları' }).click();
  await page.getByRole('tab', { name: 'Bordro' }).click();
  const termForm = page.locator('form').filter({ has: page.getByLabel('Ücret tutarı') });
  const empSelect = termForm.getByLabel('Personel', { exact: true });
  await empSelect.selectOption((await empSelect.locator('option', { hasText: 'Mehmet Kaya' }).getAttribute('value'))!);
  await termForm.getByLabel('Ücret tutarı').fill('3000');
  await termForm.getByLabel('Geçerlilik başlangıcı').fill(`${month}-01`);
  await termForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Ücret şartı eklendi')).toBeVisible();
  // KKTC ülke kuralı: prim oranları 0 (test değeri) → net = brüt; bu senaryo avans/maaş carisini sınar
  await setupKktcPayroll(page, { month, employees: ['Mehmet Kaya'], employeeInsurancePct: '0', employerInsurancePct: '0' });

  // Banka hesabı (TL)
  await nav.getByRole('link', { name: 'Hesaplar', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni hesap' }).first().click();
  await dialog.getByLabel('Hesap adı').fill('Banka TL');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Banka TL', level: 1 })).toBeVisible();

  // Avans ver: 1.000 TL
  await nav.getByRole('link', { name: 'Avans ve maaş cari' }).click();
  await expect(page.getByRole('heading', { name: 'Personel cari ve avans', level: 1 })).toBeVisible();
  await expect(page.getByText(/mali müşavirce doğrulanmamıştır/)).toBeVisible();
  await page.getByRole('tab', { name: 'Avans sicili' }).click();
  await page.getByRole('button', { name: 'Avans ver' }).click();
  const box = dialog.getByRole('combobox', { name: 'Personel' });
  await box.click();
  await box.fill('Mehmet');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('Tutar').fill('1000');
  await dialog.getByLabel('Ödeme hesabı').selectOption({ label: 'Banka TL · ₺' });
  await dialog.getByLabel('Amaç').fill('Şantiye harcırahı');
  await dialog.getByRole('button', { name: 'Avansı kaydet' }).click();
  await expect(page.getByText('Avans kaydedildi')).toBeVisible();
  const advRow = page.getByRole('row', { name: /AVN-/ });
  await expect(advRow).toContainText('1.000,00');
  await expect(advRow).toContainText('Açık');

  // Bakiye: personel şirkete borçlu
  await page.getByRole('tab', { name: 'Bakiyeler' }).click();
  const balRow = page.getByRole('row', { name: /Mehmet Kaya/ });
  await expect(balRow).toContainText('-1.000,00');
  await expect(balRow).toContainText('personel borçlu');

  // Bordro: taslakta avans kesintisi 600 → net 2.400
  await nav.getByRole('link', { name: 'Bordro', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni bordro' }).first().click();
  await dialog.getByRole('button', { name: 'Bordro aç' }).click();
  await expect(page.getByRole('heading', { name: `${month} bordrosu`, level: 1 })).toBeVisible();
  const runRow = page.getByRole('row', { name: /Mehmet Kaya/ });
  await expect(runRow).toContainText('3.000,00');
  await page.getByRole('button', { name: 'Mehmet Kaya için avans kesintisi' }).click();
  await dialog.getByLabel(/AVN-.* kesinti tutarı/).fill('600');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(runRow).toContainText('2.400,00');

  // Puantajı kapat, onayla
  await nav.getByRole('link', { name: 'Puantaj' }).click();
  await page.getByRole('button', { name: 'Ayı kapat' }).click();
  await dialog.getByRole('button', { name: 'Ayı kapat' }).click();
  await expect(page.getByText('Ay kapalı', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Bordro', exact: true }).click();
  await page.getByRole('row', { name: /BRD-/ }).click();
  await page.getByRole('button', { name: 'Onayla' }).click();
  await dialog.getByRole('button', { name: 'Onayla' }).click();
  await expect(page.getByText('Onaylı', { exact: true })).toBeVisible();

  // Bakiye: net ücret 2.400 + kesinti 600 − avans 1.000 = 2.000 şirket borçlu; avans kısmen kapandı
  await nav.getByRole('link', { name: 'Avans ve maaş cari' }).click();
  await expect(page.getByRole('row', { name: /Mehmet Kaya/ })).toContainText('2.000,00');
  await expect(page.getByRole('row', { name: /Mehmet Kaya/ })).toContainText('şirket borçlu');
  await page.getByRole('tab', { name: 'Avans sicili' }).click();
  await expect(page.getByRole('row', { name: /AVN-/ })).toContainText('Kısmen kapandı');
  await expect(page.getByRole('row', { name: /AVN-/ })).toContainText('400,00');

  // Maaş ödemesi: ödenmemiş net 2.400
  await page.getByRole('tab', { name: 'Maaş ödemeleri' }).click();
  await page.getByRole('button', { name: 'Maaş öde' }).first().click();
  await dialog.getByRole('combobox', { name: 'Personel' }).selectOption({ index: 1 });
  await expect(dialog.getByLabel('Tutar')).toHaveValue('2.400,00');
  await dialog.getByLabel('Ödeme hesabı').selectOption({ label: 'Banka TL · ₺' });
  await dialog.getByRole('button', { name: 'Maaş öde' }).click();
  await expect(page.getByText('Maaş ödemesi kaydedildi')).toBeVisible();
  await expect(page.getByRole('row', { name: /Mehmet Kaya/ })).toContainText('2.400,00');

  // Ekstre
  await page.getByRole('tab', { name: 'Bakiyeler' }).click();
  await expect(page.getByRole('row', { name: /Mehmet Kaya/ })).toContainText('-400,00');
  await page.getByRole('link', { name: /Mehmet Kaya/ }).click();
  await expect(page.getByRole('heading', { name: /Personel cari ekstresi/, level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: /Bordrodan avans kesintisi/ })).toContainText('600,00');
  await expect(page.getByRole('row', { name: /Maaş ödemesi/ })).toContainText('2.400,00');
  await expect(page.getByRole('row', { name: /Şantiye harcırahı/ }).first()).toContainText('1.000,00');
});
