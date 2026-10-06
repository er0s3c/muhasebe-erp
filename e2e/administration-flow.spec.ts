import { test, expect } from '@playwright/test';

test('şirket bütçesi aylık sapmayı ve kaynağı gösterir; onaydan sonra yeni revizyon açılır', async ({
  page,
}, info) => {
  const registration = await page.request.post('/api/auth/register', {
    data: {
      email: `budget-ui-${Date.now()}@example.com`,
      password: 'Enterprise-Test-12345',
      fullName: 'Bütçe Yönetici',
      organizationName: 'Bütçe Testi',
    },
  });
  expect(registration.status()).toBe(201);
  const token = (await registration.json()).accessToken;
  const made = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'Bütçe İnşaat', sector: 'CONSTRUCTION' },
  });
  expect(made.status()).toBe(201);
  const company = (await made.json()).company,
    headers = { authorization: `Bearer ${token}`, 'x-company-id': company.id };
  const accounts = (await (await page.request.get('/api/accounts', { headers })).json()).accounts;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Nicosia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const expense = await page.request.post('/api/journal-entries', {
    headers,
    data: {
      entryDate: date,
      description: 'Şantiye bütçe harcaması',
      post: true,
      lines: [
        {
          accountId: accounts.find((a: any) => a.code === '632').id,
          debit: '1250',
          credit: '0',
          currency: 'TRY',
        },
        {
          accountId: accounts.find((a: any) => a.code === '100').id,
          debit: '0',
          credit: '1250',
          currency: 'TRY',
        },
      ],
    },
  });
  expect(expense.status(), await expense.text()).toBe(201);
  await page.goto('/accounting/budgets');
  await page.getByRole('button', { name: 'Bütçe oluştur', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Bütçe başlığı').fill('Yıllık şantiye bütçesi');
  await sheet.getByLabel('Bütçe hesabı').fill('632');
  await page.getByRole('option', { name: /^632/ }).click();
  await sheet.getByRole('button', { name: 'Hesap ekle' }).click();
  await sheet.getByLabel('632 eşit aylık tutar').focus();
  await expect(sheet.getByLabel('632 eşit aylık tutar')).toHaveValue('0,00');
  await sheet.getByLabel('632 eşit aylık tutar').fill('1000');
  await sheet.getByRole('button', { name: 'Taslağı kaydet' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Yıllık şantiye bütçesi' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: '632' });
  await expect(row).toContainText('1.250,00');
  await expect(row).toContainText('250,00');
  await expect(row).toContainText('Olumsuz');
  await row.getByRole('button', { name: 'Kaynaklar' }).click();
  await expect(sheet).toContainText('Şantiye bütçe harcaması');
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel', exact: true }).click();
  expect((await download).suggestedFilename()).toContain('budget-');
  await page.getByRole('button', { name: 'Onayla', exact: true }).click();
  await sheet.getByRole('button', { name: 'Onayı kaydet' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revizyon aç', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revizyon aç', exact: true }).click();
  await expect(sheet).toContainText('Bütçeyi düzenle · R2');
  await sheet.getByLabel('632 eşit aylık tutar').focus();
  await expect(sheet.getByLabel('632 eşit aylık tutar')).toHaveValue('1000,00');
  await sheet.getByLabel('632 eşit aylık tutar').fill('1500');
  await sheet.getByRole('button', { name: 'Taslağı kaydet' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row).toContainText('1.500,00');
  await expect(row).toContainText('Olumlu');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('budget-desktop.png'),
    fullPage: true,
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(theme + '-budget.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Düzenle', exact: true }).click();
    await expect(sheet.getByLabel('Bütçe başlığı')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(theme + '-budget-form.png'),
    });
    await page.keyboard.press('Escape');
  }
});

