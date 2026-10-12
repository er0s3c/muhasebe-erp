import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountIds, addMember, client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';
import { expectCompanyInvariants } from './invariants';

/**
 * Öneri 121: cevabı kaybolan ve kullanıcının yeniden gönderdiği kayıt komutu ikinci fatura, tahsilat veya yevmiye
 * oluşturmaz. Aynı anahtar aynı içerikle ilk cevabı döndürür; farklı içerikle reddedilir; başarısız deneme anahtarı tüketmez.
 */
describe('tekrar gönderime karşı korunan kayıt komutları (Idempotency-Key)', async () => {
  const { app } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { name: `${name} Ltd.` });
    const c = client(app, s.token, company.id);
    const send = (url: string, payload: unknown, key?: string, token = s.token) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}`, 'x-company-id': company.id, ...(key ? { 'idempotency-key': key } : {}) },
        payload: payload as object,
      });
    const customer = (await c.post('/api/parties', { name: 'Müşteri', kind: 'customer' })).json().party.id as string;
    return { s, company, c, send, customer };
  }
  const invoiceBody = (partyId: string, price = '100') => ({
    post: true, type: 'sales', partyId, invoiceDate: day(3, 5),
    lines: [{ description: 'Hizmet', quantity: '1', unitPrice: price, vatCode: 'KDV-16' }],
  });
  const countOf = async (table: string, companyId: string) =>
    Number((await execAsOwner(`select count(*)::int as n from ${table} where company_id = $1`, [companyId])).rows[0].n);

  it('aynı anahtar ve içerikle tekrar gönderilen fatura yeniden kaydedilmez; ilk cevap aynen döner', async () => {
    const w = await world('IdemFatura');
    const key = randomUUID();
    const first = await w.send('/api/invoices', invoiceBody(w.customer), key);
    expect(first.statusCode, first.body).toBe(201);
    const replay = await w.send('/api/invoices', invoiceBody(w.customer), key);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json().invoice.id).toBe(first.json().invoice.id);
    expect(replay.json().invoice.invoiceNo).toBe(first.json().invoice.invoiceNo);
    expect(await countOf('invoices', w.company.id)).toBe(1);
    await expectCompanyInvariants(w.company.id);
  });

  it('aynı anahtar farklı içerikle reddedilir; başlık yoksa davranış değişmez', async () => {
    const w = await world('IdemFark');
    const key = randomUUID();
    expect((await w.send('/api/invoices', invoiceBody(w.customer, '100'), key)).statusCode).toBe(201);
    const changed = await w.send('/api/invoices', invoiceBody(w.customer, '250'), key);
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Anahtarsız iki gönderim iki kayıttır (eski istemciler etkilenmez)
    expect((await w.send('/api/invoices', invoiceBody(w.customer))).statusCode).toBe(201);
    expect((await w.send('/api/invoices', invoiceBody(w.customer))).statusCode).toBe(201);
    expect(await countOf('invoices', w.company.id)).toBe(3);
    expect((await w.send('/api/invoices', invoiceBody(w.customer), 'kisa')).json().error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('başarısız deneme anahtarı tüketmez: düzeltilen içerik aynı anahtarla kaydedilir', async () => {
    const w = await world('IdemHata');
    const key = randomUUID();
    const bad = await w.send('/api/invoices', { ...invoiceBody(w.customer), lines: [] }, key);
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(await countOf('command_receipts', w.company.id)).toBe(0);
    const fixed = await w.send('/api/invoices', invoiceBody(w.customer), key);
    expect(fixed.statusCode, fixed.body).toBe(201);
    expect(fixed.headers['idempotent-replay']).toBeUndefined();
  });

  it('eşzamanlı iki kopya sıraya girer: tek tahsilat, tek cari kapatma', async () => {
    const w = await world('IdemTahsilat');
    const bank = (await w.c.post('/api/treasury/accounts', { kind: 'bank', name: 'Banka', currency: 'TRY' })).json().account.id as string;
    expect((await w.send('/api/invoices', invoiceBody(w.customer, '1000'))).statusCode).toBe(201);
    const open = (await w.c.get(`/api/parties/${w.customer}/open-items?type=receivable&asOf=${day(3, 31)}`)).json().receivable.items as { lineId: string }[];
    const body = { type: 'receipt', date: day(3, 10), accountId: bank, amount: '400', partyId: w.customer, items: [{ lineId: open[0]!.lineId, amount: '400', settleAmount: '400' }] };
    const key = randomUUID();
    const [a, b] = await Promise.all([w.send('/api/treasury/transactions', body, key), w.send('/api/treasury/transactions', body, key)]);
    expect([a.statusCode, b.statusCode], `${a.body} | ${b.body}`).toEqual([201, 201]);
    expect(a.json().transaction.id).toBe(b.json().transaction.id);
    expect(await countOf('treasury_transactions', w.company.id)).toBe(1);
    expect(await countOf('party_allocations', w.company.id)).toBe(1);
    await expectCompanyInvariants(w.company.id);
  });

  it('yevmiye tekrar gönderimi tek kayıt; anahtar kullanıcıya özeldir', async () => {
    const w = await world('IdemYevmiye');
    const ids = await accountIds(app, w.s.token, w.company.id);
    const body = { entryDate: day(3, 6), description: 'Sermaye', post: true, lines: [{ accountId: ids['100'], currency: 'TRY', debit: '500' }, { accountId: ids['500'], currency: 'TRY', credit: '500' }] };
    const key = randomUUID();
    const first = await w.send('/api/journal-entries', body, key);
    expect(first.statusCode, first.body).toBe(201);
    expect((await w.send('/api/journal-entries', body, key)).json().entry.id).toBe(first.json().entry.id);
    // Başka kullanıcı aynı anahtarı kullanırsa kendi komutu çalışır (makbuzlar kullanıcıya ve şirkete özeldir)
    const member = await addMember(app, w.c, w.company.id, 'accountant', 'idem-muhasebe');
    const other = await w.send('/api/journal-entries', body, key, member.token);
    expect(other.statusCode, other.body).toBe(201);
    expect(other.json().entry.id).not.toBe(first.json().entry.id);
    await expectCompanyInvariants(w.company.id);
  });
});
