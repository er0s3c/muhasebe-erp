import { type Page } from '@playwright/test';
import { expect, test, withOpenMenu } from './fixtures';

const PASSWORD = 'Sifre-12345-xyz';
/** Sunucuyla aynı "bugün" (Europe/Nicosia). */
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Nicosia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function signUpWithCompany(page: Page, tag: string): Promise<string> {
  const email = `e2e-${tag}-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Selin Yücel');
  await page.getByLabel('Firma / kuruluş adı').fill('Yücel Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await page.getByLabel('Şirket unvanı').fill('Yücel İnşaat Ltd.');
  await page.getByLabel('Şirketin ülkesi').selectOption('KKTC');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
  return email;
}

test('bildirim: veri oluşur → tarama → zil sayacı → liste → okundu/kapat → tercih kalıcı → izleyici kaynak-kapılı bildirimi görmez', async ({ page, browser }) => {
  const email = await signUpWithCompany(page, 'bildirim');

  // Veri API ile hazırlanır: bugün vadeli ajanda kalemi + kritik seviyenin altında stok kartı
  const login = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  const token = (await login.json()).accessToken as string;
  const companyId = ((await (await page.request.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json()).companies as { id: string }[])[0]!.id;
  const headers = { authorization: `Bearer ${token}`, 'x-company-id': companyId };
  const post = async (url: string, data: unknown, status = 201) => {
    const res = await page.request.post(url, { headers, data });
    expect(res.status(), `${url}: ${await res.text()}`).toBe(status);
    return res.json();
  };
  await post('/api/agenda', { title: 'Banka ile toplantı', dueDate: TODAY });
  await post('/api/items', { name: 'Çimento', minLevel: '10' });

  // İzleyici üye (ajanda izni yok; stok okuma izni var)
  const viewerEmail = `e2e-izleyici-${Date.now()}@example.com`;
  await post('/api/company/members', { email: viewerEmail, fullName: 'Veli İzleyici', role: 'viewer', password: PASSWORD, mustChangePassword: false });

  // Yalnızca sahip/yönetici şirket taramasını çalıştırır (zamanlayıcı da aynı işi yapar)
  const scan = await post('/api/notifications/scan', {}, 200);
  expect(scan.result).toMatchObject({ skipped: false, failedKinds: [] });
  expect(scan.result.created).toBeGreaterThanOrEqual(3); // sahip: ajanda + stok; izleyici: stok

  // Zil: okunmamış sayısı rozette ve erişilebilir adda
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Merhaba, Selin' })).toBeVisible();
  const bell = page.getByRole('button', { name: 'Bildirimler, 2 okunmamış' });
  await expect(bell).toBeVisible();
  await expect(page.getByTestId('notification-badge')).toHaveText('2');
  // Genel bakış kartı: en yeni okunmamışlar
  await expect(page.getByTestId('dashboard-notifications')).toContainText('Kritik seviyenin altındaki stok kartı: 1');

  // Açılır liste (klavyeyle de açılır, Esc kapatır ve odak zile döner)
  await bell.focus();
  await page.keyboard.press('Enter');
  const list = page.getByTestId('notification-bell-list');
  await expect(list.getByRole('button', { name: /Ajandada bugün vadesi gelen ya da geciken kalem: 1/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /Kritik seviyenin altındaki stok kartı: 1/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(bell).toBeFocused();

  // Tümünü gör → liste sayfası
  await bell.click();
  await page.getByRole('dialog', { name: 'Bildirimler' }).getByRole('link', { name: 'Tümünü gör' }).click();
  await expect(page.getByRole('heading', { name: 'Bildirimler', level: 1 })).toBeVisible();
  const rows = page.getByTestId('notification-row');
  await expect(rows).toHaveCount(2);
  // Metin genel: ad, tutar, belge numarası yok; bağlantı ilgili ekrana gider
  await expect(page.getByTestId('notification-list')).not.toContainText('Banka ile toplantı');
  await expect(page.getByTestId('notification-list')).not.toContainText('Çimento');

  // Okundu işaretle → sayaç düşer
  const agendaRow = rows.filter({ hasText: 'Ajandada' });
  await agendaRow.getByRole('button', { name: 'Okundu işaretle' }).click();
  await expect(page.getByTestId('notification-badge')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Bildirimler, 1 okunmamış' })).toBeVisible();
  // Okunmamış süzgeci yalnızca kalanı gösterir; "Etkin" ikisini birden
  await expect(rows).toHaveCount(1);
  await page.getByRole('tab', { name: 'Etkin' }).click();
  await expect(rows).toHaveCount(2);

  // Kapat → listeden kalkar (aynı durum yeniden bildirilmez)
  await rows.filter({ hasText: 'Kritik seviyenin altındaki' }).getByRole('button', { name: 'Kapat' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Bildirimler, okunmamış yok' })).toBeVisible();
  await post('/api/notifications/scan', {}, 200);
  await page.reload();
  await expect(page.getByText('Okunmamış bildirim yok').first()).toBeVisible(); // varsayılan süzgeç: okunmamış
  await page.getByRole('tab', { name: 'Etkin' }).click();
  await expect(rows).toHaveCount(1);

  // Tıklayınca ilgili ekrana gider (ajanda)
  await rows.getByRole('button', { name: 'Aç' }).click();
  await expect(page.getByRole('heading', { name: 'Ajanda', level: 1 })).toBeVisible();

  // Tercihler: uygulama içi kapatma kalıcıdır; e-posta özeti SMTP yokken kapalıdır
  await page.getByRole('button', { name: new RegExp(`^${'Selin'}`) }).click();
  await page.getByRole('menuitem', { name: 'Bildirim tercihleri' }).click();
  await expect(page.getByRole('heading', { name: 'Bildirim tercihleri', level: 1 })).toBeVisible();
  await expect(page.getByText('e-posta (SMTP) yapılandırılmamış')).toBeVisible();
  const agendaPrefs = page.locator('[data-kind="agenda_due"]');
  const inApp = agendaPrefs.getByRole('switch', { name: /Ajanda: bugün ve geciken: Uygulama içi/ });
  await expect(inApp).toHaveAttribute('aria-checked', 'true');
  await expect(agendaPrefs.getByRole('switch', { name: /E-posta özeti/ })).toBeDisabled();
  await inApp.click();
  await expect(page.getByText('Tercih kaydedildi')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-kind="agenda_due"]').getByRole('switch', { name: /Uygulama içi/ })).toHaveAttribute('aria-checked', 'false');
  // Gün eşiği: boş = varsayılan; değer yazıp odaktan çıkınca kaydedilir
  const chequeLead = page.locator('[data-kind="cheque_due"]').getByLabel('Kaç gün önceden');
  await chequeLead.fill('14');
  await chequeLead.blur();
  await expect(page.getByText('Tercih kaydedildi').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-kind="cheque_due"]').getByLabel('Kaç gün önceden')).toHaveValue('14');
  // İzleyici türlerinde İK/ajanda yok; sahipte lisans türü var
  await expect(page.locator('[data-kind="license_expiring"]')).toBeVisible();

  // Kapatılan türden yeni bildirim üretilmez (tarama sonrası ajanda satırı yok)
  await post('/api/notifications/scan', {}, 200);
  await page.goto('/notifications');
  await page.getByRole('tab', { name: 'Etkin' }).click();
  await expect(page.getByTestId('notification-row')).toHaveCount(0);

  // İzleyici: yalnızca stok bildirimi (izni var); ajanda bildirimi (rehber izni yok) yok
  const ctx = await withOpenMenu(await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Nicosia' }));
  const vp = await ctx.newPage();
  await vp.goto('/login');
  await vp.getByLabel('E-posta').fill(viewerEmail);
  await vp.getByLabel('Şifre').fill(PASSWORD);
  await vp.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(vp.getByRole('heading', { name: /Merhaba, Veli/ })).toBeVisible();
  await expect(vp.getByRole('button', { name: 'Bildirimler, 1 okunmamış' })).toBeVisible();
  await vp.goto('/notifications');
  const vrows = vp.getByTestId('notification-row');
  await expect(vrows).toHaveCount(1);
  await expect(vrows.first()).toHaveAttribute('data-kind', 'stock_below_min');
  await expect(vp.getByText('Ajandada')).toHaveCount(0);
  // İzleyici şirket taramasını çalıştıramaz (düğme yok, API 403)
  await expect(vp.getByRole('button', { name: 'Şimdi tara' })).toHaveCount(0);
  const viewerLogin = await vp.request.post('/api/auth/login', { data: { email: viewerEmail, password: PASSWORD } });
  const vtoken = (await viewerLogin.json()).accessToken as string;
  const denied = await vp.request.post('/api/notifications/scan', { headers: { authorization: `Bearer ${vtoken}`, 'x-company-id': companyId } });
  expect(denied.status()).toBe(403);
  // İzleyici sahibin bildirimini göremez: tercih sayfasında yalnızca kendi türleri
  await vp.goto('/settings/notifications');
  await expect(vp.locator('[data-kind="stock_below_min"]')).toBeVisible();
  await expect(vp.locator('[data-kind="foreign_doc_expiring"]')).toHaveCount(0);
  await expect(vp.locator('[data-kind="agenda_due"]')).toHaveCount(0);
  await ctx.close();
});
