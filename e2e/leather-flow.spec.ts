import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { todayIso } from '@erp/shared';

const password = 'Sifre-12345-xyz';
async function leatherCompany(request: APIRequestContext, tag: string) {
  const email = `leather-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const registered = await request.post('/api/auth/register', {
    data: { email, password, fullName: 'Deri Atölyesi', organizationName: 'Deri Test İşletmesi' },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const { accessToken } = await registered.json();
  const auth = { authorization: `Bearer ${accessToken}` };
  const created = await request.post('/api/companies', {
    headers: auth,
    data: { name: 'Deri Aksesuar Test', sector: 'LEATHER_FASHION' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { company } = await created.json();
  const headers = { ...auth, 'x-company-id': company.id };
  const stocks = await request.get('/api/warehouses', { headers });
  expect(stocks.ok()).toBeTruthy();
  const { warehouses } = await stocks.json();
  const warehouseId =
    warehouses[0]?.id ??
    (
      await (
        await request.post('/api/warehouses', {
          headers,
          data: { name: 'Atölye ve mağaza deposu' },
        })
      ).json()
    ).warehouse.id;
  return { email, headers, warehouseId };
}

async function loginAt(page: Page, email: string, path: string) {
  await page.goto(path);
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Şifre').fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

test('deri kataloğu: numune, reçete ve iş rotası onaylandıktan sonra mamul SKU oluşturulur', async ({
  request,
  page,
}) => {
  const { email, headers } = await leatherCompany(request, 'catalog');
  const materialResponse = await request.post('/api/items', {
    headers,
    data: {
      name: 'İtalyan bitkisel dana derisi',
      kind: 'goods',
      unit: 'm2',
      inventoryRole: 'raw_material',
    },
  });
  expect(materialResponse.status(), await materialResponse.text()).toBe(201);
  const material = (await materialResponse.json()).item;
  const outputResponse = await request.post('/api/items', {
    headers,
    data: {
      name: 'Klasik deri cüzdan taba',
      kind: 'goods',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      salePrice: '100',
    },
  });
  expect(outputResponse.status(), await outputResponse.text()).toBe(201);
  const output = (await outputResponse.json()).item;
  await loginAt(page, email, '/leather/models');
  const modelForm = page.getByRole('form', { name: 'Yeni model', exact: true });
  await modelForm.getByLabel('Model kodu').fill('CZD-01');
  await modelForm.getByLabel('Model adı').fill('Klasik cüzdan');
  await modelForm.getByLabel('Ürün ailesi').selectOption('wallet');
  await modelForm.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await page
    .getByRole('row', { name: /CZD-01 Klasik cüzdan/ })
    .getByRole('button', { name: 'Reçete ve varyantlar' })
    .click();
  const revision = page.getByRole('form', { name: 'Yeni reçete ve numune revizyonu' });
  await revision.getByLabel('Revizyon adı').fill('İlk üretim numunesi');
  await revision.getByLabel('Numune sonucu').selectOption('true');
  await revision.getByLabel('Bitmiş ürün ölçüleri').fill('11 x 9 cm');
  await revision.getByLabel('Hedef deri kalınlığı (mm)').fill('1.2');
  await revision.getByLabel('Reçete malzemesi 1').selectOption(material.id);
  await revision.getByLabel('Birim tüketim 1').fill('0.15');
  await revision.getByLabel('Plan fire (%) 1').fill('10');
  await revision.getByLabel('Dikiş süre (dk)').fill('12');
  await revision.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await page
    .getByRole('row', { name: /R1.*İlk üretim numunesi/ })
    .getByRole('button', { name: 'Üretime uygun olarak onayla' })
    .click();
  await expect(page.getByRole('row', { name: /R1.*İlk üretim numunesi/ })).toContainText(
    'Üretime uygun',
  );
  const variant = page.getByRole('form', { name: 'Yeni ürün varyantı' });
  const revisionId = await variant
    .getByLabel('Üretim revizyonu')
    .locator('option')
    .nth(1)
    .getAttribute('value');
  expect(revisionId).toBeTruthy();
  await variant.getByLabel('Üretim revizyonu').selectOption(revisionId!);
  await variant.getByLabel('Mamul stok kartı').selectOption(output.id);
  await variant.getByLabel('Ürün rengi').fill('Taba');
  await variant.getByLabel('Kişiselleştirme').selectOption('true');
  await variant.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(
    page.getByRole('row', { name: /Klasik deri cüzdan taba Klasik cüzdan R1 Taba/ }),
  ).toBeVisible();
  const result = await request.get('/api/leather/catalog/variants', { headers });
  expect((await result.json()).variants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        itemId: output.id,
        revisionId,
        color: 'Taba',
        allowsPersonalization: true,
      }),
    ]),
  );
});

test('mağaza: barkod, bölünmüş ödeme, kaybolan yanıttan sonra güvenli tekrar, kısmi iade ve kasa kapanışı', async ({
  request,
  page,
}) => {
  const { email, headers, warehouseId } = await leatherCompany(request, 'pos');
  const productResponse = await request.post('/api/items', {
    headers,
    data: {
      name: 'Taba deri kartlık',
      kind: 'goods',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: '8690000000012',
      salePrice: '100',
    },
  });
  expect(productResponse.status(), await productResponse.text()).toBe(201);
  const product = (await productResponse.json()).item;
  const opened = await request.post('/api/stock-documents', {
    headers,
    data: {
      type: 'opening',
      docDate: todayIso(),
      warehouseId,
      lines: [{ itemId: product.id, quantity: '5', unitCost: '20', currency: 'TRY' }],
    },
  });
  expect(opened.ok(), await opened.text()).toBeTruthy();
  const cashResponse = await request.post('/api/treasury/accounts', {
    headers,
    data: { kind: 'cash', name: 'Mağaza nakdi', currency: 'TRY' },
  });
  expect(cashResponse.ok(), await cashResponse.text()).toBeTruthy();
  const cardResponse = await request.post('/api/treasury/accounts', {
    headers,
    data: { kind: 'bank', name: 'Mağaza POS tahsilatı', currency: 'TRY' },
  });
  expect(cardResponse.ok(), await cardResponse.text()).toBeTruthy();
  const bootstrap = await (await request.get('/api/pos/bootstrap', { headers })).json();
  const tillResponse = await request.post('/api/pos/tills', {
    headers,
    data: {
      name: 'Ana mağaza',
      warehouseId,
      cashAccountId: (await cashResponse.json()).account.id,
      cardAccountId: (await cardResponse.json()).account.id,
      maxDiscountPct: '5',
      assignedUserIds: [bootstrap.members[0].userId],
    },
  });
  expect(tillResponse.status(), await tillResponse.text()).toBe(201);
  const till = (await tillResponse.json()).till;
  await loginAt(page, email, '/pos/sessions');
  const opening = page.getByRole('form', { name: 'Kasayı aç' });
  await opening.getByLabel('Satış noktası').selectOption(till.id);
  await opening.getByLabel('Açılış nakdi').fill('100');
  await opening.getByRole('button', { name: 'Kasayı aç' }).click();
  await expect(page.getByRole('row', { name: /Ana mağaza/ })).toContainText('Açık');
  await page.goto('/pos');
  await page.getByLabel('Barkod veya ürün ara').fill('8690000000012');
  await page.getByRole('button', { name: 'Barkodu ekle' }).click();
  await page.getByLabel('Miktar 1', { exact: true }).fill('2');
  await page.getByLabel('Nakit ödeme').fill('70');
  await page.getByLabel('Kart ödemesi').fill('129');
  await expect(page.getByRole('button', { name: 'Satışı tamamla' })).toBeDisabled();
  await page.getByLabel('Kart ödemesi').fill('130');
  let lostResponse = true;
  const requestIds: string[] = [];
  await page.route('**/api/pos/sessions/*/sales', async (route) => {
    requestIds.push(route.request().postDataJSON().requestId);
    if (lostResponse) {
      lostResponse = false;
      const saved = await route.fetch();
      expect(saved.status()).toBe(201);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Satışı tamamla' }).click();
  await expect(page.getByLabel('Miktar 1', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Satışı tamamla' }).click();
  await expect(page.getByText(/Satış kaydedildi ·/)).toBeVisible();
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
  const sessionList = (await (await request.get('/api/pos/sessions', { headers })).json()).sessions;
  const sessionId = sessionList[0].id;
  const saved = await (await request.get(`/api/pos/sessions/${sessionId}`, { headers })).json();
  expect(saved.sales.filter((sale: any) => sale.kind === 'sale')).toHaveLength(1);
  expect(saved.session.expectedCash).toBe('170.00');
  await page.getByLabel('İade edilecek satış').selectOption(saved.sales[0].id);
  await page.getByLabel('İade miktarı 1').fill('1');
  await page.getByLabel('İade nedeni').fill('Müşteri farklı model istedi');
  await page.getByLabel('Nakit iadesi').fill('50');
  await page.getByLabel('Kart iadesi').fill('50');
  await page.getByRole('button', { name: 'İadeyi kaydet' }).click();
  await expect(page.getByText('İade kaydedildi', { exact: true })).toBeVisible();
  const returned = await request.get(`/api/pos/sessions/${sessionId}`, { headers });
  const returnedData = await returned.json();
  expect(returnedData.sales.filter((sale: any) => sale.kind === 'return')).toHaveLength(1);
  expect(returnedData.session.expectedCash).toBe('120.00');
  await page.goto(`/pos/sessions?open=${sessionId}`);
  const closing = page.getByRole('form', { name: 'Kasayı kapat' });
  await closing.getByLabel('Sayılan nakit').fill('120');
  await closing.getByRole('button', { name: 'Kasayı kapat' }).click();
  await expect(page.getByRole('row', { name: /Ana mağaza/ })).toContainText('Kapalı');
  const closed = (await (await request.get(`/api/pos/sessions/${sessionId}`, { headers })).json())
    .session;
  expect(closed.status).toBe('closed');
  expect(closed.variance).toBe('0.00');
});
