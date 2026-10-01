import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secretBase32: string, offset = 0): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/\s/g, '')) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Math.floor(Date.now() / 30_000) + offset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

test('iki adımlı doğrulama: QR ile kurulum, kurtarma kodları, kodla giriş, kapatma', async ({ page, request }) => {
  const email = `e2e-mfa-${Date.now()}@example.com`;
  const password = 'Sifre-12345-xyz';
  const reg = await (await request.post('/api/auth/register', { data: { email, password, fullName: 'Mine Güvenli', organizationName: 'Güvenli Holding' } })).json();
  await request.post('/api/companies', { headers: { authorization: `Bearer ${reg.accessToken}` }, data: { name: 'Güvenli İnşaat Ltd.', sector: 'CONSTRUCTION' } });

  const login = async () => {
    await page.goto('/login');
    await page.getByLabel('E-posta').fill(email);
    await page.getByLabel('Şifre').fill(password);
    await page.getByRole('button', { name: 'Giriş yap' }).click();
  };

  await login();
  await expect(page.getByRole('heading', { name: 'Merhaba, Mine' })).toBeVisible();
  await page.goto('/account/security');
  await expect(page.getByRole('heading', { name: 'Hesap güvenliği', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Etkinleştir' }).click();
  await expect(page.getByRole('img', { name: 'İki adımlı doğrulama QR kodu' })).toBeVisible();
  const secret = (await page.locator('p.font-mono').first().innerText()).trim();
  await page.getByLabel('Doğrulama kodu').fill(totp(secret));
  await page.getByRole('button', { name: 'Doğrula ve etkinleştir' }).click();
  const codes = page.getByTestId('recovery-codes').locator('li');
  await expect(codes).toHaveCount(8);
  const recovery = (await codes.first().innerText()).trim();
  await page.getByRole('button', { name: 'Kaydettim' }).click();
  await expect(page.getByText('8 kurtarma kodu kaldı')).toBeVisible();

  // Çıkış: yeni oturumda şifre tek başına yetmez
  await page.context().clearCookies();
  await login();
  await expect(page.getByRole('heading', { name: 'İki adımlı doğrulama', level: 1 })).toBeVisible();
  await page.getByLabel('Doğrulama kodu').fill('000000');
  await page.getByRole('button', { name: 'Doğrula', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('hatalı');
  await page.getByLabel('Doğrulama kodu').fill(recovery);
  await page.getByRole('button', { name: 'Doğrula', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Mine' })).toBeVisible();

  // Kurtarma kodu tek kullanımlık: 7 kaldı; MFA parola + kodla kapatılır
  await page.goto('/account/security');
  await expect(page.getByText('7 kurtarma kodu kaldı')).toBeVisible();
  await page.getByRole('button', { name: 'Kapat', exact: true }).click();
  await page.getByLabel('Şifre').fill(password);
  await page.getByLabel('Doğrulama kodu').fill(totp(secret, 1));
  await page.getByRole('dialog').getByRole('button', { name: 'Kapat', exact: true }).click();
  await expect(page.getByText('Kapalı', { exact: true })).toBeVisible();
});
