import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { asDb, asOwner, day, execAsOwner, expectDbError, makeApp, thisYear } from './helpers';
import { x2Kit } from './x2-helpers';

/**
 * Gider kartları ve gider fişi (Faz X4). KDV kodu ve stopaj oranı KULLANICI verisidir; hesap eşlemeleri (191/320/360) varsayılan ve
 * DOĞRULANMAMIŞTIR: testler davranışı (yevmiye dengesi, kırılımlar, korumalar) sınar, vergi doğruluğunu değil.
 */
describe('gider kartları ve raporları (Faz X4)', async () => {
  const { app, handle } = await makeApp();
  const k = x2Kit(app);

  async function world(name: string) {
    const ctx = await k.setup(name);
    const { c } = ctx;
    const ok = async (r: Promise<{ statusCode: number; body: string; json: () => any }>, code = 200) => {
      const res = await r;
      if (res.statusCode !== code) throw new Error(`beklenen ${code}, gelen ${res.statusCode}: ${res.body}`);
      return res.json();
    };
    const card = async (body: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/expense-cards', { code: `GK${Math.random().toString(36).slice(2, 6)}`, name: 'Nakliye', accountId: ctx.ids['632'], taxCode: 'KDV-16', ...body }, ), 201)).card as any;
    const bank = async (n = 'Banka TL', currency = 'TRY', kind = 'bank') => (await ok(c.post('/api/treasury/accounts', { kind, name: n, currency }), 201)).account as { id: string; accountId: string; accountCode: string };
    const supplier = (n = 'Nakliyat A.Ş.') => k.mkParty(c, n, 'supplier');
    const entry = async (body: Record<string, unknown>, code = 201) => (await ok(c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'Mart nakliye', net: '1000', ...body }), code)).entry as any;
    const je = async (e: any) => k.journalOf(c, e.journalEntryId);
    const balance = async (accountId: string) => {
      const list = (await ok(c.get('/api/treasury/accounts'))).accounts as any[];
      return Number(list.find((a) => a.id === accountId).balance ?? list.find((a) => a.id === accountId).balanceDoc);
    };
    const report = async (q = `from=${day(1, 1)}&to=${day(12, 31)}`) => ok(c.get(`/api/expense-entries/report?${q}`));
    return { ...ctx, ok, card, bank, supplier, entry, je, balance, report };
  }

  it('gider kartı: hesap gider/maliyet olmalı, KDV kodu var olmalı, kod tekil; düzenle, pasifleştir, kullanılmışsa silinemez', async () => {
    const w = await world('GdrKart');
    const bad = await w.c.post('/api/expense-cards', { code: 'A1', name: 'Hatalı', accountId: w.ids['120'] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('EXPENSE_ACCOUNT_INVALID');
    const noTax = await w.c.post('/api/expense-cards', { code: 'A2', name: 'KDVsiz', accountId: w.ids['632'], taxCode: 'YOK-99' });
    expect(noTax.json().error.code).toBe('TAX_CODE_NOT_FOUND');
    expect((await w.c.post('/api/expense-cards', { code: 'A3', name: 'Oran', accountId: w.ids['632'], withholdingRate: '101' })).statusCode).toBe(400);
    const c1 = await w.card({ code: 'nkl', withholdingRate: '10', notes: 'Kullanıcı verisi' });
    expect(c1).toMatchObject({ code: 'NKL', accountId: w.ids['632'], taxCode: 'KDV-16', withholdingRate: '10.0000' });
    expect((await w.c.post('/api/expense-cards', { code: 'NKL', name: 'Aynı', accountId: w.ids['632'] })).statusCode).toBe(409);
    const upd = await w.ok(w.c.patch(`/api/expense-cards/${c1.id}`, { name: 'Nakliye ve taşıma', taxCode: null, withholdingRate: null }));
    expect(upd.card).toMatchObject({ name: 'Nakliye ve taşıma', taxCode: null, withholdingRate: null });
    const list = (await w.ok(w.c.get('/api/expense-cards'))).cards as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ accountCode: '632', entryCount: 0 });
    const bank = await w.bank();
    await w.entry({ cardId: c1.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    const del = await w.c.delete(`/api/expense-cards/${c1.id}`);
    expect(del.statusCode).toBe(422);
    expect(del.json().error.code).toBe('EXPENSE_RULE_VIOLATION');
    await w.ok(w.c.patch(`/api/expense-cards/${c1.id}`, { isActive: false }));
    expect(((await w.ok(w.c.get('/api/expense-cards'))).cards as any[])).toHaveLength(0);
    expect(((await w.ok(w.c.get('/api/expense-cards?all=true'))).cards as any[])).toHaveLength(1);
    const inactive = await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '1', cardId: c1.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    expect(inactive.json().error.code).toBe('EXPENSE_CARD_INACTIVE');
    const unused = await w.card({ code: 'BOS' });
    expect((await w.c.delete(`/api/expense-cards/${unused.id}`)).statusCode).toBe(204);
  });

  it('banka ödemeli gider: KDV kartın kodundan, yevmiye dengeli, banka bakiyesi düşer, numara boşluksuz', async () => {
    const w = await world('GdrBanka');
    const card = await w.card();
    const bank = await w.bank();
    const e1 = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id, documentRef: 'Fiş-123 (taranmış kopya: ek klasör 4)' });
    expect(e1).toMatchObject({ entryNo: `GDF-${thisYear}-000001`, status: 'posted', net: '1000.0000', vatCode: 'KDV-16', vatRate: '16.0000', vat: '160.0000', gross: '1160.0000', withholding: '0.0000', payable: '1160.0000', documentRef: 'Fiş-123 (taranmış kopya: ek klasör 4)', paymentKind: 'treasury' });
    const j = await w.je(e1);
    expect(j.byCode('632')).toEqual([['632', 1000, 0]]);
    expect(j.byCode('191')).toEqual([['191', 160, 0]]);
    expect(j.byCode(bank.accountCode)).toEqual([[bank.accountCode, 0, 1160]]);
    expect(j.entry.status).toBe('posted');
    expect(await w.balance(bank.id)).toBe(-1160);
    // KDV'yi açıkça kapat: vat 0
    const e2 = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id, taxCode: null, net: '200.50' });
    expect(e2).toMatchObject({ entryNo: `GDF-${thisYear}-000002`, vat: '0.0000', gross: '200.5000', vatCode: null });
    // Hassasiyet: 3 ondalık reddedilir; kapalı/yanlış hesap para birimi
    const prec = await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '1.005', cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    expect(prec.json().error.code).toBe('AMOUNT_PRECISION');
    const gbp = await w.bank('Banka GBP', 'GBP');
    const fx = await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '10', cardId: card.id, paymentKind: 'treasury', treasuryAccountId: gbp.id });
    expect(fx.statusCode).toBe(422);
    expect(fx.json().error.code).toBe('EXPENSE_TREASURY_CURRENCY');
    // Kasa yetersiz bakiye
    const cash = await w.bank('Kasa TL', 'TRY', 'cash');
    const low = await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '10', cardId: card.id, paymentKind: 'treasury', treasuryAccountId: cash.id });
    expect(low.json().error.code).toBe('CASH_INSUFFICIENT');
  });

  it('stopaj kullanıcı oranıdır: ödenecek tutar brütten düşer, stopaj ayrı alacak satırı; yerine geçen oran ve brüt aşımı', async () => {
    const w = await world('GdrStopaj');
    const card = await w.card({ withholdingRate: '10' });
    const bank = await w.bank();
    const e = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    expect(e).toMatchObject({ withholdingRate: '10.0000', withholding: '100.0000', gross: '1160.0000', payable: '1060.0000' });
    const j = await w.je(e);
    expect(j.byCode(bank.accountCode)).toEqual([[bank.accountCode, 0, 1060]]);
    expect(j.byCode('360')).toEqual([['360', 0, 100]]);
    expect(j.lines.reduce((s: number, l: readonly [string, number, number]) => s + l[1] - l[2], 0)).toBe(0);
    // Gönderilen oran kartınkini ezer; null oranı kaldırır
    const e2 = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id, withholdingRate: '20' });
    expect(e2.withholding).toBe('200.0000');
    const e3 = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id, withholdingRate: null });
    expect(e3.withholding).toBe('0.0000');
    // Eşleme eksik: açık hata
    await execAsOwner(`delete from account_mappings where company_id = $1 and key = 'withholding_payable'`, [w.company.id]);
    const miss = await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '10', cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    expect(miss.json().error.code).toBe('ACCOUNT_MAPPING_MISSING');
  });

  it('cari ödemeli gider: tedarikçi cari alacaklanır, vade kayıtlı; müşteri carisi reddedilir; açık kalemde görünür', async () => {
    const w = await world('GdrCari');
    const card = await w.card();
    const sup = await w.supplier();
    const e = await w.entry({ cardId: card.id, paymentKind: 'party', partyId: sup.id, dueDate: day(4, 30) });
    expect(e).toMatchObject({ paymentKind: 'party', partyId: sup.id, dueDate: day(4, 30), payable: '1160.0000', treasuryAccountId: null });
    const j = await w.je(e);
    expect(j.byCode('320')).toEqual([['320', 0, 1160]]);
    const open = (await w.ok(w.c.get(`/api/parties/${sup.id}/open-items?asOf=${day(12, 31)}&type=payable`))).payable;
    expect(open.items).toHaveLength(1);
    expect(open.items[0]).toMatchObject({ remaining: '1160.00', dueDate: day(4, 30) });
    const cust = await k.mkParty(w.c, 'Müşteri', 'customer');
    const bad = await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '10', cardId: card.id, paymentKind: 'party', partyId: cust.id });
    expect(bad.json().error.code).toBe('PARTY_KIND_MISMATCH');
    // Cari ödemede cari, banka ödemesinde banka şart (şema)
    expect((await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '10', cardId: card.id, paymentKind: 'party' })).statusCode).toBe(400);
    expect((await w.c.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '10', cardId: card.id, paymentKind: 'treasury' })).statusCode).toBe(400);
    // Cariyi ödeme ile kapat: mevcut ödeme akışı kullanılır (cari ekstresi doğru)
    const bank = await w.bank();
    const pay = await w.c.post('/api/treasury/transactions', { type: 'payment', date: day(4, 1), accountId: bank.id, partyId: sup.id, amount: '1160', items: [{ lineId: open.items[0].lineId, amount: '1160', settleAmount: '1160' }] });
    expect(pay.statusCode).toBe(201);
    const after = (await w.ok(w.c.get(`/api/parties/${sup.id}/open-items?asOf=${day(12, 31)}&type=payable`))).payable;
    expect(after.items).toHaveLength(0);
  });

  it('proje boyutu: kartın proje/maliyet kodu varsayılanı gider satırına yazılır; fişte ezilir ya da kaldırılır', async () => {
    const w = await world('GdrProje');
    const p = (await w.ok(w.c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' }), 201)).project as { id: string; code: string };
    const codes = (await w.ok(w.c.get('/api/cost-codes'))).costCodes as any[];
    const cc = codes[0];
    const card = await w.card({ projectId: p.id, costCodeId: cc.id });
    const bank = await w.bank();
    const e1 = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    expect(e1).toMatchObject({ projectId: p.id, costCodeId: cc.id, projectCode: p.code });
    const l1 = (await w.ok(w.c.get(`/api/journal-entries/${e1.journalEntryId}`))).entry.lines as any[];
    expect(l1.find((l: any) => l.accountCode === '632')).toMatchObject({ projectId: p.id, costCodeId: cc.id });
    expect(l1.find((l: any) => l.accountCode === '191').projectId ?? null).toBeNull();
    const e2 = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id, projectId: null });
    expect(e2).toMatchObject({ projectId: null, costCodeId: null });
    // Proje maliyet raporunda görünür
    const cost = await w.ok(w.c.get(`/api/projects/${p.id}/cost-report`));
    expect(JSON.stringify(cost)).toContain('1000');
    // Kartta iş kalemi/maliyet kodu projesiz olamaz
    const bad = await w.c.post('/api/expense-cards', { code: 'PRJ', name: 'x', accountId: w.ids['632'], costCodeId: cc.id });
    expect(bad.statusCode).toBe(422);
  });

  it('iptal: ters yevmiye, banka bakiyesi geri gelir, rapordan düşer; ikinci iptal ve geçmiş tarih reddedilir', async () => {
    const w = await world('GdrIptal');
    const card = await w.card();
    const bank = await w.bank();
    const e = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    expect(await w.balance(bank.id)).toBe(-1160);
    const early = await w.c.post(`/api/expense-entries/${e.id}/cancel`, { reason: 'Hatalı giriş', date: day(3, 1) });
    expect(early.json().error.code).toBe('CANCEL_DATE_BEFORE_ENTRY');
    expect((await w.c.post(`/api/expense-entries/${e.id}/cancel`, { reason: '' })).statusCode).toBe(400);
    const c = (await w.ok(w.c.post(`/api/expense-entries/${e.id}/cancel`, { reason: 'Hatalı giriş', date: day(3, 12) }))).entry;
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Hatalı giriş' });
    expect(await w.balance(bank.id)).toBe(0);
    expect((await k.journalOf(w.c, c.cancelJournalEntryId)).byCode('632')).toEqual([['632', 0, 1000]]);
    expect((await w.report()).totals).toMatchObject({ count: 0 });
    const again = await w.c.post(`/api/expense-entries/${e.id}/cancel`, { reason: 'tekrar' });
    expect(again.json().error.code).toBe('EXPENSE_ALREADY_CANCELLED');
    // Fişin yevmiyesi tek başına ters çevrilemez (kaynaklı)
    const direct = await w.c.post(`/api/journal-entries/${e.journalEntryId}/reverse`, { reason: 'x' });
    expect(direct.statusCode).toBe(422);
    expect(direct.json().error.code).toBe('ENTRY_HAS_SOURCE');
    // Silme yok; iptal edilmiş fişler listede durur
    const list = await w.ok(w.c.get('/api/expense-entries'));
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0].status).toBe('cancelled');
    expect(list.totals).toEqual({ net: '0', gross: '0' });
  });

  it('veritabanı korumaları (tablo sahibi olarak): kaydedilmiş fiş değişmez/silinmez, iptal ters yevmiye ister, kart hesabı gider olmalı', async () => {
    const w = await world('GdrDb');
    const card = await w.card();
    const bank = await w.bank();
    const e = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update expense_entries set description = 'x' where id = $1`, [e.id])).code).toBe('ERP19');
      expect((await expectDbError(q, `delete from expense_entries where id = $1`, [e.id])).code).toBe('ERP19');
      // Ters yevmiyesiz iptal
      const x = await expectDbError(q, `update expense_entries set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x', cancel_journal_entry_id = journal_entry_id where id = $1`, [e.id]);
      expect(x.code).toBe('ERP19');
      // Başka bir fişin yevmiyesiyle kaynaksız ekleme
      const y = await expectDbError(q, `insert into expense_entries (id, company_id, entry_no, entry_date, card_id, description, payment_kind, treasury_account_id, net, vat, withholding, gross, payable, journal_entry_id)
        select gen_random_uuid(), company_id, 'GDF-X', entry_date, card_id, 'x', 'treasury', treasury_account_id, 1, 0, 0, 1, 1, journal_entry_id from expense_entries where id = $1`, [e.id]);
      expect(y.code).toBe('ERP19');
      // Tutar tutarsızlığı kısıtı
      const z = await expectDbError(q, `update expense_cards set account_id = (select id from accounts where company_id = $1 and code = '120') where id = $2`, [w.company.id, card.id]);
      expect(z.code).toBe('ERP19');
      expect((await expectDbError(q, `delete from expense_cards where id = $1`, [card.id])).code).toBe('ERP19');
    });
  });

  it('raporlar: kart, ay, proje, cari kırılımları ve en yüksek giderler aynı toplamı verir; süzgeçler; iptal ve dönem dışı hariç', async () => {
    const w = await world('GdrRapor');
    const p = (await w.ok(w.c.post('/api/projects', { name: 'Site A', kind: 'own' }), 201)).project as { id: string };
    const nakliye = await w.card({ code: 'NKL', name: 'Nakliye' });
    const kira = await w.card({ code: 'KIRA', name: 'Kira', taxCode: null, projectId: p.id });
    const bank = await w.bank();
    const s1 = await w.supplier('Nakliyat A.Ş.');
    const s2 = await w.supplier('Kiraya Veren');
    const b = (extra: Record<string, unknown>) => w.entry({ paymentKind: 'treasury', treasuryAccountId: bank.id, ...extra });
    await b({ cardId: nakliye.id, entryDate: day(1, 15), net: '1000', partyId: s1.id });
    await b({ cardId: nakliye.id, entryDate: day(2, 15), net: '500', partyId: s1.id });
    await b({ cardId: kira.id, entryDate: day(2, 20), net: '3000', partyId: s2.id });
    const gone = await b({ cardId: kira.id, entryDate: day(3, 1), net: '9999', partyId: s2.id });
    await w.ok(w.c.post(`/api/expense-entries/${gone.id}/cancel`, { reason: 'Hatalı', date: day(3, 2) }));
    await b({ cardId: nakliye.id, entryDate: day(12, 20), net: '777' });
    const r = await w.report(`from=${day(1, 1)}&to=${day(12, 1)}`);
    expect(r.totals).toMatchObject({ count: 3, net: '4500.0000', vat: '240.0000', gross: '4740.0000' });
    expect(r.byCard.map((x: any) => [x.cardCode, x.count, x.net])).toEqual([['KIRA', 1, '3000.0000'], ['NKL', 2, '1500.0000']]);
    expect(r.byMonth.map((x: any) => [x.month, x.net])).toEqual([[`${thisYear}-01`, '1000.0000'], [`${thisYear}-02`, '3500.0000']]);
    expect(r.byProject.map((x: any) => [x.projectId ? 'P' : null, x.net])).toEqual([['P', '3000.0000'], [null, '1500.0000']]);
    expect(r.byParty.map((x: any) => [x.partyName, x.net])).toEqual([['Kiraya Veren', '3000.0000'], ['Nakliyat A.Ş.', '1500.0000']]);
    expect(r.top.map((x: any) => x.net)).toEqual(['3000.0000', '1000.0000', '500.0000']);
    // Her kırılımın toplamı genel toplama eşit
    for (const key of ['byCard', 'byMonth', 'byProject', 'byParty']) expect(r[key].reduce((s: number, x: any) => s + Number(x.net), 0)).toBe(4500);
    // Süzgeçler ve top sınırı
    const f = await w.report(`from=${day(1, 1)}&to=${day(12, 1)}&cardId=${nakliye.id}&top=1`);
    expect(f.totals).toMatchObject({ count: 2, net: '1500.0000' });
    expect(f.top).toHaveLength(1);
    expect((await w.report(`from=${day(1, 1)}&to=${day(12, 1)}&projectId=${p.id}`)).totals).toMatchObject({ count: 1, net: '3000.0000' });
    expect((await w.report(`from=${day(1, 1)}&to=${day(12, 1)}&partyId=${s1.id}`)).totals).toMatchObject({ count: 2 });
    expect((await w.c.get(`/api/expense-entries/report?from=${day(5, 1)}&to=${day(4, 1)}`)).statusCode).toBe(400);
    expect((await w.report(`from=${day(6, 1)}&to=${day(6, 30)}`)).totals).toMatchObject({ count: 0, net: '0' });
    // Liste süzgeçleri
    const list = await w.ok(w.c.get(`/api/expense-entries?from=${day(1, 1)}&to=${day(12, 1)}&cardId=${kira.id}`));
    expect(list.entries).toHaveLength(2);
    expect(list.totals.net).toBe('3000.0000');
    expect((await w.ok(w.c.get(`/api/expense-entries?q=kiraya`))).entries).toHaveLength(2);

    // Dışa aktarma: xlsx (5 sayfa) ve csv
    const x = await w.c.get(`/api/exports/expense-report?from=${day(1, 1)}&to=${day(12, 1)}&format=xlsx`);
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-disposition']).toMatch(/gider-raporu-\d{4}-01-01-\d{4}-12-01\.xlsx/);
    const sheets = readXlsx(new Uint8Array(x.rawPayload));
    expect(sheets.map((s) => s.name)).toEqual(['Kartlara göre', 'Aylık', 'Projelere göre', 'Cariye göre', 'En yüksek']);
    expect(sheets[0]!.rows.slice(4).map((row) => row[0])).toEqual(['KIRA Kira', 'NKL Nakliye', 'Toplam']);
    const csv = await w.c.get(`/api/exports/expense-report?from=${day(1, 1)}&to=${day(12, 1)}&format=csv`);
    expect(csv.statusCode).toBe(200);
    const reg = await w.c.get(`/api/exports/expense-entries?format=csv`);
    expect(reg.statusCode).toBe(200);
    expect(reg.body).toContain('GDF-');
    expect(reg.body).toContain('İptal');
  });

  it('RLS ve yetki: başka şirket göremez; izleyici okur, satış temsilcisi giremez, muhasebeci girer; modül kapalıyken uçlar kapanır', async () => {
    const w = await world('GdrYetki');
    const card = await w.card();
    const bank = await w.bank();
    const e = await w.entry({ cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id });
    const other = await k.setup('GdrBaska');
    expect((await other.c.get(`/api/expense-entries/${e.id}`)).statusCode).toBe(404);
    expect((await other.c.get('/api/expense-cards')).json().cards).toHaveLength(0);
    await asDb(handle, { companyId: other.company.id }, async (q) => {
      expect((await q(`select count(*)::int as n from expense_entries`)).rows[0].n).toBe(0);
      expect((await q(`select count(*)::int as n from expense_cards`)).rows[0].n).toBe(0);
    });
    const viewer = await k.memberClient(w.c, w.company.id, 'viewer');
    expect((await viewer.get('/api/expense-entries')).statusCode).toBe(200);
    expect((await viewer.post('/api/expense-entries', { entryDate: day(3, 10), description: 'x', net: '1', cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id })).statusCode).toBe(403);
    expect((await viewer.post('/api/expense-cards', { code: 'V', name: 'v', accountId: w.ids['632'] })).statusCode).toBe(403);
    expect((await viewer.post(`/api/expense-entries/${e.id}/cancel`, { reason: 'x' })).statusCode).toBe(403);
    const sales = await k.memberClient(w.c, w.company.id, 'sales');
    expect((await sales.get('/api/expense-entries')).statusCode).toBe(403);
    const acc = await k.memberClient(w.c, w.company.id, 'accountant');
    expect((await acc.post('/api/expense-entries', { entryDate: day(3, 10), description: 'Muhasebeci', net: '5', cardId: card.id, paymentKind: 'treasury', treasuryAccountId: bank.id })).statusCode).toBe(201);
    expect((await w.c.put('/api/company/modules/treasury.expenses', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.get('/api/expense-entries')).statusCode).toBe(403);
    expect((await w.c.get('/api/exports/expense-entries?format=csv')).statusCode).toBe(403);
  });
});
