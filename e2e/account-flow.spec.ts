import { expect, test } from './fixtures';

test('hesap güvenliği: posta kapalıyken genel sayfalar; yöneticinin geçici şifresiyle girişte şifre değiştirmeden ilerlenemez', async ({ page, request }) => {
  // 1) Posta yapılandırılmamış kurulum: "Şifremi unuttum" görünmez, sıfırlama sayfası nedenini açıklar
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Hesabınıza giriş yapın', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Şifremi unuttum' })).toHaveCount(0);
  await page.goto('/forgot-password');
  await expect(page.getByText('e-posta gönderimi kapalı')).toBeVisible();
  await page.goto('/reset-password');
  await expect(page.getByText('Bağlantı eksik ya da geçersiz')).toBeVisible();
  await page.goto('/reset-password?token=' + 'a'.repeat(43));
  await page.getByLabel('Yeni şifre').fill('Kirmizi-Bulut-84!x');
  await page.getByRole('button', { name: 'Şifreyi değiştir' }).click();
  await expect(page.getByRole('alert')).toContainText('geçersiz');
  await page.goto('/verify-email?token=' + 'b'.repeat(43));
  await expect(page.getByRole('alert')).toContainText('geçersiz');

  // 2) Yönetici geçici şifre belirler (API ile hazırlanır); kullanıcı arayüzden girer
  const stamp = Date.now();
  const owner = await (
    await request.post('/api/auth/register', {
      data: { email: `e2e-sahip-${stamp}@example.com`, password: 'Sifre-12345-xyz', fullName: 'Selin Sahip', organizationName: 'Sahip Holding' },
    })
  ).json();
  const auth = { authorization: `Bearer ${owner.accessToken}` };
  const company = (await (await request.post('/api/companies', { headers: auth, data: { name: 'Sahip İnşaat Ltd.', sector: 'CONSTRUCTION', jurisdiction: 'KKTC' } })).json()).company;
  const memberEmail = `e2e-uye-${stamp}@example.com`;
  const add = await request.post('/api/company/members', {
    headers: { ...auth, 'x-company-id': company.id },
    data: { email: memberEmail, fullName: 'Mert Muhasebeci', role: 'accountant', password: 'Gecici-Sifre-4242!' },
  });
  expect(add.status()).toBe(201);

  await page.goto('/login');
  await page.getByLabel('E-posta').fill(memberEmail);
  await page.getByLabel('Şifre').fill('Gecici-Sifre-4242!');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('heading', { name: 'Kendi şifrenizi belirleyin', level: 1 })).toBeVisible();

  // Başka bir ekrana gitmeye çalışmak yine şifre ekranına döner
  await page.goto('/parties');
  await expect(page.getByRole('heading', { name: 'Kendi şifrenizi belirleyin', level: 1 })).toBeVisible();

  // Aynı şifre kabul edilmez; yeni şifre kabul edilir ve uygulama açılır
  await page.getByLabel('Mevcut şifre').fill('Gecici-Sifre-4242!');
  await page.getByLabel('Yeni şifre').fill('Gecici-Sifre-4242!');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('alert')).toContainText('farklı olmalı');
  await page.getByLabel('Yeni şifre').fill('Yeni-Kalem-9090!');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page.getByRole('heading', { name: /Merhaba, Mert/ })).toBeVisible();

  // Yeni şifreyle yeniden giriş çalışır
  await page.getByRole('button', { name: 'Mert Muhasebeci', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
  await page.getByLabel('E-posta').fill(memberEmail);
  await page.getByLabel('Şifre').fill('Yeni-Kalem-9090!');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('heading', { name: /Merhaba, Mert/ })).toBeVisible();
});
