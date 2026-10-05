import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

/**
 * Kullanıcı bazlı modül erişimi (uçtan uca): sahip, bir üyenin "Fatura ve irsaliye" modülünü Sadece görüntüle → Erişim yok → rol varsayılanı
 * yaparak izler; üye ayrı oturumda menüyü, düğmeleri, yetki ekranını ve API cevabını görür. Rol varsayılanında düzenleyemediği bir modülde
 * (Rehber) "Görüntüle ve düzenle" ile kayıt açabilir. Yönetici sahibin, başkasının ve kendi erişimini değiştiremez (arayüz gizler).
 */

const PASSWORD = 'Sifre-12345-xyz';

async function ownerWithCompany(request: APIRequestContext, tag: string) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `e2e-${tag}-${stamp}@example.com`;
  const reg = await request.post('/api/auth/register', { data: { email, password: PASSWORD, fullName: 'Selin Yücel', organizationName: 'Yücel Holding' } });
  expect(reg.status()).toBe(201);
  const { accessToken, user } = (await reg.json()) as { accessToken: string; user: { id: string } };
  const auth = { authorization: `Bearer ${accessToken}` };
  const res = await request.post('/api/companies', { headers: auth, data: { name: 'Yücel İnşaat Ltd.', sector: 'CONSTRUCTION' } });
  expect(res.status()).toBe(201);
  const { company } = (await res.json()) as { company: { id: string } };
  return { email, stamp, ownerId: user.id, companyId: company.id, headers: { ...auth, 'x-company-id': company.id } };
}

async function addMember(request: APIRequestContext, headers: Record<string, string>, email: string, fullName: string, role: string) {
  const add = await request.post('/api/company/members', { headers, data: { email, fullName, role, password: PASSWORD, mustChangePassword: false } });
  expect(add.status(), await add.text()).toBe(201);
  return ((await add.json()) as { member: { userId: string } }).member.userId;
}

async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('heading', { name: /Merhaba,/ })).toBeVisible();
}

async function newSession(browser: Browser, email: string) {
  const ctx = await browser.newContext({ locale: 'tr-TR', timezoneId: 'Europe/Nicosia' });
  const page = await ctx.newPage();
  await loginUi(page, email);
  return { ctx, page };
}

/** Sahibin ekranında üyenin modül erişimi sayfasını açar, seçimleri yapar, onay özetini doğrular ve kaydeder. */
async function setAccess(page: Page, memberId: string, choices: Record<string, 'default' | 'none' | 'read' | 'write'>, summary: RegExp) {
  await page.goto('/settings/members');
  await page.getByTestId(`member-access-${memberId}`).click();
  const sheet = page.getByRole('dialog', { name: /Modül erişimi:/ });
  await expect(sheet).toBeVisible();
  for (const [area, level] of Object.entries(choices)) {
    await sheet.getByTestId(`access-${area}-${level}`).click();
    await expect(sheet.getByTestId(`access-${area}-${level}`)).toHaveAttribute('aria-checked', 'true');
  }
  await sheet.getByTestId('access-save').click();
  const confirm = page.getByRole('dialog', { name: 'Değişiklikleri onaylayın' });
  await expect(confirm.getByTestId('access-summary')).toContainText(summary);
  await confirm.getByTestId('access-confirm').click();
  await expect(page.getByText('Modül erişimi kaydedildi')).toBeVisible();
  await expect(sheet).toBeHidden();
}

