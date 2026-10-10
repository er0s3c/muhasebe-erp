import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Arayüz sağlamlığı (denetim düzeltmeleri 4): Türkçe sayı girişi, yetki ekranı, dar ekranda yatay kaydırma olmaması,
 * rota hata sınırı (parça yükleme hatası) ve girişten sonra derin bağlantıya dönüş.
 */

const PASSWORD = 'Sifre-12345-xyz';

/** API ile sahip + inşaat şirketi açar (arayüz akışı diğer testlerde sınanıyor). */
async function ownerWithCompany(request: APIRequestContext, tag: string) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `e2e-${tag}-${stamp}@example.com`;
  const reg = await request.post('/api/auth/register', { data: { email, password: PASSWORD, fullName: 'Selin Yücel', organizationName: 'Yücel Holding' } });
  expect(reg.status()).toBe(201);
  const { accessToken } = (await reg.json()) as { accessToken: string };
  const auth = { authorization: `Bearer ${accessToken}` };
  const res = await request.post('/api/companies', { headers: auth, data: { name: 'Yücel İnşaat Ltd.', sector: 'CONSTRUCTION', jurisdiction: 'KKTC' } });
  expect(res.status()).toBe(201);
  const { company } = (await res.json()) as { company: { id: string } };
  return { email, stamp, headers: { ...auth, 'x-company-id': company.id } };
}

async function login(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
}

test('Türkçe sayı girişi: "250.000" liste fiyatı 250.000,00 olur; belirsiz "12.5" ondalıktır; geçersiz giriş silinmez, işaretlenir', async ({ page, request }) => {
  const { email, headers } = await ownerWithCompany(request, 'sayi');
  const project = await request.post('/api/projects', { headers, data: { name: 'Güneş Sitesi', kind: 'own' } });
  expect(project.ok()).toBeTruthy();

  await page.goto('/real-estate/units');
  await login(page, email);
  // Derin bağlantı: girişten sonra istenen sayfaya dönülür (UI-12)
  await expect(page).toHaveURL(/\/real-estate\/units$/);
  await page.getByRole('button', { name: 'Birim ekle' }).first().click();
  const dialog = page.getByRole('dialog');
  const box = dialog.getByRole('combobox', { name: /^Proje/ });
  await box.click();
  await box.fill('Güneş');
  await page.getByRole('listbox').getByRole('option').first().click();
  await dialog.getByLabel('Birim no').fill('101');

  const price = dialog.getByLabel('Liste fiyatı');
  await price.fill('250.000');
  await dialog.getByLabel('Birim no').click();
  await expect(price).toHaveValue('250.000,00');

  const gross = dialog.getByLabel('Brüt m²');
  await gross.fill('12.5');
  await price.click();
  await expect(gross).toHaveValue('12,5');
  await gross.fill('1.234,5');
  await price.click();
  await expect(gross).toHaveValue('1.234,5');

  // Geçersiz yazım: değer kalır, alan işaretlenir ve "Geçersiz sayı" görünür (sessizce boşaltılmaz)
  const net = dialog.getByLabel('Net m²');
  await net.fill('1,2,3');
  await price.click();
  await expect(net).toHaveValue('1,2,3');
  await expect(net).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByText('Geçersiz sayı. Örnek: 1.234,56')).toBeVisible();
  await net.fill('');

  // Enter, alt bilgideki Kaydet'e basar (UI-15)
  await dialog.getByLabel('Birim no').press('Enter');
  await expect(page.getByText('Kaydedildi')).toBeVisible();
  const row = page.getByRole('row', { name: /101/ });
  await expect(row).toContainText('250.000');
  await expect(row).toContainText('1.234,5');

  // Kaydedilen değer düzenlemede yine Türkçe biçimde gelir
  await row.click();
  await expect(dialog.getByLabel('Liste fiyatı')).toHaveValue('250.000,00');
});

