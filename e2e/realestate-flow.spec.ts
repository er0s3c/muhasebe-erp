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
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
}

test('gayrimenkul satışı: toplu birim → sözleşme + taksit planı → yürürlüğe al → teslim; ikinci sözleşmede fesih; proje satış özeti', async ({ page }) => {
  await signUpWithCompany(page, 'gayrimenkul');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');
  const pick = async (scope: typeof page | ReturnType<typeof page.getByRole>, name: string | RegExp, q: string) => {
    const box = scope.getByRole('combobox', { name });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };

  // Hazırlık: alıcı (müşteri) ve kendi projesi
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Sarah Thompson');
  await dialog.getByLabel('Tür').selectOption('customer');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Sarah Thompson', level: 1 })).toBeVisible();
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('button', { name: 'Yeni proje' }).first().click();
  await dialog.getByLabel('Proje adı').fill('Güneş Sitesi');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Güneş Sitesi', level: 1 })).toBeVisible();

  // 1) Toplu birim üretimi: A blok, 1–2. kat, kat başına 2 birim = 101, 102, 201, 202
  await nav.getByRole('link', { name: 'Birimler' }).click();
  await expect(page.getByText('Henüz birim yok')).toBeVisible();
  await page.getByRole('button', { name: 'Toplu üret' }).first().click();
  await pick(dialog, /^Proje/, 'Güneş');
  await dialog.getByLabel('Blok').fill('A');
  await dialog.getByLabel('İlk kat').fill('1');
  await dialog.getByLabel('Son kat').fill('2');
  await dialog.getByLabel('Kat başına birim').fill('2');
  await dialog.getByRole('button', { name: '4 birim üret' }).click();
  await expect(page.getByText('4 birim eklendi, 0 atlandı')).toBeVisible();
  await expect(page.getByRole('row', { name: /A-101/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Kat planı' }).click();
  await expect(page.getByRole('button', { name: /^A-202 Satışa açık/ })).toBeVisible();

  // 2) Sözleşme: TL bedel 100.000, peşinat 20.000, 4 eşit taksit → plan 20.000 + 4 × 20.000
  await nav.getByRole('link', { name: 'Satış sözleşmeleri' }).click();
  await page.getByRole('button', { name: 'Yeni sözleşme' }).first().click();
  await pick(page, /^Birim/, '101');
  await pick(page, /^Alıcı/, 'Sarah');
  await page.getByLabel('Para birimi').selectOption('TRY');
  await page.getByLabel(/^Bedel/).fill('100000');
  await page.getByLabel('Peşinat', { exact: true }).fill('20000');
  await page.getByLabel('Taksit sayısı').fill('4');
  await page.getByLabel('İlk taksit vadesi').fill('2027-01-15');
  await page.getByRole('button', { name: 'Planı oluştur' }).click();
  await expect(page.getByLabel('Tutar 1')).toHaveValue('20.000,00');
  await expect(page.getByLabel('Tutar 5')).toHaveValue('20.000,00');
  await page.getByRole('button', { name: 'Taslak kaydet' }).click();
  await expect(page.getByRole('heading', { name: /SSZ-\d{4}-000001/, level: 1 })).toBeVisible();
  await expect(page.getByText('Taslak', { exact: true }).first()).toBeVisible();

  // 3) Yürürlüğe al → birim satıldı; taksitler bekliyor
  await page.getByRole('button', { name: 'Etkinleştir' }).click();
  await dialog.getByRole('button', { name: 'Etkinleştir' }).click();
  await expect(page.getByText('Sözleşme yürürlüğe alındı')).toBeVisible();
  await expect(page.getByText('Yürürlükte', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Bekliyor').first()).toBeVisible();
  await expect(page.getByText('Kalan').first()).toBeVisible();

  // 4) Teslim: gelir tanınır
  await page.getByRole('button', { name: 'Teslim et' }).click();
  await dialog.getByRole('button', { name: 'Teslim et' }).click();
  await expect(page.getByText('Birim teslim edildi, gelir tanındı')).toBeVisible();
  await expect(page.getByText('Teslim edildi', { exact: true }).first()).toBeVisible();

  // 5) İkinci sözleşme (A-102): yürürlüğe al, tahsilatsız feshet → birim yeniden satışa açık
  await nav.getByRole('link', { name: 'Satış sözleşmeleri' }).click();
  await page.getByRole('button', { name: 'Yeni sözleşme' }).first().click();
  await pick(page, /^Birim/, '102');
  await pick(page, /^Alıcı/, 'Sarah');
  await page.getByLabel('Para birimi').selectOption('TRY');
  await page.getByLabel(/^Bedel/).fill('50000');
  await page.getByLabel('Taksit sayısı').fill('2');
  await page.getByLabel('İlk taksit vadesi').fill('2027-02-01');
  await page.getByRole('button', { name: 'Planı oluştur' }).click();
  await page.getByRole('button', { name: 'Taslak kaydet' }).click();
  await expect(page.getByRole('heading', { name: /SSZ-\d{4}-000002/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Etkinleştir' }).click();
  await dialog.getByRole('button', { name: 'Etkinleştir' }).click();
  await expect(page.getByText('Sözleşme yürürlüğe alındı')).toBeVisible();
  await page.getByRole('button', { name: 'Feshet' }).click();
  await dialog.getByLabel(/^Fesih nedeni/).fill('Alıcı vazgeçti');
  await dialog.getByRole('button', { name: 'Feshet' }).click();
  await expect(page.getByText('Sözleşme feshedildi')).toBeVisible();
  await expect(page.getByText('Feshedildi', { exact: true }).first()).toBeVisible();

  // 6) Birimler ve proje satış özeti
  await nav.getByRole('link', { name: 'Birimler' }).click();
  await expect(page.getByRole('row', { name: /A-101.*Teslim edildi/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /A-102.*Satışa açık/ })).toBeVisible();
  await nav.getByRole('link', { name: 'Projeler' }).click();
  await page.getByRole('row', { name: /Güneş Sitesi/ }).click();
  await page.getByRole('tab', { name: 'Satış' }).click();
  await expect(page.getByText('Sözleşme bedeli')).toBeVisible();
  await expect(page.getByText('100.000,00').first()).toBeVisible();
});
