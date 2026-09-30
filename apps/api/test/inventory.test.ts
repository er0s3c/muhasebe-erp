import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PASSWORD,
  accountIds,
  asDb,
  asOwner,
  client,
  createCompany,
  day,
  expectDbError,
  makeApp,
  orgOf,
  registerUser,
  thisYear,
} from './helpers';

describe('stok', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const warehouses = (await c.get('/api/warehouses')).json().warehouses as { id: string; code: string; isDefault: boolean }[];
    const main = warehouses.find((w) => w.isDefault)!;
    return { s, company, c, main, orgId: await orgOf(app, s.token) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];

  const mkItem = async (c: C, name: string, extra: Record<string, unknown> = {}) => {
    const res = await c.post('/api/items', { name, ...extra });
    if (res.statusCode !== 201) throw new Error(`item failed: ${res.body}`);
    return res.json().item as { id: string; code: string };
  };
  const mkWarehouse = async (c: C, name: string) => {
    const res = await c.post('/api/warehouses', { name });
    if (res.statusCode !== 201) throw new Error(`warehouse failed: ${res.body}`);
    return res.json().warehouse as { id: string; code: string };
  };
  const stock = (c: C, type: string, docDate: string, warehouseId: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
    c.post('/api/stock-documents', { type, docDate, warehouseId, lines, ...extra });
  const receipt = (c: C, date: string, wh: string, itemId: string, qty: string, unitCost: string, extra: Record<string, unknown> = {}) =>
    stock(c, 'receipt', date, wh, [{ itemId, quantity: qty, unitCost, ...extra }]);
  const issue = (c: C, date: string, wh: string, itemId: string, qty: string) =>
    stock(c, 'issue', date, wh, [{ itemId, quantity: qty }]);
  const info = async (c: C, id: string) =>
    (await c.get(`/api/items/${id}`)).json().stock as {
      qty: string;
      value: string;
      avgCost: string | null;
      isLow: boolean;
      byWarehouse: { warehouseId: string; qty: string }[];
    };
  const putRate = (c: C, date: string, code: string, buy: string) =>
    c.put('/api/exchange-rates', { rateDate: date, currencyCode: code, quoteCode: 'TRY', buy });

  /** Şirkete verilen rolde kullanıcı ekler ve onun istemcisini döndürür. */
  async function memberClient(owner: C, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Kişi`, role, password: PASSWORD, mustChangePassword: false });
    if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return client(app, login.json().accessToken as string, companyId);
  }

  it('kart: otomatik kod, kod/barkod benzersizliği, KDV kodu ve kategori doğrulaması, süzme, silme kuralı', async () => {
    const { c, main } = await setup('Kart');
    const cat = (await c.post('/api/item-categories', { name: 'Yapı malzemesi' })).json().category;
    expect((await c.post('/api/item-categories', { name: 'Yapı malzemesi' })).json().error.code).toBe('CATEGORY_NAME_TAKEN');

    const cement = await mkItem(c, 'Çimento 50 kg', {
      unit: 'cuval', barcode: '869000000001', vatCode: 'KDV-16', categoryId: cat.id, minLevel: '20',
      purchasePrice: '12.5', purchaseCurrency: 'EUR', salePrice: '15', saleCurrency: 'GBP',
    });
    const rebar = await mkItem(c, 'Nervürlü demir 12 mm', { unit: 'ton' });
    const service = await mkItem(c, 'Nakliye hizmeti', { kind: 'service' });
    expect([cement.code, rebar.code, service.code]).toEqual(['ST-000001', 'ST-000002', 'ST-000003']);

    const got = (await c.get(`/api/items/${cement.id}`)).json();
    expect(got.item).toMatchObject({
      unit: 'cuval', purchasePrice: '12.500000', purchaseCurrency: 'EUR', salePrice: '15.000000',
      saleCurrency: 'GBP', categoryName: 'Yapı malzemesi', minLevel: '20.0000',
    });

    expect((await c.post('/api/items', { name: 'Tekrar', code: 'ST-000001' })).json().error.code).toBe('ITEM_CODE_TAKEN');
    expect((await c.post('/api/items', { name: 'Aynı barkod', barcode: '869000000001' })).json().error.code).toBe('BARCODE_TAKEN');
    expect((await c.post('/api/items', { name: 'Bilinmeyen KDV', vatCode: 'KDV-99' })).json().error.code).toBe('VAT_CODE_UNKNOWN');
    expect((await c.post('/api/items', { name: 'Kategori yok', categoryId: '0198f2c4-7b1a-7000-8000-000000000001' })).json().error.code).toBe('CATEGORY_NOT_FOUND');
    expect((await c.post('/api/items', { name: 'Eksi fiyat', salePrice: '-1' })).statusCode).toBe(400);
    expect((await c.post('/api/items', { name: 'Bozuk birim', unit: 'kutu' })).statusCode).toBe(400);
    // Boş barkod birden çok kartta olabilir
    await mkItem(c, 'Barkodsuz 1');
    await mkItem(c, 'Barkodsuz 2');

    const names = async (qs: string) => (await c.get(`/api/items?${qs}`)).json().items.map((i: any) => i.name);
    expect(await names(`categoryId=${cat.id}`)).toEqual(['Çimento 50 kg']);
    expect(await names('kind=service')).toEqual(['Nakliye hizmeti']);
    expect(await names('barcode=869000000001')).toEqual(['Çimento 50 kg']);
    expect(await names('query=' + encodeURIComponent('ÇİMENTO'))).toEqual(['Çimento 50 kg']);
    expect(await names('query=demir')).toEqual(['Nervürlü demir 12 mm']);
    // Türkçe sıralama: Ç, N'den önce; hizmet kalemi de listelenir
    expect((await names('')).slice(0, 3)).toEqual(['Barkodsuz 1', 'Barkodsuz 2', 'Çimento 50 kg']);

    // Güncelleme: boş metin alanı temizler, null kritik seviyeyi ve fiyatı kaldırır
    const upd = await c.patch(`/api/items/${cement.id}`, { barcode: '', minLevel: null, salePrice: null });
    expect(upd.json().item).toMatchObject({ barcode: null, minLevel: null, salePrice: null, name: 'Çimento 50 kg' });

    // Kategori kullanımdayken silinemez
    expect((await c.delete(`/api/item-categories/${cat.id}`)).json().error.code).toBe('CATEGORY_IN_USE');

    // Hareketi olan kart silinemez ve türü değişmez; hareketsiz silinir
    expect((await receipt(c, day(3, 1), main.id, cement.id, '5', '10')).statusCode).toBe(201);
    expect((await c.delete(`/api/items/${cement.id}`)).json().error.code).toBe('ITEM_HAS_MOVEMENTS');
    expect((await c.patch(`/api/items/${cement.id}`, { kind: 'service' })).json().error.code).toBe('ITEM_KIND_IN_USE');
    expect((await c.delete(`/api/items/${service.id}`)).statusCode).toBe(200);
    expect((await c.get(`/api/items/${service.id}`)).statusCode).toBe(404);
  });

  it('hareketli ağırlıklı ortalama: 10@10 + 10@20 → ort. 15; çıkış ortalamayla; boşaltınca kuruş artığı kalmaz', async () => {
    const { c, main } = await setup('Ortalama');
    const a = await mkItem(c, 'Kum');
    expect((await receipt(c, day(3, 1), main.id, a.id, '10', '10')).statusCode).toBe(201);
    expect((await receipt(c, day(3, 2), main.id, a.id, '10', '20')).statusCode).toBe(201);
    expect(await info(c, a.id)).toMatchObject({ qty: '20.0000', value: '300.0000', avgCost: '15.0000' });

    const out = await issue(c, day(3, 3), main.id, a.id, '5');
    expect(out.statusCode).toBe(201);
    expect(out.json().lines[0]).toMatchObject({ direction: 'out', qty: '5.0000', value: '75.0000', unitCostBase: '15.0000' });
    expect(await info(c, a.id)).toMatchObject({ qty: '15.0000', value: '225.0000' });

    // Boşaltma: 3 ad / 100,00 → 33,33 + 33,34 + 33,33; toplam tam 100,00 ve kalan değer 0
    const b = await mkItem(c, 'Çivi');
    await receipt(c, day(3, 4), main.id, b.id, '3', '33.3333');
    expect((await info(c, b.id)).value).toBe('100.0000');
    const values: string[] = [];
    for (let i = 0; i < 3; i++) {
      values.push((await issue(c, day(3, 5), main.id, b.id, '1')).json().lines[0].value);
    }
    expect(values).toEqual(['33.3300', '33.3400', '33.3300']);
    expect(await info(c, b.id)).toMatchObject({ qty: '0.0000', value: '0.0000', avgCost: null });

    // Fire de ortalama maliyetle değerlenir
    const w = await stock(c, 'waste', day(3, 6), main.id, [{ itemId: a.id, quantity: '3' }], { description: 'Yağmurda bozuldu' });
    expect(w.json().lines[0].value).toBe('45.0000');
    expect(w.json().document).toMatchObject({ type: 'waste', description: 'Yağmurda bozuldu' });
  });

  it('aynı belgede aynı kartın birden çok satırı sırayla maliyetlenir ve bakiye satır satır düşer', async () => {
    const { c, main } = await setup('CokSatir');
    const a = await mkItem(c, 'Çok satırlı kart');
    const two = await stock(c, 'receipt', day(3, 1), main.id, [
      { itemId: a.id, quantity: '10', unitCost: '10' },
      { itemId: a.id, quantity: '10', unitCost: '20' },
    ]);
    expect(two.statusCode).toBe(201);
    expect(await info(c, a.id)).toMatchObject({ qty: '20.0000', value: '300.0000', avgCost: '15.0000' });

    // Toplamı bakiyeyi aşan iki satırlı çıkış reddedilir (ikinci satırda) ve hiçbir şey yazılmaz
    const over = await stock(c, 'issue', day(3, 2), main.id, [
      { itemId: a.id, quantity: '15' },
      { itemId: a.id, quantity: '10' },
    ]);
    expect(over.json().error.code).toBe('STOCK_INSUFFICIENT');
    expect(await info(c, a.id)).toMatchObject({ qty: '20.0000', value: '300.0000' });

    // 10 + 10: ilk satır ortalamayla (150), ikinci satır kalanı boşaltır (150); toplam 300
    const ok = await stock(c, 'issue', day(3, 2), main.id, [
      { itemId: a.id, quantity: '10' },
      { itemId: a.id, quantity: '10' },
    ]);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().lines.map((l: any) => l.value)).toEqual(['150.0000', '150.0000']);
    expect(await info(c, a.id)).toMatchObject({ qty: '0.0000', value: '0.0000' });
  });

  it('belge numaraları boşluksuz; reddedilen belge numara tüketmez', async () => {
    const { c, main } = await setup('Numara');
    const a = await mkItem(c, 'Tuğla');
    const n1 = (await receipt(c, day(3, 1), main.id, a.id, '10', '1')).json().document.docNo;
    expect((await issue(c, day(3, 2), main.id, a.id, '99')).statusCode).toBe(422);
    const n2 = (await issue(c, day(3, 2), main.id, a.id, '1')).json().document.docNo;
    expect([n1, n2]).toEqual([`SH-${thisYear}-000001`, `SH-${thisYear}-000002`]);
  });

  it('yetersiz stok uygulamada ve veritabanı tetikleyicisinde engellenir', async () => {
    const { c, main, s, company, orgId } = await setup('Yetersiz');
    const a = await mkItem(c, 'Boya');
    await receipt(c, day(3, 1), main.id, a.id, '4', '10');

    const res = await issue(c, day(3, 2), main.id, a.id, '5');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('STOCK_INSUFFICIENT');
    expect(res.json().error.message).toContain('4 adet var, 5 isteniyor');
    expect(await info(c, a.id)).toMatchObject({ qty: '4.0000' });

    // Uygulama atlansa bile tetikleyici reddeder (ham SQL, erp_app rolüyle)
    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      const period = (await q('select id from fiscal_periods where company_id = $1 and month = 3 and year = $2', [company.id, thisYear])).rows[0].id;
      const doc = (
        await q(
          `insert into stock_documents (id, company_id, doc_no, doc_date, period_id, type, warehouse_id)
           values (gen_random_uuid(), $1, 'RAW-1', $2, $3, 'issue', $4) returning id`,
          [company.id, day(3, 5), period, main.id],
        )
      ).rows[0].id;
      const err = await expectDbError(
        q,
        `insert into stock_movements (id, company_id, document_id, line_no, item_id, warehouse_id, movement_date, qty, value)
         values (gen_random_uuid(), $1, $2, 1, $3, $4, $5, -50, -500)`,
        [company.id, doc, a.id, main.id, day(3, 5)],
      );
      expect(err.code).toBe('ERP02');
      expect(err.message).toContain('Yetersiz stok');
    });
  });

  it('negatif stok ayarı: perakende şirketinde açık başlar; eksi çıkış son maliyetle, alış gelince maliyet düzeltmesi', async () => {
    const construction = await setup('Insaat');
    expect((await construction.c.get('/api/company')).json().company.allowNegativeStock).toBe(false);

    const { c, main } = await setup('Market', { sector: 'RETAIL_MARKET' });
    expect((await c.get('/api/company')).json().company.allowNegativeStock).toBe(true);

    const a = await mkItem(c, 'Süt 1 lt');
    await receipt(c, day(3, 1), main.id, a.id, '10', '10');
    await issue(c, day(3, 2), main.id, a.id, '10'); // bakiye 0, son maliyet 10 kalır
    const neg = await issue(c, day(3, 3), main.id, a.id, '5'); // stokta yok: son alış maliyetiyle
    expect(neg.statusCode).toBe(201);
    expect(neg.json().lines[0].value).toBe('50.0000');
    expect(await info(c, a.id)).toMatchObject({ qty: '-5.0000', value: '-50.0000', avgCost: '10.0000' });

    // Sonradan 12'den alış girilir: eksik bakiye kapanır, maliyet farkı ayrı satır olarak yazılır
    const late = await receipt(c, day(3, 4), main.id, a.id, '10', '12');
    expect(late.statusCode).toBe(201);
    expect(late.json().lines[0]).toMatchObject({ direction: 'in', value: '120.0000', adjustment: '-10.0000' });
    expect(await info(c, a.id)).toMatchObject({ qty: '5.0000', value: '60.0000', avgCost: '12.0000' });

    // Alış belgesi ters çevrilince durum tam eski haline döner (düzeltme satırı dahil)
    const rev = await c.post(`/api/stock-documents/${late.json().document.id}/reverse`, { docDate: day(3, 5) });
    expect(rev.statusCode).toBe(200);
    expect(await info(c, a.id)).toMatchObject({ qty: '-5.0000', value: '-50.0000' });

    // Ayar kapatılınca bakiyeyi aşan çıkış yeniden engellenir
    expect((await c.patch('/api/company', { allowNegativeStock: false })).json().company.allowNegativeStock).toBe(false);
    expect((await issue(c, day(3, 6), main.id, a.id, '1')).json().error.code).toBe('STOCK_INSUFFICIENT');
  });

  it('transfer: depolar arası miktar ve değer taşınır, toplam değişmez; kaynak yetersizse reddedilir', async () => {
    const { c, main } = await setup('Transfer');
    const site = await mkWarehouse(c, 'Şantiye deposu');
    expect(site.code).toBe('D-001');
    const a = await mkItem(c, 'Kablo');
    await receipt(c, day(3, 1), main.id, a.id, '10', '10');

    const tr = await stock(c, 'transfer', day(3, 2), main.id, [{ itemId: a.id, quantity: '4' }], { toWarehouseId: site.id });
    expect(tr.statusCode).toBe(201);
    expect(tr.json().lines[0]).toMatchObject({ direction: 'transfer', qty: '4.0000', value: '40.0000' });
    const s = await info(c, a.id);
    expect(s).toMatchObject({ qty: '10.0000', value: '100.0000' });
    const by = Object.fromEntries(s.byWarehouse.map((w) => [w.warehouseId, w.qty]));
    expect(by[main.id]).toBe('6.0000');
    expect(by[site.id]).toBe('4.0000');

    expect((await stock(c, 'transfer', day(3, 3), main.id, [{ itemId: a.id, quantity: '7' }], { toWarehouseId: site.id })).json().error.code).toBe('STOCK_INSUFFICIENT');
    expect((await stock(c, 'transfer', day(3, 3), main.id, [{ itemId: a.id, quantity: '1' }], { toWarehouseId: main.id })).statusCode).toBe(400);
    expect((await stock(c, 'transfer', day(3, 3), main.id, [{ itemId: a.id, quantity: '1' }])).statusCode).toBe(400);
    expect((await stock(c, 'issue', day(3, 3), main.id, [{ itemId: a.id, quantity: '1' }], { toWarehouseId: site.id })).statusCode).toBe(400);

    // Hedef depodan çıkış yapılabilir; fazlası yapılamaz
    expect((await issue(c, day(3, 4), site.id, a.id, '4')).statusCode).toBe(201);
    expect((await issue(c, day(3, 4), site.id, a.id, '1')).json().error.code).toBe('STOCK_INSUFFICIENT');

    // Depo süzgeciyle ürün listesi: miktar depoya göre, değer = miktar × ortalama
    const list = (await c.get(`/api/items?warehouseId=${main.id}`)).json().items[0];
    expect(list).toMatchObject({ onHand: '6.0000', value: '60.00' });
  });

  it('çoklu para birimi: EUR ve GBP alışları hareket günü kuruyla TL maliyete çevrilir; elle kur; kur yoksa hata', async () => {
    const { c, main } = await setup('Doviz');
    const a = await mkItem(c, 'İthal seramik');
    await putRate(c, day(3, 1), 'EUR', '50');
    await putRate(c, day(3, 1), 'GBP', '60');

    const eur = await receipt(c, day(3, 1), main.id, a.id, '10', '2', { currency: 'EUR' });
    expect(eur.statusCode).toBe(201);
    expect(eur.json().lines[0]).toMatchObject({
      currencyCode: 'EUR', unitCost: '2.000000', fxRate: '50.00000000', value: '1000.0000', unitCostBase: '100.0000',
    });

    const gbp = await receipt(c, day(3, 1), main.id, a.id, '10', '1', { currency: 'GBP' });
    expect(gbp.json().lines[0]).toMatchObject({ value: '600.0000', unitCostBase: '60.0000' });
    expect(await info(c, a.id)).toMatchObject({ qty: '20.0000', value: '1600.0000', avgCost: '80.0000' });

    // Elle kur: kayıtlı kura gerek yok, satırda saklanır
    const usd = await receipt(c, day(3, 2), main.id, a.id, '2', '10', { currency: 'USD', fxRate: '30' });
    expect(usd.json().lines[0]).toMatchObject({ currencyCode: 'USD', fxRate: '30.00000000', value: '600.0000' });
    // Kur yok
    expect((await receipt(c, day(3, 2), main.id, a.id, '2', '10', { currency: 'USD' })).json().error.code).toBe('FX_RATE_MISSING');
    // Şirket para biriminde kur 1'dir; bedelsiz (sıfır maliyetli) giriş kabul edilir
    const free = await receipt(c, day(3, 2), main.id, a.id, '1', '0');
    expect(free.statusCode).toBe(201);
    expect(free.json().lines[0]).toMatchObject({ currencyCode: 'TRY', fxRate: '1.00000000', value: '0.0000' });
    // Birim maliyet giriş belgelerinde zorunlu, çıkışta yasak
    expect((await stock(c, 'receipt', day(3, 2), main.id, [{ itemId: a.id, quantity: '1' }])).statusCode).toBe(400);
    expect((await stock(c, 'issue', day(3, 2), main.id, [{ itemId: a.id, quantity: '1', unitCost: '5' }])).statusCode).toBe(400);
  });

  it('ters belge: durumu tam geri alır; sonrasında hareket varsa, çift veya ters-tersi yapılamaz', async () => {
    const { c, main } = await setup('Ters');
    const a = await mkItem(c, 'Alçı');
    const first = (await receipt(c, day(3, 1), main.id, a.id, '10', '10')).json().document;
    const out = (await issue(c, day(3, 2), main.id, a.id, '4')).json().document;

    // Sonradan çıkış olduğu için ilk alış ters çevrilemez
    expect((await c.post(`/api/stock-documents/${first.id}/reverse`, { docDate: day(3, 3) })).json().error.code).toBe('STOCK_DOC_HAS_LATER_MOVEMENTS');

    // Son belge (çıkış) ters çevrilir → miktar ve değer eski haline döner
    const rev = await c.post(`/api/stock-documents/${out.id}/reverse`, { docDate: day(3, 3) });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().document).toMatchObject({ reversalOfId: out.id, type: 'issue' });
    expect(rev.json().document.description).toContain('Ters kayıt');
    expect(await info(c, a.id)).toMatchObject({ qty: '10.0000', value: '100.0000' });
    expect((await c.get(`/api/stock-documents/${out.id}`)).json().document.reversedById).toBe(rev.json().document.id);

    expect((await c.post(`/api/stock-documents/${out.id}/reverse`, { docDate: day(3, 3) })).json().error.code).toBe('STOCK_DOC_ALREADY_REVERSED');
    expect((await c.post(`/api/stock-documents/${rev.json().document.id}/reverse`, { docDate: day(3, 3) })).json().error.code).toBe('STOCK_DOC_IS_REVERSAL');
    // Çıkış ve ters belgesi çifti ürünün durumunu (miktar, değer) olduğu gibi bıraktı: sonradan hareket
    // sayılmaz, ilk alış yine tam geri alınır
    const back = await c.post(`/api/stock-documents/${first.id}/reverse`, { docDate: day(3, 4) });
    expect(back.statusCode).toBe(200);
    expect(await info(c, a.id)).toMatchObject({ qty: '0.0000', value: '0.0000' });

    // Ters çevrilmemiş bir hareket ise engellemeye devam eder
    const b = await mkItem(c, 'Kireç');
    const firstB = (await receipt(c, day(3, 5), main.id, b.id, '10', '10')).json().document;
    await issue(c, day(3, 6), main.id, b.id, '1');
    expect((await c.post(`/api/stock-documents/${firstB.id}/reverse`, { docDate: day(3, 7) })).json().error.code).toBe('STOCK_DOC_HAS_LATER_MOVEMENTS');
  });

  it('stok defteri değiştirilemez: tetikleyiciler (sahip rolüyle) ve yetkiler (erp_app) UPDATE/DELETE reddeder', async () => {
    const { c, main, s, company, orgId } = await setup('Degismez');
    const a = await mkItem(c, 'Kireç');
    const doc = (await receipt(c, day(3, 1), main.id, a.id, '10', '10')).json().document;

    // Tetikleyicinin kendisi: tablo sahibi bile değiştiremez
    await asOwner(async (q) => {
      for (const sql of [
        `update stock_movements set qty = 999 where document_id = '${doc.id}'`,
        `delete from stock_movements where document_id = '${doc.id}'`,
        `update stock_documents set description = 'oynandı' where id = '${doc.id}'`,
        `delete from stock_documents where id = '${doc.id}'`,
      ]) {
        const err = await expectDbError(q, sql);
        expect(err.code, sql).toBe('ERP02');
      }
    });

    // Çalışma zamanı rolü: hareket satırlarında UPDATE/DELETE yetkisi hiç yok
    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      expect((await expectDbError(q, `update stock_movements set qty = 999 where document_id = '${doc.id}'`)).code).toBe('42501');
      expect((await expectDbError(q, `delete from stock_movements where document_id = '${doc.id}'`)).code).toBe('42501');
      expect((await expectDbError(q, `delete from stock_documents where id = '${doc.id}'`)).code).toBe('42501');
      // Belge başlığında UPDATE yetkisi var (reversed_by_id için) ama tetikleyici başka alana izin vermez
      expect((await expectDbError(q, `update stock_documents set description = 'oynandı' where id = '${doc.id}'`)).code).toBe('ERP02');
    });

    // Kapalı dönem
    const march = (await c.get(`/api/periods?year=${thisYear}`)).json().periods.find((p: any) => p.month === 3);
    expect((await c.post(`/api/periods/${march.id}/close`)).statusCode).toBe(200);
    expect((await receipt(c, day(3, 10), main.id, a.id, '1', '10')).json().error.code).toBe('PERIOD_CLOSED');
    // Kapalı dönemdeki belge, açık bir tarihle ters çevrilebilir
    expect((await c.post(`/api/stock-documents/${doc.id}/reverse`, { docDate: day(4, 2) })).statusCode).toBe(200);
    // Dönem tanımsız
    expect((await receipt(c, `${thisYear + 5}-01-10`, main.id, a.id, '1', '10')).json().error.code).toBe('PERIOD_MISSING');
  });

  it('hizmet kalemi stok hareketi görmez; pasif kart ve pasif depo kullanılamaz', async () => {
    const { c, main, s, company, orgId } = await setup('Hizmet');
    const svc = await mkItem(c, 'Nakliye', { kind: 'service' });
    const a = await mkItem(c, 'Mermer');
    expect((await receipt(c, day(3, 1), main.id, svc.id, '1', '10')).json().error.code).toBe('ITEM_NOT_STOCKED');
    expect((await receipt(c, day(3, 1), main.id, '0198f2c4-7b1a-7000-8000-000000000001', '1', '10')).json().error.code).toBe('ITEM_NOT_FOUND');

    // Tetikleyici de hizmet kalemini reddeder
    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      const period = (await q('select id from fiscal_periods where company_id = $1 and month = 3 and year = $2', [company.id, thisYear])).rows[0].id;
      const doc = (
        await q(
          `insert into stock_documents (id, company_id, doc_no, doc_date, period_id, type, warehouse_id)
           values (gen_random_uuid(), $1, 'RAW-2', $2, $3, 'receipt', $4) returning id`,
          [company.id, day(3, 5), period, main.id],
        )
      ).rows[0].id;
      const err = await expectDbError(
        q,
        `insert into stock_movements (id, company_id, document_id, line_no, item_id, warehouse_id, movement_date, qty, value)
         values (gen_random_uuid(), $1, $2, 1, $3, $4, $5, 1, 10)`,
        [company.id, doc, svc.id, main.id, day(3, 5)],
      );
      expect(err.code).toBe('ERP02');
      expect(err.message).toContain('Hizmet kalemi');
    });

    await c.patch(`/api/items/${a.id}`, { isActive: false });
    expect((await receipt(c, day(3, 1), main.id, a.id, '1', '10')).json().error.code).toBe('ITEM_INACTIVE');
    await c.patch(`/api/items/${a.id}`, { isActive: true });
    const w2 = await mkWarehouse(c, 'Eski depo');
    await c.patch(`/api/warehouses/${w2.id}`, { isActive: false });
    expect((await receipt(c, day(3, 1), w2.id, a.id, '1', '10')).json().error.code).toBe('WAREHOUSE_INACTIVE');
  });

  it('depolar: varsayılan depo tek ve değişebilir; stoklu/hareketli depo pasifleşmez veya silinmez', async () => {
    const { c, main } = await setup('Depo');
    expect(main.code).toBe('ANA');
    const b = await mkWarehouse(c, 'Yedek depo');
    expect((await c.post('/api/warehouses', { name: 'Yedek', code: 'ANA' })).json().error.code).toBe('WAREHOUSE_CODE_TAKEN');
    const list = async () => (await c.get('/api/warehouses')).json().warehouses as any[];
    expect((await list()).filter((w) => w.isDefault).map((w) => w.code)).toEqual(['ANA']);

    expect((await c.patch(`/api/warehouses/${main.id}`, { isActive: false })).json().error.code).toBe('WAREHOUSE_IS_DEFAULT');
    expect((await c.delete(`/api/warehouses/${main.id}`)).json().error.code).toBe('WAREHOUSE_IS_DEFAULT');
    expect((await c.patch(`/api/warehouses/${b.id}`, { isDefault: true })).statusCode).toBe(200);
    expect((await list()).filter((w) => w.isDefault).map((w) => w.code)).toEqual([b.code]);

    const a = await mkItem(c, 'Fayans');
    await receipt(c, day(3, 1), main.id, a.id, '5', '10');
    expect((await c.patch(`/api/warehouses/${main.id}`, { isActive: false })).json().error.code).toBe('WAREHOUSE_HAS_STOCK');
    expect((await c.delete(`/api/warehouses/${main.id}`)).json().error.code).toBe('WAREHOUSE_HAS_MOVEMENTS');
    // Boşaltılınca pasifleştirilebilir
    await issue(c, day(3, 2), main.id, a.id, '5');
    expect((await c.patch(`/api/warehouses/${main.id}`, { isActive: false })).statusCode).toBe(200);
    // Hareketsiz depo silinir
    const tmp = await mkWarehouse(c, 'Geçici');
    expect((await c.delete(`/api/warehouses/${tmp.id}`)).statusCode).toBe(200);
  });

  it('sayım: fazla ortalama maliyetle giriş, eksik çıkış; sayılmayan satır atlanır; işlenen sayım değişmez', async () => {
    const { c, main, s, company, orgId } = await setup('Sayim');
    const A = await mkItem(c, 'Ürün A');
    const B = await mkItem(c, 'Ürün B');
    const C = await mkItem(c, 'Ürün C');
    const D = await mkItem(c, 'Ürün D'); // depoda hiç stok yok
    await receipt(c, day(3, 1), main.id, A.id, '10', '10');
    await receipt(c, day(3, 1), main.id, B.id, '10', '20');
    await receipt(c, day(3, 1), main.id, C.id, '5', '4');

    const created = await c.post('/api/stock-counts', { warehouseId: main.id, countDate: day(3, 10), description: 'Mart sayımı' });
    expect(created.statusCode).toBe(201);
    const count = created.json();
    expect(count.count).toMatchObject({ status: 'draft', countNo: null });
    expect(count.lines.map((l: any) => [l.itemCode, l.systemQty, l.countedQty])).toEqual([
      [A.code, '10.0000', null],
      [B.code, '10.0000', null],
      [C.code, '5.0000', null],
    ]);

    // Boş sayım işlenemez
    expect((await c.post(`/api/stock-counts/${count.count.id}/post`)).json().error.code).toBe('COUNT_EMPTY');

    // Aynı kart iki kez girilemez
    expect(
      (await c.put(`/api/stock-counts/${count.count.id}`, { lines: [{ itemId: A.id, countedQty: '1' }, { itemId: A.id, countedQty: '2' }] })).json().error.code,
    ).toBe('COUNT_DUPLICATE_ITEM');
    const upd = await c.put(`/api/stock-counts/${count.count.id}`, {
      lines: [
        { itemId: A.id, countedQty: '12' },
        { itemId: B.id, countedQty: '7' },
        { itemId: C.id, countedQty: '5' },
        { itemId: D.id, countedQty: null },
      ],
    });
    expect(upd.statusCode).toBe(200);
    const byCode = Object.fromEntries(upd.json().lines.map((l: any) => [l.itemCode, l]));
    expect(byCode[A.code]).toMatchObject({ systemQty: '10.0000', diffQty: '2.0000' });
    expect(byCode[B.code]).toMatchObject({ diffQty: '-3.0000' });
    expect(byCode[C.code]).toMatchObject({ diffQty: '0.0000' });
    expect(byCode[D.code]).toMatchObject({ countedQty: null, diffQty: null });
    expect(upd.json().summary).toMatchObject({ lines: 4, counted: 3, uncounted: 1, surplus: 1, shortage: 1 });

    const posted = await c.post(`/api/stock-counts/${count.count.id}/post`);
    expect(posted.statusCode).toBe(200);
    const p = posted.json();
    expect(p.count).toMatchObject({ status: 'posted', countNo: `SY-${thisYear}-000001` });
    expect(p.count.documentId).toBeTruthy();
    expect(p.warnings.zeroCostItems).toEqual([]);

    const doc = (await c.get(`/api/stock-documents/${p.count.documentId}`)).json();
    expect(doc.document.type).toBe('count');
    const lines = Object.fromEntries(doc.lines.map((l: any) => [l.itemCode, l]));
    expect(lines[A.code]).toMatchObject({ direction: 'in', qty: '2.0000', value: '20.0000' }); // 2 ad × ort. 10
    expect(lines[B.code]).toMatchObject({ direction: 'out', qty: '3.0000', value: '60.0000' }); // 3 ad × ort. 20
    expect(lines[C.code]).toBeUndefined();
    expect(await info(c, A.id)).toMatchObject({ qty: '12.0000', value: '120.0000' });
    expect(await info(c, B.id)).toMatchObject({ qty: '7.0000', value: '140.0000' });
    expect(await info(c, D.id)).toMatchObject({ qty: '0.0000' });

    // İşlenen sayım değişmez ve silinemez (uygulama ve veritabanı)
    expect((await c.put(`/api/stock-counts/${count.count.id}`, { description: 'x' })).json().error.code).toBe('COUNT_NOT_DRAFT');
    expect((await c.delete(`/api/stock-counts/${count.count.id}`)).json().error.code).toBe('COUNT_NOT_DRAFT');
    expect((await c.post(`/api/stock-counts/${count.count.id}/post`)).json().error.code).toBe('COUNT_NOT_DRAFT');
    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      expect((await expectDbError(q, `update stock_counts set description = 'oynandı' where id = '${count.count.id}'`)).code).toBe('ERP02');
      expect((await expectDbError(q, `update stock_count_lines set counted_qty = 99 where count_id = '${count.count.id}'`)).code).toBe('ERP02');
      expect((await expectDbError(q, `delete from stock_counts where id = '${count.count.id}'`)).code).toBe('ERP02');
    });

    // Taslak silinebilir; maliyeti bilinmeyen kartın fazlası uyarı üretir
    const d2 = (await c.post('/api/stock-counts', { warehouseId: main.id, countDate: day(3, 11), prefill: 'empty' })).json();
    expect(d2.lines).toEqual([]);
    expect((await c.delete(`/api/stock-counts/${d2.count.id}`)).statusCode).toBe(200);
    const d3 = (await c.post('/api/stock-counts', { warehouseId: main.id, countDate: day(3, 12), prefill: 'empty' })).json();
    await c.put(`/api/stock-counts/${d3.count.id}`, { lines: [{ itemId: D.id, countedQty: '3' }] });
    const post3 = (await c.post(`/api/stock-counts/${d3.count.id}/post`)).json();
    expect(post3.warnings.zeroCostItems).toEqual([D.code]);
    expect(await info(c, D.id)).toMatchObject({ qty: '3.0000', value: '0.0000' });

    // Fark yoksa belge üretilmez ama sayım kaydedilir
    const d4 = (await c.post('/api/stock-counts', { warehouseId: main.id, countDate: day(3, 13), prefill: 'empty' })).json();
    await c.put(`/api/stock-counts/${d4.count.id}`, { lines: [{ itemId: C.id, countedQty: '5' }] });
    const post4 = (await c.post(`/api/stock-counts/${d4.count.id}/post`)).json();
    expect(post4.count).toMatchObject({ status: 'posted', documentId: null });
  });

  it('stok durumu: tarih anı, kritik seviye, depo süzgeci, raporlama karşılığı ve muhasebe mutabakatı', async () => {
    const { c, main, s, company } = await setup('Rapor');
    const site = await mkWarehouse(c, 'Şantiye');
    const a = await mkItem(c, 'Çimento', { minLevel: '5' });
    const b = await mkItem(c, 'Demir', { minLevel: '100' });
    await mkItem(c, 'Hiç hareket görmemiş');
    await receipt(c, day(3, 1), main.id, a.id, '10', '10');
    await receipt(c, day(3, 1), main.id, b.id, '20', '10');
    await stock(c, 'transfer', day(3, 2), main.id, [{ itemId: a.id, quantity: '4' }], { toWarehouseId: site.id });
    await issue(c, day(3, 20), main.id, a.id, '5');

    const report = async (qs: string) => (await c.get(`/api/reports/stock-status?${qs}`)).json();
    const rowOf = (r: any, name: string) => r.rows.find((x: any) => x.name === name);

    // 10 Mart itibarıyla çıkış henüz olmamış
    const early = await report(`asOf=${day(3, 10)}`);
    expect(rowOf(early, 'Çimento')).toMatchObject({ onHand: '10.0000', value: '100.0000', avgCost: '10.0000', isLow: false });
    expect(early.rows.map((r: any) => r.name)).toEqual(['Çimento', 'Demir']); // hareketsiz kart gizlenir
    expect(early.totals).toMatchObject({ itemCount: 2, value: '300.0000', lowCount: 1 }); // Demir: 20 ≤ 100

    // 31 Mart itibarıyla: çıkıştan sonra 5 ad kaldı → kritik seviyede (≤ 5)
    const late = await report(`asOf=${day(3, 31)}`);
    expect(rowOf(late, 'Çimento')).toMatchObject({ onHand: '5.0000', value: '50.0000', isLow: true });
    expect(late.totals).toMatchObject({ value: '250.0000', lowCount: 2 });

    expect((await report(`asOf=${day(3, 31)}&lowOnly=true`)).rows).toHaveLength(2);
    expect((await report(`asOf=${day(3, 31)}&includeZero=true`)).rows).toHaveLength(3);
    expect((await report(`asOf=${day(3, 31)}&query=demir`)).rows.map((r: any) => r.name)).toEqual(['Demir']);

    // Şantiye deposunda 4 ad; değer = 4 × ortalama (10). Kritik kart depoda 0 olsa da görünür.
    const wh = await report(`asOf=${day(3, 31)}&warehouseId=${site.id}`);
    expect(rowOf(wh, 'Çimento')).toMatchObject({ onHand: '4.0000', value: '40.0000' });
    expect(rowOf(wh, 'Demir')).toMatchObject({ onHand: '0.0000', value: '0.0000', isLow: true });
    expect(wh.ledger).toBeNull();

    // Raporlama para birimi karşılığı: GBP kuru girilince toplam / 50
    expect(late.totals.reportingValue).toBeNull();
    await putRate(c, day(3, 25), 'GBP', '50');
    expect((await report(`asOf=${day(3, 31)}`)).totals).toMatchObject({ reportingCurrency: 'GBP', reportingValue: '5.0000' });

    // Muhasebe mutabakatı: elle girilen stok belgeleri otomatik yevmiye ürettiği için stok defteri
    // ile 150–157 hesap bakiyesi baştan tutar (fark 0).
    expect((await report(`asOf=${day(3, 31)}`)).ledger).toMatchObject({ accountsBalance: '250.0000', stockValue: '250.0000', difference: '0.0000' });
    // Girişler 1 Mart'ta: 10 Mart itibarıyla hesap bakiyesi 300, çıkış (20 Mart) henüz yok
    expect((await report(`asOf=${day(3, 10)}`)).ledger).toMatchObject({ accountsBalance: '300.0000', stockValue: '300.0000', difference: '0.0000' });

    // Stok hesabına elle yevmiye ile 200 borç yazılırsa fark görünür: 250 − 450 = −200
    const ids = await accountIds(app, s.token, company.id);
    const je = await c.post('/api/journal-entries', {
      entryDate: day(3, 15),
      description: 'Stok hesabına elle kayıt',
      lines: [
        { accountId: ids['150']!, currency: 'TRY', debit: '200' },
        { accountId: ids['100']!, currency: 'TRY', credit: '200' },
      ],
      post: true,
    });
    expect(je.statusCode).toBe(201);
    expect((await report(`asOf=${day(3, 31)}`)).ledger).toMatchObject({ accountsBalance: '450.0000', stockValue: '250.0000', difference: '-200.0000' });

    // Genel bakış özeti
    const summary = (await c.get('/api/inventory/summary')).json();
    expect(summary).toMatchObject({ itemCount: 3, stockValue: '250.0000', lowCount: 2 });
  });

  it('stok kartı ekstresi: dönem başı bakiye ve yürüyen miktar/değer', async () => {
    const { c, main } = await setup('Ekstre');
    const site = await mkWarehouse(c, 'Ek depo');
    const a = await mkItem(c, 'Ekstre kalemi');
    await receipt(c, day(3, 1), main.id, a.id, '10', '10');
    await issue(c, day(3, 5), main.id, a.id, '4');
    await receipt(c, day(3, 8), site.id, a.id, '2', '20');

    const st = (await c.get(`/api/items/${a.id}/movements?from=${day(3, 4)}&to=${day(3, 31)}`)).json();
    expect(st).toMatchObject({ openingQty: '10.0000', openingValue: '100.0000', closingQty: '8.0000', closingValue: '100.0000' });
    expect(st.lines.map((l: any) => [l.type, l.qty, l.balanceQty, l.balanceValue])).toEqual([
      ['issue', '-4.0000', '6.0000', '60.0000'],
      ['receipt', '2.0000', '8.0000', '100.0000'],
    ]);

    // Depo süzgecinde yalnızca miktar yürür (depo bazında değer tutulmaz)
    const wh = (await c.get(`/api/items/${a.id}/movements?from=${day(3, 1)}&to=${day(3, 31)}&warehouseId=${main.id}`)).json();
    expect(wh).toMatchObject({ closingQty: '6.0000', closingValue: null });
  });

  it('yetkiler: izleyici okur; satış kart açar ama hareket giremez; şantiye sorumlusu hareket girer ama kart açamaz', async () => {
    const { c, company, main } = await setup('Yetki');
    const a = await mkItem(c, 'Malzeme');
    await receipt(c, day(3, 1), main.id, a.id, '10', '10');
    const viewer = await memberClient(c, company.id, 'viewer');
    const sales = await memberClient(c, company.id, 'sales');
    const site = await memberClient(c, company.id, 'site_manager');

    const line = [{ itemId: a.id, quantity: '1' }];
    // İzleyici
    expect((await viewer.get('/api/items')).statusCode).toBe(200);
    expect((await viewer.get(`/api/reports/stock-status?asOf=${day(3, 31)}`)).statusCode).toBe(200);
    expect((await viewer.post('/api/items', { name: 'Yetkisiz' })).statusCode).toBe(403);
    expect((await viewer.post('/api/warehouses', { name: 'Yetkisiz' })).statusCode).toBe(403);
    expect((await stock(viewer, 'issue', day(3, 2), main.id, line)).statusCode).toBe(403);
    // Satış temsilcisi
    expect((await sales.post('/api/items', { name: 'Satışın kartı' })).statusCode).toBe(201);
    expect((await stock(sales, 'issue', day(3, 2), main.id, line)).statusCode).toBe(403);
    expect((await sales.post('/api/stock-counts', { warehouseId: main.id, countDate: day(3, 2) })).statusCode).toBe(403);
    // Şantiye sorumlusu: sarf ve sayım girer, kart açamaz, şirket ayarını değiştiremez
    expect((await stock(site, 'issue', day(3, 2), main.id, line)).statusCode).toBe(201);
    expect((await site.post('/api/stock-counts', { warehouseId: main.id, countDate: day(3, 2) })).statusCode).toBe(201);
    expect((await site.post('/api/items', { name: 'Şantiyenin kartı' })).statusCode).toBe(403);
    expect((await site.patch('/api/company', { allowNegativeStock: true })).statusCode).toBe(403);
    const keys = (await site.get('/api/navigation')).json().groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(keys).toEqual(expect.arrayContaining(['items', 'stock-status', 'stock-movements', 'stock-counts', 'warehouses']));
  });

  it('kiracı yalıtımı: başka şirketin kartı/deposuna erişilemez veya bağlanılamaz (RLS + bileşik yabancı anahtar)', async () => {
    const A = await setup('KiraciA');
    const B = await setup('KiraciB');
    const cat = (await A.c.post('/api/item-categories', { name: 'Gizli' })).json().category;
    const itemA = await mkItem(A.c, 'A firmasının kartı');
    await receipt(A.c, day(3, 1), A.main.id, itemA.id, '5', '10');

    expect((await B.c.get('/api/items')).json().items).toEqual([]);
    expect((await B.c.get(`/api/items/${itemA.id}`)).statusCode).toBe(404);
    expect((await B.c.get('/api/stock-documents')).json().documents).toEqual([]);
    expect((await B.c.get('/api/item-categories')).json().categories).toEqual([]);
    expect((await receipt(B.c, day(3, 1), B.main.id, itemA.id, '1', '1')).json().error.code).toBe('ITEM_NOT_FOUND');
    const itemB = await mkItem(B.c, 'B firmasının kartı');
    expect((await receipt(B.c, day(3, 1), A.main.id, itemB.id, '1', '1')).json().error.code).toBe('WAREHOUSE_NOT_FOUND');
    expect((await B.c.post('/api/stock-counts', { warehouseId: A.main.id, countDate: day(3, 1) })).json().error.code).toBe('WAREHOUSE_NOT_FOUND');
    expect((await B.c.post('/api/items', { name: 'Yabancı kategori', categoryId: cat.id })).json().error.code).toBe('CATEGORY_NOT_FOUND');
    // Yetkili olmadığı şirketin başlığıyla istek
    expect((await client(app, B.s.token, A.company.id).get('/api/items')).statusCode).toBe(403);

    // Ham SQL: RLS satırları gizler; bileşik yabancı anahtar başka şirketin kaydına bağlanmayı engeller
    await asDb(handle, { userId: B.s.userId, orgId: B.orgId, companyId: B.company.id }, async (q) => {
      expect((await q('select count(*)::int as n from stock_movements')).rows[0].n).toBe(0);
      expect((await q('select count(*)::int as n from items')).rows[0].n).toBe(1);
      const err = await expectDbError(
        q,
        `insert into items (id, company_id, code, name, category_id) values (gen_random_uuid(), $1, 'X-1', 'x', $2)`,
        [B.company.id, cat.id],
      );
      expect(err.code).toBe('23503');
    });
  });

  it('eşzamanlılık: aynı ürüne paralel iki çıkıştan yalnızca biri başarılı olur; numaralar boşluksuz kalır', async () => {
    const { c, main } = await setup('Paralel');
    const a = await mkItem(c, 'Yarış kalemi');
    await receipt(c, day(3, 1), main.id, a.id, '10', '10');

    for (let round = 0; round < 5; round++) {
      const results = await Promise.all([issue(c, day(3, 2), main.id, a.id, '6'), issue(c, day(3, 2), main.id, a.id, '6')]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
      expect(results.find((r) => r.statusCode === 422)!.json().error.code).toBe('STOCK_INSUFFICIENT');
      const s = await info(c, a.id);
      expect(s).toMatchObject({ qty: '4.0000', value: '40.0000' });
      await receipt(c, day(3, 2), main.id, a.id, '6', '10'); // tekrar 10'a tamamla
    }
    // Paralel girişler de doğru toplanır
    await Promise.all(Array.from({ length: 6 }, () => receipt(c, day(3, 3), main.id, a.id, '1', '10')));
    expect(await info(c, a.id)).toMatchObject({ qty: '16.0000', value: '160.0000' });

    const nos = (await c.get('/api/stock-documents?limit=500')).json().documents.map((d: any) => Number(d.docNo.split('-')[2]));
    expect(nos.sort((x: number, y: number) => x - y)).toEqual(Array.from({ length: nos.length }, (_, i) => i + 1));
  });

  it('stok belgesi listesi: tür, tarih, ürün ve depo süzgeçleri', async () => {
    const { c, main } = await setup('Liste');
    const site = await mkWarehouse(c, 'Depo 2');
    const a = await mkItem(c, 'Liste A');
    const b = await mkItem(c, 'Liste B');
    await receipt(c, day(3, 1), main.id, a.id, '10', '10');
    await receipt(c, day(3, 2), main.id, b.id, '10', '5');
    await stock(c, 'transfer', day(3, 3), main.id, [{ itemId: a.id, quantity: '2' }], { toWarehouseId: site.id });
    await issue(c, day(3, 4), site.id, a.id, '1');

    const count = async (qs: string) => (await c.get(`/api/stock-documents?${qs}`)).json().documents.length;
    expect(await count('')).toBe(4);
    expect(await count('type=receipt')).toBe(2);
    expect(await count(`itemId=${b.id}`)).toBe(1);
    expect(await count(`warehouseId=${site.id}`)).toBe(2); // transfer (hedef) + çıkış
    expect(await count(`from=${day(3, 3)}&to=${day(3, 4)}`)).toBe(2);
    const first = (await c.get('/api/stock-documents')).json().documents[0];
    expect(first).toMatchObject({ type: 'issue', lineCount: 1, totalValue: '10.0000' });
    expect((await c.get('/api/stock-documents?type=bozuk')).statusCode).toBe(400);
  });
});
