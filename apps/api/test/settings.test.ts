import { describe, expect, it } from 'vitest';
import { client, createCompany, day, makeApp, registerUser, thisYear } from './helpers';

describe('ayarlar: kur, KDV, dönem, özel kod', async () => {
  const { app } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    return { s, company, c: client(app, s.token, company.id) };
  }

  const rate = (currencyCode: string, quoteCode: string, buy: string, rateDate: string) => ({
    rateDate, currencyCode, quoteCode, buy,
  });

  it('kur girilir, aynı gün için güncellenir ve tarihine göre aranır', async () => {
    const { c } = await setup('Kur');
    expect((await c.put('/api/exchange-rates', rate('GBP', 'TRY', '40.5', day(3, 10)))).statusCode).toBe(200);
    // Aynı gün/çift: güncelleme (yinelenen kayıt oluşmaz)
    await c.put('/api/exchange-rates', rate('GBP', 'TRY', '41.25', day(3, 10)));
    const list = (await c.get('/api/exchange-rates?currency=GBP')).json().rates;
    expect(list).toHaveLength(1);
    expect(list[0].buy).toBe('41.25000000');
    expect(list[0].sell).toBe('41.25000000');

    const lookup = async (from: string, to: string, date: string) =>
      (await c.get(`/api/exchange-rates/lookup?from=${from}&to=${to}&date=${date}`)).json().rate;
    expect(await lookup('GBP', 'TRY', day(3, 10))).toBe('41.25000000');
    // Hafta sonu/bayram: tolerans süresi içinde son kur geçerli
    expect(await lookup('GBP', 'TRY', day(3, 15))).toBe('41.25000000');
    // Tolerans (10 gün) aşıldı
    expect(await lookup('GBP', 'TRY', day(3, 25))).toBeNull();
    // Kurdan önceki tarih
    expect(await lookup('GBP', 'TRY', day(3, 9))).toBeNull();
    // Aynı para birimi
    expect(await lookup('TRY', 'TRY', day(3, 10))).toBe('1.00000000');
  });

  it('ters ve üçgen kur hesaplanır (GBP→EUR, TRY üzerinden)', async () => {
    const { c } = await setup('Uclu');
    await c.put('/api/exchange-rates', rate('GBP', 'TRY', '40', day(4, 1)));
    await c.put('/api/exchange-rates', rate('EUR', 'TRY', '35', day(4, 1)));
    const get = async (from: string, to: string) =>
      (await c.get(`/api/exchange-rates/lookup?from=${from}&to=${to}&date=${day(4, 1)}`)).json().rate;
    expect(await get('TRY', 'GBP')).toBe('0.02500000');
    expect(Number(await get('GBP', 'EUR'))).toBeCloseTo(40 / 35, 6);
    expect(Number(await get('EUR', 'GBP'))).toBeCloseTo(35 / 40, 6);
  });

  it('geçersiz kurlar reddedilir; yetkisiz rol kur giremez', async () => {
    const { c, company } = await setup('KurHata');
    expect((await c.put('/api/exchange-rates', rate('GBP', 'TRY', '0', day(4, 1)))).statusCode).toBe(400);
    expect((await c.put('/api/exchange-rates', rate('GBP', 'GBP', '1', day(4, 1)))).statusCode).toBe(400);
    expect((await c.put('/api/exchange-rates', rate('GBP', 'TRY', 'abc', day(4, 1)))).statusCode).toBe(400);

    await c.post('/api/company/members', { email: 'viewer-kur@example.com', fullName: 'İzleyici', role: 'viewer', password: 'Izleyici-12345' });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'viewer-kur@example.com', password: 'Izleyici-12345' } })).json().accessToken;
    expect((await client(app, tok, company.id).put('/api/exchange-rates', rate('GBP', 'TRY', '40', day(4, 1)))).statusCode).toBe(403);
  });

  it('KDV oranı eklenir, doğrulanır, silinir', async () => {
    const { c } = await setup('Kdv');
    const created = await c.post('/api/tax-rates', {
      code: 'KDV-20', name: 'Deneme Oran', rate: '20', validFrom: '2027-01-01',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().taxRate.id;
    expect(created.json().taxRate.verifiedAt).toBeNull();

    const verified = await c.post(`/api/tax-rates/${id}/verify`, { verifiedBy: 'Mali Müşavir A.', sourceNote: 'Resmi Gazete' });
    expect(verified.json().taxRate).toMatchObject({ verifiedBy: 'Mali Müşavir A.', sourceNote: 'Resmi Gazete' });
    expect(verified.json().taxRate.verifiedAt).not.toBeNull();

    // Aynı kod + geçerlilik başı yinelenemez
    expect((await c.post('/api/tax-rates', { code: 'KDV-20', name: 'Yinelenen', rate: '20', validFrom: '2027-01-01' })).statusCode).toBe(409);
    // Oran %100'ü aşamaz
    expect((await c.post('/api/tax-rates', { code: 'KDV-X', name: 'Aşan oran', rate: '101', validFrom: '2027-01-01' })).statusCode).toBe(400);

    expect((await c.delete(`/api/tax-rates/${id}`)).statusCode).toBe(200);
    expect((await c.delete(`/api/tax-rates/${id}`)).statusCode).toBe(404);
  });

  it('yeni yılın dönemleri üretilir; yinelenmez', async () => {
    const { c } = await setup('Donem');
    const y = thisYear + 1;
    const res = await c.post('/api/periods/generate', { year: y });
    expect(res.json().periods).toHaveLength(12);
    const feb = res.json().periods.find((p: any) => p.month === 2);
    expect(feb.startDate).toBe(`${y}-02-01`);
    expect(['28', '29']).toContain(feb.endDate.slice(8));
    await c.post('/api/periods/generate', { year: y });
    expect((await c.get(`/api/periods?year=${y}`)).json().periods).toHaveLength(12);
    const years = (await c.get('/api/periods/years')).json().years;
    expect(years).toEqual([y, thisYear]);
  });

  it('özel kodlar: ekle, listele, yinelenemez, sil', async () => {
    const { c } = await setup('Kod');
    const a = await c.post('/api/custom-codes', { scope: 'account', code: 'A1', name: 'Şantiye Giderleri' });
    expect(a.statusCode).toBe(201);
    expect((await c.post('/api/custom-codes', { scope: 'account', code: 'A1', name: 'Yinelenen' })).statusCode).toBe(409);
    await c.post('/api/custom-codes', { scope: 'party', code: 'A1', name: 'Aynı kod farklı kapsam' });
    expect((await c.get('/api/custom-codes?scope=account')).json().customCodes).toHaveLength(1);
    expect((await c.get('/api/custom-codes')).json().customCodes).toHaveLength(2);
    expect((await c.delete(`/api/custom-codes/${a.json().customCode.id}`)).statusCode).toBe(200);
  });

  it('kur ve KDV ayarları şirketler arasında yalıtılır', async () => {
    const one = await setup('YalitA');
    const two = await setup('YalitB');
    await one.c.put('/api/exchange-rates', rate('GBP', 'TRY', '40', day(5, 1)));
    expect((await two.c.get('/api/exchange-rates')).json().rates).toHaveLength(0);
    const lookup = await two.c.get(`/api/exchange-rates/lookup?from=GBP&to=TRY&date=${day(5, 1)}`);
    expect(lookup.json().rate).toBeNull();
  });
});