test('demirbaş kartından amortisman taslağı, yevmiye kaydı ve ters kayıt izlenir', async ({
  page,
}, info) => {
  const registration = await page.request.post('/api/auth/register', {
    data: {
      email: `asset-ui-${Date.now()}@example.com`,
      password: 'Enterprise-Test-12345',
      fullName: 'Demirbaş Yönetici',
      organizationName: 'Demirbaş Testi',
    },
  });
  expect(registration.status()).toBe(201);
  const token = (await registration.json()).accessToken;
  const made = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'Ekipman İnşaat', sector: 'CONSTRUCTION' },
  });
  expect(made.status()).toBe(201);
  const company = (await made.json()).company,
    headers = { authorization: `Bearer ${token}`, 'x-company-id': company.id };
  const account = await page.request.post('/api/accounts', {
    headers,
    data: { code: '257', name: 'Birikmiş amortismanlar' },
  });
  expect([201, 409]).toContain(account.status());
  await page.goto('/accounting/fixed-assets');
  await page.getByRole('button', { name: 'Demirbaş ekle' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Demirbaş kodu').fill('EK-UI');
  await sheet.getByLabel('Demirbaş adı').fill('Şantiye ekskavatörü');
  await sheet.getByLabel(/^Maliyet \(/).fill('12000');
  await sheet.getByLabel('Kullanım süresi (ay)').fill('12');
  await sheet.getByLabel('Departman', { exact: true }).fill('Saha');
  await sheet.getByLabel('Amortisman gider hesabı').fill('632');
  await page.getByRole('option', { name: /^632/ }).click();
  await sheet.getByLabel('Birikmiş amortisman hesabı').fill('257');
  await page.getByRole('option', { name: /^257/ }).click();
  await sheet.getByRole('button', { name: 'Kartı kaydet' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Şantiye ekskavatörü' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan ve geçmiş' }).click();
  await expect(sheet).toContainText('Aylık tutar: 1.000,00 TRY');
  await sheet.getByRole('button', { name: 'Yevmiye taslağı oluştur' }).click();
  await expect(sheet.getByText('Taslak', { exact: true })).toBeVisible();
  await sheet.getByRole('link', { name: 'Yevmiyeyi aç' }).click();
  await expect(sheet).toContainText('Amortisman');
  await sheet.getByRole('button', { name: 'Muhasebeleştir', exact: true }).click();
  await expect(sheet.getByText('Kaydedildi', { exact: true })).toBeVisible();
  await page.goto('/accounting/fixed-assets');
  await page.getByRole('button', { name: 'Plan ve geçmiş' }).click();
  await expect(sheet.getByText('Kayıtlı', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'İptal et' }).click();
  const cancel = page.getByRole('dialog', { name: 'Amortismanı iptal et' });
  await cancel.getByLabel('İptal gerekçesi').fill('Dönem hatalı seçildi');
  await cancel.getByRole('button', { name: 'İptali kaydet' }).click();
  await expect(cancel).toHaveCount(0);
  await expect(sheet.getByRole('link', { name: 'Ters yevmiye' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('assets-desktop.png') });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/accounting/fixed-assets');
    await expect(page.locator('main h1')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ animations: 'disabled', path: info.outputPath(theme + '-assets.png') });
  }
});

