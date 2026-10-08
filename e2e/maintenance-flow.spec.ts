import { expect, test } from '@playwright/test';

const localFields = (value: Date) => ({
  date: value.toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }),
  time: value.toLocaleTimeString('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }),
});

test('bakım başlangıçla açılır, saatin tamamı tıklanır ve gerçekleşen bitişle kapanır', async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const email = `maintenance-${suffix}@example.com`,
    password = 'Bakim-Test-12345!';
  const registered = await request.post('/api/auth/register', {
    data: { email, password, fullName: 'Bakım Testi', organizationName: `Bakım testi ${suffix}` },
  });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const auth = { authorization: `Bearer ${(await registered.json()).accessToken}` };
  const companyResponse = await request.post('/api/companies', {
    headers: auth,
    data: { name: `Bakım testi ${suffix}`, sector: 'MANUFACTURING_WHOLESALE' },
  });
  expect(companyResponse.ok(), await companyResponse.text()).toBeTruthy();
  const headers = { ...auth, 'x-company-id': (await companyResponse.json()).company.id };
  const resourceResponse = await request.post('/api/manufacturing/resources', {
    headers,
    data: { code: `BAKIM-${suffix}`, name: 'Bakım test makinesi', type: 'machine' },
  });
  expect(resourceResponse.ok(), await resourceResponse.text()).toBeTruthy();
  const resource = (await resourceResponse.json()).record;
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('button', { name: 'Şirket değiştir' })).toBeVisible();
  await page.goto('/manufacturing/maintenance');
  const form = page.getByRole('form', { name: 'Bakım veya arıza kaydı' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel(/Bitiş/i)).toHaveCount(0);
  const start = localFields(new Date(Date.now() - 2 * 3600000));
  const finish = localFields(new Date(Date.now() - 3600000));
  await form.getByRole('combobox', { name: 'Makine', exact: true }).selectOption(resource.id);
  await form.getByRole('combobox', { name: 'Tür', exact: true }).selectOption('breakdown');
  await form
    .getByRole('textbox', { name: 'Açıklama', exact: true })
    .fill('Bitişi bilinmeyen arıza');
  await form.getByLabel('Başlangıç tarihi').fill(start.date);
  const clock = form.getByLabel('Başlangıç saati');
  await clock.fill(start.time);
  await clock.evaluate((input) => {
    input.setAttribute('data-picker-opened', '0');
    (input as HTMLInputElement).showPicker = () => {
      input.setAttribute(
        'data-picker-opened',
        String(Number(input.getAttribute('data-picker-opened')) + 1),
      );
    };
  });
  await clock.click({ position: { x: 12, y: 16 } });
  await expect(clock).toHaveAttribute('data-picker-opened', '1');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await expect(clock).toBeVisible();
  }
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/manufacturing/maintenance') &&
      response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Kaydet', exact: true }).click();
  const created = await createdResponse;
  expect(created.ok(), await created.text()).toBeTruthy();
  const record = (await created.json()).record;
  expect(record).toMatchObject({ status: 'open', end: null });
  const row = page.getByRole('row').filter({ hasText: record.code });
  await expect(row.getByText('Devam ediyor', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Kaydı tamamla', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Gerçekleşen bitiş tarihi').fill(finish.date);
  await dialog.getByLabel('Gerçekleşen bitiş saati').fill(finish.time);
  await expect(dialog.getByLabel('Yedek parça sarf tarihi')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: 'Kaydı tamamla', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const completedResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/manufacturing/maintenance/${record.id}/complete`),
  );
  await dialog.getByRole('button', { name: 'Kaydı tamamla', exact: true }).click();
  const completed = await completedResponse;
  expect(completed.ok(), await completed.text()).toBeTruthy();
  expect((await completed.json()).record).toMatchObject({
    status: 'completed',
    stockDocumentId: null,
  });
  await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(row.getByText('Tamamlandı', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/maintenance-completed.png', fullPage: true });
});
