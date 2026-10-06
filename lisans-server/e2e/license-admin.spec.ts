import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// Satıcı yönetim paneli (lisans-server/panel) — gerçek lisans sunucusunu ve paneli sunan süreçle (lisans-server/tools/ci-license-host.sh).
const PANEL = process.env.E2E_PANEL_URL;
test.skip(!PANEL, 'Yönetim paneli ortamı yok (lisans-server/tools/ci-license-host.sh çalıştırın)');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 6238 (SHA-1, 30 sn, 6 hane): panelin zorunlu TOTP'sini üretir. */
function totp(secretBase32: string, now = Date.now()): string {
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

async function login(page: Page) {
  await page.goto(`${PANEL}/`);
  await expect(page.getByRole('heading', { name: 'Lisans yönetimi', level: 1 })).toBeVisible();
  await page.getByLabel('E-posta').fill(process.env.E2E_PANEL_EMAIL!);
  await page.getByLabel('Parola').fill(process.env.E2E_PANEL_PASSWORD!);
  await page.getByLabel('Doğrulama kodu').fill(totp(process.env.E2E_PANEL_TOTP_SECRET!));
  await page.getByRole('button', { name: 'Giriş yap' }).click();
}

test('yönetim paneli: TOTP'+"'"+'lu giriş, müşteri ve lisans verme (kod bir kez), durum/süre/kod işlemleri, çevrimdışı imza hatası, denetim kaydı', async ({ page }) => {
  // Kimliksiz erişim girişe düşer; yanlış doğrulama kodu reddedilir
  await page.goto(`${PANEL}/licenses`);
  await expect(page.getByLabel('Doğrulama kodu')).toBeVisible();
  await page.getByLabel('E-posta').fill(process.env.E2E_PANEL_EMAIL!);
  await page.getByLabel('Parola').fill(process.env.E2E_PANEL_PASSWORD!);
  const wrong = totp(process.env.E2E_PANEL_TOTP_SECRET!, Date.now() + 10 * 30_000);
  await page.getByLabel('Doğrulama kodu').fill(wrong);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByText('E-posta, parola ya da doğrulama kodu hatalı')).toBeVisible();

  await login(page);
  await expect(page.getByRole('heading', { name: 'Özet', level: 1 })).toBeVisible();
  await expect(page.getByTestId('dashboard')).toContainText('Etkin lisans');

  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  const customer = `Panel Deneme ${Date.now()} A.Ş.`;

  // Müşteri ekle → "Lisans ver" formu müşteri ön seçimiyle açılır
  await nav.getByRole('link', { name: 'Müşteriler' }).click();
  await page.getByRole('button', { name: 'Yeni müşteri' }).click();
  await page.getByLabel('Ad / unvan').fill(customer);
  await page.getByLabel('E-posta').fill('musteri@example.com');
  await page.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('Müşteri eklendi.')).toBeVisible();
  const row = page.getByTestId(`customer-${customer}`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Lisans ver' }).click();

  await expect(page.getByRole('heading', { name: 'Yeni lisans' })).toBeVisible();
  await page.getByLabel('Market ve perakende').check();
  await page.getByLabel('Cihaz kotası').fill('2');
  await page.getByLabel('Şirket sınırı').fill('3');
  await page.getByLabel('Çevrimdışı etkinleştirmeye izin ver').check();
  await page.getByRole('button', { name: 'Lisansı ver' }).click();

  // Etkinleştirme kodu yalnızca bir kez gösterilir
  const codeBox = page.getByTestId('activation-code');
  await expect(codeBox).toHaveText(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
  const firstCode = (await codeBox.textContent())!;
  await page.getByRole('button', { name: 'Kodu kaydettim, kapat' }).click();
  await expect(page.getByTestId(`license-${customer}`)).toContainText('Etkin');
  await expect(page.getByTestId(`license-${customer}`)).toContainText('Market ve perakende');
  await expect(page.getByTestId(`license-${customer}`)).toContainText('0 / 2');

  // Ayrıntı: durum işlemleri
  await page.getByTestId(`license-${customer}`).getByRole('link', { name: customer }).click();
  await expect(page.getByRole('heading', { name: customer, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Askıya al' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Askıya al' }).click();
  await expect(page.getByText('Askıda', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Devam ettir' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Devam ettir' }).click();
  await expect(page.getByText('Etkin', { exact: true }).first()).toBeVisible();

  // Süre uzatma
  await page.getByRole('button', { name: 'Süreyi uzat' }).click();
  await page.getByLabel('Yeni bitiş tarihi').fill('2031-12-31');
  await page.getByRole('dialog').getByRole('button', { name: 'Uzat' }).click();
  await expect(page.getByText('Süre uzatıldı.')).toBeVisible();
  await expect(page.getByText('31.12.2031')).toBeVisible();

  // Yeni kod: eskisinden farklı, yine bir kez gösterilir
  await page.getByRole('button', { name: 'Yeni kod üret' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Kodu üret' }).click();
  const second = page.getByTestId('activation-code');
  await expect(second).toHaveText(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
  expect(await second.textContent()).not.toBe(firstCode);
  await page.getByRole('button', { name: 'Kodu kaydettim, kapat' }).click();

  // Düzenleme (kota)
  await page.getByRole('button', { name: 'Düzenle' }).click();
  await page.getByLabel('Cihaz kotası').fill('5');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Lisans güncellendi.')).toBeVisible();
  await expect(page.getByText(/5 \(boşta 30 gün/)).toBeVisible();

  // Çevrimdışı imza: geçersiz istek kodu anlamlı hata verir
  await page.getByLabel('İstek kodu').fill('erpreq1.bu-gecerli-bir-istek-kodu-degil.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.yyyyyyyy');
  await page.getByRole('button', { name: 'İmzala' }).click();
  await expect(page.getByText('İstek kodu geçersiz')).toBeVisible();

  // İptal
  await page.getByRole('button', { name: 'İptal et' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'İptal et' }).click();
  await expect(page.getByText('İptal', { exact: true }).first()).toBeVisible();

  // CLI ile verilip uygulamayı etkinleştiren CI lisansı: etkinleştirme ve kurulum bilgisi görünür
  await nav.getByRole('link', { name: 'Lisanslar' }).click();
  await page.getByTestId('license-CI Müşterisi').getByRole('link', { name: 'CI Müşterisi' }).click();
  await expect(page.getByTestId(/^activation-/)).toHaveCount(1);
  await expect(page.getByTestId(/^activation-/)).toContainText('Etkin');

  // Denetim kaydı
  await nav.getByRole('link', { name: 'Denetim kaydı' }).click();
  await expect(page.getByRole('cell', { name: 'Lisans verildi' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Müşteri oluşturuldu' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Yönetici girişi' }).first()).toBeVisible();

  // Çıkış
  await page.getByRole('button', { name: 'Çıkış' }).click();
  await expect(page.getByLabel('Doğrulama kodu')).toBeVisible();
  await page.goto(`${PANEL}/licenses`);
  await expect(page.getByLabel('Doğrulama kodu')).toBeVisible();
});