test('personel masraf formu avans ve iade tutarını gösterir; iptal bakiyeyi açar', async ({
  page,
}, info) => {
  const registration = await page.request.post('/api/auth/register', {
    data: {
      email: `expense-ui-${Date.now()}@example.com`,
      password: 'Enterprise-Test-12345',
      fullName: 'Selin Muhasebe',
      organizationName: 'Masraf Testi',
    },
  });
  expect(registration.status()).toBe(201);
  const token = (await registration.json()).accessToken;
  const made = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'Masraf İnşaat', sector: 'CONSTRUCTION' },
  });
  expect(made.status()).toBe(201);
  const company = (await made.json()).company,
    headers = { authorization: `Bearer ${token}`, 'x-company-id': company.id };
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Nicosia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const employee = (
    await (
      await page.request.post('/api/employees', {
        headers,
        data: { fullName: 'Saha Ustası', hireDate: date },
      })
    ).json()
  ).employee;
  const bank = (
    await (
      await page.request.post('/api/treasury/accounts', {
        headers,
        data: { name: 'Masraf Bankası', kind: 'bank', currency: 'TRY' },
      })
    ).json()
  ).account;
  const advanceResponse = await page.request.post('/api/employee-ledger/advances', {
    headers,
    data: {
      employeeId: employee.id,
      date,
      amount: '1000',
      purpose: 'Malzeme avansı',
      treasuryAccountId: bank.id,
    },
  });
  expect(advanceResponse.status(), await advanceResponse.text()).toBe(201);
  const advance = (await advanceResponse.json()).advance;
  const accounts = (await (await page.request.get('/api/accounts', { headers })).json()).accounts;
  const account = accounts.find((a: { code: string }) => a.code === '632');
  expect(
    (
      await page.request.post('/api/expense-cards', {
        headers,
        data: { code: 'SAHA', name: 'Saha masrafı', accountId: account.id },
      })
    ).status(),
  ).toBe(201);
  await page.goto('/treasury/expenses');
  await page.getByRole('button', { name: 'Yeni gider', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Gider kartı/).fill('SAHA');
  await page.getByRole('option', { name: /SAHA/ }).click();
  await dialog.getByLabel(/Açıklama/).fill('Ustanın malzeme masrafı');
  await dialog.getByLabel(/KDV hariç tutar/).fill('1200');
  await dialog.getByLabel('Ödeme şekli').selectOption('employee');
  await dialog.getByLabel(/^Personel/).fill('Saha Ustası');
  await page.getByRole('option', { name: /Saha Ustası/ }).click();
  await expect(dialog.getByLabel('Mahsup edilecek avans')).toContainText(advance.number);
  await dialog.getByLabel('Mahsup edilecek avans').selectOption(advance.id);
  await dialog.getByLabel('Kasa / banka hesabı').selectOption(bank.id);
  await expect(dialog).toContainText('Personele iade: 200,00 TRY');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('employee-expense-form.png'),
  });
  await dialog.getByRole('button', { name: 'Gideri kaydet' }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: 'Ustanın malzeme masrafı' });
  await expect(row).toContainText('Saha Ustası');
  await expect(row).toContainText(advance.number);
  await row.getByRole('button', { name: 'İptal', exact: true }).click();
  await page.getByRole('dialog').getByLabel('İptal nedeni').fill('Hatalı masraf fişi');
  await page.getByRole('dialog').getByRole('button', { name: 'İptal', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const reopened = (
    await (
      await page.request.get(`/api/employee-ledger/advances/${advance.id}`, { headers })
    ).json()
  ).advance;
  expect(reopened.openAmount).toBe('1000.00');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/treasury/expenses');
    await expect(page.locator('main h1')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(theme + '-expenses.png'),
    });
  }
});

