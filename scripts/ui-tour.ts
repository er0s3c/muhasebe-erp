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

  // Fatura
  await go('/invoices/sales', '40-satis-faturalari', 'Satış faturaları');
  await page.getByRole('row', { name: /B Blok 1\. kat seramik/ }).click();
  await page.getByRole('heading', { name: /^SF-/, level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '41-fatura-detay-gbp');
  await go('/invoices/purchases', '42-alis-faturalari', 'Alış ve gider faturaları');
  await page.getByRole('row', { name: /LO-388/ }).click();
  await page.getByRole('heading', { name: /^AF-/, level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '43-alis-faturasi-detay-eur');
  await go('/invoices/sales', '44-satis-listesi-tumu', 'Satış faturaları');
  await page.getByRole('row', { name: /Ek boya siparişi/ }).click();
  await page.getByRole('heading', { name: /Satış faturası \(taslak\)/, level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '45-taslak-fatura-duzenle');
  await go('/invoices/new?type=sales', '46-yeni-satis-faturasi', 'Satış faturası');
  await go('/invoices/vat-summary', '47-kdv-ozeti', 'KDV özeti');
  await go('/settings/account-mapping', '48-hesap-esleme', 'Hesap eşlemesi');
  await go('/accounting/journal', '49-yevmiye-kaynakli', 'Yevmiye kayıtları');

  // İrsaliye: bekleyenler, kısmen faturalanan sevk, fiyat farklı mal kabul, form ve faturada seçici
  await go('/delivery-notes/sales', '50-satis-irsaliyeleri', 'Satış irsaliyeleri');
  await page.getByRole('row', { name: /A Blok ek boya sevki/ }).click();
  await page.getByRole('heading', { name: /^SIR-/, level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '51-irsaliye-detay-kismi');
  await go('/delivery-notes/purchases', '52-alis-irsaliyeleri', 'Alış irsaliyeleri');
  await page.getByRole('row', { name: /Demir mal kabul/ }).click();
  await page.getByRole('heading', { name: /^AIR-/, level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '53-alis-irsaliyesi-faturali');
  await go('/delivery-notes/new?type=sales', '54-yeni-satis-irsaliyesi', 'Satış irsaliyesi');
  await go('/delivery-notes/new?type=purchase', '55-yeni-alis-irsaliyesi', 'Alış irsaliyesi');
  await go('/invoices/new?type=sales', '56a-yeni-satis-faturasi', 'Satış faturası');
  const cust = page.getByRole('combobox', { name: 'Müşteri' });
  await cust.click();
  await cust.fill('Ali');
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByRole('button', { name: 'İrsaliyeden ekle' }).click();
  await page.getByRole('dialog').waitFor();
  await settle(page, 600);
  await shot(page, '56-faturada-irsaliye-secici');
  await page.keyboard.press('Escape');
  await go('/invoices/sales', '57a-satis-faturalari', 'Satış faturaları');
  await page.getByRole('row', { name: /Sevk irsaliyesinin ilk kısmı/ }).click();
  await page.getByRole('heading', { name: /^SF-/, level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '57-fatura-irsaliyeye-bagli');
  await go('/inventory/status', '58a-stok-durumu', 'Stok durumu');
  await page.getByText('Muhasebe mutabakatı').scrollIntoViewIfNeeded();
  await settle(page, 400);
  await shot(page, '58-stok-mutabakat-bekleyen');

  const csvFile = (text: string) => ({ name: 'dosya.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });
  const wizard = page.getByRole('dialog');

  // Kasa ve banka: hesaplar, ekstre, hareketler, tahsilat/ödeme/döviz formları
  await go('/treasury/accounts', '60-kasa-banka-hesaplari', 'Kasa ve banka hesapları');
  await page.getByRole('row', { name: /KTB GBP Hesabı/ }).click();
  await page.getByRole('heading', { name: 'KTB GBP Hesabı', level: 1 }).waitFor();
  await settle(page, 700);
  await shot(page, '61-hesap-ekstresi-gbp');
  // Banka ekstresi ve mutabakat (TL banka hesabı)
  await go('/treasury/accounts', '89a-kasa-banka-hesaplari', 'Kasa ve banka hesapları');
  await page.getByRole('row', { name: /KTB TL Vadesiz/ }).click();
  await page.getByRole('heading', { name: 'KTB TL Vadesiz', level: 1 }).waitFor();
  await page.getByRole('tab', { name: 'Banka ekstresi' }).click();
  await page.getByRole('heading', { name: 'Banka ekstresi ve mutabakat' }).waitFor();
  await settle(page, 700);
  await shot(page, '89-banka-mutabakat-acik');
  await page.getByRole('tab', { name: /^Eşleşen/ }).click();
  await settle(page, 300);
  await shot(page, '90-banka-mutabakat-eslesen');
  await page.getByRole('tab', { name: /^Açık/ }).click();
  await page.getByRole('row', { name: /Hesap işletim ücreti/ }).getByRole('button', { name: 'Hareket oluştur' }).click();
  await wizard.getByText('Ekstre satırından hareket oluşturuluyor').waitFor();
  await settle(page, 500);
  await shot(page, '91-ekstre-satirindan-hareket');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ekstre içe aktar' }).first().click();
  await wizard.getByText('Dosyanızı seçin').waitFor();
  await wizard.locator('input[type=file]').setInputFiles(csvFile('İşlem Tarihi;Açıklama;Dekont No;Borç;Alacak;Bakiye\n01.10.2026;Havale — kira;D-1;1.500,00;;10.000,00\n02.10.2026;EFT gelen;D-2;;750,00;10.750,00\n'));
  await wizard.getByText('Sütunları eşleyin').waitFor();
  await page.waitForTimeout(300);
  await shot(page, '92-ekstre-esleme');
  await wizard.getByRole('button', { name: 'Ön izleme' }).click();
  await wizard.getByText('Henüz hiçbir kayıt yazılmadı').waitFor();
  await settle(page, 300);
  await shot(page, '93-ekstre-onizleme');
  await page.keyboard.press('Escape');
  await go('/treasury/transactions', '62-kasa-banka-hareketleri', 'Kasa ve banka hareketleri');
  await page.getByRole('row', { name: /Seramik faturası \(GBP\) tahsilatı/ }).click();
  await page.getByRole('dialog').getByText('TAH-').first().waitFor();
  await settle(page, 600);
  await shot(page, '63-hareket-detay-kur-farki');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.getByRole('row', { name: /Peşinat/ }).click();
  await page.getByRole('dialog').getByText('iptal edildi').waitFor();
  await settle(page, 600);
  await shot(page, '64-hareket-iptal-edilmis');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Tahsilat: carinin açık kalemleri seçilir, tutar en eskiden dağıtılır
  await go('/parties', '65a-cariler', 'Cari hesaplar');
  await page.getByRole('cell', { name: /Ali Yılmaz/ }).click();
  await page.getByRole('heading', { name: 'Ali Yılmaz', level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Tahsilat al' }).click();
  const receipt = page.getByRole('dialog');
  await receipt.getByText('Açık kalemler').waitFor();
  await receipt.getByLabel('Tahsil edilen tutar (TRY)').fill('700.000,00');
  await receipt.getByRole('button', { name: 'Tutarı en eskiden dağıt' }).click();
  await settle(page, 600);
  await shot(page, '65-tahsilat-formu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Ödeme: EUR faturası TL hesaptan ödenir; kalem kurundan farklı kurda kambiyo farkı önizlenir
  await go('/parties', '66a-cariler', 'Cari hesaplar');
  await page.getByRole('cell', { name: /Lefkoşa Otomotiv/ }).click();
  await page.getByRole('heading', { name: /Lefkoşa Otomotiv/, level: 1 }).waitFor();
  await page.getByRole('button', { name: 'Ödeme yap' }).click();
  const payment = page.getByRole('dialog');
  await payment.getByText('Açık kalemler').waitFor();
  await payment.getByLabel('Ödeme hesabı (çıkış)').selectOption({ label: 'KTB TL Vadesiz · TRY' });
  await payment.getByRole('button', { name: 'Tümünü seç' }).click();
  await settle(page, 700);
  await shot(page, '66-odeme-formu-kur-farki');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Döviz alım-satım
  await go('/treasury/transactions', '67a-hareketler', 'Kasa ve banka hareketleri');
  await page.getByRole('button', { name: 'Yeni işlem' }).click();
  const exchange = page.getByRole('dialog');
  await exchange.getByRole('tab', { name: 'Döviz alım-satım' }).click();
  await exchange.getByLabel('Kaynak hesap (çıkış)').selectOption({ label: 'KTB GBP Hesabı · GBP' });
  await exchange.getByLabel('Hedef hesap (giriş)').selectOption({ label: 'KTB TL Vadesiz · TRY' });
  await exchange.getByLabel('Çıkan tutar (GBP)').fill('10.000,00');
  await exchange.getByLabel('Giren tutar (TRY)').fill('648.000,00');
  await settle(page, 700);
  await shot(page, '67-doviz-satis-formu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Raporlar: defterler, satış/alış, kârlılık, kambiyo, veri dışa aktarma ve baskı görünümü
  await go('/reports/journal-book', '70-yevmiye-defteri', 'Yevmiye defteri');
  await go('/reports/general-ledger', '71-kebir', 'Kebir (büyük defter)');
  await go('/reports/sales', '72-satis-raporu', 'Satış raporu');
  await page.getByRole('tab', { name: 'Stok kartı' }).click();
  await settle(page, 600);
  await shot(page, '73-satis-raporu-stok-karti');
  await go('/reports/purchases', '74-alis-raporu', 'Alış raporu');
  await go('/reports/item-profit', '75-stok-karliligi', 'Stok kârlılığı');
  await go('/reports/fx-differences', '76-kambiyo-raporu', 'Kambiyo (kur farkı) raporu');
  await go('/reports/data-export', '77-veri-disa-aktarma', 'Veri dışa aktarma');
  await go('/accounting/trial-balance', '78a-mizan', 'Mizan');
  await page.getByRole('button', { name: 'Dışa aktar' }).click();
  await page.getByRole('menuitem', { name: /\.xlsx/ }).waitFor();
  await page.waitForTimeout(300);
  await shot(page, '78-disa-aktar-menusu');
  await page.keyboard.press('Escape');
  // Baskı önizlemesi: yatay A4 yazdırılabilir genişlikte (10 mm kenar boşluğu, 1047 px) tam sayfa + gerçek PDF çıktısının sayfa sayısı
  const screenViewport = page.viewportSize();
  await page.setViewportSize({ width: 1047, height: 740 });
  await page.emulateMedia({ media: 'print' });
  await settle(page, 400);
  await page.screenshot({ path: `${OUT}/79-mizan-baski-onizleme.png`, fullPage: true });
  console.log('  ✓ 79-mizan-baski-onizleme');
  const pdf = await page.pdf({ format: 'A4', margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' }, preferCSSPageSize: true, path: `${OUT}/79-mizan.pdf` });
  const pdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`  ✓ PDF: ${pdf.length} bayt, ${pdfPages} sayfa`);
  await page.emulateMedia({ media: 'screen' });
  if (screenViewport) await page.setViewportSize(screenViewport);

  // İçe aktarma sihirbazı ve açılış bakiyeleri
  await go('/parties', '80-cariler-ice-aktar-dugmesi', 'Cari hesaplar');
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await wizard.getByText('Dosyanızı seçin').waitFor();
  await page.waitForTimeout(400);
  await shot(page, '81-ice-aktar-dosya');
  const stamp = Date.now();
  await wizard.locator('input[type=file]').setInputFiles(
    csvFile(`Cari Kodu;Ünvan / Ad Soyad;Tür;Vergi No;E-posta;Vade\n;Tur Deneme ${stamp} Ltd.;Müşteri;;info@ornek.com;30\nCR-000001;Yinelenen Kod;Müşteri;;;\n;Hatalı E-posta;Tedarikçi;;ali@;\n`),
  );
  await wizard.getByText('Sütunları eşleyin').waitFor();
  await page.waitForTimeout(300);
  await shot(page, '82-ice-aktar-esleme');
  await wizard.getByRole('button', { name: 'Ön izleme' }).click();
  await wizard.getByText('Henüz hiçbir kayıt yazılmadı').waitFor();
  await settle(page, 300);
  await shot(page, '83-ice-aktar-onizleme-hata');
  await wizard.getByRole('button', { name: 'Geri' }).click();
  await wizard.getByRole('button', { name: 'Geri' }).click();
  await wizard.locator('input[type=file]').setInputFiles(csvFile(`Cari Kodu;Ünvan / Ad Soyad;Tür;Vergi No;E-posta;Vade\n;Tur Deneme ${stamp} Ltd.;Müşteri;;info@ornek.com;30\n`));
  await wizard.getByRole('button', { name: 'Ön izleme' }).click();
  await wizard.getByText('Henüz hiçbir kayıt yazılmadı').waitFor();
  await settle(page, 300);
  await shot(page, '84-ice-aktar-onizleme-hazir');
  await wizard.getByRole('button', { name: 'İçe aktar', exact: true }).click();
  await wizard.getByRole('heading', { name: 'İçe aktarma tamamlandı' }).waitFor();
  await shot(page, '85-ice-aktar-sonuc');
  await wizard.getByRole('button', { name: 'Tamam' }).click();

  await go('/accounting/openings', '86-acilis-bakiyeleri', 'Açılış bakiyeleri');
  await page.getByRole('tab', { name: 'Mizan' }).click();
  await settle(page, 300);
  await shot(page, '87-acilis-mizan-sekmesi');
  await page.getByRole('button', { name: 'İçe aktar' }).click();
  await wizard.getByText('Dosyanızı seçin').waitFor();
  await wizard.locator('input[type=file]').setInputFiles(csvFile('Hesap Kodu;Hesap Adı;Borç;Alacak\n100;Kasa;50.000,00;\n120;Alıcılar;10.000,00;\n254;Taşıtlar;100.000,00;\n500;Sermaye;;120.000,00\n'));
  await wizard.getByText('Sütunları eşleyin').waitFor();
  await wizard.getByRole('button', { name: 'Ön izleme' }).click();
  await wizard.getByText('Henüz hiçbir kayıt yazılmadı').waitFor();
  await settle(page, 300);
  await shot(page, '88-mizan-acilisi-onizleme');
  await page.keyboard.press('Escape');

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
  await go('/settings/modules', '17-moduller', 'Modüller');

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
  for (const path of ['/', '/parties', '/parties/aging', '/inventory/items', '/inventory/status', '/inventory/movements', '/inventory/counts', '/inventory/warehouses', '/invoices/sales', '/invoices/purchases', '/invoices/new?type=sales', '/delivery-notes/sales', '/delivery-notes/purchases', '/delivery-notes/new?type=sales', '/delivery-notes/new?type=purchase', '/treasury/accounts', '/treasury/transactions', '/reports/journal-book', '/reports/general-ledger', '/reports/sales', '/reports/purchases', '/reports/item-profit', '/reports/fx-differences', '/reports/data-export', '/accounting/openings', '/invoices/vat-summary', '/settings/account-mapping', '/accounting/journal', '/accounting/accounts', '/accounting/trial-balance', '/accounting/account-ledger', '/settings/company', '/settings/currencies', '/settings/tax-rates', '/settings/periods', '/settings/custom-codes', '/settings/members', '/settings/modules', '/settings/license', '/settings/devices']) {
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

  // Mobilde tahsilat formu (açık kalem ızgarası) da yatay taşmamalı
  await m.goto(`${BASE}/parties`);
  await m.getByRole('heading', { level: 1 }).first().waitFor();
  await m.getByText('Ali Yılmaz').first().click();
  await m.getByRole('heading', { name: 'Ali Yılmaz', level: 1 }).waitFor();
  await m.getByRole('button', { name: 'Tahsilat al' }).click();
  const sheet = m.getByRole('dialog');
  await sheet.getByText('Açık kalemler').waitFor();
  await sheet.getByRole('button', { name: 'Tümünü seç' }).click();
  await settle(m, 600);
  await m.screenshot({ path: `${OUT}/68-mobil-tahsilat-formu.png` });
  console.log('  ✓ 68-mobil-tahsilat-formu');
  const sheetOver = await sheet.evaluate((el) => {
    const body = el.querySelector('div.overflow-y-auto');
    return body ? body.scrollWidth - body.clientWidth : 0;
  });
  if (sheetOver > 1) {
    overflowing.push(`tahsilat formu (+${sheetOver}px)`);
    console.log(`  ✗ Tahsilat formu mobilde taşıyor (+${sheetOver}px)`);
  } else {
    console.log('  ✓ mobilde tahsilat formu taşmıyor');
  }

  await browser.close();
  if (overflowing.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
