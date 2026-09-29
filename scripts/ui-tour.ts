/**
 * Arayüz turu: demo verisiyle tüm ana ekranların ekran görüntüsünü alır.
 * Önce `npm run db:seed` ve `npm run dev` çalışmalı.
 *
 *   TOUR_OUT=./tour PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run tour
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.TOUR_BASE ?? 'http://localhost:5173';
const OUT = process.env.TOUR_OUT ?? 'tour';
const EMAIL = 'demo@ornek.local';
const PASSWORD = 'Demo-Sifre-123';

mkdirSync(OUT, { recursive: true });

async function waitForServer(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* henüz açılmadı */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Sunucu yanıt vermedi: ${url}`);
}

const settle = (page: Page, ms = 500) => page.waitForLoadState('networkidle').then(() => page.waitForTimeout(ms));
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  ✓', name);
};

async function main() {
  await waitForServer('http://localhost:3000/api/health');
  await waitForServer(BASE);

  const browser = await chromium.launch(
    process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: 'tr-TR',
    timezoneId: 'Europe/Nicosia',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // Giriş ekranı
  await page.goto(`${BASE}/login`);
  await settle(page);
  await shot(page, '01-giris');

  await page.getByLabel('E-posta').fill(EMAIL);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.getByRole('heading', { name: /Merhaba/ }).waitFor();
  await settle(page, 900);
  await shot(page, '02-genel-bakis');

  const go = async (path: string, name: string, ready: string | RegExp) => {
    await page.goto(`${BASE}${path}`);
    await page.getByRole('heading', { name: ready, level: 1 }).waitFor();
    await settle(page);
    await shot(page, name);
  };

  // Yevmiye listesi ve detay
  await go('/accounting/journal', '03-yevmiye-listesi', 'Yevmiye kayıtları');
  await page.getByText('Yurt dışı yatırımcıdan GBP avans').first().click();
  await page.getByRole('dialog').getByText('YV-').first().waitFor();
  await settle(page, 600);
  await shot(page, '04-yevmiye-detay-dovizli');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  await page.getByText('Eylül şantiye ofisi kirası (taslak)').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Muhasebeleştir' }).waitFor();
  await settle(page, 600);
  await shot(page, '05-yevmiye-taslak');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Yeni yevmiye formu: gerçekçi bir giriş
  await page.getByRole('button', { name: 'Yeni yevmiye' }).click();
  await page.getByRole('textbox', { name: /^Açıklama/ }).fill('Şantiye sarf malzemesi alımı');
  const pick = async (n: number, q: string) => {
    const box = page.getByRole('combobox', { name: `Hesap ${n}` });
    await box.click();
    await box.fill(q);
    await page.getByRole('listbox').getByRole('option').first().click();
  };
  await pick(1, '150');
  await page.getByLabel('Borç 1').fill('120.000,00');
  await pick(2, '191');
  await page.getByLabel('Borç 2').fill('19.200,00');
  // "Satır ekle": farkı kapatacak alacak tutarı otomatik hazırlanır
  await page.getByRole('button', { name: 'Satır ekle' }).click();
  await pick(3, '320');
  // Cari hesap (320): satır bir cariye bağlanır
  const partyBox = page.getByRole('combobox', { name: 'Cari 3' });
  await partyBox.click();
  await partyBox.fill('Hazır');
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByText('Dengeli', { exact: true }).waitFor();
  await settle(page, 600);
  await shot(page, '06-yevmiye-formu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Hesap planı, mizan, ekstre
  await go('/accounting/accounts', '07-hesap-plani', 'Hesap planı');

  await go('/accounting/trial-balance', '08-mizan', 'Mizan');
  await page.getByLabel('Para birimi').selectOption('reporting');
  await settle(page, 700);
  await shot(page, '09-mizan-gbp');

  await page.goto(`${BASE}/accounting/account-ledger`);
  await page.getByRole('heading', { name: 'Hesap ekstresi', level: 1 }).waitFor();
  const combo = page.getByRole('combobox', { name: 'Hesap seçin' });
  await combo.click();
  await combo.fill('102.001');
  await page.getByRole('listbox').getByRole('option').first().click();
  await settle(page, 700);
  await shot(page, '10-hesap-ekstresi');

  // Cari
  await go('/parties', '22-cariler', 'Cari hesaplar');
  await page.getByRole('cell', { name: /Ali Yılmaz/ }).click();
  await page.getByRole('heading', { name: 'Ali Yılmaz', level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '23-cari-ekstre');
  await page.getByRole('tab', { name: 'Açık kalemler' }).click();
  await settle(page, 700);
  await shot(page, '24-cari-acik-kalemler');
  await go('/parties/aging', '25-yaslandirma-alacak', 'Cari yaşlandırma raporu');
  await page.getByRole('tab', { name: 'Borçlar' }).click();
  await settle(page, 700);
  await shot(page, '26-yaslandirma-borc');

  // Stok
  await go('/inventory/items', '30-stok-kartlari', 'Stok kartları');
  await page.getByRole('row', { name: /Nervürlü inşaat demiri/ }).click();
  await page.getByRole('heading', { name: 'Nervürlü inşaat demiri 12 mm', level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '31-stok-karti-ekstre');
  // Dövizli giriş: maliyet £ ile girilir, TL karşılığı hareket günü kuruyla önizlenir
  await page.getByRole('button', { name: 'Stok girişi' }).click();
  const stockForm = page.getByRole('dialog');
  await stockForm.getByLabel('Miktar 1').fill('5');
  await stockForm.getByLabel('Birim maliyet 1').fill('110');
  await stockForm.getByLabel('Para birimi 1').selectOption('GBP');
  await stockForm.getByLabel('Tutar (TRY) 1').filter({ hasText: /\d/ }).waitFor();
  await settle(page, 600);
  await shot(page, '32-stok-giris-formu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await go('/inventory/status', '33-stok-durumu', 'Stok durumu');
  await go('/inventory/movements', '34-stok-hareketleri', 'Stok hareketleri');
  await page.getByText('Depoda bozulan boya (fire)').first().click();
  await page.getByRole('dialog').getByText('SH-').first().waitFor();
  await settle(page, 600);
  await shot(page, '35-stok-belge-detay');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await go('/inventory/counts', '36-sayimlar', 'Stok sayımları');
  await page.getByText('Eylül depo sayımı').first().click();
  await page.getByRole('heading', { name: /^SY-/, level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '37-sayim-detay');
  await go('/inventory/warehouses', '38-depolar', 'Depolar');

  // Ayarlar
  await go('/settings/currencies', '11-kurlar', 'Para birimi ve kurlar');
  // Merkez Bankası XML dosyasından içe aktarma (resmî örnek dosya)
  await page.getByLabel('XML dosyası yükle').setInputFiles('apps/api/test/fixtures/kktcmb-gunluk.xml');
  await page.getByText(/kurları yüklendi/).waitFor();
  await settle(page, 400);
  await shot(page, '11b-kur-xml-yuklendi');
  await go('/settings/tax-rates', '12-kdv-oranlari', 'KDV oranları');
  await go('/settings/periods', '13-donemler', 'Mali dönemler');
  await go('/settings/custom-codes', '14-ozel-kodlar', 'Özel kodlar');
  await go('/settings/members', '15-kullanicilar', /Kullanıcılar/);
  await go('/settings/company', '16-sirket', 'Şirket bilgileri');

  // Komut paleti
  await page.goto(`${BASE}/`);
  await page.getByRole('heading', { name: /Merhaba/ }).waitFor();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Sayfa veya işlem ara').fill('kur');
  await settle(page, 400);
  await shot(page, '17-komut-paleti');
  await page.keyboard.press('Escape');

  // Koyu tema
  await page.getByRole('button', { name: 'Tema' }).click();
  await page.waitForTimeout(500);
  await shot(page, '18-koyu-genel-bakis');
  await go('/accounting/trial-balance', '19-koyu-mizan', 'Mizan');

  // Mobil
  await page.getByRole('button', { name: 'Tema' }).click(); // açık temaya dön
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'tr-TR',
    storageState: await context.storageState(),
  });
  const m = await mobile.newPage();
  await m.goto(`${BASE}/`);
  await m.getByRole('heading', { name: /Merhaba/ }).waitFor();
  await settle(m, 700);
  await m.screenshot({ path: `${OUT}/20-mobil-genel-bakis.png` });
  console.log('  ✓ 20-mobil-genel-bakis');
  await m.getByRole('button', { name: 'Menüyü aç' }).click();
  await m.waitForTimeout(500);
  await m.screenshot({ path: `${OUT}/21-mobil-menu.png` });
  console.log('  ✓ 21-mobil-menu');

  // Mobilde yatay taşma denetimi (sayfa içeriği ekrandan geniş olmamalı)
  const overflowing: string[] = [];
  for (const path of ['/', '/parties', '/parties/aging', '/inventory/items', '/inventory/status', '/inventory/movements', '/inventory/counts', '/inventory/warehouses', '/accounting/journal', '/accounting/accounts', '/accounting/trial-balance', '/accounting/account-ledger', '/settings/company', '/settings/currencies', '/settings/tax-rates', '/settings/periods', '/settings/custom-codes', '/settings/members']) {
    await m.goto(`${BASE}${path}`);
    await m.getByRole('heading', { level: 1 }).first().waitFor();
    await settle(m, 400);
    const over = await m.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.scrollWidth - main.clientWidth : 0;
    });
    if (over > 1) overflowing.push(`${path} (+${over}px)`);
  }
  console.log(overflowing.length ? `  ✗ Yatay taşma: ${overflowing.join(', ')}` : '  ✓ mobilde yatay taşma yok');

  await browser.close();
  if (overflowing.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
