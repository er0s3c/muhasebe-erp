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

const addDays = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Test değerleri YALNIZCA TEST AMAÇLIDIR (yasal değer değildir). */
test('yabancı işçi: personel (uyruklu) → belge (numara maskeli, gerekçeyle göster) → uyarı günü + teminat parametresi (doğrulanmadı) → dolmak üzere → yenile → teminat → sonuçlandır', async ({ page }) => {
  await signUpWithCompany(page, 'foreign');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  await nav.getByRole('link', { name: 'Personel', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni personel' }).first().click();
  await dialog.getByLabel('Ad soyad').fill('Ali Demir');
  await dialog.getByLabel('Uyruk').fill('Test-Uyruk');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Ali Demir/, level: 1 })).toBeVisible();

  // Ayarlar: genel belge türleri hazır; parametre yok
  await nav.getByRole('link', { name: 'Yabancı işçi ayarları' }).click();
  await expect(page.getByRole('heading', { name: 'Yabancı işçi ayarları', level: 1 })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Çalışma izni', exact: true })).toBeVisible();
  await expect(page.getByText('Henüz parametre yok')).toBeVisible();
  const form = page.locator('form').filter({ has: page.getByLabel('Kaynak notu') });
  // Uyarı günü (açık)
  await form.getByLabel('Parametre', { exact: true }).selectOption('expiry_warning_days');
  await form.getByLabel('Değer', { exact: true }).fill('30');
  await form.getByLabel('Yeni parametre açık').click();
  await form.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Parametre eklendi')).toBeVisible();
  await expect(page.getByText('Parametre eklendi')).toBeHidden();
  // Teminat tutarı (açık)
  await form.getByLabel('Parametre', { exact: true }).selectOption('guarantee_amount');
  await form.getByLabel('Değer', { exact: true }).fill('100');
  await form.getByLabel('Yeni parametre açık').click();
  await form.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Parametre eklendi')).toBeVisible();
  await expect(page.getByText('Doğrulanmadı').first()).toBeVisible();

  // Belge ekle
  await nav.getByRole('link', { name: 'Yabancı işçi belgeleri' }).click();
  await page.getByRole('button', { name: 'Yeni belge' }).first().click();
  await dialog.getByLabel('Personel').selectOption({ index: 1 });
  await dialog.getByLabel('Belge numarası').fill('TST-9876543');
  await dialog.getByLabel('Veren makam').fill('Test Makamı');
  await dialog.getByLabel('Son kullanma tarihi').fill(addDays(10));
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Belge eklendi')).toBeVisible();
  const row = page.getByRole('row', { name: /Ali Demir/ });
  await expect(row.getByText('Dolmak üzere')).toBeVisible();
  await expect(row.getByText('••••6543')).toBeVisible();
  await expect(page.getByText('TST-9876543')).toHaveCount(0);

  // Gerekçeyle göster
  await page.getByRole('button', { name: /^Göster: Ali Demir/ }).click();
  await dialog.getByLabel('Gerekçe').fill('Kayıt doğrulaması');
  await dialog.getByRole('button', { name: 'Göster', exact: true }).click();
  await expect(page.getByText('TST-9876543')).toBeVisible();

  // Yenile
  await page.getByRole('button', { name: /^Yenile: Ali Demir/ }).click();
  await dialog.getByLabel('Yeni son kullanma tarihi').fill(addDays(400));
  await dialog.getByRole('button', { name: 'Yenile' }).click();
  await expect(page.getByText('Belge yenilendi')).toBeVisible();
  await expect(page.getByRole('row', { name: /Ali Demir/ }).getByText('Geçerli', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Geçmiş: Ali Demir/ }).click();
  await expect(dialog.getByText(/Önceki:/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Kapat' }).click();

  // Teminat
  await page.getByRole('tab', { name: 'Teminatlar' }).click();
  await page.getByRole('button', { name: 'Teminat kaydet' }).first().click();
  await dialog.getByLabel('Personel').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Teminat kaydedildi')).toBeVisible();
  const grow = page.getByRole('row', { name: /Ali Demir/ });
  await expect(grow.getByText('Tutuluyor')).toBeVisible();
  await expect(grow.getByText('Doğrulanmadı')).toBeVisible();
  await grow.getByRole('button', { name: 'Sonuçlandır' }).click();
  await dialog.getByRole('button', { name: 'Sonuçlandır' }).click();
  await expect(page.getByText('Teminat sonuçlandırıldı')).toBeVisible();
  await expect(page.getByRole('row', { name: /Ali Demir/ }).getByText('İade edildi')).toBeVisible();
});
