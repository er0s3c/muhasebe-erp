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

/** Şirket saat diliminde (Europe/Nicosia) bugün: gg.aa.yyyy */
const todayTr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Nicosia' }).format(new Date()).split('-').reverse().join('.');

test('banka ekstresi: içe aktar → kesin eşleşmeleri uygula → eşleşmeyen satırdan hareket oluştur → fark kapanır → eşleşmeyi kaldır', async ({ page }) => {
  await signUpWithCompany(page, 'mutabakat');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // 1) Banka hesabı (102.001) ve iki defter kaydı: sermaye girişi +1.000, banka masrafı −35
  await nav.getByRole('link', { name: 'Hesaplar', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni hesap' }).first().click();
  await dialog.getByLabel('Hesap adı').fill('KTB TL');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'KTB TL', level: 1 })).toBeVisible();
  await expect(page.getByText('102.001').first()).toBeVisible();

  const pick = async (index: number, search: string) => {
    const box = page.getByRole('combobox', { name: `Hesap ${index}` });
    await box.click();
    await box.fill(search);
    await page.getByRole('listbox').getByRole('option').first().click();
  };
  const journal = async (description: string, debitAccount: string, creditAccount: string, amount: string) => {
    await nav.getByRole('link', { name: 'Yevmiye kayıtları' }).click();
    await expect(page.getByRole('heading', { name: 'Yevmiye kayıtları', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Yeni yevmiye' }).first().click();
    await page.getByRole('textbox', { name: /^Açıklama/ }).fill(description);
    await pick(1, debitAccount);
    await page.getByLabel('Borç 1').fill(amount);
    await pick(2, creditAccount);
    await page.getByLabel('Alacak 2').fill(amount);
    await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
    await expect(page.getByText(/Yevmiye kaydedildi: YV-/)).toBeVisible();
    await page.keyboard.press('Escape');
  };
  await journal('Sermaye girişi', '102.001', '500', '1.000,00');
  await journal('Banka masrafı', '770', '102.001', '35,00');

  // 2) Ekstre: 3 satır (ikisi defterde var, biri yok) + kapanış bakiyesi sütunu
  await nav.getByRole('link', { name: 'Hesaplar', exact: true }).click();
  await page.getByRole('row', { name: /KTB TL/ }).click();
  await expect(page.getByRole('heading', { name: 'KTB TL', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Banka ekstresi' }).click();
  await expect(page.getByText('Henüz banka ekstresi yok')).toBeVisible();
  await page.getByRole('button', { name: 'Ekstre içe aktar' }).first().click();
  const d = todayTr();
  const csv = `Tarih;Açıklama;Tutar;Bakiye\n${d};Sermaye girişi;1.000,00;1.000,00\n${d};Banka masrafı;-35,00;965,00\n${d};Kart aidatı;-12,00;953,00\n`;
  await dialog.locator('input[type=file]').setInputFiles({ name: 'ekstre.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(dialog.getByText('Sütunları eşleyin')).toBeVisible();
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  await expect(dialog.getByText('Kapanış bakiyesi', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'İçe aktar', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'İçe aktarma tamamlandı' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Tamam' }).click();

  // 3) Mutabakat: 3 açık satır, fark −12,00 (ekstre 953 − defter 965)
  await expect(page.getByRole('tab', { name: /^Açık \(3\)/ })).toBeVisible();
  await expect(page.getByText('-₺12,00').first()).toBeVisible();
  await page.getByRole('button', { name: /Kesin eşleşmeleri uygula/ }).click();
  await expect(page.getByText('2 satır eşleştirildi')).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Açık \(1\)/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Eşleşen \(2\)/ })).toBeVisible();

  // 4) Eşleşmeyen satırdan hareket oluştur: tarih/tutar/hesap kilitli, "Diğer ödeme" + karşı hesap 770
  await page.getByRole('row', { name: /Kart aidatı/ }).getByRole('button', { name: 'Hareket oluştur' }).click();
  await expect(dialog.getByText('Ekstre satırından hareket oluşturuluyor')).toBeVisible();
  await expect(dialog.getByLabel('Tarih')).toBeDisabled();
  await expect(dialog.getByRole('tab', { name: 'Tahsilat', exact: true })).toHaveCount(0); // yalnızca çıkış türleri
  await dialog.getByRole('tab', { name: 'Diğer ödeme' }).click();
  const gl = dialog.getByRole('combobox', { name: 'Karşı hesap' });
  await gl.click();
  await gl.fill('770');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByText(/DOD-\d{4}-000001 kaydedildi/)).toBeVisible();

  // 5) Fark kapandı: mutabık, açık satır yok
  await expect(page.getByText('Mutabık')).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Açık \(0\)/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Eşleşen \(3\)/ })).toBeVisible();

  // 6) Eşleşmiş hareket iptal edilemez; eşleşme kaldırılınca yeniden açık ve fark oluşur
  await page.getByRole('tab', { name: /^Eşleşen/ }).click();
  await page.getByRole('row', { name: /Kart aidatı/ }).getByRole('button', { name: 'Eşleşmeyi kaldır' }).click();
  await expect(page.getByText('Eşleşme kaldırıldı')).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Açık \(1\)/ })).toBeVisible();
  await page.getByRole('tab', { name: /^Açık/ }).click();
  // Defterde karşılığı var (önceki adım); aday olarak önerilir, tek tıkla yeniden eşleşir
  await page.getByRole('row', { name: /Kart aidatı/ }).getByRole('button', { name: 'Eşleştir' }).click();
  await expect(page.getByText('Satır eşleştirildi')).toBeVisible();
  await expect(page.getByText('Mutabık')).toBeVisible();
});
