import { expect, test } from '@playwright/test';

test('üçlü eşleştirme: siparişten fatura satırı, tolerans dışı reddedilir, düzeltilince eşleşir', async ({ page, request }) => {
  const stamp = Date.now();
  const email = `e2e-esles-${stamp}@example.com`;
  const password = 'Sifre-12345-xyz';
  const reg = await (await request.post('/api/auth/register', { data: { email, password, fullName: 'Ece Satınalma', organizationName: 'Eşleşme Holding' } })).json();
  const auth = { authorization: `Bearer ${reg.accessToken}` };
  const company = (await (await request.post('/api/companies', { headers: auth, data: { name: 'Eşleşme İnşaat Ltd.', sector: 'CONSTRUCTION' } })).json()).company;
  const h = { ...auth, 'x-company-id': company.id };
  const project = (await (await request.post('/api/projects', { headers: h, data: { name: 'Güneş Sitesi', kind: 'own' } })).json()).project;
  const wbs = (await (await request.post(`/api/projects/${project.id}/wbs`, { headers: h, data: { code: '03', name: 'Betonarme' } })).json()).wbs[0];
  await request.post('/api/parties', { headers: h, data: { name: 'Hazır Beton Ltd.', kind: 'supplier' } });
  const sup = (await (await request.get('/api/parties', { headers: h })).json()).parties[0];
  const order = await (
    await request.post('/api/purchase-orders', {
      headers: h,
      data: { projectId: project.id, partyId: sup.id, currencyCode: 'TRY', paymentDays: 30, lines: [{ description: 'Beton pompası kiralama', unit: 'gün', quantity: '2', unitPrice: '4000', wbsId: wbs.id }] },
    })
  ).json();
  const issued = await (await request.post(`/api/purchase-orders/${order.order.id}/issue`, { headers: h, data: {} })).json();
  const rc = await request.post(`/api/purchase-orders/${order.order.id}/receipts`, { headers: h, data: { receiptDate: new Date().toISOString().slice(0, 10), lines: [{ orderLineId: issued.lines[0].id, quantity: '2' }] } });
  expect(rc.status()).toBe(201);

  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('heading', { name: 'Merhaba, Ece' })).toBeVisible();

  await page.goto('/invoices/new?type=purchase');
  const box = page.getByRole('combobox', { name: /Tedarikçi/ });
  await box.click();
  await box.fill('Hazır');
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByLabel('Tedarikçi fatura no').fill('TED-2026-77');
  await page.getByRole('button', { name: 'Siparişten satır ekle' }).click();
  await page.getByRole('checkbox', { name: /SIP-0001/ }).check();
  await page.getByRole('button', { name: 'Seçilenleri ekle' }).click();
  await expect(page.getByText('Sipariş SIP-0001')).toBeVisible();

  // Fiyat %2,5 yüksek: tolerans dışı
  const price = page.getByLabel('Birim fiyat 1');
  const setPrice = async (v: string) => {
    await price.click();
    await price.press('Control+A');
    await price.pressSequentially(v);
  };
  await setPrice('4100');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('alert')).toContainText('tolerans dışı');

  // Düzeltilince geçer ve eşleştirme tablosu görünür
  await setPrice('4000');
  await page.getByRole('button', { name: 'Kaydet ve muhasebeleştir' }).click();
  await expect(page.getByRole('heading', { name: 'Sipariş eşleştirme', level: 2 })).toBeVisible();
  await expect(page.getByText('Eşleşti').first()).toBeVisible();

  await page.goto('/purchasing/matching');
  await expect(page.getByRole('row', { name: /SIP-0001/ })).toContainText('Eşleşti');
});
