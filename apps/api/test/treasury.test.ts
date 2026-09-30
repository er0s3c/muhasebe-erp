import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PASSWORD, accountIds, asDb, asOwner, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';

describe('kasa ve banka', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, ids, orgId: await orgOf(app, s.token) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];

  const mkParty = async (c: C, name: string, kind = 'customer') => {
    const res = await c.post('/api/parties', { name, kind });
    if (res.statusCode !== 201) throw new Error(`party failed: ${res.body}`);
    return res.json().party as { id: string };
  };
  const mkAccount = async (c: C, kind: 'cash' | 'bank', name: string, currency = 'TRY', extra: Record<string, unknown> = {}) => {
    const res = await c.post('/api/treasury/accounts', { kind, name, currency, ...extra });
    if (res.statusCode !== 201) throw new Error(`account failed: ${res.body}`);
    return res.json().account as { id: string; accountId: string; accountCode: string; balance: string; balanceBase: string };
  };
  /** Satış (alacak) faturası; dövizliyse `fx` kuruyla. */
  const saleInvoice = async (c: C, partyId: string, amount: string, date: string, currency = 'TRY', fx?: string) => {
    const res = await c.post('/api/invoices', {
      post: true, type: 'sales', partyId, invoiceDate: date, currency, ...(fx ? { fxRate: fx } : {}),
      lines: [{ description: 'Hizmet', quantity: '1', unitPrice: amount }],
    });
    if (res.statusCode !== 201) throw new Error(`invoice failed: ${res.body}`);
    return res.json() as { invoice: { id: string } };
  };
  /** Gider (borç) faturası. */
  const expenseInvoice = async (c: C, partyId: string, amount: string, date: string, no: string, currency = 'TRY', fx?: string) => {
    const res = await c.post('/api/invoices', {
      post: true, type: 'expense', partyId, invoiceDate: date, externalNo: no, currency, ...(fx ? { fxRate: fx } : {}),
      lines: [{ description: 'Gider', quantity: '1', unitPrice: amount }],
    });
    if (res.statusCode !== 201) throw new Error(`expense failed: ${res.body}`);
    return res.json();
  };
  const open = async (c: C, partyId: string, type: 'receivable' | 'payable' = 'receivable') =>
    (await c.get(`/api/parties/${partyId}/open-items?asOf=${day(12, 31)}&type=${type}`)).json()[type] as {
      items: { lineId: string; amount: string; remaining: string; remainingBase: string; currencyCode: string }[];
      unapplied: string;
    };
  const txn = (c: C, body: Record<string, unknown>) => c.post('/api/treasury/transactions', body);
  const posted = async (c: C, body: Record<string, unknown>) => {
    const res = await txn(c, body);
    if (res.statusCode !== 201) throw new Error(`txn failed: ${res.body}`);
    return res.json() as { transaction: any; allocations: any[]; fxNet: string };
  };
  const journal = async (c: C, id: string) => {
    const e = (await c.get(`/api/journal-entries/${id}`)).json().entry;
    const lines = e.lines.map((l: any) => ({ code: l.accountCode as string, d: Number(l.debit), c: Number(l.credit), db: Number(l.debitBase), cb: Number(l.creditBase) }));
    return { entry: e, lines, of: (code: string) => lines.filter((l: any) => l.code === code) as { code: string; d: number; c: number; db: number; cb: number }[] };
  };
  const closing = async (c: C) => {
    const tb = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    return (code: string) => Number(Object.fromEntries(tb.rows.map((r: any) => [r.code, r.closing]))[code] ?? 0);
  };
  const balanceOf = async (c: C, id: string) => (await c.get(`/api/treasury/accounts/${id}`)).json().account as { balance: string; balanceBase: string; equivalent: string | null };
  /** Hesaba sermaye girişi (diğer tahsilat): kasa/banka bakiyesi hazırlar. */
  const fund = (c: C, ids: Record<string, string>, accountId: string, amount: string, fxRate?: string, date = day(2, 1)) =>
    posted(c, { type: 'other_receipt', date, accountId, amount, glAccountId: ids['500'], ...(fxRate ? { fxRate } : {}) });

  async function memberClient(owner: C, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Kişi`, role, password: PASSWORD, mustChangePassword: false });
    if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return client(app, login.json().accessToken as string, companyId);
  }

  it('hesap açma: yeni alt hesap, dövizli hesap, mevcut hesaba bağlama, kurallar', async () => {
    const { c, ids } = await setup('Hesap');
    const cash = await mkAccount(c, 'cash', 'Ana kasa');
    expect(cash).toMatchObject({ kind: 'cash', accountCode: '100.001', currencyCode: 'TRY', balance: '0.0000', equivalent: '0.0000', isActive: true });
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD', { bankName: 'KTB', iban: 'TR000000000000000000000001' });
    expect(usd).toMatchObject({ accountCode: '102.001', currencyCode: 'USD', bankName: 'KTB' });
    const glList = (await c.get('/api/accounts')).json().accounts as any[];
    expect(glList.find((a) => a.code === '102.001')).toMatchObject({ currencyCode: 'USD', isPostable: true });
    expect(glList.find((a) => a.code === '100.001').currencyCode).toBeNull();

    // Aynı ad tekrar açılamaz; mevcut hesaba bağlama denetlenir
    const dup = await c.post('/api/treasury/accounts', { kind: 'cash', name: 'Ana kasa', currency: 'TRY' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('TREASURY_ACCOUNT_NAME_TAKEN');
    const manual = await c.post('/api/accounts', { code: '102.050', name: 'Eski banka hesabı' });
    expect(manual.statusCode).toBe(201);
    const linked = await mkAccount(c, 'bank', 'Eski banka', 'TRY', { linkAccountId: manual.json().account.id });
    expect(linked.accountCode).toBe('102.050');
    expect((await c.post('/api/treasury/accounts', { kind: 'bank', name: 'Yanlış grup', currency: 'TRY', linkAccountId: ids['120'] })).json().error.code).toBe('TREASURY_ACCOUNT_GROUP');
    expect((await c.post('/api/treasury/accounts', { kind: 'bank', name: 'Kur uyumsuz', currency: 'TRY', linkAccountId: usd.accountId })).json().error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');
    const again = await c.post('/api/treasury/accounts', { kind: 'bank', name: 'İkinci bağ', currency: 'USD', linkAccountId: usd.accountId });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TREASURY_ACCOUNT_LINKED');

    // Güncelleme: ad ve banka bilgisi; pasif hesapta hareket yapılamaz
    const patched = await c.patch(`/api/treasury/accounts/${cash.id}`, { name: 'Merkez kasa', isActive: false });
    expect(patched.json().account).toMatchObject({ name: 'Merkez kasa', isActive: false });
    const res = await txn(c, { type: 'other_receipt', date: day(3, 1), accountId: cash.id, amount: '10', glAccountId: ids['500'] });
    expect(res.json().error.code).toBe('TREASURY_ACCOUNT_INACTIVE');
    expect((await c.get('/api/treasury/accounts')).json().accounts).toHaveLength(3);
  });

  it('hareket görmüş 102 hesabının altına alt hesap açılamaz; hesaba bağlanarak kullanılır', async () => {
    const { c, ids } = await setup('Hareketli');
    const j = await c.post('/api/journal-entries', {
      entryDate: day(1, 5), description: 'Açılış', post: true,
      lines: [{ accountId: ids['102'], currency: 'TRY', debit: '100' }, { accountId: ids['500'], currency: 'TRY', credit: '100' }],
    });
    expect(j.statusCode).toBe(201);
    const blocked = await c.post('/api/treasury/accounts', { kind: 'bank', name: 'Yeni banka', currency: 'TRY' });
    expect(blocked.json().error.code).toBe('PARENT_ACCOUNT_HAS_MOVEMENTS');
    const bank = await mkAccount(c, 'bank', 'KTB (mevcut)', 'TRY', { linkAccountId: ids['102'] });
    expect(bank).toMatchObject({ accountCode: '102', balance: '100.0000' });
  });

  it('TL tahsilat: fatura kalemini kapatır, yevmiye ve bakiye tutarlı, aynı kalem ikinci kez kapanmaz', async () => {
    const { c } = await setup('Tahsilat');
    const cust = await mkParty(c, 'Ali Yılmaz');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    await saleInvoice(c, cust.id, '1000', day(3, 1));
    const item = (await open(c, cust.id)).items[0]!;
    expect(item).toMatchObject({ amount: '1000.00', remaining: '1000.00' });

    const r = await posted(c, { type: 'receipt', date: day(3, 10), accountId: bank.id, amount: '1000', partyId: cust.id, items: [{ lineId: item.lineId, amount: '1000', settleAmount: '1000' }] });
    expect(r.transaction).toMatchObject({ txnNo: `TAH-${thisYear}-000001`, status: 'posted', partyName: 'Ali Yılmaz', amount: '1000.0000', fxRate: null });
    expect(r.fxNet).toBe('0.0000');
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]).toMatchObject({ lineId: item.lineId, amount: '1000.0000', amountBase: '1000.0000', settleAmount: '1000.0000' });

    const j = await journal(c, r.transaction.journalEntryId);
    expect(j.entry).toMatchObject({ sourceType: 'treasury', sourceId: r.transaction.id, status: 'posted' });
    expect(j.of('102.001')).toEqual([{ code: '102.001', d: 1000, c: 0, db: 1000, cb: 0 }]);
    expect(j.of('120')).toEqual([{ code: '120', d: 0, c: 1000, db: 0, cb: 1000 }]);
    expect(await balanceOf(c, bank.id)).toMatchObject({ balance: '1000.0000', balanceBase: '1000.0000' });
    const after = await open(c, cust.id);
    expect(after.items).toHaveLength(0);
    expect(after.unapplied).toBe('0.00');

    const dup = await txn(c, { type: 'receipt', date: day(3, 11), accountId: bank.id, amount: '1000', partyId: cust.id, items: [{ lineId: item.lineId, amount: '1000', settleAmount: '1000' }] });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error.code).toBe('ITEM_NOT_OPEN');
  });

  it('dövizli tahsilat: USD faturası yüksek kurla kâr, düşük kurla zarar, TL hesaba tahsilatta kur farkı', async () => {
    const { c } = await setup('KurFarki');
    const cust = await mkParty(c, 'Sarah Thompson');
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD');
    const tl = await mkAccount(c, 'bank', 'KTB TL');

    // Kâr: 100 USD @40 = 4.000 TL alacak; tahsilat günü kur 42 → 4.200 TL, 200 TL kambiyo kârı
    await saleInvoice(c, cust.id, '100', day(3, 1), 'USD', '40');
    let item = (await open(c, cust.id)).items[0]!;
    expect(item).toMatchObject({ currencyCode: 'USD', remaining: '100.00', remainingBase: '4000.00' });
    const gain = await posted(c, { type: 'receipt', date: day(3, 10), accountId: usd.id, amount: '100', fxRate: '42', partyId: cust.id, items: [{ lineId: item.lineId, amount: '100', settleAmount: '100' }] });
    let j = await journal(c, gain.transaction.journalEntryId);
    expect(j.of('102.001')).toEqual([{ code: '102.001', d: 100, c: 0, db: 4200, cb: 0 }]);
    expect(j.of('120')).toEqual([{ code: '120', d: 0, c: 100, db: 0, cb: 4000 }]);
    expect(j.of('646')).toEqual([{ code: '646', d: 0, c: 4200 - 4000, db: 0, cb: 200 }]);
    expect(gain.fxNet).toBe('200.0000');
    expect(gain.transaction.fxRate).toBe('42.00000000');
    expect(await balanceOf(c, usd.id)).toMatchObject({ balance: '100.0000', balanceBase: '4200.0000' });
    expect((await open(c, cust.id)).items).toHaveLength(0);

    // Zarar: aynı fatura, kur 38 → 3.800 TL, 200 TL kambiyo zararı
    await saleInvoice(c, cust.id, '100', day(3, 12), 'USD', '40');
    item = (await open(c, cust.id)).items[0]!;
    const loss = await posted(c, { type: 'receipt', date: day(3, 20), accountId: usd.id, amount: '100', fxRate: '38', partyId: cust.id, items: [{ lineId: item.lineId, amount: '100', settleAmount: '100' }] });
    j = await journal(c, loss.transaction.journalEntryId);
    expect(j.of('102.001')).toEqual([{ code: '102.001', d: 100, c: 0, db: 3800, cb: 0 }]);
    expect(j.of('120')[0]).toMatchObject({ c: 100, cb: 4000 });
    expect(j.of('656')).toEqual([{ code: '656', d: 200, c: 0, db: 200, cb: 0 }]);
    expect(loss.fxNet).toBe('-200.0000');

    // TL hesaba tahsilat: 100 USD'lik alacak 4.200 TL ile kapanır
    await saleInvoice(c, cust.id, '100', day(4, 1), 'USD', '40');
    item = (await open(c, cust.id)).items[0]!;
    const inTl = await posted(c, { type: 'receipt', date: day(4, 10), accountId: tl.id, amount: '4200', partyId: cust.id, items: [{ lineId: item.lineId, amount: '100', settleAmount: '4200' }] });
    j = await journal(c, inTl.transaction.journalEntryId);
    expect(j.of('102.002')).toEqual([{ code: '102.002', d: 4200, c: 0, db: 4200, cb: 0 }]);
    expect(j.of('120')[0]).toMatchObject({ c: 100, cb: 4000 });
    expect(j.of('646')[0]).toMatchObject({ cb: 200 });
    // Cari kapanış: dövizli alacak sıfır, defter alacağı sıfır; kambiyo net +200 (kâr) −200 (zarar) +200 = 200
    const bal = await closing(c);
    expect(bal('120')).toBe(0);
    expect(bal('646')).toBe(-400);
    expect(bal('656')).toBe(200);
  });

  it('kısmi ve çoklu kalem, avans kalanı, iptalde kalemler geri gelir', async () => {
    const { c } = await setup('Coklu');
    const cust = await mkParty(c, 'Müşteri');
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD');
    await saleInvoice(c, cust.id, '100', day(3, 1), 'USD', '40'); // 4.000 TL
    await saleInvoice(c, cust.id, '50', day(3, 2), 'USD', '41'); // 2.050 TL
    const [a, b] = (await open(c, cust.id)).items;

    // 200 USD @42: A'nın tamamı (100), B'nin 20'si; kalan 80 USD avans
    const r = await posted(c, {
      type: 'receipt', date: day(3, 10), accountId: usd.id, amount: '200', fxRate: '42', partyId: cust.id,
      items: [{ lineId: a!.lineId, amount: '100', settleAmount: '100' }, { lineId: b!.lineId, amount: '20', settleAmount: '20' }],
    });
    const j = await journal(c, r.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ d: 200, db: 8400 }); // 4.200 + 840 + 3.360
    expect(j.of('120').map((l) => [l.c, l.cb])).toEqual([[100, 4000], [20, 820], [80, 3360]]); // B: 2.050 × 20/50 = 820
    expect(j.of('646')[0]).toMatchObject({ cb: 220 }); // 200 + (840 − 820)
    expect(r.fxNet).toBe('220.0000');
    expect(r.allocations).toHaveLength(2);

    // Avans FIFO ile B'nin kalanını da kapatır; artan tutar avans olarak görünür
    const after = await open(c, cust.id);
    expect(after.items).toHaveLength(0);
    expect(after.unapplied).toBe('2130.00'); // 3.360 − B'nin kalan 1.230

    const cancelled = await c.post(`/api/treasury/transactions/${r.transaction.id}/cancel`, { reason: 'Yanlış tutar', date: day(3, 11) });
    expect(cancelled.statusCode).toBe(200);
    const back = await open(c, cust.id);
    expect(back.items.map((i) => [i.remaining, i.remainingBase])).toEqual([['100.00', '4000.00'], ['50.00', '2050.00']]);
    expect(back.unapplied).toBe('0.00');
  });

  it('seçilen kalem kapanır (FIFO değil): yeni fatura seçilince eski kalem açık kalır, kısmi tahsilat seçilen kalemden düşer', async () => {
    const { c } = await setup('Secim');
    const cust = await mkParty(c, 'Müşteri');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    await saleInvoice(c, cust.id, '100', day(3, 1));
    await saleInvoice(c, cust.id, '200', day(3, 2));
    const [older, newer] = (await open(c, cust.id)).items;

    const full = await posted(c, { type: 'receipt', date: day(3, 5), accountId: bank.id, amount: '200', partyId: cust.id, items: [{ lineId: newer!.lineId, amount: '200', settleAmount: '200' }] });
    expect((await open(c, cust.id)).items.map((i) => [i.lineId, i.remaining])).toEqual([[older!.lineId, '100.00']]);

    // Geri alınca ikisi de açık; şimdi yalnızca yeni faturadan 50 kapatılır
    await c.post(`/api/treasury/transactions/${full.transaction.id}/cancel`, { reason: 'Deneme', date: day(3, 6) });
    await posted(c, { type: 'receipt', date: day(3, 7), accountId: bank.id, amount: '50', partyId: cust.id, items: [{ lineId: newer!.lineId, amount: '50', settleAmount: '50' }] });
    expect((await open(c, cust.id)).items.map((i) => [i.lineId, i.remaining])).toEqual([[older!.lineId, '100.00'], [newer!.lineId, '150.00']]);
  });

  it('kuruş artığı: 3 USD (100,00 TL) üç ayrı tahsilatla kapanınca cari defter tutarı sıfırlanır', async () => {
    const { c } = await setup('Kurus');
    const cust = await mkParty(c, 'Müşteri');
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD');
    await saleInvoice(c, cust.id, '3', day(3, 1), 'USD', '33.333333'); // 100,00 TL
    for (let i = 0; i < 3; i++) {
      const item = (await open(c, cust.id)).items[0]!;
      await posted(c, { type: 'receipt', date: day(3, 5 + i), accountId: usd.id, amount: '1', fxRate: '33.333333', partyId: cust.id, items: [{ lineId: item.lineId, amount: '1', settleAmount: '1' }] });
    }
    expect((await open(c, cust.id)).items).toHaveLength(0);
    const bal = await closing(c);
    expect(bal('120')).toBe(0); // son pay kalanı alır: 33,33 + 33,34 + 33,33
    expect(bal('656')).toBeCloseTo(0.01, 4); // ortadaki pay 33,34 taşındı, karşılığı 33,33 alındı
  });

  it('ödeme: tedarikçi borcunu kapatır; yüksek kurda kambiyo zararı, düşük kurda kâr; avans kalanı', async () => {
    const { c } = await setup('Odeme');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD');
    await expenseInvoice(c, sup.id, '100', day(3, 1), 'G-1', 'USD', '40'); // 4.000 TL borç
    let item = (await open(c, sup.id, 'payable')).items[0]!;
    expect(item).toMatchObject({ remaining: '100.00', remainingBase: '4000.00' });

    const loss = await posted(c, { type: 'payment', date: day(3, 10), accountId: usd.id, amount: '100', fxRate: '42', partyId: sup.id, items: [{ lineId: item.lineId, amount: '100', settleAmount: '100' }] });
    expect(loss.transaction.txnNo).toBe(`ODE-${thisYear}-000001`);
    let j = await journal(c, loss.transaction.journalEntryId);
    expect(j.of('320')[0]).toMatchObject({ d: 100, db: 4000 });
    expect(j.of('102.001')[0]).toMatchObject({ c: 100, cb: 4200 });
    expect(j.of('656')[0]).toMatchObject({ db: 200 });
    expect(loss.fxNet).toBe('-200.0000');
    expect((await open(c, sup.id, 'payable')).items).toHaveLength(0);

    await expenseInvoice(c, sup.id, '100', day(3, 12), 'G-2', 'USD', '40');
    item = (await open(c, sup.id, 'payable')).items[0]!;
    const gain = await posted(c, { type: 'payment', date: day(3, 20), accountId: usd.id, amount: '100', fxRate: '38', partyId: sup.id, items: [{ lineId: item.lineId, amount: '100', settleAmount: '100' }] });
    j = await journal(c, gain.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ c: 100, cb: 3800 });
    expect(j.of('646')[0]).toMatchObject({ cb: 200 });
    expect(gain.fxNet).toBe('200.0000');

    // Kalemsiz ödeme = verilen avans (cari borç tarafında)
    const advance = await posted(c, { type: 'payment', date: day(4, 1), accountId: usd.id, amount: '50', fxRate: '40', partyId: sup.id });
    j = await journal(c, advance.transaction.journalEntryId);
    expect(j.of('320')[0]).toMatchObject({ d: 50, db: 2000 });
    expect((await open(c, sup.id, 'payable')).unapplied).toBe('2000.00');
  });

  it('avans tahsilatı: kalemsiz tahsilat cari alacağı azaltır, sonraki fatura FIFO ile kapanır', async () => {
    const { c } = await setup('Avans');
    const cust = await mkParty(c, 'Müşteri');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    const r = await posted(c, { type: 'receipt', date: day(3, 1), accountId: bank.id, amount: '500', partyId: cust.id, description: 'Peşinat' });
    expect(r.allocations).toHaveLength(0);
    const j = await journal(c, r.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ d: 500 });
    expect(j.of('120')[0]).toMatchObject({ c: 500, cb: 500 });
    expect((await open(c, cust.id)).unapplied).toBe('500.00');
    await saleInvoice(c, cust.id, '300', day(3, 5));
    const after = await open(c, cust.id);
    expect(after.items).toHaveLength(0);
    expect(after.unapplied).toBe('200.00');
  });

  it('virman ve döviz alım-satım: maliyet taşınır, satışta kâr/zarar, tüm bakiyede artık kalmaz, yabancıdan yabancıya', async () => {
    const { c, ids } = await setup('Doviz');
    const usdA = await mkAccount(c, 'bank', 'USD A', 'USD');
    const usdB = await mkAccount(c, 'bank', 'USD B', 'USD');
    const tl = await mkAccount(c, 'bank', 'TL 1');
    const eur = await mkAccount(c, 'bank', 'EUR 1', 'EUR');

    // Virman (aynı para birimi): ortalama maliyet taşınır, kambiyo yok
    await fund(c, ids, usdA.id, '200', '40'); // 8.000 TL
    const t1 = await posted(c, { type: 'transfer', date: day(3, 1), accountId: usdA.id, toAccountId: usdB.id, amount: '50' });
    let j = await journal(c, t1.transaction.journalEntryId);
    expect(j.lines).toHaveLength(2);
    expect(j.of('102.001')[0]).toMatchObject({ c: 50, cb: 2000 });
    expect(j.of('102.002')[0]).toMatchObject({ d: 50, db: 2000 });
    const t2 = await posted(c, { type: 'transfer', date: day(3, 2), accountId: usdA.id, toAccountId: usdB.id, amount: '150' });
    j = await journal(c, t2.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ c: 150, cb: 6000 }); // tüm kalan bakiye: artık yok
    expect(await balanceOf(c, usdA.id)).toMatchObject({ balance: '0.0000', balanceBase: '0.0000' });
    expect(t1.transaction.txnNo).toBe(`VRM-${thisYear}-000001`);

    // Türler arası hatalar
    expect((await txn(c, { type: 'transfer', date: day(3, 3), accountId: usdB.id, toAccountId: tl.id, amount: '10' })).json().error.code).toBe('TRANSFER_CURRENCY_MISMATCH');
    expect((await txn(c, { type: 'exchange', date: day(3, 3), accountId: usdA.id, toAccountId: usdB.id, amount: '10', counterAmount: '10' })).json().error.code).toBe('EXCHANGE_SAME_CURRENCY');

    // Satış: 100 USD (maliyet 4.000) 4.400 TL'ye → 400 TL kâr; 3.900 TL'ye → 100 TL zarar (tüm bakiye: maliyet kalanın tamamı)
    await fund(c, ids, usdA.id, '200', '40', day(3, 5));
    const sellHigh = await posted(c, { type: 'exchange', date: day(3, 6), accountId: usdA.id, toAccountId: tl.id, amount: '100', counterAmount: '4400' });
    j = await journal(c, sellHigh.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ c: 100, cb: 4000 });
    expect(j.of('102.003')[0]).toMatchObject({ d: 4400, db: 4400 });
    expect(j.of('646')[0]).toMatchObject({ cb: 400 });
    expect(sellHigh.fxNet).toBe('400.0000');
    const sellLow = await posted(c, { type: 'exchange', date: day(3, 7), accountId: usdA.id, toAccountId: tl.id, amount: '100', counterAmount: '3900' });
    j = await journal(c, sellLow.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ c: 100, cb: 4000 });
    expect(j.of('656')[0]).toMatchObject({ db: 100 });
    expect(sellLow.fxNet).toBe('-100.0000');
    expect(sellLow.transaction.txnNo).toBe(`DVZ-${thisYear}-000002`);

    // Alım: TL ile döviz, maliyet ödenen TL; ortalama maliyetle satış (8.300/200 → 4.150) ve kalan bakiye (4.150)
    await posted(c, { type: 'exchange', date: day(4, 1), accountId: tl.id, toAccountId: usdA.id, amount: '4300', counterAmount: '100' });
    const buy2 = await posted(c, { type: 'exchange', date: day(4, 2), accountId: tl.id, toAccountId: usdA.id, amount: '4000', counterAmount: '100' });
    j = await journal(c, buy2.transaction.journalEntryId);
    expect(j.lines).toHaveLength(2); // alımda kambiyo yok
    expect(j.of('102.001')[0]).toMatchObject({ d: 100, db: 4000 });
    const sellHalf = await posted(c, { type: 'exchange', date: day(4, 3), accountId: usdA.id, toAccountId: tl.id, amount: '100', counterAmount: '4200' });
    j = await journal(c, sellHalf.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ cb: 4150 });
    expect(j.of('646')[0]).toMatchObject({ cb: 50 });
    const sellRest = await posted(c, { type: 'exchange', date: day(4, 4), accountId: usdA.id, toAccountId: tl.id, amount: '100', counterAmount: '4150' });
    j = await journal(c, sellRest.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ cb: 4150 });
    expect(j.of('646')).toHaveLength(0);
    expect(j.of('656')).toHaveLength(0);
    expect(await balanceOf(c, usdA.id)).toMatchObject({ balance: '0.0000', balanceBase: '0.0000' });

    // Yabancıdan yabancıya: 100 USD (maliyet 4.000) → 90 EUR, EUR kuru 45 → değer 4.050, 50 TL kâr; kur 43 → 130 TL zarar
    await fund(c, ids, usdA.id, '100', '40', day(5, 1));
    const cross = await posted(c, { type: 'exchange', date: day(5, 2), accountId: usdA.id, toAccountId: eur.id, amount: '100', counterAmount: '90', fxRate: '45' });
    j = await journal(c, cross.transaction.journalEntryId);
    expect(j.of('102.001')[0]).toMatchObject({ c: 100, cb: 4000 });
    expect(j.of('102.004')[0]).toMatchObject({ d: 90, db: 4050 });
    expect(j.of('646')[0]).toMatchObject({ cb: 50 });
    await fund(c, ids, usdA.id, '100', '40', day(5, 3));
    const crossLoss = await posted(c, { type: 'exchange', date: day(5, 4), accountId: usdA.id, toAccountId: eur.id, amount: '100', counterAmount: '90', fxRate: '43' });
    j = await journal(c, crossLoss.transaction.journalEntryId);
    expect(j.of('102.004')[0]).toMatchObject({ db: 3870 });
    expect(j.of('656')[0]).toMatchObject({ db: 130 });
  });

  it('diğer tahsilat/ödeme: banka masrafı, faiz geliri, dövizli hesapta TL karşı satır; karşı hesap kuralları', async () => {
    const { c, ids } = await setup('Diger');
    const tl = await mkAccount(c, 'bank', 'KTB TL');
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD');
    await fund(c, ids, tl.id, '1000');
    const fee = await posted(c, { type: 'other_payment', date: day(3, 1), accountId: tl.id, amount: '25', glAccountId: ids['770'], description: 'Havale masrafı' });
    expect(fee.transaction).toMatchObject({ txnNo: `DOD-${thisYear}-000001`, glAccountCode: '770' });
    let j = await journal(c, fee.transaction.journalEntryId);
    expect(j.of('770')[0]).toMatchObject({ d: 25, db: 25 });
    expect(j.of('102.001')[0]).toMatchObject({ c: 25, cb: 25 });
    const interest = await posted(c, { type: 'other_receipt', date: day(3, 2), accountId: tl.id, amount: '10', glAccountId: ids['642'] });
    j = await journal(c, interest.transaction.journalEntryId);
    expect(j.of('642')[0]).toMatchObject({ c: 10, cb: 10 });
    expect(interest.transaction.txnNo).toMatch(/^DTH-/);
    expect(await balanceOf(c, tl.id)).toMatchObject({ balance: '985.0000' });

    await fund(c, ids, usd.id, '100', '40');
    const usdFee = await posted(c, { type: 'other_payment', date: day(3, 3), accountId: usd.id, amount: '10', fxRate: '40', glAccountId: ids['770'] });
    j = await journal(c, usdFee.transaction.journalEntryId);
    expect(j.of('770')[0]).toMatchObject({ d: 400, db: 400 });
    expect(j.of('102.002')[0]).toMatchObject({ c: 10, cb: 400 });

    const bad = (glAccountId: string) => txn(c, { type: 'other_payment', date: day(3, 4), accountId: tl.id, amount: '5', glAccountId });
    expect((await bad(ids['120']!)).json().error.code).toBe('ACCOUNT_NOT_ALLOWED'); // cari kontrol hesabı
    expect((await bad(usd.accountId)).json().error.code).toBe('ACCOUNT_NOT_ALLOWED'); // kasa/banka hesabı: virman kullanılır
  });

  it('kasa eksiye düşmez, banka düşebilir; kasa çıkışları ve iptali denetlenir', async () => {
    const { c, ids } = await setup('Kasa');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const cust = await mkParty(c, 'Müşteri');
    const cash = await mkAccount(c, 'cash', 'Ana kasa');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    await fund(c, ids, cash.id, '100');

    const over = await txn(c, { type: 'payment', date: day(3, 1), accountId: cash.id, amount: '150', partyId: sup.id });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('CASH_INSUFFICIENT');
    expect((await txn(c, { type: 'other_payment', date: day(3, 1), accountId: cash.id, amount: '150', glAccountId: ids['770'] })).json().error.code).toBe('CASH_INSUFFICIENT');
    expect((await txn(c, { type: 'transfer', date: day(3, 1), accountId: cash.id, toAccountId: bank.id, amount: '150' })).json().error.code).toBe('CASH_INSUFFICIENT');
    await posted(c, { type: 'payment', date: day(3, 2), accountId: cash.id, amount: '100', partyId: sup.id });
    expect(await balanceOf(c, cash.id)).toMatchObject({ balance: '0.0000' });

    // Banka (kredili mevduat) eksiye düşebilir
    await posted(c, { type: 'payment', date: day(3, 3), accountId: bank.id, amount: '50', partyId: sup.id });
    expect(await balanceOf(c, bank.id)).toMatchObject({ balance: '-50.0000' });

    // Kasaya giren tahsilat harcandıktan sonra iptal edilemez
    const inflow = await posted(c, { type: 'receipt', date: day(4, 1), accountId: cash.id, amount: '100', partyId: cust.id });
    await posted(c, { type: 'other_payment', date: day(4, 2), accountId: cash.id, amount: '80', glAccountId: ids['770'] });
    const cancel = await c.post(`/api/treasury/transactions/${inflow.transaction.id}/cancel`, { reason: 'Yanlış giriş', date: day(4, 3) });
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.code).toBe('CASH_INSUFFICIENT');
  });

  it('iptal: yevmiye ters çevrilir, kalem yeniden açılır, numara kalır; kaynaklı yevmiye elle ters çevrilemez; iptal edilen fatura kalem bırakmaz', async () => {
    const { c } = await setup('Iptal');
    const cust = await mkParty(c, 'Müşteri');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    await saleInvoice(c, cust.id, '1000', day(3, 1));
    const item = (await open(c, cust.id)).items[0]!;
    const r = await posted(c, { type: 'receipt', date: day(3, 10), accountId: bank.id, amount: '1000', partyId: cust.id, items: [{ lineId: item.lineId, amount: '1000', settleAmount: '1000' }] });

    // Ham ters kayıt: kaynak korumalı
    const manual = await c.post(`/api/journal-entries/${r.transaction.journalEntryId}/reverse`, {});
    expect(manual.statusCode).toBe(422);
    expect(manual.json().error.code).toBe('ENTRY_HAS_SOURCE');

    expect((await c.post(`/api/treasury/transactions/${r.transaction.id}/cancel`, { reason: 'x', date: day(3, 11) })).statusCode).toBe(400); // neden en az 3 karakter
    expect((await c.post(`/api/treasury/transactions/${r.transaction.id}/cancel`, { reason: 'Hatalı giriş', date: day(3, 9) })).json().error.code).toBe('CANCEL_DATE_BEFORE_TXN');
    const cancelled = await c.post(`/api/treasury/transactions/${r.transaction.id}/cancel`, { reason: 'Hatalı giriş', date: day(3, 11) });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().transaction).toMatchObject({ status: 'cancelled', cancelReason: 'Hatalı giriş', cancelJournalEntryNo: expect.stringMatching(/^YV-/) });
    expect(await balanceOf(c, bank.id)).toMatchObject({ balance: '0.0000' });
    expect((await c.post(`/api/treasury/transactions/${r.transaction.id}/cancel`, { reason: 'Tekrar', date: day(3, 12) })).json().error.code).toBe('TREASURY_ALREADY_CANCELLED');
    expect((await open(c, cust.id)).items[0]).toMatchObject({ lineId: item.lineId, remaining: '1000.00' });

    // Aynı kalem yeniden kapatılır; iptal edilen numara serinin parçası kalır
    const again = await posted(c, { type: 'receipt', date: day(3, 13), accountId: bank.id, amount: '1000', partyId: cust.id, items: [{ lineId: item.lineId, amount: '1000', settleAmount: '1000' }] });
    expect(again.transaction.txnNo).toBe(`TAH-${thisYear}-000002`);

    // İptal edilen (yeni) faturanın çifti nötrdür: eski fatura açık, iptal edilen görünmez
    const other = await mkParty(c, 'Diğer müşteri');
    await saleInvoice(c, other.id, '100', day(4, 1));
    const b = await saleInvoice(c, other.id, '200', day(4, 5));
    await c.post(`/api/invoices/${b.invoice.id}/cancel`, { reason: 'Hatalı fatura', date: day(4, 6) });
    const items = (await open(c, other.id)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ remaining: '100.00' });
  });

  it('doğrulamalar ve hatalar: şema, cari türü, kalem, kur, dönem, eksik eşleme', async () => {
    const { c, company } = await setup('Hata');
    const cust = await mkParty(c, 'Müşteri');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const tl = await mkAccount(c, 'bank', 'KTB TL');
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD');
    const code = async (body: Record<string, unknown>) => (await txn(c, body)).json().error?.code;
    const base = { date: day(3, 1), accountId: tl.id, amount: '100' };

    // Şema (400)
    expect(await code({ ...base, type: 'receipt' })).toBe('VALIDATION_ERROR'); // cari yok
    expect(await code({ ...base, type: 'transfer', toAccountId: tl.id })).toBe('VALIDATION_ERROR'); // aynı hesap
    expect(await code({ ...base, type: 'exchange', toAccountId: usd.id })).toBe('VALIDATION_ERROR'); // hedef tutar yok
    expect(await code({ ...base, type: 'other_payment' })).toBe('VALIDATION_ERROR'); // karşı hesap yok
    expect(await code({ ...base, type: 'transfer', toAccountId: usd.id, partyId: cust.id })).toBe('VALIDATION_ERROR');
    const itemRow = { lineId: randomUUID(), amount: '10', settleAmount: '10' };
    expect(await code({ ...base, type: 'receipt', partyId: cust.id, items: [itemRow, itemRow] })).toBe('VALIDATION_ERROR'); // aynı kalem iki kez
    expect(await code({ ...base, type: 'receipt', partyId: cust.id, items: [{ ...itemRow, settleAmount: '150' }] })).toBe('VALIDATION_ERROR'); // hareket tutarını aşar

    // İş kuralları (422)
    expect(await code({ ...base, type: 'receipt', partyId: sup.id })).toBe('PARTY_KIND_MISMATCH'); // tedarikçiden tahsilat
    expect(await code({ ...base, type: 'payment', partyId: cust.id })).toBe('PARTY_KIND_MISMATCH');
    expect(await code({ ...base, type: 'receipt', partyId: cust.id, items: [itemRow] })).toBe('ITEM_NOT_OPEN');
    await saleInvoice(c, cust.id, '100', day(3, 1));
    const item = (await open(c, cust.id)).items[0]!;
    expect(await code({ ...base, amount: '500', type: 'receipt', partyId: cust.id, items: [{ lineId: item.lineId, amount: '150', settleAmount: '150' }] })).toBe('ALLOCATION_EXCEEDED');
    expect(await code({ ...base, date: `${thisYear - 5}-03-05`, type: 'receipt', partyId: cust.id })).toMatch(/^PERIOD_/);
    expect(await code({ date: day(3, 1), accountId: usd.id, amount: '10', type: 'receipt', partyId: cust.id })).toBe('FX_RATE_MISSING'); // kur yok, elle de verilmedi

    // Eksik kambiyo eşlemesi yalnızca kur farkı oluşan hareketi durdurur
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      await owner.query(`delete from account_mappings where company_id = $1 and key = 'fx_gain'`, [company.id]);
    } finally {
      await owner.end();
    }
    await saleInvoice(c, cust.id, '100', day(3, 2), 'USD', '40');
    const usdItem = (await open(c, cust.id)).items.find((i) => i.currencyCode === 'USD')!;
    const withGain = await txn(c, { type: 'receipt', date: day(3, 5), accountId: usd.id, amount: '100', fxRate: '42', partyId: cust.id, items: [{ lineId: usdItem.lineId, amount: '100', settleAmount: '100' }] });
    expect(withGain.statusCode).toBe(422);
    expect(withGain.json().error.code).toBe('ACCOUNT_MAPPING_MISSING');
    const noDiff = await txn(c, { type: 'receipt', date: day(3, 5), accountId: usd.id, amount: '100', fxRate: '40', partyId: cust.id, items: [{ lineId: usdItem.lineId, amount: '100', settleAmount: '100' }] });
    expect(noDiff.statusCode).toBe(201);
  });

  it('yetkiler: muhasebeci tam, izleyici yalnızca okur, satış ve şantiye sorumlusu erişemez', async () => {
    const { c, company, ids } = await setup('Yetki');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    const acct = await memberClient(c, company.id, 'accountant');
    const viewer = await memberClient(c, company.id, 'viewer');
    const sales = await memberClient(c, company.id, 'sales');
    const sm = await memberClient(c, company.id, 'site_manager');
    const body = { type: 'other_receipt', date: day(3, 1), accountId: bank.id, amount: '10', glAccountId: ids['500'] };

    expect((await acct.post('/api/treasury/transactions', body)).statusCode).toBe(201);
    expect((await acct.post('/api/treasury/accounts', { kind: 'cash', name: 'Kasa', currency: 'TRY' })).statusCode).toBe(201);
    expect((await viewer.get('/api/treasury/accounts')).statusCode).toBe(200);
    expect((await viewer.get('/api/treasury/transactions')).statusCode).toBe(200);
    expect((await viewer.post('/api/treasury/transactions', body)).statusCode).toBe(403);
    expect((await viewer.post('/api/treasury/accounts', { kind: 'cash', name: 'Kasa 2', currency: 'TRY' })).statusCode).toBe(403);
    for (const other of [sales, sm]) {
      expect((await other.get('/api/treasury/accounts')).statusCode).toBe(403);
      expect((await other.post('/api/treasury/transactions', body)).statusCode).toBe(403);
    }
  });

  it('DB kuralları (ERP05): kaydedilmiş hareket ve eşleştirme değişmez, hesap kuralları ham SQL ile de geçerli', async () => {
    const { s, company, c, ids, orgId } = await setup('DbKural');
    const cust = await mkParty(c, 'Müşteri');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    await saleInvoice(c, cust.id, '100', day(3, 1));
    const item = (await open(c, cust.id)).items[0]!;
    const r = await posted(c, { type: 'receipt', date: day(3, 5), accountId: bank.id, amount: '100', partyId: cust.id, items: [{ lineId: item.lineId, amount: '100', settleAmount: '100' }] });
    const id = r.transaction.id as string;

    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      expect((await expectDbError(q, `update treasury_transactions set description = 'x' where id = $1`, [id])).code).toBe('ERP05');
      expect((await expectDbError(q, `update treasury_transactions set amount = 1 where id = $1`, [id])).code).toBe('ERP05');
      // Yevmiyesi ters kayıt olmayan iptal
      expect(
        (await expectDbError(q, `update treasury_transactions set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x', cancel_journal_entry_id = journal_entry_id where id = $1`, [id])).code,
      ).toBe('ERP05');
      // erp_app'in silme yetkisi yok
      expect((await expectDbError(q, `delete from treasury_transactions where id = $1`, [id])).code).toBe('42501');
      expect((await expectDbError(q, `update party_allocations set amount = 1 where transaction_id = $1`, [id])).code).toBe('42501');
      // Hesap kuralları: yanlış grup, tür/para birimi/hesap değişmez
      expect(
        (await expectDbError(q, `insert into treasury_accounts (id, company_id, kind, name, currency_code, account_id) values (gen_random_uuid(), $1, 'bank', 'X', 'TRY', $2)`, [company.id, ids['120']])).code,
      ).toBe('ERP05');
      expect((await expectDbError(q, `update treasury_accounts set currency_code = 'USD' where id = $1`, [bank.id])).code).toBe('ERP05');
      expect((await expectDbError(q, `update treasury_accounts set account_id = $2 where id = $1`, [bank.id, ids['100']])).code).toBe('ERP05');
      // Tutarsız eşleştirme
      expect(
        (await expectDbError(
          q,
          `insert into party_allocations (id, company_id, party_id, control, transaction_id, charge_line_id, settle_line_id, amount, amount_base, settle_amount)
           select gen_random_uuid(), $1, $2, 'receivable', $3, charge_line_id, settle_line_id, 999, 999, 999 from party_allocations where transaction_id = $3`,
          [company.id, cust.id, id],
        )).code,
      ).toBe('ERP05');
    });

    // Tablo sahibi olarak (yetki kısıtından bağımsız) tetikleyicilerin kendisi
    await asOwner(async (q) => {
      expect((await expectDbError(q, `delete from treasury_transactions where id = $1`, [id])).code).toBe('ERP05');
      expect((await expectDbError(q, `update party_allocations set amount = 1 where transaction_id = $1`, [id])).code).toBe('ERP05');
      expect((await expectDbError(q, `delete from party_allocations where transaction_id = $1`, [id])).code).toBe('ERP05');
      expect((await expectDbError(q, `delete from treasury_accounts where id = $1`, [bank.id])).code).toBe('ERP05');
    });
  });

  it('eşzamanlılık: aynı kalemi iki tahsilat kapatamaz; aynı kasadan iki ödeme bakiyeyi aşamaz', async () => {
    const { c, ids } = await setup('Yaris');
    const cust = await mkParty(c, 'Müşteri');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const bank = await mkAccount(c, 'bank', 'KTB TL');
    const bank2 = await mkAccount(c, 'bank', 'İş Bankası TL');
    const cash = await mkAccount(c, 'cash', 'Ana kasa');
    await saleInvoice(c, cust.id, '1000', day(3, 1));
    const item = (await open(c, cust.id)).items[0]!;
    // Farklı iki hesaba: hesap kilidi serileştirmez, yalnızca cari/kalem kilidi devrededir
    const receive = (d: number, accountId: string) => txn(c, { type: 'receipt', date: day(3, d), accountId, amount: '1000', partyId: cust.id, items: [{ lineId: item.lineId, amount: '1000', settleAmount: '1000' }] });
    const [a, b] = await Promise.all([receive(10, bank.id), receive(11, bank2.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
    expect((a.statusCode === 422 ? a : b).json().error.code).toBe('ITEM_NOT_OPEN');
    expect((await open(c, cust.id)).items).toHaveLength(0);

    await fund(c, ids, cash.id, '100');
    // Aynı tarihli iki çıkış: bakiye denetimi işlem tarihine kadarki hareketlere bakar (geriye dönük tarihte sonrası denetlenmez),
    // bu yüzden farklı tarihler isteklerin işlenme sırasına göre sonucu değiştirirdi (test kararsızlığı)
    const pay = () => txn(c, { type: 'payment', date: day(4, 1), accountId: cash.id, amount: '80', partyId: sup.id });
    const [p1, p2] = await Promise.all([pay(), pay()]);
    expect([p1.statusCode, p2.statusCode].sort()).toEqual([201, 422]);
    expect((p1.statusCode === 422 ? p1 : p2).json().error.code).toBe('CASH_INSUFFICIENT');
    expect(await balanceOf(c, cash.id)).toMatchObject({ balance: '20.0000' });
  });

  it('ekstre, liste, özet: yürüyen bakiye (hesap ve defter para birimi), süzgeçler, güncel kurla karşılık', async () => {
    const { c, ids } = await setup('Rapor');
    const cust = await mkParty(c, 'Çağlar Ticaret');
    const usd = await mkAccount(c, 'bank', 'KTB USD', 'USD');
    const tl = await mkAccount(c, 'bank', 'KTB TL');
    const t1 = await fund(c, ids, usd.id, '100', '40', day(2, 1));
    await posted(c, { type: 'other_payment', date: day(2, 5), accountId: usd.id, amount: '30', fxRate: '41', glAccountId: ids['770'] });
    await posted(c, { type: 'receipt', date: day(3, 1), accountId: tl.id, amount: '250', partyId: cust.id, description: 'Peşinat' });

    const st = (await c.get(`/api/treasury/accounts/${usd.id}/statement?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    expect(st.account).toMatchObject({ name: 'KTB USD', currencyCode: 'USD', accountCode: '102.001' });
    expect(st.openingDoc).toBe('0.0000');
    expect(st.lines).toHaveLength(2);
    expect(st.lines[0]).toMatchObject({ txnNo: t1.transaction.txnNo, txnType: 'other_receipt', debit: '100.0000', balanceDoc: '100.0000', balanceBase: '4000.0000' });
    expect(st.lines[1]).toMatchObject({ credit: '30.0000', balanceDoc: '70.0000', balanceBase: '2770.0000' }); // 4.000 − 30×41
    expect(st.closingDoc).toBe('70.0000');
    const later = (await c.get(`/api/treasury/accounts/${usd.id}/statement?from=${day(3, 1)}&to=${day(12, 31)}`)).json();
    expect(later).toMatchObject({ openingDoc: '70.0000', openingBase: '2770.0000', lines: [] });

    const all = (await c.get('/api/treasury/transactions')).json();
    expect(all.total).toBe(3);
    const ids2 = async (qs: string) => (await c.get(`/api/treasury/transactions?${qs}`)).json().transactions.map((t: any) => t.txnNo);
    expect((await ids2('type=receipt')).length).toBe(1);
    expect((await ids2(`accountId=${usd.id}`)).length).toBe(2);
    expect((await ids2(`partyId=${cust.id}`)).length).toBe(1);
    expect((await ids2('query=' + encodeURIComponent('ÇAĞLAR'))).length).toBe(1);
    expect((await ids2('query=Peşinat')).length).toBe(1);
    expect((await ids2('status=cancelled')).length).toBe(0);
    expect((await c.get('/api/treasury/transactions?limit=1&offset=1')).json()).toMatchObject({ total: 3 });

    // Kur yokken karşılık null, özet yaklaşık (tarihsel maliyet); kur girilince güncel karşılık
    let summary = (await c.get('/api/treasury/summary')).json();
    expect(summary).toMatchObject({ accountCount: 2, approximate: true });
    for (const off of [1, 0]) {
      const d = new Date(Date.now() - off * 86_400_000).toISOString().slice(0, 10);
      await c.put('/api/exchange-rates', { rateDate: d, currencyCode: 'USD', quoteCode: 'TRY', buy: '42' });
    }
    const list = (await c.get('/api/treasury/accounts')).json().accounts as any[];
    expect(list.find((a) => a.id === usd.id)).toMatchObject({ balance: '70.0000', equivalent: '2940.0000', balanceBase: '2770.0000' });
    summary = (await c.get('/api/treasury/summary')).json();
    expect(summary).toMatchObject({ approximate: false, equivalent: '3190.0000' }); // 70 × 42 + 250
    expect(summary.byCurrency).toEqual(expect.arrayContaining([{ currency: 'USD', balance: '70.0000' }, { currency: 'TRY', balance: '250.0000' }]));
  });
});