test('modül erişimi: sadece görüntüle → erişim yok → görüntüle ve düzenle → rol varsayılanı; yönetici sahibin erişimini değiştiremez', async ({ page, browser, request }) => {
  const o = await ownerWithCompany(request, 'erisim');
  const memberEmail = `e2e-muhasebeci-${o.stamp}@example.com`;
  const adminEmail = `e2e-yonetici-${o.stamp}@example.com`;
  const memberId = await addMember(request, o.headers, memberEmail, 'Mehmet Muhasebeci', 'accountant');
  const adminId = await addMember(request, o.headers, adminEmail, 'Yasemin Yönetici', 'admin');

  // Sahip girer
  await loginUi(page, o.email);

  // Üye ayrı oturumda: rol varsayılanında faturayı görür ve yeni fatura düğmesini görür
  const member = await newSession(browser, memberEmail);
  const mp = member.page;
  const memberLogin = await mp.request.post('/api/auth/login', { data: { email: memberEmail, password: PASSWORD } });
  const memberHeaders = { authorization: `Bearer ${((await memberLogin.json()) as { accessToken: string }).accessToken}`, 'x-company-id': o.companyId };
  await mp.goto('/invoices/sales');
  await expect(mp.getByRole('heading', { name: 'Satış faturaları', level: 1 })).toBeVisible();
  await expect(mp.getByRole('button', { name: 'Yeni satış faturası' }).first()).toBeVisible();

  // 1) Sahip: Fatura ve irsaliye → Sadece görüntüle
  await setAccess(page, memberId, { 'core.invoices': 'read' }, /Fatura ve irsaliye: Rol varsayılanı → Sadece görüntüle/);
  await expect(page.getByTestId(`custom-access-${memberId}`)).toContainText('Özel erişim');
  // Üye: liste açılır, "Yeni fatura" düğmeleri yok; API oluşturmayı Türkçe nedenle reddeder
  await mp.reload();
  await expect(mp.getByRole('heading', { name: 'Satış faturaları', level: 1 })).toBeVisible();
  await expect(mp.getByRole('button', { name: /Yeni satış faturası/ })).toHaveCount(0);
  const denied = await mp.request.post('/api/invoices', { headers: memberHeaders, data: {} });
  expect(denied.status()).toBe(403);
  const deniedBody = (await denied.json()) as { error: { code: string; message: string } };
  expect(deniedBody.error.code).toBe('MODULE_READ_ONLY');
  expect(deniedBody.error.message).toBe('Bu modülde yalnızca görüntüleme yetkiniz var; düzenleme yöneticiniz tarafından kapatıldı');
  expect((await mp.request.get('/api/invoices', { headers: memberHeaders })).status()).toBe(200);

  // 2) Sahip: Erişim yok → menüden kalkar, adres yetki ekranı gösterir
  await setAccess(page, memberId, { 'core.invoices': 'none' }, /Fatura ve irsaliye: Sadece görüntüle → Erişim yok/);
  await mp.goto('/');
  await expect(mp.getByRole('heading', { name: /Merhaba,/ })).toBeVisible();
  const nav = mp.getByRole('navigation', { name: 'Ana menü' });
  await expect(nav.getByRole('link', { name: 'Satış faturaları' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Cari hesaplar' })).toBeVisible(); // diğer modüller etkilenmez
  await mp.goto('/invoices/sales');
  await expect(mp.getByTestId('forbidden-page')).toBeVisible();
  await expect(mp.getByTestId('forbidden-page')).toHaveAttribute('data-reason', 'blocked');
  await expect(mp.getByText('Bu modüle erişiminiz yönetici tarafından kapatıldı')).toBeVisible();
  const blocked = await mp.request.get('/api/invoices', { headers: memberHeaders });
  expect(blocked.status()).toBe(403);
  expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('MODULE_ACCESS_DENIED');

  // 3) Rolün normalde düzenleyemediği modülde (Rehber: muhasebeci yalnızca görür) "Görüntüle ve düzenle" ile kayıt açabilir
  await mp.goto('/directory/contacts');
  await expect(mp.getByRole('heading', { name: 'Kişi rehberi', level: 1 })).toBeVisible();
  await expect(mp.getByRole('button', { name: 'Kişi ekle' })).toHaveCount(0);
  expect((await mp.request.post('/api/directory/contacts', { headers: memberHeaders, data: { fullName: 'Ali Veli' } })).status()).toBe(403);
  await setAccess(page, memberId, { 'core.directory': 'write' }, /Rehber, ajanda ve görüşme notları: Rol varsayılanı → Görüntüle ve düzenle/);
  await mp.reload();
  await expect(mp.getByRole('button', { name: 'Kişi ekle' }).first()).toBeVisible();
  const created = await mp.request.post('/api/directory/contacts', { headers: memberHeaders, data: { fullName: 'Ali Veli' } });
  expect(created.status(), await created.text()).toBe(201);

  // Etkin erişim sekmesi: sahibin gördüğü sonuç
  await page.goto('/settings/members');
  await page.getByTestId(`member-access-${memberId}`).click();
  const sheet = page.getByRole('dialog', { name: /Modül erişimi:/ });
  await sheet.getByRole('tab', { name: 'Etkin erişim' }).click();
  await expect(sheet.getByTestId('effective-core.invoices')).toContainText('Erişim yok');
  await expect(sheet.getByTestId('effective-core.directory')).toContainText('Görüntüle ve düzenle');
  await expect(sheet.getByTestId('effective-core.parties')).toContainText('Görüntüle ve düzenle');

  // 4) Tümünü rol varsayılanına döndür → fatura yeniden açılır, rozet kalkar
  await sheet.getByRole('tab', { name: 'Erişim ayarı' }).click();
  await sheet.getByTestId('access-reset-all').click();
  await sheet.getByTestId('access-save').click();
  const confirm = page.getByRole('dialog', { name: 'Değişiklikleri onaylayın' });
  await expect(confirm.getByTestId('access-summary')).toContainText('Fatura ve irsaliye: Erişim yok → Rol varsayılanı');
  await confirm.getByTestId('access-confirm').click();
  await expect(page.getByText('Modül erişimi kaydedildi')).toBeVisible();
  await expect(page.getByTestId(`custom-access-${memberId}`)).toHaveCount(0);
  await mp.goto('/invoices/sales');
  await expect(mp.getByRole('button', { name: 'Yeni satış faturası' }).first()).toBeVisible();
  await expect(mp.getByTestId('forbidden-page')).toHaveCount(0);
  await member.ctx.close();

  // 5) Yönetici: üye için erişim düğmesi var; sahibin, kendisinin (ve başka bir yöneticinin) satırında yok
  const admin = await newSession(browser, adminEmail);
  await admin.page.goto('/settings/members');
  await expect(admin.page.getByRole('heading', { name: 'Kullanıcılar ve yetkiler', level: 1 })).toBeVisible();
  await expect(admin.page.getByTestId(`member-access-${memberId}`)).toBeVisible();
  await expect(admin.page.getByTestId(`member-access-${o.ownerId}`)).toHaveCount(0);
  await expect(admin.page.getByTestId(`member-access-${adminId}`)).toHaveCount(0);
  // Sunucu da reddeder (arayüz atlansa bile)
  const adminLogin = await admin.page.request.post('/api/auth/login', { data: { email: adminEmail, password: PASSWORD } });
  const adminHeaders = { authorization: `Bearer ${((await adminLogin.json()) as { accessToken: string }).accessToken}`, 'x-company-id': o.companyId };
  const tryOwner = await admin.page.request.put(`/api/company/members/${o.ownerId}/module-access`, { headers: adminHeaders, data: { levels: { 'core.parties': 'none' } } });
  expect(tryOwner.status()).toBe(403);
  expect(((await tryOwner.json()) as { error: { code: string } }).error.code).toBe('MODULE_ACCESS_OWNER');
  await admin.ctx.close();
});