test('görev sayacı, uyarı tasarımı, yönetim raporu ve işletim ayarları', async ({ page }, info) => {
  const register = await page.request.post('/api/auth/register', {
    data: {
      email: `admin-ui-${Date.now()}@example.com`,
      password: 'Enterprise-Test-12345',
      fullName: 'Deniz Yönetici',
      organizationName: 'Yönetim Testi',
    },
  });
  expect(register.status(), await register.text()).toBe(201);
  const token = (await register.json()).accessToken;
  const made = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'Yönetim Test İnşaat', sector: 'CONSTRUCTION' },
  });
  expect(made.status()).toBe(201);
  const company = (await made.json()).company,
    headers = { authorization: `Bearer ${token}`, 'x-company-id': company.id };
  const partyResult = await page.request.post('/api/parties', {
    headers,
    data: { name: 'Deneme müşterisi', code: 'M-UI', kind: 'customer' },
  });
  expect(partyResult.status()).toBe(201);
  const party = (await partyResult.json()).party;
  // Representative monetary alerts are controlled UI fixtures; task/report/settings calls use the real API.
  await page.route('**/api/workspace/alerts', (route) =>
    route.fulfill({
      json: {
        total: 8,
        truncated: false,
        items: Array.from({ length: 8 }, (_, i) => ({
          key: 'ui-' + i,
          title: 'Deneme müşterisi · tahsilat',
          subject: 'Deneme müşterisi',
          amount: i % 2 ? '2320000.00' : '15413.81',
          currency: i % 2 ? 'TRY' : 'GBP',
          category: 'Tahsilat',
          dueDate: '2026-01-01',
          path: '/parties/' + party.id,
          read: i === 7,
        })),
      },
    }),
  );
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: 'Bugünkü işlerim', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yeni görev', exact: true }).first().click();
  await page.getByLabel('Başlık', { exact: true }).fill('Günlük şantiye toplantısı');
  await page.getByRole('button', { name: 'Görev oluştur', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Günlük şantiye toplantısı' })).toBeVisible();
  await page.getByRole('button', { name: 'Süre başlat', exact: true }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  await page.getByRole('button', { name: 'Durdur', exact: true }).click();
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(
    page.getByLabel('Bildirim merkezi').getByText('£15.413,81', { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tüm uyarıları göster (8)' }).click();
  await expect(page.getByLabel('Bildirim merkezi').getByRole('article')).toHaveCount(8);
  await page.getByRole('button', { name: 'Okunmamış', exact: true }).click();
  await expect(page.getByLabel('Bildirim merkezi').getByRole('article')).toHaveCount(7);
  await page.locator('main').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('work-desktop.png'),
    fullPage: true,
  });
  await page.getByLabel('Bildirim merkezi').evaluate((el) => {
    const main = el.closest('main')!;
    main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
  });
  await page.screenshot({ animations: 'disabled', path: info.outputPath('alerts-desktop.png') });
  await page.getByRole('button', { name: 'Tamamla', exact: true }).click();
  await page.goto('/reports/activity');
  await expect(
    page.getByRole('heading', { name: 'Yönetim ve faaliyet raporu', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: /^Görevler/ }).first()).toBeVisible();
  await page
    .getByRole('button', { name: /işlem detayını aç/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('activity-desktop.png'),
    fullPage: true,
  });
  await page.goto('/settings/operations');
  await expect(
    page.getByRole('heading', { name: 'İşletim ve güvenlik', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Belge arşivi: dosya başına MB').fill('8');
  await page.getByRole('button', { name: 'Ayarları kaydet', exact: true }).click();
  await expect(page.getByText('İşletim ayarları kaydedildi.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Belge arşivi: dosya başına MB')).toHaveValue('8');
  const limits = await page.request.get('/api/workspace/upload-limits', { headers });
  expect((await limits.json()).documentLimitMb).toBe(8);
  await page.goto('/settings/backups');
  await expect(page.getByRole('heading', { name: 'Yedekleme merkezi', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Şimdi yedekle' })).toBeDisabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [
      '/workspace',
      '/reports/activity',
      '/settings/operations',
      '/settings/backups',
    ]) {
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
          message: theme + ' ' + path,
        })
        .toBe(true);
      await page.screenshot({
        animations: 'disabled',
        path: info.outputPath(theme + path.replaceAll('/', '-') + '.png'),
        fullPage: true,
      });
    }
  }
});

test('kampanya önizlemesi fatura indirimi ve tarihli geçmiş olarak kaydedilir', async ({
  page,
}, info) => {
  const register = await page.request.post('/api/auth/register', {
    data: {
      email: `promo-ui-${Date.now()}@example.com`,
      password: 'Enterprise-Test-12345',
      fullName: 'Ali Satış',
      organizationName: 'Promosyon Testi',
    },
  });
  expect(register.status()).toBe(201);
  const token = (await register.json()).accessToken;
  const made = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'Satış Test İnşaat', sector: 'CONSTRUCTION' },
  });
  expect(made.status()).toBe(201);
  const company = (await made.json()).company,
    headers = { authorization: `Bearer ${token}`, 'x-company-id': company.id };
  const party = (
    await (
      await page.request.post('/api/parties', {
        headers,
        data: { name: 'Promosyon UI müşterisi', kind: 'customer' },
      })
    ).json()
  ).party;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Nicosia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const invoice = await page.request.post('/api/invoices', {
    headers,
    data: {
      type: 'sales',
      partyId: party.id,
      invoiceDate: date,
      externalNo: 'PROMO-UI',
      lines: [{ description: 'Şantiye hizmeti', quantity: '1', unitPrice: '1000' }],
    },
  });
  expect(invoice.status()).toBe(201);
  const invoiceId = (await invoice.json()).invoice.id;
  await page.goto('/sales/campaigns');
  await page.getByRole('button', { name: 'Yeni kampanya' }).click();
  await page.getByLabel('Kampanya kodu').fill('UI10');
  await page.getByLabel('Kampanya adı').fill('İlk satış promosyonu');
  await page.getByRole('button', { name: 'Kampanyayı kaydet' }).click();
  await expect(page.getByRole('heading', { name: 'İlk satış promosyonu' })).toBeVisible();
  await page.getByRole('button', { name: 'Faturada önizle' }).click();
  await page
    .getByRole('textbox', { name: 'Satış faturası taslağı ara', exact: true })
    .fill('PROMO-UI');
  await page.getByRole('button', { name: /PROMO-UI/ }).click();
  await page.getByRole('button', { name: 'İndirimi önizle' }).click();
  await expect(page.getByText('₺900,00', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Taslağa uygula' }).click();
  await expect(
    page.getByText('Kampanya fatura taslağına uygulandı.', { exact: true }),
  ).toBeVisible();
  const saved = await page.request.get(`/api/invoices/${invoiceId}`, { headers });
  expect((await saved.json()).invoice.grossTotal).toBe('900.0000');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Geçmiş', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('%10');
  await page.keyboard.press('Escape');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/sales/campaigns');
    await expect(page.getByRole('heading', { name: 'Kampanya ve promosyon' })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath(theme + '-campaigns.png'),
    });
  }
});

