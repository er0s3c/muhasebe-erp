import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { describeError, mapError, PG_RULE_CODES } from '../src/http/errors';
import { client, createCompany, day, makeApp, registerUser, TODAY_LOCAL, thisYear } from './helpers';

/**
 * API sağlamlığı denetimi (API-2 … API-11) regresyon testleri. Her senaryo denetimde hatayı gösteren isteğin kendisidir:
 * düzeltmeden önce 500, yanlış kod, İngilizce ileti ya da yinelenen kayıt üretiyordu.
 */
describe('API sağlamlığı (API-2…API-11)', async () => {
  const { app } = await makeApp();

  type C = ReturnType<typeof client>;
  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, codes = [200, 201]) => {
    const r = await p;
    if (!codes.includes(r.statusCode)) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
    return r.json();
  };
  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    return { s, company, c: client(app, s.token, company.id) };
  }
  const party = async (c: C, name: string, kind = 'customer') => (await ok(c.post('/api/parties', { name, kind }))).party as { id: string };
  const raw = (c: { s: { token: string }; company: { id: string } }, method: 'POST' | 'PATCH' | 'GET', url: string, payload: string, contentType = 'application/json') =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${c.s.token}`, 'x-company-id': c.company.id, 'content-type': contentType } });
  const noEnglish = (body: string) => expect(body).not.toMatch(/Too (small|big)|Invalid|expected|Body is not valid|Unsupported Media|Request body is too large/);

  it('API-2: bozuk tutar/miktar ("1,5", "abc", "1e999") 400 VALIDATION_ERROR olur, 500 değil', async () => {
    const { c } = await world('Rob2');
    const cust = await party(c, 'Müşteri');
    for (const bad of ['1,5', 'abc', '1e999', 'NaN', ' ']) {
      const inv = await c.post('/api/invoices', { type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), currency: 'TRY', lines: [{ description: 'Hizmet', quantity: bad, unitPrice: '10', vatCode: 'KDV-0' }] });
      expect(inv.statusCode, `${bad}: ${inv.body}`).toBe(400);
      expect(inv.json().error.code).toBe('VALIDATION_ERROR');
      const price = await c.post('/api/invoices', { type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: bad, vatCode: 'KDV-0', discountPct: bad }] });
      expect(price.statusCode, price.body).toBe(400);
      const chq = await c.post('/api/cheques', { direction: 'received', docType: 'cheque', docNo: 'K-1', partyId: cust.id, amount: bad, bankName: 'Banka', issueDate: day(3, 1), dueDate: day(4, 1) });
      expect(chq.statusCode, chq.body).toBe(400);
      const tr = await c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 1), accountId: '00000000-0000-4000-8000-000000000000', amount: bad, partyId: cust.id, items: [{ lineId: '00000000-0000-4000-8000-000000000001', amount: bad, settleAmount: bad }] });
      expect(tr.statusCode, tr.body).toBe(400);
    }
    // Servis içinde kaçan bir Decimal hatası da 400'e eşlenir (son savunma hattı)
    expect(mapError(new Error('[DecimalError] Invalid argument: 1,5'))).toMatchObject({ status: 400, code: 'INVALID_NUMBER' });
  });

  it('API-3: bağlantı havuzu dolu → 503 BUSY + Retry-After (500 değil)', async () => {
    const config = loadConfig();
    const handle = createDb(config.DATABASE_URL, { max: 1, connectTimeoutMs: 300 });
    const busyApp = await buildApp({ db: handle.db, config, logger: false });
    await busyApp.ready();
    try {
      const s = await registerUser(busyApp, 'RobBusy');
      const company = await createCompany(busyApp, s.token);
      const held = await handle.pool.connect(); // havuzun tek bağlantısı meşgul
      try {
        const r = await busyApp.inject({ method: 'GET', url: '/api/accounts', headers: { authorization: `Bearer ${s.token}`, 'x-company-id': company.id } });
        expect(r.statusCode, r.body).toBe(503);
        expect(r.json().error.code).toBe('BUSY');
        expect(r.headers['retry-after']).toBe('3');
      } finally {
        held.release();
      }
      const again = await busyApp.inject({ method: 'GET', url: '/api/accounts', headers: { authorization: `Bearer ${s.token}`, 'x-company-id': company.id } });
      expect(again.statusCode).toBe(200);
    } finally {
      await busyApp.close();
      await handle.close();
    }
    // Bağlantı reddi / sunucu kapanıyor / çok fazla bağlantı da 503
    expect(mapError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))?.code).toBe('BUSY');
    expect(mapError(Object.assign(new Error('too many clients'), { code: '53300' }))?.status).toBe(503);
    expect(mapError(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toMatchObject({ status: 503, code: 'TIMEOUT' });
  });

  it('API-4: tarih penceresi 1900–2100, NUL karakteri ve SQLSTATE sınıf 22 → 400 Türkçe', async () => {
    const w = await world('Rob4');
    const { c } = w;
    for (const url of [
      '/api/reports/stock-status?asOf=0001-01-01',
      '/api/exports/stock-status?format=csv&asOf=0001-01-01',
      '/api/cash-forecast?from=9999-12-31',
      '/api/projects/profitability?asOf=1899-12-31',
    ]) {
      const r = await c.get(url);
      expect(r.statusCode, `${url}: ${r.body}`).toBe(400);
      expect(r.body).toContain('1900');
    }
    const cust = await party(c, 'Müşteri');
    const far = await c.post('/api/invoices', { type: 'sales', partyId: cust.id, invoiceDate: '9999-12-31', currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '10', vatCode: 'KDV-0' }] });
    expect(far.statusCode).toBe(400);
    expect(far.json().error.details[0].message).toBe('Tarih 01.01.1900 ile 31.12.2100 arasında olmalı');
    // NUL: gövdede (iç içe dahil) ve sorguda
    const nul = await c.post('/api/invoices', { type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), currency: 'TRY', description: 'a\u0000b', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '10', vatCode: 'KDV-0' }] });
    expect(nul.statusCode, nul.body).toBe(400);
    expect(nul.json().error).toMatchObject({ code: 'INVALID_TEXT', message: 'Metinde geçersiz karakter (NUL) var' });
    expect((await c.patch(`/api/parties/${cust.id}`, { name: 'x\u0000' })).json().error.code).toBe('INVALID_TEXT');
    expect((await c.get('/api/parties?q=a%00b')).json().error.code).toBe('INVALID_TEXT');
    // Veri istisnaları (sınıf 22) → 400 Türkçe, kod ayrımlı
    const pg = (code: string) => mapError(Object.assign(new Error('x'), { code }));
    expect(pg('22001')).toMatchObject({ status: 400, code: 'VALUE_TOO_LONG' });
    expect(pg('22007')).toMatchObject({ status: 400, code: 'INVALID_DATE' });
    expect(pg('22008')).toMatchObject({ status: 400, code: 'INVALID_DATE' });
    expect(pg('22021')).toMatchObject({ status: 400, code: 'INVALID_TEXT' });
    expect(pg('22P02')).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(pg('22003')).toMatchObject({ status: 400, code: 'AMOUNT_OUT_OF_RANGE' });
    expect(pg('22012')).toMatchObject({ status: 400, code: 'INVALID_INPUT' });
  });

  it('API-5: fon/harç tahmini sorgusu doğrulanır, bilinmeyen proje 404; taksit listesinde overdue doğrulanır', async () => {
    const { c } = await world('Rob5');
    const project = (await ok(c.post('/api/projects', { name: 'Proje', kind: 'own' }))).project;
    expect((await c.get(`/api/projects/${project.id}/fee-estimate?asOf=bozuk`)).statusCode).toBe(400);
    expect((await c.get(`/api/projects/${project.id}/fee-estimate?asOf=0001-01-01`)).statusCode).toBe(400);
    expect((await c.get(`/api/projects/${project.id}/fee-estimate?asOf=${TODAY_LOCAL}`)).statusCode).toBe(200);
    const unknown = await c.get(`/api/projects/00000000-0000-4000-8000-000000000000/fee-estimate`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Proje bulunamadı');
    expect((await c.get('/api/real-estate/installments?overdue=belki')).statusCode).toBe(400);
    expect((await c.get('/api/real-estate/installments?overdue=true')).statusCode).toBe(200);
  });

  it('API-6: değişiklik içermeyen PATCH güncel kaydı döndürür (500 "No values to set" değil)', async () => {
    const { c, company } = await world('Rob6');
    const accounts = (await ok(c.get('/api/accounts'))).accounts as { id: string; code: string; name: string }[];
    const acc = accounts.find((a) => a.code === '100')!;
    const a = await c.patch(`/api/accounts/${acc.id}`, {});
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().account ?? a.json()).toMatchObject({ id: acc.id, name: acc.name });
    const co = await c.patch('/api/company', {});
    expect(co.statusCode, co.body).toBe(200);
    expect(co.json().company).toMatchObject({ id: company.id });
    const item = (await ok(c.post('/api/payroll/items', { code: 'KES-1', name: 'Kesinti', kind: 'deduction' }))).item;
    const p1 = await c.patch(`/api/payroll/items/${item.id}`, {});
    expect(p1.statusCode, p1.body).toBe(200);
    // Kesinti kalemine yalnızca matrah bayrağı (yok sayılır) → değişiklik yok, güncel kayıt
    const p2 = await c.patch(`/api/payroll/items/${item.id}`, { affectsTaxBase: true });
    expect(p2.statusCode, p2.body).toBe(200);
    expect(p2.json().item).toMatchObject({ id: item.id, affectsTaxBase: false });
  });

  it('API-7: liste uçları sayfalanır (limit/offset, truncated); sınır dışı limit 400; çek aramasında % ve _ düz metindir', async () => {
    const { c } = await world('Rob7');
    const cust = await party(c, 'Müşteri');
    for (const no of ['K-1', 'K-2', 'K-3']) {
      await ok(c.post('/api/cheques', { direction: 'received', docType: 'cheque', docNo: no, partyId: cust.id, amount: '10', bankName: 'Banka', issueDate: day(1, 1), dueDate: day(2, 1) }));
    }
    const p1 = await ok(c.get('/api/cheques?limit=2'));
    expect(p1.cheques).toHaveLength(2);
    expect(p1.truncated).toBe(true);
    const p2 = await ok(c.get('/api/cheques?limit=2&offset=2'));
    expect(p2.cheques).toHaveLength(1);
    expect(p2.truncated).toBe(false);
    expect((await ok(c.get('/api/cheques'))).truncated).toBe(false);
    expect((await c.get('/api/cheques?limit=0')).statusCode).toBe(400);
    expect((await c.get('/api/cheques?limit=999999')).statusCode).toBe(400);
    expect((await ok(c.get('/api/cheques?q=%25'))).cheques).toHaveLength(0);
    expect((await ok(c.get('/api/cheques?q=K_1'))).cheques).toHaveLength(0);
    expect((await ok(c.get('/api/cheques?q=K-1'))).cheques).toHaveLength(1);
    // Diğer liste uçları da sayfa parametresi kabul eder ve truncated döner
    for (const url of [
      '/api/accounts', '/api/employees', '/api/privacy/requests', '/api/payroll/runs', '/api/social-security/declarations', '/api/bank-guarantees',
      '/api/purchase-requests', '/api/purchase-orders', '/api/rfqs', '/api/sales-contracts', '/api/real-estate/installments', '/api/real-estate/units',
      '/api/progress-payments', '/api/variation-orders', '/api/expense-cards', '/api/directory/organizations', '/api/foreign-workers/documents',
      '/api/foreign-workers/guarantees',
    ]) {
      const r = await c.get(`${url}?limit=1`);
      expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
      expect(r.json().truncated, url).toBeTypeOf('boolean');
      expect((await c.get(`${url}?limit=-1`)).statusCode, url).toBe(400);
    }
    // Hesap planı varsayılanı tüm planı verir (seçiciler bütün listeyi kullanır)
    const all = await ok(c.get('/api/accounts'));
    expect(all.truncated).toBe(false);
    expect(all.accounts.length).toBeGreaterThan(100);
    expect((await ok(c.get('/api/accounts?limit=10'))).accounts).toHaveLength(10);
  });

  it('API-8: göçlerde kullanılan her ERPnn kodu eşlenir; errorHandler ve describeError aynı tabloyu kullanır', async () => {
    const dir = join(__dirname, '..', 'drizzle');
    const codes = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/errcode\s*=\s*'(ERP\d+)'/gi)) codes.add(m[1]!.toUpperCase());
    }
    expect(codes.size).toBeGreaterThanOrEqual(24);
    for (const code of codes) {
      expect(PG_RULE_CODES[code], code).toMatch(/_VIOLATION$/);
      const err = Object.assign(new Error('Türkçe kural iletisi'), { code });
      expect(mapError(err)).toMatchObject({ status: 422, code: PG_RULE_CODES[code], message: 'Türkçe kural iletisi' });
      expect(describeError(err)).toEqual({ code: PG_RULE_CODES[code], message: 'Türkçe kural iletisi' });
    }
    // Eskiden describeError'da eksik olanlar: ERP05–ERP14, 23505, 23514
    expect(describeError(Object.assign(new Error('x'), { code: 'ERP05' })).code).toBe('TREASURY_RULE_VIOLATION');
    expect(describeError(Object.assign(new Error('x'), { code: '23505', constraint: 'parties_company_code_uq' }))).toEqual({ code: 'DUPLICATE', message: 'Bu kod zaten kullanılıyor' });
    expect(describeError(Object.assign(new Error('x'), { code: '23514' })).code).toBe('CONSTRAINT_VIOLATION');
    // Drizzle sarmalayıcısı (cause) içinden de bulunur
    expect(describeError(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('y'), { code: 'ERP14' }) })).code).toBe('CHEQUE_RULE_VIOLATION');
  });

  it('API-9: Fastify ve zod hataları Türkçe; __proto__ gövdesi doğru iletiyle reddedilir', async () => {
    const w = await world('Rob9');
    const badJson = await raw(w, 'POST', '/api/parties', '{"name": "x",');
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.message).toBe('İstek gövdesi geçerli bir JSON değil');
    const proto = await raw(w, 'POST', '/api/parties', '{"name": "Cari", "kind": "customer", "__proto__": {"isAdmin": true}}');
    expect(proto.statusCode).toBe(400);
    expect(proto.json().error).toMatchObject({ code: 'FORBIDDEN_JSON_KEY' });
    expect(proto.json().error.message).toContain('__proto__');
    const xml = await raw(w, 'POST', '/api/parties', '<a/>', 'application/xml');
    expect(xml.statusCode).toBe(415);
    expect(xml.json().error.message).toBe('Desteklenmeyen içerik türü; istek gövdesi application/json olmalı');
    const big = await raw(w, 'POST', '/api/parties', JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.message).toBe('İstek gövdesi çok büyük');
    for (const r of [badJson, proto, xml, big]) noEnglish(r.body);
    // Zod: iletisiz kurallar Türkçe
    const long = await w.c.post('/api/parties', { name: 'x'.repeat(500), kind: 'customer' });
    expect(long.statusCode).toBe(400);
    noEnglish(long.body);
    expect(long.json().error.details[0].message).toMatch(/^En çok \d+ karakter olmalı$/);
    const lines = await w.c.post('/api/invoices', { type: 'sales', partyId: '00000000-0000-4000-8000-000000000000', invoiceDate: day(3, 1), currency: 'TRY', lines: Array.from({ length: 301 }, () => ({ description: 'a', quantity: '1', unitPrice: '1' })) });
    noEnglish(lines.body);
    expect(lines.json().error.details.map((d: { message: string }) => d.message)).toContain('En çok 300 öğe olmalı');
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'bozuk', password: 'x', fullName: 'A', organizationName: '' } });
    expect(reg.statusCode).toBe(400);
    noEnglish(reg.body);
  });

  it('API-10: kayıtlı fatura silme iletisi doğru; 409 DUPLICATE kısıt adı sızdırmaz; puantaj ayı kodları tutarlı (422)', async () => {
    const { c } = await world('Rob10');
    const cust = await party(c, 'Müşteri');
    const inv = (await ok(c.post('/api/invoices', { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '10', vatCode: 'KDV-0' }] }))).invoice;
    const del = await c.delete(`/api/invoices/${inv.id}`);
    expect(del.statusCode).toBe(422);
    expect(del.json().error.message).toBe('Yalnızca taslak fatura silinebilir; kayıtlı fatura iptal edilir');
    expect(del.json().error.message).not.toContain('düzenlenebilir');

    // Aynı fiyat satırı iki kez: 409, kısıt adı yok, alan adı var
    const item = (await ok(c.post('/api/items', { name: 'Kum', vatCode: 'KDV-16' }))).item;
    const list = (await ok(c.post('/api/price-lists', { code: 'SL-1', name: 'Liste', kind: 'sales', currency: 'TRY' }))).list;
    await ok(c.post(`/api/price-lists/${list.id}/items`, { itemId: item.id, price: '95' }));
    const dup = await c.post(`/api/price-lists/${list.id}/items`, { itemId: item.id, price: '85' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'DUPLICATE', details: { field: 'itemId' } });
    expect(dup.body).not.toMatch(/_uq|constraint/);
    expect(mapError(Object.assign(new Error('x'), { code: '23505', constraint: 'some_internal_uq_name' }))).toEqual({ status: 409, code: 'DUPLICATE', message: 'Bu kayıt zaten mevcut' });

    // Puantaj ayı: zaten kapalı ayı kapatma da 422 (kapalı değil ayı açma ile aynı)
    const month = `${thisYear}-01`;
    expect((await ok(c.post('/api/attendance/months/close', { month }))).lock.closed).toBe(true);
    const twice = await c.post('/api/attendance/months/close', { month });
    expect(twice.statusCode).toBe(422);
    expect(twice.json().error.code).toBe('ATTENDANCE_MONTH_CLOSED');
    const notClosed = await c.post('/api/attendance/months/reopen', { month: `${thisYear}-02`, reason: 'kapalı olmayan ay' });
    expect(notClosed.statusCode).toBe(422);
    expect(notClosed.json().error.code).toBe('ATTENDANCE_MONTH_NOT_CLOSED');
  });

  it('API-11: dönem kapat/aç tekrarında 409 (kapanış bilgisi ezilmez)', async () => {
    const { c } = await world('Rob11P');
    const periods = (await ok(c.get(`/api/periods?year=${thisYear}`))).periods as { id: string; month: number }[];
    const jan = periods.find((p) => p.month === 1)!;
    const first = (await ok(c.post(`/api/periods/${jan.id}/close`))).period;
    const again = await c.post(`/api/periods/${jan.id}/close`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('PERIOD_ALREADY_CLOSED');
    const now = (await ok(c.get(`/api/periods?year=${thisYear}`))).periods.find((p: { id: string }) => p.id === jan.id);
    expect(now.closedAt).toBe(first.closedAt);
    await ok(c.post(`/api/periods/${jan.id}/reopen`));
    const reopenAgain = await c.post(`/api/periods/${jan.id}/reopen`);
    expect(reopenAgain.statusCode).toBe(409);
    expect(reopenAgain.json().error.code).toBe('PERIOD_ALREADY_OPEN');
  });

  it('API-11: siparişten ikinci açık taslak (irsaliye/fatura) açılmaz', async () => {
    const { c } = await world('Rob11S');
    const cust = await party(c, 'Müşteri');
    const wh = ((await ok(c.get('/api/warehouses'))).warehouses as { id: string; isDefault: boolean }[]).find((w) => w.isDefault)!;
    const item = (await ok(c.post('/api/items', { name: 'Çimento', vatCode: 'KDV-16', salePrice: '100' }))).item;
    await ok(c.post('/api/stock-documents', { type: 'receipt', docDate: day(3, 1), warehouseId: wh.id, lines: [{ itemId: item.id, quantity: '10', unitCost: '50' }] }));
    const order = (await ok(c.post('/api/sales-docs', { kind: 'order', partyId: cust.id, docDate: day(3, 2), warehouseId: wh.id, lines: [{ itemId: item.id, quantity: '6', unitPrice: '100' }, { description: 'Nakliye', quantity: '1', unitPrice: '50' }] }))).doc;
    await ok(c.post(`/api/sales-docs/${order.id}/confirm`, {}));

    const dn = await ok(c.post(`/api/sales-docs/${order.id}/delivery-note`, {}));
    const dn2 = await c.post(`/api/sales-docs/${order.id}/delivery-note`, {});
    expect(dn2.statusCode).toBe(409);
    expect(dn2.json().error).toMatchObject({ code: 'SO_DRAFT_EXISTS', details: { noteId: dn.noteId } });
    const inv = await ok(c.post(`/api/sales-docs/${order.id}/invoice`, {}));
    const inv2 = await c.post(`/api/sales-docs/${order.id}/invoice`, {});
    expect(inv2.statusCode).toBe(409);
    expect(inv2.json().error).toMatchObject({ code: 'SO_DRAFT_EXISTS', details: { invoiceId: inv.invoiceId } });
    // Taslak silinince (ya da kaydedilince) yeniden açılabilir
    await ok(c.delete(`/api/delivery-notes/${dn.noteId}`), [200, 204]);
    expect((await c.post(`/api/sales-docs/${order.id}/delivery-note`, {})).statusCode).toBe(201);
    // Eşzamanlı iki istek: biri 201, diğeri 409
    await ok(c.delete(`/api/invoices/${inv.invoiceId}`), [200, 204]);
    const both = await Promise.all([c.post(`/api/sales-docs/${order.id}/invoice`, {}), c.post(`/api/sales-docs/${order.id}/invoice`, {})]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('API-11: aynı bilgilerle (aynı numara dahil) yabancı belge yenilemesi geçmişe ikinci kez yazılmaz', async () => {
    const { c } = await world('Rob11F');
    const emp = (await ok(c.post('/api/employees', { fullName: 'Ali Veli', nationality: 'Test-Uyruk', hireDate: '2020-01-01' }))).employee;
    const typeId = ((await ok(c.get('/api/foreign-workers/doc-types'))).types as { id: string; code: string }[]).find((t) => t.code === 'WORK_PERMIT')!.id;
    const docRow = (await ok(c.post('/api/foreign-workers/documents', { employeeId: emp.id, typeId, documentNo: 'TST-123456', issueDate: '2020-01-01', expiryDate: day(12, 31) }))).doc;
    const body = { issueDate: '2020-01-01', expiryDate: day(12, 31), documentNo: 'TST-123456' };
    const same = await c.post(`/api/foreign-workers/documents/${docRow.id}/renew`, body);
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('RENEWAL_NO_CHANGE');
    const next = { ...body, expiryDate: day(12, 31, thisYear + 1) };
    await ok(c.post(`/api/foreign-workers/documents/${docRow.id}/renew`, next));
    const repeat = await c.post(`/api/foreign-workers/documents/${docRow.id}/renew`, next);
    expect(repeat.statusCode).toBe(409);
    const detail = await ok(c.get(`/api/foreign-workers/documents/${docRow.id}`));
    expect(detail.renewals).toHaveLength(1);
  });

  it('API-11: eşzamanlı DELETE (proje, cari, depo): biri başarılı, diğeri 404', async () => {
    const { c } = await world('Rob11D');
    const project = (await ok(c.post('/api/projects', { name: 'Silinecek', kind: 'own' }))).project;
    const p = await party(c, 'Silinecek Cari');
    const wh = (await ok(c.post('/api/warehouses', { name: 'Yan Depo' }))).warehouse;
    for (const url of [`/api/projects/${project.id}`, `/api/parties/${p.id}`, `/api/warehouses/${wh.id}`]) {
      const res = await Promise.all([c.delete(url), c.delete(url), c.delete(url)]);
      const codes = res.map((r) => r.statusCode).sort();
      expect(codes.filter((s) => s === 200 || s === 204), `${url}: ${codes}`).toHaveLength(1);
      expect(codes.filter((s) => s === 404), `${url}: ${codes}`).toHaveLength(2);
    }
  });
});
