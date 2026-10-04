import { expect, test, type Page } from '@playwright/test';

// Üretim paketi modunda (E2E_TARGET=bundle) gerçek lisans sunucusuyla etkinleştirilmiş kurulumda çalışır.
test.skip(process.env.E2E_TARGET !== 'bundle', 'Üretim paketi modunda çalışır');

const CUSTOMER = process.env.E2E_LICENSE_CUSTOMER ?? 'CI Müşterisi';

async function signUpWithCompany(page: Page, tag: string, sector?: string) {
  const email = `e2e-${tag}-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Selin Yücel');
  await page.getByLabel('Firma / kuruluş adı').fill('Yücel Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill('Sifre-12345-xyz');
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel Ltd.');
  if (sector) await page.getByLabel('Faaliyet alanı').selectOption(sector);
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
}

/** Kurulum sahibi olarak giriş (lisans ayrıntıları yalnızca kurulum sahibi kuruluşa açıktır; hesap e2e/global-setup.ts'de açılır). */
async function loginAsInstallationOwner(page: Page) {
  const email = process.env.E2E_OWNER_EMAIL;
  const password = process.env.E2E_OWNER_PASSWORD;
  if (!email || !password) throw new Error('E2E_OWNER_* yok: veritabanı temiz değil (global-setup kurulum sahibini yalnızca ilk etkinleştirmede açar)');
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Kurulum' })).toBeVisible();
}

/** `GET /api/license` yanıtı (alanlar apps/api/src/licensing/routes.ts `view` ile aynıdır). */
function licenseInfo(over: Record<string, unknown> = {}) {
  return {
    enforced: true,
    state: 'active',
    reason: null,
    message: null,
    expiresSoon: false,
    daysUntilExpiry: 300,
    activeUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    graceUntil: new Date(Date.now() + 19 * 86_400_000).toISOString(),
    license: {
      customer: 'Mock Müşteri',
      kind: 'commercial',
      sectors: ['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE'],
      deviceLimit: 3,
      companyLimit: 5,
      deviceIdleDays: 30,
      graceDays: 14,
      validUntil: new Date(Date.now() + 300 * 86_400_000).toISOString(),
      leaseUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      offline: false,
    },
    usage: { companies: 1, devices: 1 },
    isOwner: true,
    installationId: '00000000-0000-7000-8000-000000000000',
    fingerprintStrength: 'strong',
    serverConfigured: true,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastError: null,
    pendingOfflineRequest: false,
    ...over,
  };
}

test('ayarlar: lisans durumu/kapsam/kullanım, yenileme; cihaz listesi ve yeniden adlandırma (gerçek lisans sunucusu)', async ({ page }) => {
  await loginAsInstallationOwner(page);
  const nav = page.getByRole('navigation', { name: 'Ana menü' });

  await nav.getByRole('link', { name: 'Lisans' }).click();
  await expect(page.getByRole('heading', { name: 'Lisans', level: 1 })).toBeVisible();
  await expect(page.getByTestId('license-state')).toContainText('Etkin');
  await expect(page.getByTestId('license-customer')).toContainText(CUSTOMER);
  for (const s of ['İnşaat ve taahhüt', 'Market ve perakende', 'Ticaret']) await expect(page.getByTestId('license-sectors')).toContainText(s);
  await expect(page.getByTestId('license-companies')).toContainText(/\d+ \/ 500/);
  await expect(page.getByTestId('license-installation')).toContainText(/[0-9a-f]{8}-/);
  // Etkin kurulumda uyarı bandı yok
  await expect(page.getByTestId('license-banner')).toHaveCount(0);

  await page.getByRole('button', { name: 'Şimdi yenile' }).click();
  await expect(page.getByText('Lisans yenilendi.')).toBeVisible();

  await nav.getByRole('link', { name: 'Cihazlar' }).click();
  await expect(page.getByRole('heading', { name: 'Cihazlar', level: 1 })).toBeVisible();
  await expect(page.getByTestId('device-seats')).toContainText(/\d+ \/ 500/);
  const current = page.getByRole('row').filter({ hasText: 'Bu cihaz' });
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('Etkin');
  await current.getByRole('button', { name: 'Yeniden adlandır' }).click();
  await page.getByRole('textbox', { name: 'Ad', exact: true }).fill('Muhasebe bilgisayarı');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByText('Cihaz adı güncellendi.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Bu cihaz' })).toContainText('Muhasebe bilgisayarı');
});

test('etkinleştirme sayfası: lisanssız kurulumda her yerin yerine çıkar; kod biçimlenir, hata gösterilir, başarıda giriş açılır', async ({ page }) => {
  let state: 'unlicensed' | 'active' = 'unlicensed';
  await page.route('**/api/public-config', (route) =>
    route.fulfill({ json: { registrationEnabled: true, mailEnabled: false, version: 'e2e', license: { enforced: true, state, reason: null } } }),
  );
  await page.route('**/api/license/activate', (route) => {
    const { code } = route.request().postDataJSON() as { code: string };
    if (code !== 'ABCDE-FGHJK-MNPQR-STVWX-YZ234') {
      return route.fulfill({ status: 422, json: { error: { code: 'INVALID_CODE', message: 'Etkinleştirme kodu geçersiz' } } });
    }
    state = 'active';
    return route.fulfill({ json: licenseInfo() });
  });
  await page.route('**/api/license/offline-request', (route) => route.fulfill({ json: { requestCode: 'erpreq1.örnek.istek.kodu' } }));

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Lisansınızı etkinleştirin', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hesabınıza giriş yapın' })).toHaveCount(0);
  // başka bir yol da etkinleştirme sayfasına düşer (yönlendirici kurulmaz)
  await page.goto('/invoices/sales');
  await expect(page.getByRole('heading', { name: 'Lisansınızı etkinleştirin', level: 1 })).toBeVisible();

  const code = page.getByLabel('Etkinleştirme kodu');
  await code.fill('abcde fghjk-mnpqr');
  await expect(code).toHaveValue('ABCDE-FGHJK-MNPQR');
  await page.getByRole('button', { name: 'Etkinleştir' }).click();
  await expect(page.getByText('Kod 25 harf ya da rakamdan oluşmalı.')).toBeVisible();

  await code.fill('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
  await page.getByRole('button', { name: 'Etkinleştir' }).click();
  await expect(page.getByText('Etkinleştirme kodu geçersiz')).toBeVisible();

  // çevrimdışı yol ve gönderilen bilgiler açıklaması
  await page.getByText('İnternet erişimi yok mu?').click();
  await page.getByRole('button', { name: 'İstek kodu oluştur' }).click();
  await expect(page.getByLabel('İstek kodu')).toHaveValue('erpreq1.örnek.istek.kodu');
  await page.getByText('Lisans sunucusuna hangi bilgiler gönderilir?').click();
  await expect(page.getByText('GÖNDERİLMEZ')).toBeVisible();

  await code.fill('ABCDE-FGHJK-MNPQR-STVWX-YZ234');
  await page.getByRole('button', { name: 'Etkinleştir' }).click();
  await expect(page.getByRole('heading', { name: 'Hesabınıza giriş yapın', level: 1 })).toBeVisible();
});

test('uyarı bantları: salt-okunur, tolerans ve yakında bitiyor; yalnızca sahip yönetim bağlantısını görür', async ({ page }) => {
  await signUpWithCompany(page, 'bant');
  const banner = page.getByTestId('license-banner');

  await page.route('**/api/license', (route) =>
    route.fulfill({
      json: licenseInfo({
        state: 'restricted',
        reason: 'expired',
        message: 'Lisans süreniz doldu; yalnızca görüntüleme ve dışa aktarma yapılabilir. Yenilemek için satıcınızla iletişime geçin.',
      }),
    }),
  );
  await page.reload();
  await expect(banner).toContainText('Salt-okunur mod');
  await expect(banner).toContainText('Lisans süreniz doldu');
  await expect(banner.getByRole('link', { name: 'Lisansı yönet' })).toBeVisible();

  await page.unroute('**/api/license');
  await page.route('**/api/license', (route) => route.fulfill({ json: licenseInfo({ state: 'grace', isOwner: false }) }));
  await page.reload();
  await expect(banner).toContainText('Lisans doğrulanamıyor');
  await expect(banner.getByRole('link', { name: 'Lisansı yönet' })).toHaveCount(0); // sahip değil

  await page.unroute('**/api/license');
  await page.route('**/api/license', (route) => route.fulfill({ json: licenseInfo({ expiresSoon: true, daysUntilExpiry: 9 }) }));
  await page.reload();
  await expect(banner).toContainText('Lisansınız yakında bitiyor');
  await expect(banner).toContainText('9 gün sonra');
});

test('şirket açma: sektör lisansla sınırlıdır; şirket sınırına ulaşılınca oluşturma kapanır', async ({ page }) => {
  await signUpWithCompany(page, 'sektor');

  await page.route('**/api/license', (route) =>
    route.fulfill({
      json: licenseInfo({
        license: { ...licenseInfo().license, sectors: ['RETAIL_MARKET'] },
        usage: { companies: 1, devices: 1 },
      }),
    }),
  );
  await page.goto('/company/new');
  const sector = page.getByLabel('Faaliyet alanı');
  await expect(sector.locator('option')).toHaveCount(1);
  await expect(sector).toHaveValue('RETAIL_MARKET');
  await expect(page.getByText('Lisansınız yalnızca “Market ve perakende” sektörünü kapsıyor.')).toBeVisible();

  await page.unroute('**/api/license');
  await page.route('**/api/license', (route) =>
    route.fulfill({
      json: licenseInfo({ license: { ...licenseInfo().license, sectors: ['COMMERCE', 'RETAIL_MARKET'], companyLimit: 1 }, usage: { companies: 1, devices: 1 } }),
    }),
  );
  await page.goto('/company/new');
  await expect(sector.locator('option')).toHaveCount(2);
  await expect(page.getByText('en fazla 1 şirkete izin veriyor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Şirketi oluştur' })).toBeDisabled();
});
