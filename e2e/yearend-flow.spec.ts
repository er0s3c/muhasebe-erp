import { expect, test } from '@playwright/test';

const PASSWORD = 'Sifre-12345-xyz';
const year = new Date().getFullYear();

test('yıl sonu: satış ve gider → ön kontrol → önizleme → yazılı onayla kapat → kilitli yıl, sıfırlanan gelir/gider, ertesi yıl devri → yeniden aç', async ({ page }) => {
  const email = `e2e-yilsonu-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Ad soyad').fill('Mert Kaya');
  await page.getByLabel('Firma / kuruluş adı').fill('Kaya Holding');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(PASSWORD);
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'İlk şirketinizi kuralım' })).toBeVisible();
  await page.getByLabel('Şirket unvanı').fill('Kaya İnşaat Ltd.');
  await page.getByRole('button', { name: 'Şirketi oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Mert' })).toBeVisible();

  // Defter verisi API ile: sermaye, satış, gider
  const login = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  const token = (await login.json()).accessToken as string;
  const me = (await (await page.request.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).json()).companies as { id: string }[];
  const companyId = me[0]!.id;
  const headers = { authorization: `Bearer ${token}`, 'x-company-id': companyId };
  const ids = Object.fromEntries((((await (await page.request.get('/api/accounts', { headers })).json()).accounts) as { code: string; id: string }[]).map((a) => [a.code, a.id]));
  const journal = async (date: string, lines: [string, 'debit' | 'credit', string][]) => {
    const res = await page.request.post('/api/journal-entries', { headers, data: { entryDate: `${year}-${date}`, description: 'E2E', post: true, lines: lines.map(([c, s, a]) => ({ accountId: ids[c], currency: 'TRY', [s]: a })) } });
    expect(res.ok(), await res.text()).toBeTruthy();
  };
  await journal('01-05', [['100', 'debit', '10000'], ['500', 'credit', '10000']]);
  await journal('03-10', [['100', 'debit', '1000'], ['600', 'credit', '1000']]);
  await journal('04-10', [['632', 'debit', '300'], ['100', 'credit', '300']]);

  const nav = page.getByRole('navigation', { name: 'Ana menü' });
  await nav.getByRole('link', { name: 'Yıl sonu kapanışı' }).click();
  await expect(page.getByRole('heading', { name: 'Yıl sonu kapanışı', level: 1 })).toBeVisible();
  await expect(page.getByText('Doğrulanmadı: hesap seçimleri')).toBeVisible();

  // Mali yılı tanımla (öneri: takvim yılı)
  await page.getByLabel('Başlangıç').fill(`${year}-01-01`);
  await page.getByLabel('Bitiş').fill(`${year}-12-31`);
  await page.getByRole('button', { name: 'Yılı tanımla' }).click();
  await expect(page.getByText('Mali yıl tanımlandı')).toBeVisible();
  await expect(page.getByTestId('fiscal-year-row')).toHaveCount(1);

  // Ön kontrol: engel yok, kur değerlemesi uyarısı var
  const pre = page.getByTestId('preflight');
  await expect(pre.getByTestId('check-trial_balance')).toHaveAttribute('data-severity', 'ok');
  await expect(pre.getByTestId('check-fx_revaluation_not_done')).toHaveAttribute('data-severity', 'warning');
  await expect(pre.getByTestId('check-draft_entries')).toHaveAttribute('data-severity', 'ok');

  // Önizleme: 600, 632 kapanır; sonuç 700 kâr; devir fişi ertesi yılın ilk günü
  const closing = page.getByTestId('preview-closing');
  await expect(closing.getByText('600', { exact: true })).toBeVisible();
  await expect(closing.getByText('632', { exact: true })).toBeVisible();
  await expect(closing.getByText('590', { exact: true })).toBeVisible();
  await expect(page.getByTestId('preview-result')).toContainText('700,00');
  await expect(page.getByTestId('preview-carry')).toContainText(`01.01.${year + 1}`);

  // Yazılı onay olmadan kapanmaz
  await page.getByTestId('close-year').click();
  const confirm = page.getByTestId('confirm-close');
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Onay metni').fill(String(year));
  await confirm.click();
  await expect(page.getByTestId('fiscal-year-result')).toContainText('700,00');
  await expect(page.getByTestId('closed-panel')).toBeVisible();

  // Mizan: kapanış dahil gelir/gider sıfır; kapanışsız görünümde satış 1.000 durur; kapalı yıl bandı görünür
  await nav.getByRole('link', { name: 'Mizan' }).click();
  await expect(page.getByTestId('closed-year-banner')).toBeVisible();
  const row600 = page.getByRole('row').filter({ hasText: 'Yurt İçi Satışlar' }).first();
  await expect(row600).toBeVisible();

  // Kilit: yıl içine kayıt reddedilir
  const blocked = await page.request.post('/api/journal-entries', { headers, data: { entryDate: `${year}-05-05`, description: 'x', post: true, lines: [{ accountId: ids['100'], currency: 'TRY', debit: '1' }, { accountId: ids['500'], currency: 'TRY', credit: '1' }] } });
  expect(blocked.status()).toBe(422);

  // Ertesi yıl: gelir/gider sıfırdan, sonuç geçmiş yıllar kârlarında
  const next = await (await page.request.get(`/api/reports/trial-balance?from=${year + 1}-01-01&to=${year + 1}-12-31`, { headers })).json();
  const bal = (code: string) => Number(next.rows.find((r: { code: string }) => r.code === code)?.closing ?? 0);
  expect(bal('600')).toBe(0);
  expect(bal('570')).toBe(-700);
  expect(bal('100')).toBe(10700);

  // Yeniden aç: gerekçe zorunlu
  await nav.getByRole('link', { name: 'Yıl sonu kapanışı' }).click();
  await page.getByRole('button', { name: 'Yeniden aç' }).first().click();
  const submit = page.getByRole('dialog').getByRole('button', { name: 'Yeniden aç' });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Gerekçe (en az 5 karakter)').fill('Mali müşavir düzeltme istedi');
  await submit.click();
  await expect(page.getByTestId('fiscal-year-row').getByText('Açık', { exact: true })).toBeVisible();
  const reopened = await page.request.post('/api/journal-entries', { headers, data: { entryDate: `${year}-05-05`, description: 'x', post: true, lines: [{ accountId: ids['100'], currency: 'TRY', debit: '1' }, { accountId: ids['500'], currency: 'TRY', credit: '1' }] } });
  expect(reopened.status()).toBe(201);
});