test('izleyici, yetkisi olmayan sayfayı adresle açınca "yetkiniz yok" ekranı görür; menüsü ve kabuğu çalışır', async ({ page, request }) => {
  const { headers, stamp } = await ownerWithCompany(request, 'yetki');
  const viewerEmail = `e2e-izleyici-${stamp}@example.com`;
  const add = await request.post('/api/company/members', { headers, data: { email: viewerEmail, fullName: 'Veli İzleyici', role: 'viewer', password: 'Gecici-Sifre-4242!' } });
  expect(add.status()).toBe(201);

  await page.goto('/login');
  await login(page, viewerEmail, 'Gecici-Sifre-4242!');
  await page.getByLabel('Mevcut şifre').fill('Gecici-Sifre-4242!');
  await page.getByLabel('Yeni şifre').fill('Yeni-Kalem-9090!');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Merhaba, Veli/ })).toBeVisible();

  // Personel (hr.read) ve üyeler (members.manage) izleyicide yok: sonsuz yükleniyor / "personel yok" yerine yetki ekranı
  for (const url of ['/hr/employees', '/hr/attendance', '/settings/members', '/invoices/new?type=purchase']) {
    await page.goto(url);
    await expect(page.getByTestId('forbidden-page'), url).toBeVisible();
    await expect(page.getByText('Bu sayfayı görme yetkiniz yok')).toBeVisible();
    await expect(page.getByText('Personel yok')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Ana menü' })).toBeVisible();
  }
  // İzni olan sayfa normal açılır
  await page.getByRole('link', { name: 'Ana sayfaya dön' }).click();
  await page.goto('/parties');
  await expect(page.getByRole('heading', { name: 'Cari hesaplar', level: 1 })).toBeVisible();
  await expect(page.getByTestId('forbidden-page')).toHaveCount(0);
});

test('dar ekran (375 px): tablo kendi kabında kayar, sayfa yatay kaymaz; menü çekmecesi Escape ile kapanır', async ({ page, request }) => {
  const { email, headers } = await ownerWithCompany(request, 'mobil');
  for (const name of ['Güneş Sitesi Konut Projesi Uzun Adlı', 'Deniz Evleri']) {
    const r = await request.post('/api/projects', { headers, data: { name, kind: 'own' } });
    expect(r.ok()).toBeTruthy();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/login');
  await login(page, email);
  await expect(page.getByRole('heading', { name: /Merhaba, Selin/ })).toBeVisible();

  const overflow = () =>
    page.evaluate(() => {
      const main = document.querySelector('main')!;
      return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth };
    });
  for (const url of ['/projects', '/treasury/cheques', '/party-prices', '/settings/modules']) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await overflow(), url).toEqual({ doc: 0, main: 0 });
  }
  // Proje tablosu var ve kendi kabında kayıyor
  await page.goto('/projects');
  await expect(page.getByRole('row', { name: /Deniz Evleri/ })).toBeVisible();
  expect(await overflow()).toEqual({ doc: 0, main: 0 });

  // Mobil menü: aç → Escape kapatır → odak menü düğmesine döner
  const menuButton = page.getByRole('button', { name: 'Menüyü aç' });
  await menuButton.click();
  const drawer = page.getByRole('dialog', { name: 'Ana menü' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Ana menü' })).toHaveCount(0);
  await expect(menuButton).toBeFocused();
});

test('sayfa parçası yüklenemezse (yeni sürüm/kopuk bağlantı) Türkçe hata sayfası ve "Sayfayı yenile" görünür; kabuk ayakta kalır', async ({ page, request }) => {
  const { email } = await ownerWithCompany(request, 'parca');
  await page.goto('/login');
  await login(page, email);
  await expect(page.getByRole('heading', { name: /Merhaba, Selin/ })).toBeVisible();

  // Yevmiye sayfasının parçası (geliştirmede kaynak modülü, üretimde hash'li chunk) inmesin
  await page.route(/JournalPage[^/]*\.(tsx|js)(\?.*)?$/, (route) => route.abort());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Yevmiye kayıtları' }).click();

  // İlk hatada bir kez kendiliğinden yenilenir; parça yine inmeyince açıklama ve yenileme düğmesi görünür
  await expect(page.getByTestId('route-error')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Yeni sürüm yüklendi' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sayfayı yenile' })).toBeVisible();
  await expect(page.getByText('Unexpected Application Error')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Ana menü' })).toBeVisible();
  await expect(page).toHaveURL(/\/accounting\/journal$/);

  // Bağlantı düzelince "Sayfayı yenile" sayfayı getirir
  await page.unroute(/JournalPage[^/]*\.(tsx|js)(\?.*)?$/);
  await page.getByRole('button', { name: 'Sayfayı yenile' }).click();
  await expect(page.getByRole('heading', { name: 'Yevmiye kayıtları', level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});
