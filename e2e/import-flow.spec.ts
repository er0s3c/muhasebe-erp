import { expect, test, type Page } from '@playwright/test';
import { writeXlsx } from '../apps/api/src/files/xlsx-write';

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

const csv = (text: string) => ({ name: 'dosya.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });

test('içe aktarma: cari (hatalı dosya engellenir → düzeltilmiş dosya), stok kartı (xlsx), stok ve cari açılışı, mizan dengeli', async ({ page }) => {
  await signUpWithCompany(page, 'aktar');
  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const dialog = page.getByRole('dialog');

  // 1) Cari kartları: bozuk e-postalı satır ön izlemede hata verir ve içe aktarma kapalı kalır
  await nav.getByRole('link', { name: 'Cari hesaplar' }).click();
  await expect(page.getByRole('heading', { name: 'Cari hesaplar', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await expect(dialog.getByRole('heading', { name: 'Cari kartları — İçe aktar' })).toBeVisible();
  const bad = 'Kod;Ünvan / Ad Soyad;Tür;Vergi No;E-posta\nCR-000100;Demir Çelik A.Ş.;Tedarikçi;1234567890;\n;Ali Yılmaz;Müşteri;;ali@\n';
  await dialog.locator('input[type=file]').setInputFiles(csv(bad));
  await expect(dialog.getByText('Sütunları eşleyin')).toBeVisible();
  await expect(dialog.getByLabel(/^Ünvan/)).toHaveValue('1'); // başlık "Ünvan / Ad Soyad" otomatik eşlendi
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  await expect(dialog.getByText('Henüz hiçbir kayıt yazılmadı')).toBeVisible();
  await expect(dialog.getByText('"ali@" geçerli bir e-posta adresi değil')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'İçe aktar', exact: true })).toBeDisabled();

  // Düzeltilmiş dosya: geri dön, yeniden yükle
  await dialog.getByRole('button', { name: 'Geri' }).click();
  await dialog.getByRole('button', { name: 'Geri' }).click();
  const good = 'Kod;Ünvan / Ad Soyad;Tür;Vergi No;E-posta\nCR-000100;Demir Çelik A.Ş.;Tedarikçi;1234567890;\n;Ali Yılmaz;Müşteri;;ali@ornek.com\n';
  await dialog.locator('input[type=file]').setInputFiles(csv(good));
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  await expect(dialog.getByText('Yazılacak', { exact: true }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'İçe aktar', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'İçe aktarma tamamlandı' })).toBeVisible();
  await expect(dialog.getByText('2 kayıt oluşturuldu, 0 satır atlandı.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Tamam' }).click();
  await expect(page.getByRole('row', { name: /Demir Çelik A\.Ş\./ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Ali Yılmaz/ })).toBeVisible();

  // Aynı dosya yeniden yüklenirse yinelenenler atlanır (yeni kayıt yok)
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await dialog.locator('input[type=file]').setInputFiles(csv(good.replace(';ali@ornek.com', ';').replace('Ali Yılmaz', 'Veli Kaya')));
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  await expect(dialog.getByText('CR-000100 kodlu cari zaten var; atlandı')).toBeVisible();
  await page.keyboard.press('Escape');

  // 2) Stok kartları: xlsx dosyası (başlık satırı yok sayılmaz; kategori yoksa açılır)
  const xlsx = writeXlsx([
    {
      key: 'kartlar',
      title: 'Kartlar',
      plain: true,
      columns: [
        { key: 'a', label: 'Stok Adı', kind: 'text' },
        { key: 'b', label: 'Birim', kind: 'text' },
        { key: 'c', label: 'Kategori', kind: 'text' },
        { key: 'd', label: 'KDV', kind: 'text' },
      ],
      rows: [
        { a: 'Çimento 50 kg', b: 'çuval', c: 'İnşaat malzemesi', d: '16' },
        { a: 'Demir 12 mm', b: 'ton', c: 'İnşaat malzemesi', d: '16' },
      ],
    },
  ]);
  await nav.getByRole('link', { name: 'Stok kartları' }).click();
  await expect(page.getByRole('heading', { name: 'Stok kartları', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'kartlar.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xlsx) });
  await expect(dialog.getByText('Sütunları eşleyin')).toBeVisible();
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  await expect(dialog.getByText('İnşaat malzemesi')).toBeVisible(); // "Yeni kategori" özeti
  await dialog.getByRole('button', { name: 'İçe aktar', exact: true }).click();
  await expect(dialog.getByText('2 kayıt oluşturuldu, 0 satır atlandı.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Tamam' }).click();
  await expect(page.getByRole('row', { name: /Çimento 50 kg/ })).toBeVisible();

  // 3) Açılış bakiyeleri sayfası: stok açılışı → stok durumunda görünür
  await nav.getByRole('link', { name: 'Açılış bakiyeleri' }).click();
  await expect(page.getByRole('heading', { name: 'Açılış bakiyeleri', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Stok' }).click();
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await dialog.locator('input[type=file]').setInputFiles(csv('Stok kartı;Miktar;Birim maliyet\nÇimento 50 kg;100;10,50\nDemir 12 mm;2;30000\n'));
  await expect(dialog.getByText('Sütunları eşleyin')).toBeVisible();
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  await expect(dialog.getByText('Stok belgesi')).toBeVisible();
  await dialog.getByRole('button', { name: 'İçe aktar', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'İçe aktarma tamamlandı' })).toBeVisible();
  await expect(dialog.getByText(/SH-\d{4}-000001/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Tamam' }).click();

  // 4) Cari açılışı: müşteriye 1.000, tedarikçiye 400 → tek açılış yevmiyesi, fark 500 hesabına
  await page.getByRole('tab', { name: 'Cari bakiyeleri' }).click();
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await dialog.locator('input[type=file]').setInputFiles(csv('Cari Kodu;Borç Bakiyesi;Alacak Bakiyesi\nAli Yılmaz;1.000,00;\nCR-000100;;400,00\n'));
  await dialog.getByRole('button', { name: 'Ön izleme' }).click();
  await expect(dialog.getByText('Karşı hesap')).toBeVisible();
  await dialog.getByRole('button', { name: 'İçe aktar', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'İçe aktarma tamamlandı' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: /YV-\d{4}-000002/ })).toBeVisible(); // stok açılışının otomatik yevmiyesi 000001
  await dialog.getByRole('button', { name: 'Tamam' }).click();

  // 5) Mizan: dengeli; 120 borç 1.000, 320 alacak 400, stok 150 açılışı
  await nav.getByRole('link', { name: 'Mizan' }).click();
  await expect(page.getByText('Mizan dengeli: borç ve alacak eşit')).toBeVisible();
  await expect(page.getByRole('row', { name: /^120 Alıcılar/ })).toContainText('1.000,00');
  await expect(page.getByRole('row', { name: /^320 Satıcılar/ })).toContainText('400,00');
  await expect(page.getByRole('row', { name: /^150 İlk Madde ve Malzeme/ })).toContainText('61.050,00'); // 100×10,50 + 2×30.000
});