test('tekrar planı ve kişisel grafik panosu gerçek kaynak kayıtlarla çalışır', async ({
  page,
}, info) => {
  const registration = await page.request.post('/api/auth/register', {
    data: {
      email: `bi-ui-${Date.now()}@example.com`,
      password: 'Enterprise-Test-12345',
      fullName: 'Ece Planlama',
      organizationName: 'Planlama Testi',
    },
  });
  expect(registration.status()).toBe(201);
  const token = (await registration.json()).accessToken;
  const made = await page.request.post('/api/companies', {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'Planlama İnşaat', sector: 'CONSTRUCTION' },
  });
  expect(made.status()).toBe(201);
  const company = (await made.json()).company,
    headers = { authorization: `Bearer ${token}`, 'x-company-id': company.id };
  const party = (
    await (
      await page.request.post('/api/parties', {
        headers,
        data: { name: 'Pano müşterisi', kind: 'customer' },
      })
    ).json()
  ).party;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Nicosia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const invoice = await page.request.post('/api/invoices', {
    headers,
    data: {
      type: 'sales',
      partyId: party.id,
      invoiceDate: date,
      lines: [{ description: 'Proje danışmanlığı', quantity: '1', unitPrice: '2500' }],
      post: true,
    },
  });
  expect(invoice.status(), await invoice.text()).toBe(201);
  await page.goto('/settings/recurring');
  await expect(page.getByRole('heading', { name: 'Tekrarlayan işler', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yeni tekrar', exact: true }).click();
  await page.getByLabel('Plan başlığı').fill('Haftalık ekip toplantısı');
  await page.getByRole('button', { name: 'Planı kaydet' }).click();
  await expect(page.getByRole('cell', { name: /Haftalık ekip toplantısı/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Şimdi çalıştır' }).click();
  await expect(page.getByText('1 kayıt oluşturuldu.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Geçmiş', exact: true }).click();
  await page.getByRole('link', { name: 'Ajandayı aç' }).click();
  await expect(page.getByText('Haftalık ekip toplantısı', { exact: true }).first()).toBeVisible();
  await page.goto('/reports/insights');
  await page.getByRole('button', { name: 'Rapor ekle', exact: true }).click();
  await page.getByLabel('Rapor adı').fill('Aylık satış grafiği');
  await page.getByLabel('Kaynak rapor').selectOption('sales-report');
  await page.getByRole('button', { name: 'Önizle', exact: true }).click();
  await expect(page.getByLabel('Grafik kaynak tablosu')).toBeVisible();
  await page.getByLabel('Grafik kaynak tablosu').selectOption('satis-raporu');
  await page.getByRole('button', { name: 'Panoya kaydet' }).click();
  await expect(
    page.getByRole('heading', { name: 'Aylık satış grafiği', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel(/Net.*grafiği/)).toContainText('Pano müşterisi');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Aylık satış grafiği', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Kaynak tabloyu aç' }).click();
  await expect(page.getByRole('dialog')).toContainText('2.500,00');
  await page.keyboard.press('Escape');
  await page.screenshot({
    animations: 'disabled',
    path: info.outputPath('insights-desktop.png'),
    fullPage: true,
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['/settings/recurring', '/reports/insights']) {
      await page.goto(path);
      await expect(page.locator('main h1')).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        animations: 'disabled',
        path: info.outputPath(theme + path.replaceAll('/', '-') + '.png'),
        fullPage: true,
      });
    }
  }
});
