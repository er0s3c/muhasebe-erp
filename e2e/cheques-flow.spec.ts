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

const addDays = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Tutarlar ve günler YALNIZCA TEST AMAÇLIDIR; hesap eşlemeleri doğrulanmamış varsayılanlardır. */
test('çek/senet: alınan çek (fatura kalemi kapanır) → tahsile ver → takas ile tahsil → karşılıksız → rapor; teminat mektubu süre uyarısı', async ({ page }) => {
  await signUpWithCompany(page, 'cheque');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // 1) Müşteri ve 1.000 TL'lik satış faturası
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await page.getByRole('button', { name: 'Yeni cari' }).first().click();
  await page.getByLabel('Ünvan / ad soyad').fill('Ali Veli');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'Ali Veli', level: 1 })).toBeVisible();

  await nav.getByRole('link', { name: 'Satış faturaları' }).click();
  await page.getByRole('button', { name: 'Yeni satış faturası' }).first().click();
  const customer = page.getByRole('combobox', { name: 'Müşteri' });
  await customer.click();
  await customer.fill('Ali');
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('Açıklama 1').fill('Hizmet');
  await page.getByLabel('Miktar 1').fill('1');
  await page.getByLabel('Birim fiyat 1').fill('1000');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: /SF-\d{4}-000001/, level: 1 })).toBeVisible();

  // 2) Banka hesabı
  await nav.getByRole('link', { name: 'Hesaplar', exact: true }).click();
  await page.getByRole('button', { name: 'Yeni hesap' }).first().click();
  await dialog.getByLabel('Hesap adı').fill('KTB TL');
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'KTB TL', level: 1 })).toBeVisible();

  // 3) Alınan çek: 600 TL, fatura kalemi kısmen kapanır (Dağıt)
  await nav.getByRole('link', { name: 'Çek/senet portföyü' }).click();
  await expect(page.getByRole('heading', { name: 'Çek/senet portföyü ve takas', level: 1 })).toBeVisible();
  await expect(page.getByText('DOĞRULANMAMIŞTIR').first()).toBeVisible();
  await expect(page.getByText('Çek/senet bulunamadı')).toBeVisible();
  await page.getByRole('button', { name: 'Alınan çek/senet' }).click();
  await dialog.getByLabel('Çek/senet numarası').fill('C-1001');
  await dialog.getByLabel('Banka', { exact: true }).fill('Test Bankası');
  const drawer = dialog.getByRole('combobox', { name: 'Keşideci (müşteri)' });
  await drawer.click();
  await drawer.fill('Ali');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('Tutar (TRY)').fill('600');
  await dialog.getByLabel('Vade tarihi').fill(addDays(10));
  await dialog.getByRole('button', { name: 'Dağıt' }).click();
  await expect(dialog.getByText(/Kalemlere ayrılan/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('C-1001 kaydedildi')).toBeVisible();
  const row = page.getByRole('row', { name: /C-1001/ });
  await expect(row).toContainText('Portföyde');
  await expect(row).toContainText('Ali Veli');

  // 4) Tahsile ver (banka hesabı seçilir) → Tahsilde
  await page.getByRole('button', { name: 'Tahsile ver: C-1001' }).click();
  await dialog.getByLabel('Banka hesabı').selectOption({ label: 'KTB TL' });
  await dialog.getByRole('button', { name: 'Tahsile ver', exact: true }).click();
  await expect(page.getByText(/İşlem kaydedildi: CTK-\d{4}-000001/)).toBeVisible();
  await expect(row).toContainText('Tahsilde');

  // 5) Takas: toplu tahsil
  await page.getByRole('tab', { name: 'Takas' }).click();
  await page.getByRole('tab', { name: 'Toplu tahsil', exact: true }).click();
  await page.getByRole('checkbox', { name: 'C-1001' }).check();
  await expect(page.getByText(/1 belge seçili/)).toBeVisible();
  await page.getByRole('button', { name: 'Tahsil edildi olarak işle' }).click();
  await expect(page.getByText(/İşlem kaydedildi: CTK-\d{4}-000002/)).toBeVisible();
  await expect(page.getByText('Bu işlem için uygun belge yok')).toBeVisible();
  const history = page.getByRole('table', { name: 'Toplu işlem geçmişi' });
  await expect(history.getByRole('row')).toHaveCount(3); // başlık + 2 işlem

  // 6) Bankada 600 TL
  await nav.getByRole('link', { name: 'Hesaplar', exact: true }).click();
  await expect(page.getByText('₺600,00').first()).toBeVisible();

  // 7) İkinci çek: avans; tahsile ver → karşılıksız → cari alacağı yeniden açılır
  await nav.getByRole('link', { name: 'Çek/senet portföyü' }).click();
  await page.getByRole('button', { name: 'Alınan çek/senet' }).click();
  await dialog.getByLabel('Çek/senet numarası').fill('C-1002');
  await dialog.getByLabel('Banka', { exact: true }).fill('Test Bankası');
  const drawer2 = dialog.getByRole('combobox', { name: 'Keşideci (müşteri)' });
  await drawer2.click();
  await drawer2.fill('Ali');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('Tutar (TRY)').fill('400');
  await dialog.getByLabel('Vade tarihi').fill(addDays(3));
  await dialog.getByRole('button', { name: 'Dağıt' }).click();
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('C-1002 kaydedildi')).toBeVisible();
  const row2 = page.getByRole('row', { name: /C-1002/ });
  await page.getByRole('button', { name: 'Tahsile ver: C-1002' }).click();
  await dialog.getByLabel('Banka hesabı').selectOption({ label: 'KTB TL' });
  await dialog.getByRole('button', { name: 'Tahsile ver', exact: true }).click();
  await expect(row2).toContainText('Tahsilde');
  await page.getByRole('button', { name: 'Karşılıksız: C-1002' }).click();
  await expect(dialog.getByText('Bu işlem cariye yeni bir açık kalem yazar')).toBeVisible();
  await dialog.getByRole('button', { name: 'Karşılıksız', exact: true }).click();
  await expect(page.getByText(/İşlem kaydedildi: CTK-\d{4}-000004/)).toBeVisible();

  // 8) Raporlar: karşılıksız listesi ve vade analizi
  await page.getByRole('tab', { name: 'Raporlar' }).click();
  const bounced = page.getByRole('table', { name: 'Karşılıksız belgeler' });
  await expect(bounced).toContainText('C-1002');
  await expect(page.getByRole('table', { name: 'Vade analizi' })).toBeVisible();

  // 9) Cari: karşılıksız çek 400 TL alacağı yeniden açtı
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  // Çek tablosunda da "Ali Veli" hücresi var: önce cari listesine geçildiğini bekle (aksi halde eski sayfadaki hücreye tıklanır)
  await expect(page.getByRole('heading', { name: 'Cari hesaplar', level: 1 })).toBeVisible();
  await page.getByRole('cell', { name: /Ali Veli/ }).click();
  await expect(page.getByRole('heading', { name: 'Ali Veli', level: 1 })).toBeVisible();
  await expect(page.getByText(/Karşılıksız: Çek C-1002/).first()).toBeVisible();

  // 10) Banka teminat mektubu: uyarı günü ayarı → mektup → dolmak üzere → sonuçlandır
  await nav.getByRole('link', { name: 'Teminat mektupları' }).click();
  await expect(page.getByRole('heading', { name: 'Banka teminat mektupları', level: 1 })).toBeVisible();
  await expect(page.getByText('DOĞRULANMADI').first()).toBeVisible();
  await expect(page.getByText(/Uyarı günü tanımsız/)).toBeVisible();
  await page.getByLabel('Uyarı günü').fill('30');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Uyarı günü kaydedildi')).toBeVisible();
  await page.getByRole('button', { name: 'Yeni mektup' }).first().click();
  await dialog.getByLabel('Mektup numarası').fill('TM-1');
  await dialog.getByLabel(/^Banka/).fill('Test Bankası');
  await dialog.getByLabel('Karşı taraf adı').fill('İşveren Kurumu');
  await dialog.getByLabel(/^Tutar/).fill('5000');
  await dialog.getByLabel('Son kullanma tarihi').fill(addDays(10));
  await dialog.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Mektup kaydedildi')).toBeVisible();
  const g = page.getByRole('row', { name: /TM-1/ });
  await expect(g).toContainText('Dolmak üzere');
  await expect(g).toContainText('İşveren Kurumu');
  await page.getByRole('button', { name: 'Sonuçlandır' }).click();
  await dialog.getByRole('button', { name: 'Sonuçlandır' }).click();
  await expect(page.getByText('Mektup sonuçlandırıldı')).toBeVisible();
  await expect(page.getByText('Teminat mektubu bulunamadı')).toBeVisible();
});
