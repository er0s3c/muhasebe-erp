import { todayIso } from '@erp/shared';
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { accountIds, addMember, asDb, asOwner, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

/**
 * Çek/senet portföyü ve takas (Faz X1). Hesap eşlemeleri (101/121/108/103/321) DOĞRULANMAMIŞ varsayılanlardır; bu testler yalnızca
 * davranışı (yevmiye dengesi, cari kalem kapama/yeniden açma, geçiş korumaları) sınar, yasal doğruluğu değil.
 */
const TODAY = todayIso();
const addDays = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ISSUE = '2020-01-01';

describe('çek/senet portföyü ve takas (Faz X1)', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const party = async (n: string, kind = 'customer') => (await c.post('/api/parties', { name: n, kind })).json().party as { id: string };
    const bankAcct = async (n: string, kind: 'bank' | 'cash' = 'bank', currency = 'TRY') => (await c.post('/api/treasury/accounts', { kind, name: n, currency })).json().account as { id: string; accountId: string; accountCode: string };
    const sale = async (partyId: string, amount: string, currency = 'TRY', fx?: string) => {
      const r = await c.post('/api/invoices', { post: true, type: 'sales', partyId, invoiceDate: day(3, 1), currency, ...(fx ? { fxRate: fx } : {}), lines: [{ description: 'Hizmet', quantity: '1', unitPrice: amount }] });
      if (r.statusCode !== 201) throw new Error(r.body);
    };
    const expense = async (partyId: string, amount: string, no: string) => {
      const r = await c.post('/api/invoices', { post: true, type: 'expense', partyId, invoiceDate: day(3, 1), externalNo: no, currency: 'TRY', lines: [{ description: 'Gider', quantity: '1', unitPrice: amount }] });
      if (r.statusCode !== 201) throw new Error(r.body);
    };
    const open = async (partyId: string, type: 'receivable' | 'payable' = 'receivable') =>
      (await c.get(`/api/parties/${partyId}/open-items?asOf=${addDays(400)}&type=${type}`)).json()[type] as {
        items: { lineId: string; amount: string; remaining: string; remainingBase: string; description: string; dueDate: string }[];
        unapplied: string;
      };
    const cheque = async (body: Record<string, unknown>, status = 201) => {
      const r = await c.post('/api/cheques', { direction: 'received', docType: 'cheque', bankName: 'Test Bankası', issueDate: ISSUE, dueDate: addDays(30), registerDate: TODAY, ...body });
      if (r.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${r.statusCode}: ${r.body}`);
      return r.json() as { cheque: Record<string, any>; events: Record<string, any>[] };
    };
    const act = (body: Record<string, unknown>) => c.post('/api/cheques/actions', { date: TODAY, ...body });
    const acted = async (body: Record<string, unknown>) => {
      const r = await act(body);
      if (r.statusCode !== 200) throw new Error(`eylem başarısız (${r.statusCode}): ${r.body}`);
      return r.json() as { batch: Record<string, any>; cheques: Record<string, any>[] };
    };
    const journal = async (entryId: string) => {
      const e = (await c.get(`/api/journal-entries/${entryId}`)).json().entry;
      const lines = e.lines.map((l: any) => ({ code: l.accountCode as string, d: Number(l.debitBase), c: Number(l.creditBase), partyId: l.partyId as string | null }));
      const bal = lines.reduce((s: number, l: any) => s + l.d - l.c, 0);
      return { entry: e, lines, balanced: Math.abs(bal) < 0.0001, of: (code: string) => lines.filter((l: any) => l.code === code) as { code: string; d: number; c: number; partyId: string | null }[] };
    };
    const closing = async () => {
      const tb = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
      return (code: string) => Number(Object.fromEntries(tb.rows.map((r: any) => [r.code, r.closing]))[code] ?? 0);
    };
    const get = async (id: string) => (await c.get(`/api/cheques/${id}`)).json() as { cheque: Record<string, any>; events: Record<string, any>[] };
    return { s, company, c, ids, orgId, party, bankAcct, sale, expense, open, cheque, act, acted, journal, closing, get };
  }
  type W = Awaited<ReturnType<typeof world>>;
  void ({} as W);

  it('hesap eşlemeleri: beş yeni anahtar varsayılanlarla gelir (doğrulanmamış), eşleme ekranından değiştirilebilir', async () => {
    const w = await world('ChqMap');
    const list = (await w.c.get('/api/account-mappings')).json().mappings as any[];
    const by = Object.fromEntries(list.map((m) => [m.key, m.accountCode]));
    expect(by).toMatchObject({ cheque_portfolio: '101', note_portfolio: '121', docs_in_collection: '108', cheque_issued: '103', note_payable: '321' });
    // Geri doldurma: DB'deki tüm şirketlerde beş anahtar da vardır
    const miss = await execAsOwner(`select count(*)::int as n from companies c where (select count(*) from account_mappings m where m.company_id = c.id and m.key in ('cheque_portfolio','note_portfolio','docs_in_collection','cheque_issued','note_payable')) <> 5`);
    expect(miss.rows[0].n).toBe(0);
  });

  it('alınan çek: kayıt cari kalemi kapatır (kısmi), kalan avans; yevmiye dengeli; aynı kalem başka yoldan fazla kapatılamaz', async () => {
    const w = await world('ChqKayit');
    const cust = await w.party('Ali Yılmaz');
    await w.sale(cust.id, '1000');
    const inv = (await w.open(cust.id)).items[0]!;
    const c1 = await w.cheque({ docNo: 'C-1', partyId: cust.id, amount: '600', items: [{ lineId: inv.lineId, amount: '600', settleAmount: '600' }] });
    expect(c1.cheque).toMatchObject({ status: 'portfolio', direction: 'received', docType: 'cheque', amount: '600.0000', currencyCode: 'TRY', partyName: 'Ali Yılmaz' });
    expect(c1.events).toHaveLength(1);
    expect(c1.events[0]).toMatchObject({ fromStatus: null, toStatus: 'portfolio' });
    const j1 = await w.journal(c1.cheque.entryId);
    expect(j1.balanced).toBe(true);
    expect(j1.of('101')).toEqual([expect.objectContaining({ d: 600, c: 0 })]);
    expect(j1.of('120')).toEqual([expect.objectContaining({ d: 0, c: 600, partyId: cust.id })]);
    let o = await w.open(cust.id);
    expect(o.items[0]!.remaining).toMatch(/^400/);

    // Kalem kapatmadan: tüm tutar avans, FIFO ile kalan 400'ü kapatır, 100 fazla
    const c2 = await w.cheque({ docNo: 'C-2', partyId: cust.id, amount: '500' });
    o = await w.open(cust.id);
    expect(o.items).toHaveLength(0);
    expect(Number(o.unapplied)).toBe(100);
    expect((await w.journal(c2.cheque.entryId)).balanced).toBe(true);

    // Yeni fatura; çekle 700'ü açıkça kapat, ardından aynı kalemi kasa/banka tahsilatıyla fazla kapatmaya çalış
    await w.sale(cust.id, '300');
    const items = (await w.open(cust.id)).items;
    expect(items).toHaveLength(1);
    const line = items[0]!;
    const over = await w.cheque({ docNo: 'C-3', partyId: cust.id, amount: '400', items: [{ lineId: line.lineId, amount: '400', settleAmount: '400' }] }, 422);
    expect((over as any).error.code).toBe('ALLOCATION_EXCEEDED');
    await w.cheque({ docNo: 'C-3', partyId: cust.id, amount: '200', items: [{ lineId: line.lineId, amount: '200', settleAmount: '200' }] });
    const bank = await w.bankAcct('KTB TL');
    const rec = await w.c.post('/api/treasury/transactions', { type: 'receipt', date: TODAY, accountId: bank.id, partyId: cust.id, amount: '200', items: [{ lineId: line.lineId, amount: '200', settleAmount: '200' }] });
    expect(rec.statusCode).toBe(422);
    expect(rec.json().error.code).toBe('ITEM_NOT_OPEN'); // kalem çekle tümüyle kapandı
    // TB: portföy = 600 + 500 + 200
    expect((await w.closing())('101')).toBe(1300);
  });

  it('döviz faturası TL çekle kapanır: kur farkı yevmiyeye yazılır (tahsilatla aynı mantık)', async () => {
    const w = await world('ChqFx');
    const cust = await w.party('Sarah Thompson');
    await w.sale(cust.id, '100', 'GBP', '40');
    const item = (await w.open(cust.id)).items[0]!;
    const r = await w.cheque({ docNo: 'F-1', partyId: cust.id, amount: '4500', items: [{ lineId: item.lineId, amount: '100', settleAmount: '4500' }] });
    const j = await w.journal(r.cheque.entryId);
    expect(j.balanced).toBe(true);
    expect(j.of('101')[0]!.d).toBe(4500);
    expect(j.of('646')[0]!.c).toBe(500); // kambiyo kârı
    expect((await w.open(cust.id)).items).toHaveLength(0);
  });

  it('yaşam döngüsü: tahsile ver → tahsil; yevmiyeler dengeli, geçmiş sıralı; karşılıksız cari alacağı yeniden açar', async () => {
    const w = await world('ChqDongu');
    const cust = await w.party('Veli Demir');
    const bank = await w.bankAcct('KTB TL');
    await w.sale(cust.id, '700');
    const item = (await w.open(cust.id)).items[0]!;
    const a = await w.cheque({ docNo: 'D-1', partyId: cust.id, amount: '700', items: [{ lineId: item.lineId, amount: '700', settleAmount: '700' }] });
    const id = a.cheque.id as string;
    expect((await w.open(cust.id)).items).toHaveLength(0);

    const dep = await w.acted({ action: 'deposit', chequeIds: [id], bankAccountId: bank.id });
    expect(dep.cheques[0]).toMatchObject({ status: 'in_collection', bankAccountId: bank.id });
    expect(dep.batch.batchNo).toMatch(/^CTK-\d{4}-000001$/);
    const jd = await w.journal(dep.batch.entryId);
    expect(jd.balanced).toBe(true);
    expect(jd.of('108')[0]!.d).toBe(700);
    expect(jd.of('101')[0]!.c).toBe(700);
    let cl = await w.closing();
    expect([cl('101'), cl('108')]).toEqual([0, 700]);

    // Karşılıksız: 108 → 120 (yeni açık kalem), bankaya hiçbir şey girmez
    const bounce = await w.acted({ action: 'bounce', chequeIds: [id], note: 'Hesapta karşılık yok' });
    expect(bounce.cheques[0]!.status).toBe('bounced');
    const jb = await w.journal(bounce.batch.entryId);
    expect(jb.balanced).toBe(true);
    expect(jb.of('120')[0]).toMatchObject({ d: 700, partyId: cust.id });
    expect(jb.of('108')[0]!.c).toBe(700);
    const reopened = await w.open(cust.id);
    expect(reopened.items).toHaveLength(1);
    expect(Number(reopened.items[0]!.remaining)).toBe(700);
    expect(reopened.items[0]!.description).toContain('Karşılıksız');
    cl = await w.closing();
    expect([cl('108'), cl('120'), cl('102.001')]).toEqual([0, 700, 0]);
    // Karşılıksız belge artık hiçbir eyleme girmez
    expect((await w.act({ action: 'collect', chequeIds: [id] })).json().error.code).toBe('CHEQUE_STATUS_INVALID');

    // Aynı müşteriden ikinci çek: tahsile ver → tahsil: banka bakiyesi
    const b = await w.cheque({ docNo: 'D-2', partyId: cust.id, amount: '250' });
    await w.acted({ action: 'deposit', chequeIds: [b.cheque.id], bankAccountId: bank.id });
    const coll = await w.acted({ action: 'collect', chequeIds: [b.cheque.id] });
    expect(coll.cheques[0]).toMatchObject({ status: 'collected' });
    const jc = await w.journal(coll.batch.entryId);
    expect(jc.balanced).toBe(true);
    expect(jc.of('102.001')[0]!.d).toBe(250);
    expect(jc.of('108')[0]!.c).toBe(250);
    const hist = (await w.get(b.cheque.id)).events.map((e) => `${e.fromStatus ?? '-'}>${e.toStatus}`);
    expect(hist).toEqual(['->portfolio', 'portfolio>in_collection', 'in_collection>collected']);
    expect((await w.c.get(`/api/treasury/accounts/${bank.id}`)).json().account.balance).toBe('250.0000');
  });

  it('takas: birden çok çek/senet tek toplu işlemle tahsile verilir ve tahsil edilir (tek yevmiye, tek banka satırı); farklı bankaya verilenler birlikte tahsil edilemez', async () => {
    const w = await world('ChqTakas');
    const a = await w.party('Müşteri A');
    const b = await w.party('Müşteri B');
    const bank = await w.bankAcct('KTB TL');
    const bank2 = await w.bankAcct('İş TL');
    const c1 = await w.cheque({ docNo: 'T-1', partyId: a.id, amount: '100' });
    const c2 = await w.cheque({ docNo: 'T-2', partyId: b.id, amount: '200' });
    const n1 = await w.cheque({ docNo: 'S-1', docType: 'note', partyId: b.id, amount: '300', bankName: '' });
    const ids = [c1, c2, n1].map((x) => x.cheque.id as string);
    const dep = await w.acted({ action: 'deposit', chequeIds: ids, bankAccountId: bank.id, note: 'Haftalık takas' });
    expect(dep.batch).toMatchObject({ docCount: 3, total: '600.00' });
    const jd = await w.journal(dep.batch.entryId);
    expect(jd.balanced).toBe(true);
    expect(jd.lines).toHaveLength(3); // 108 toplu borç + 101 + 121 alacak
    expect(jd.of('108')[0]!.d).toBe(600);
    expect(jd.of('101')[0]!.c).toBe(300);
    expect(jd.of('121')[0]!.c).toBe(300);
    const coll = await w.acted({ action: 'collect', chequeIds: ids });
    const jc = await w.journal(coll.batch.entryId);
    expect(jc.lines).toHaveLength(2);
    expect(jc.of('102.001')).toEqual([expect.objectContaining({ d: 600 })]);
    expect(coll.cheques.every((x) => x.status === 'collected')).toBe(true);
    expect((await w.c.get(`/api/treasury/accounts/${bank.id}`)).json().account.balance).toBe('600.0000');
    const batches = (await w.c.get('/api/cheques/batches')).json().batches as any[];
    expect(batches.map((x) => x.action)).toEqual(expect.arrayContaining(['deposit', 'collect']));
    expect(batches).toHaveLength(2);

    // Farklı banka hesabına verilenler tek tahsilde toplanamaz
    const d1 = await w.cheque({ docNo: 'T-3', partyId: a.id, amount: '10' });
    const d2 = await w.cheque({ docNo: 'T-4', partyId: a.id, amount: '20' });
    await w.acted({ action: 'deposit', chequeIds: [d1.cheque.id], bankAccountId: bank.id });
    await w.acted({ action: 'deposit', chequeIds: [d2.cheque.id], bankAccountId: bank2.id });
    expect((await w.act({ action: 'collect', chequeIds: [d1.cheque.id, d2.cheque.id] })).json().error.code).toBe('CHEQUE_BANK_MISMATCH');
    // Bir belge uygun durumda değilse tüm işlem geri alınır
    const e1 = await w.cheque({ docNo: 'T-5', partyId: a.id, amount: '5' });
    const bad = await w.act({ action: 'deposit', chequeIds: [e1.cheque.id, d1.cheque.id], bankAccountId: bank.id });
    expect(bad.statusCode).toBe(422);
    expect((await w.get(e1.cheque.id)).cheque.status).toBe('portfolio');
    // Önceki işlem tarihinden önceye işlem yapılamaz
    expect((await w.act({ action: 'collect', chequeIds: [d1.cheque.id], date: addDays(-1) })).json().error.code).toBe('CHEQUE_DATE_BEFORE_EVENT');
  });

  it('ciro: tedarikçi borcunu kapatır (kalem + avans); portföy hesapları belge türüne göre bölünür; ciro iadesi borcu yeniden açar; iade müşteri alacağını yeniden açar', async () => {
    const w = await world('ChqCiro');
    const cust = await w.party('Müşteri');
    const sup = await w.party('Tedarikçi', 'supplier');
    await w.expense(sup.id, '1000', 'G-1');
    const bill = (await w.open(sup.id, 'payable')).items[0]!;
    const c1 = await w.cheque({ docNo: 'E-1', partyId: cust.id, amount: '800' });
    const n1 = await w.cheque({ docNo: 'E-2', docType: 'note', partyId: cust.id, amount: '500', bankName: '' });
    // Müşteri belgesini tedarikçiye ciro: tedarikçi kalemi 1000'in 900'ü kapanır, kalan 400 avans
    const r = await w.acted({
      action: 'endorse', chequeIds: [c1.cheque.id, n1.cheque.id], partyId: sup.id,
      items: [{ lineId: bill.lineId, amount: '900', settleAmount: '900' }],
    });
    expect(r.cheques.every((x) => x.status === 'endorsed' && x.holderPartyId === sup.id)).toBe(true);
    const j = await w.journal(r.batch.entryId);
    expect(j.balanced).toBe(true);
    expect(j.of('101')[0]!.c).toBe(800);
    expect(j.of('121')[0]!.c).toBe(500);
    expect(j.of('320').reduce((s, l) => s + l.d, 0)).toBe(1300);
    const pay = await w.open(sup.id, 'payable');
    expect(pay.items).toHaveLength(0); // 900 açıkça + kalan 100'ü FIFO ile avans kapatır
    expect(Number(pay.unapplied)).toBe(300);
    // Ciro edilmiş belge tahsile verilemez; kendi keşidecisine ciro edilemez
    const bank = await w.bankAcct('KTB TL');
    expect((await w.act({ action: 'deposit', chequeIds: [c1.cheque.id], bankAccountId: bank.id })).json().error.code).toBe('CHEQUE_STATUS_INVALID');

    // Ciro iadesi: belge portföye döner, tedarikçi borcu 800 yeniden açılır
    const back = await w.acted({ action: 'unendorse', chequeIds: [c1.cheque.id] });
    expect(back.cheques[0]).toMatchObject({ status: 'portfolio', holderPartyId: null });
    const jb = await w.journal(back.batch.entryId);
    expect(jb.balanced).toBe(true);
    expect(jb.of('320')[0]).toMatchObject({ c: 800, partyId: sup.id });
    // Müşteriye iade: cari alacağı yeniden açılır
    const ret = await w.acted({ action: 'return', chequeIds: [c1.cheque.id] });
    expect(ret.cheques[0]!.status).toBe('returned');
    const jr = await w.journal(ret.batch.entryId);
    expect(jr.of('120')[0]).toMatchObject({ d: 800, partyId: cust.id });
    expect(jr.balanced).toBe(true);
    // Müşteriye faturasız (avans) alınan çek iade edilince açık kalem yazılır ve avansı eritir; yalnız diğer senedin avansı kalır
    const o = await w.open(cust.id);
    expect(o.items).toHaveLength(0);
    expect(Number(o.unapplied)).toBe(500);
    // Müşteri carisine ciro edilmek istenirse (tedarikçi değil) reddedilir
    const x = await w.cheque({ docNo: 'E-9', partyId: cust.id, amount: '10' });
    expect((await w.act({ action: 'endorse', chequeIds: [x.cheque.id], partyId: cust.id })).json().error.code).toBe('PARTY_KIND_MISMATCH');
  });

  it('verilen çek/senet: kayıt tedarikçi borcunu kapatır; ödeme bankadan; karşılıksız ve iptal borcu yeniden açar', async () => {
    const w = await world('ChqVerilen');
    const sup = await w.party('Tedarikçi', 'supplier');
    const bank = await w.bankAcct('KTB TL');
    await w.expense(sup.id, '1000', 'G-1');
    const bill = (await w.open(sup.id, 'payable')).items[0]!;
    const c1 = await w.cheque({ direction: 'issued', docNo: 'V-1', partyId: sup.id, amount: '1000', items: [{ lineId: bill.lineId, amount: '1000', settleAmount: '1000' }] });
    expect(c1.cheque.status).toBe('issued');
    const j1 = await w.journal(c1.cheque.entryId);
    expect(j1.balanced).toBe(true);
    expect(j1.of('320')[0]).toMatchObject({ d: 1000, partyId: sup.id });
    expect(j1.of('103')[0]!.c).toBe(1000);
    expect((await w.open(sup.id, 'payable')).items).toHaveLength(0);
    const paid = await w.acted({ action: 'pay', chequeIds: [c1.cheque.id], bankAccountId: bank.id });
    expect(paid.cheques[0]!.status).toBe('paid');
    const jp = await w.journal(paid.batch.entryId);
    expect(jp.of('103')[0]!.d).toBe(1000);
    expect(jp.of('102.001')[0]!.c).toBe(1000);
    expect((await w.c.get(`/api/treasury/accounts/${bank.id}`)).json().account.balance).toBe('-1000.0000');

    // Verilen senet: 321; karşılıksız → borç yeniden açılır
    const n1 = await w.cheque({ direction: 'issued', docType: 'note', docNo: 'VS-1', bankName: '', partyId: sup.id, amount: '400' });
    expect((await w.journal(n1.cheque.entryId)).of('321')[0]!.c).toBe(400);
    const bn = await w.acted({ action: 'bounce', chequeIds: [n1.cheque.id] });
    expect(bn.cheques[0]!.status).toBe('bounced');
    const jbn = await w.journal(bn.batch.entryId);
    expect(jbn.balanced).toBe(true);
    expect(jbn.of('321')[0]!.d).toBe(400);
    expect(jbn.of('320')[0]).toMatchObject({ c: 400, partyId: sup.id });
    // İptal
    const c2 = await w.cheque({ direction: 'issued', docNo: 'V-2', partyId: sup.id, amount: '50' });
    const cn = await w.acted({ action: 'cancel', chequeIds: [c2.cheque.id] });
    expect(cn.cheques[0]!.status).toBe('cancelled');
    expect((await w.journal(cn.batch.entryId)).balanced).toBe(true);
    // Verilen belge için alınan eylemleri yok
    const c3 = await w.cheque({ direction: 'issued', docNo: 'V-3', partyId: sup.id, amount: '5' });
    expect((await w.act({ action: 'deposit', chequeIds: [c3.cheque.id], bankAccountId: bank.id })).json().error.code).toBe('CHEQUE_ACTION_INVALID');
    expect((await w.act({ action: 'pay', chequeIds: [c3.cheque.id, (await w.cheque({ docNo: 'M-1', partyId: (await w.party('Mx')).id, amount: '1' })).cheque.id], bankAccountId: bank.id })).json().error.code).toBe('CHEQUE_MIXED_DIRECTION');
  });

  it('doğrulamalar: yinelenen numara, cari türü, vade tarihi, banka türü/para birimi, pasif cari', async () => {
    const w = await world('ChqDogrulama');
    const cust = await w.party('Müşteri');
    const sup = await w.party('Tedarikçi', 'supplier');
    await w.cheque({ docNo: 'K-1', partyId: cust.id, amount: '10' });
    expect(((await w.cheque({ docNo: 'K-1', partyId: cust.id, amount: '10' }, 409)) as any).error.code).toBe('CHEQUE_DUPLICATE');
    // Aynı numara farklı bankada ya da farklı yönde serbest
    await w.cheque({ docNo: 'K-1', partyId: cust.id, amount: '10', bankName: 'Başka Banka' });
    await w.cheque({ direction: 'issued', docNo: 'K-1', partyId: sup.id, amount: '10' });
    expect(((await w.cheque({ docNo: 'K-2', partyId: sup.id, amount: '10' }, 422)) as any).error.code).toBe('PARTY_KIND_MISMATCH');
    expect(((await w.cheque({ direction: 'issued', docNo: 'K-3', partyId: cust.id, amount: '10' }, 422)) as any).error.code).toBe('PARTY_KIND_MISMATCH');
    expect(((await w.cheque({ docNo: 'K-4', partyId: cust.id, amount: '10', dueDate: '2019-01-01' }, 400)) as any).error.code).toBe('VALIDATION_ERROR');
    expect(((await w.cheque({ docNo: 'K-5', partyId: cust.id, amount: '0' }, 400)) as any).error.code).toBe('VALIDATION_ERROR');
    const cash = await w.bankAcct('Kasa', 'cash');
    const usd = await w.bankAcct('USD banka', 'bank', 'USD');
    const k = await w.cheque({ docNo: 'K-6', partyId: cust.id, amount: '10' });
    expect((await w.act({ action: 'deposit', chequeIds: [k.cheque.id], bankAccountId: cash.id })).json().error.code).toBe('CHEQUE_BANK_KIND');
    expect((await w.act({ action: 'deposit', chequeIds: [k.cheque.id], bankAccountId: usd.id })).json().error.code).toBe('CHEQUE_BANK_CURRENCY');
    expect((await w.act({ action: 'deposit', chequeIds: [k.cheque.id] })).statusCode).toBe(400);
    expect((await w.act({ action: 'collect', chequeIds: [k.cheque.id] })).json().error.code).toMatch(/CHEQUE_BANK_MISMATCH|CHEQUE_STATUS_INVALID/);
    await w.c.patch(`/api/parties/${cust.id}`, { isActive: false });
    expect(((await w.cheque({ docNo: 'K-7', partyId: cust.id, amount: '10' }, 422)) as any).error.code).toBe('PARTY_INACTIVE');
    // Açıklama/şube güncellenir; tutar değişmez
    const upd = await w.c.patch(`/api/cheques/${k.cheque.id}`, { branch: 'Girne', description: 'Not' });
    expect(upd.json().cheque).toMatchObject({ branch: 'Girne', description: 'Not' });
    expect((await w.c.patch(`/api/cheques/${k.cheque.id}`, { amount: '99' })).statusCode).toBe(400);
  });

  it('DB korumaları (tablo sahibiyle ham SQL): geçersiz geçiş, olaysız geçiş, değişmez alanlar, silme, olay/toplu işlem/eşleştirme değiştirilemez', async () => {
    const w = await world('ChqGuard');
    const cust = await w.party('Müşteri');
    const sup = await w.party('Tedarikçi', 'supplier');
    const bank = await w.bankAcct('KTB TL');
    await w.sale(cust.id, '100');
    const item = (await w.open(cust.id)).items[0]!;
    const a = await w.cheque({ docNo: 'G-1', partyId: cust.id, amount: '100', items: [{ lineId: item.lineId, amount: '100', settleAmount: '100' }] });
    const id = a.cheque.id as string;
    const iss = await w.cheque({ direction: 'issued', docNo: 'G-2', partyId: sup.id, amount: '50' });
    const dep = await w.acted({ action: 'deposit', chequeIds: [(await w.cheque({ docNo: 'G-3', partyId: cust.id, amount: '10' })).cheque.id], bankAccountId: bank.id });
    const cid = w.company.id;
    await asOwner(async (q) => {
      const err = async (sql: string, params?: unknown[]) => expectDbError(q, sql, params);
      // Geçersiz geçişler
      expect((await err(`update cheques set status = 'collected' where id = $1`, [id])).code).toBe('ERP14');
      expect((await err(`update cheques set status = 'bounced' where id = $1`, [id])).code).toBe('ERP14');
      expect((await err(`update cheques set status = 'paid' where id = $1`, [iss.cheque.id])).code).toBe('ERP14');
      expect((await err(`update cheques set status = 'portfolio' where id = $1`, [iss.cheque.id])).code).toMatch(/ERP14|23514/);
      // Geçerli geçiş ama olay kaydı yok
      expect((await err(`update cheques set status = 'in_collection' where id = $1`, [id])).message).toContain('olay');
      // Değişmez alanlar, silme
      expect((await err(`update cheques set amount = 1 where id = $1`, [id])).code).toBe('ERP14');
      expect((await err(`update cheques set due_date = '2031-01-01' where id = $1`, [id])).code).toBe('ERP14');
      expect((await err(`update cheques set party_id = $2 where id = $1`, [id, sup.id])).code).toBe('ERP14');
      expect((await err(`delete from cheques where id = $1`, [id])).code).toBe('ERP14');
      // Olay: önceki durum belgenin durumuyla uyuşmalı, geçiş geçerli olmalı, değiştirilemez
      const entry = a.cheque.entryId;
      expect((await err(`insert into cheque_events (id, company_id, cheque_id, from_status, to_status, event_date, entry_id) values (gen_random_uuid(), $1, $2, 'in_collection', 'collected', current_date, $3)`, [cid, id, entry])).code).toBe('ERP14');
      expect((await err(`insert into cheque_events (id, company_id, cheque_id, from_status, to_status, event_date, entry_id) values (gen_random_uuid(), $1, $2, 'portfolio', 'collected', current_date, $3)`, [cid, id, entry])).code).toBe('ERP14');
      expect((await err(`insert into cheque_events (id, company_id, cheque_id, from_status, to_status, event_date, entry_id) values (gen_random_uuid(), $1, $2, null, 'portfolio', current_date, $3)`, [cid, id, entry])).code).toBe('ERP14');
      expect((await err(`update cheque_events set note = 'x'`)).code).toBe('ERP14');
      expect((await err(`delete from cheque_events`)).code).toBe('ERP14');
      expect((await err(`update cheque_batches set note = 'x'`)).code).toBe('ERP14');
      expect((await err(`delete from cheque_batches`)).code).toBe('ERP14');
      expect((await err(`update cheque_allocations set amount = 1`)).code).toBe('ERP14');
      expect((await err(`delete from cheque_allocations`)).code).toBe('ERP14');
      // Eşleştirme aşımı: aynı kalem aynı tutarla ikinci kez kapatılamaz (kalem satırı kilitlenir, kasa/banka + çek toplamı)
      const dupAlloc = await err(`insert into cheque_allocations (id, company_id, cheque_id, event_id, party_id, control, charge_line_id, settle_line_id, amount, amount_base, settle_amount)
        select gen_random_uuid(), company_id, cheque_id, event_id, party_id, control, charge_line_id, settle_line_id, amount, amount_base, settle_amount from cheque_allocations where cheque_id = $1`, [id]);
      expect(dupAlloc.code).toBe('ERP14');
      expect(dupAlloc.message).toContain('aşıyor');
      // Başlangıç durumu dışında kayıt
      expect((await err(`insert into cheques (id, company_id, direction, doc_type, doc_no, bank_name, party_id, amount, currency_code, issue_date, due_date, status, entry_id) values (gen_random_uuid(), $1, 'received', 'cheque', 'X', '', $2, 5, 'TRY', '2020-01-01', '2020-02-01', 'collected', $3)`, [cid, cust.id, entry])).code).toBe('ERP14');
      expect((await err(`insert into cheques (id, company_id, direction, doc_type, doc_no, bank_name, party_id, amount, currency_code, issue_date, due_date, status, entry_id) values (gen_random_uuid(), $1, 'received', 'cheque', 'X', '', $2, 5, 'TRY', '2020-01-01', '2020-02-01', 'issued', $3)`, [cid, cust.id, entry])).code).toBe('ERP14');
      // Geçerli geçiş: olay + durum güncellemesi aynı işlemde yapılırsa geçer
      await q(`insert into cheque_events (id, company_id, cheque_id, from_status, to_status, event_date, entry_id) values (gen_random_uuid(), $1, $2, 'portfolio', 'in_collection', current_date, $3)`, [cid, id, entry]);
      await q(`update cheques set status = 'in_collection' where id = $1`, [id]);
      expect((await q(`select status from cheques where id = $1`, [id])).rows[0].status).toBe('in_collection');
      // Ciro durumu ancak ciro edilen cariyle birlikte (holder_party_id denetimi)
      expect((await err(`update cheques set holder_party_id = $2 where id = $1`, [id, sup.id])).code).toBe('23514');
    });
    expect(dep.cheques[0]!.status).toBe('in_collection');
  });

  it('raporlar: vade analizi kovaları ve cariye göre, bu hafta vadesi gelenler, karşılıksız listesi, portföy toplamı = 101/121 bakiyesi', async () => {
    const w = await world('ChqRapor');
    const a = await w.party('Müşteri A');
    const b = await w.party('Müşteri B');
    const sup = await w.party('Tedarikçi', 'supplier');
    const mk = (docNo: string, due: number, amount: string, partyId = a.id, extra: Record<string, unknown> = {}) => w.cheque({ docNo, partyId, amount, dueDate: addDays(due), ...extra });
    await mk('R-1', -5, '100'); // vadesi geçmiş
    await mk('R-2', 3, '200');
    await mk('R-3', 20, '300', b.id);
    await mk('R-4', 45, '400');
    await mk('R-5', 75, '500', b.id);
    await mk('R-6', 120, '600');
    await mk('R-7', 10, '700', a.id, { docType: 'note', bankName: '' });
    await w.cheque({ direction: 'issued', docNo: 'I-1', partyId: sup.id, amount: '1000', dueDate: addDays(5) });
    const m = (await w.c.get('/api/cheques/reports/maturity')).json();
    expect(m.asOf).toBe(TODAY);
    const rb = Object.fromEntries(m.received.buckets.map((x: any) => [x.bucket, x]));
    expect(rb.overdue).toMatchObject({ count: 1, amount: '100.00' });
    expect(rb.d0_7).toMatchObject({ count: 1, amount: '200.00' });
    expect(rb.d8_30).toMatchObject({ count: 2, amount: '1000.00' }); // R-3 (+20) ve R-7 (+10)
    expect(rb.d31_60).toMatchObject({ count: 1, amount: '400.00' });
    expect(rb.d61_90).toMatchObject({ count: 1, amount: '500.00' });
    expect(rb.d90p).toMatchObject({ count: 1, amount: '600.00' });
    expect(m.received).toMatchObject({ count: 7, amount: '2800.00' });
    expect(m.issued).toMatchObject({ count: 1, amount: '1000.00' });
    const pa = m.byParty.find((p: any) => p.partyId === a.id && p.direction === 'received');
    expect(pa).toMatchObject({ count: 5, amount: '2000.00', overdue: '100.00', earliestDue: addDays(-5) });
    // Bu hafta (7 gün): vadesi geçmiş + 3 gün + verilen +5
    const due = (await w.c.get('/api/cheques/reports/due?days=7')).json();
    expect(due.rows.map((r: any) => r.docNo).sort()).toEqual(['I-1', 'R-1', 'R-2']);
    expect(due.rows.find((r: any) => r.docNo === 'R-1').overdue).toBe(true);
    expect(due.totals).toMatchObject({ received: '300.00', issued: '1000.00' });
    expect((await w.c.get('/api/cheques/reports/due?days=7&direction=issued')).json().rows).toHaveLength(1);

    // Portföy toplamı genel muhasebe bakiyesiyle birebir
    const list = (await w.c.get('/api/cheques?status=open&direction=received')).json();
    const sumOf = (t: string) => list.cheques.filter((x: any) => x.docType === t).reduce((s: number, x: any) => s + Number(x.amount), 0);
    const cl = await w.closing();
    expect(sumOf('cheque')).toBe(cl('101'));
    expect(sumOf('note')).toBe(cl('121'));
    expect(cl('103')).toBe(-1000);

    // Karşılıksız listesi
    const bank = await w.bankAcct('KTB TL');
    const first = (await w.get((list.cheques.find((x: any) => x.docNo === 'R-2') as any).id)).cheque;
    await w.acted({ action: 'deposit', chequeIds: [first.id], bankAccountId: bank.id });
    await w.acted({ action: 'bounce', chequeIds: [first.id] });
    const bn = (await w.c.get('/api/cheques/reports/bounced')).json();
    expect(bn.rows).toEqual([expect.objectContaining({ docNo: 'R-2', bouncedDate: TODAY, daysSince: 0, amount: '200.0000' })]);
    expect(bn.totals.received).toBe('200.00');
    // Süzgeçler
    const byStatus = (await w.c.get('/api/cheques?status=bounced')).json().cheques;
    expect(byStatus).toHaveLength(1);
    expect((await w.c.get(`/api/cheques?partyId=${b.id}`)).json().cheques).toHaveLength(2);
    expect((await w.c.get('/api/cheques?q=R-7')).json().cheques).toHaveLength(1);
    expect((await w.c.get(`/api/cheques?dueFrom=${addDays(100)}`)).json().cheques.map((x: any) => x.docNo)).toEqual(['R-6']);
    expect((await w.c.get('/api/cheques')).json().summary.length).toBeGreaterThan(2);
  });

  it('nakit projeksiyonu: portföydeki alınan belge giriş, ödenmemiş verilen belge çıkış olarak vadesinde görünür; tahsil edilince kaybolur', async () => {
    const w = await world('ChqNakit');
    const a = await w.party('Müşteri');
    const sup = await w.party('Tedarikçi', 'supplier');
    const bank = await w.bankAcct('KTB TL');
    const r = await w.cheque({ docNo: 'N-1', partyId: a.id, amount: '900', dueDate: addDays(3) });
    await w.cheque({ direction: 'issued', docNo: 'N-2', partyId: sup.id, amount: '400', dueDate: addDays(10) });
    let f = (await w.c.get('/api/cash-forecast')).json();
    const items = f.items.filter((i: any) => i.cheque);
    expect(items.map((i: any) => [i.description, i.direction, i.amountBase])).toEqual([
      ['Çek N-1', 'in', '900.00'],
      ['Çek N-2', 'out', '400.00'],
    ]);
    const total = (k: string) => f.buckets.reduce((s: number, b: any) => s + Number(b[k]), 0);
    expect([total('receivables'), total('payables')]).toEqual([900, 400]);
    await w.acted({ action: 'deposit', chequeIds: [r.cheque.id], bankAccountId: bank.id });
    f = (await w.c.get('/api/cash-forecast')).json();
    expect(f.items.filter((i: any) => i.cheque)).toHaveLength(2); // tahsildeki belge hâlâ beklenen giriş
    await w.acted({ action: 'collect', chequeIds: [r.cheque.id] });
    f = (await w.c.get('/api/cash-forecast')).json();
    expect(f.items.filter((i: any) => i.cheque).map((i: any) => i.description)).toEqual(['Çek N-2']);
    expect(Number(f.opening)).toBe(900); // tahsil edilen tutar bankada
  });

  it('dışa aktarma: portföy, vade analizi (2 sayfa), vadesi gelenler, karşılıksızlar xlsx; izin ve modül kapısı', async () => {
    const w = await world('ChqExport');
    const a = await w.party('Müşteri');
    await w.cheque({ docNo: 'X-1', partyId: a.id, amount: '123.45', dueDate: addDays(2) });
    const xl = async (url: string) => {
      const res = await w.c.get(url);
      expect(res.statusCode, url).toBe(200);
      return readXlsx(new Uint8Array(res.rawPayload));
    };
    const p = await xl('/api/exports/cheques');
    expect(p[0]!.rows[0]![0]).toBe('Çek/senet portföyü');
    expect(p[0]!.rows.some((r) => r.includes('X-1'))).toBe(true);
    expect((await xl('/api/exports/cheque-maturity')).map((s) => s.name)).toEqual(['Vade kovaları', 'Cariye göre']);
    expect((await xl('/api/exports/cheques-due?days=7'))[0]!.rows.some((r) => r.includes('X-1'))).toBe(true);
    expect((await xl('/api/exports/cheques-bounced'))[0]!.name).toBe('Karşılıksız');
    const csv = await w.c.get('/api/exports/cheques?format=csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('X-1');
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    expect((await viewer.client.get('/api/exports/cheques')).statusCode).toBe(200);
    const sales = await addMember(app, w.c, w.company.id, 'sales');
    expect((await sales.client.get('/api/exports/cheques')).statusCode).toBe(403);
  });

  it('yetki ve modül: muhasebeci yönetir, izleyici okur ama yazamaz, satış/şantiye erişemez; modül kapalıyken 403, kasa/banka kapatılamaz', async () => {
    const w = await world('ChqYetki');
    const a = await w.party('Müşteri');
    const k = await w.cheque({ docNo: 'P-1', partyId: a.id, amount: '10' });
    const reads = ['/api/cheques', `/api/cheques/${k.cheque.id}`, '/api/cheques/batches', '/api/cheques/reports/maturity', '/api/cheques/reports/due', '/api/cheques/reports/bounced'];
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    for (const url of reads) expect((await acc.client.get(url)).statusCode, url).toBe(200);
    expect((await acc.client.post('/api/cheques', { direction: 'received', docType: 'cheque', docNo: 'P-2', bankName: 'B', partyId: a.id, amount: '5', issueDate: ISSUE, dueDate: addDays(5), registerDate: TODAY })).statusCode).toBe(201);
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    for (const url of reads) expect((await viewer.client.get(url)).statusCode, `viewer ${url}`).toBe(200);
    expect((await viewer.client.post('/api/cheques', { direction: 'received', docType: 'cheque', docNo: 'P-3', bankName: 'B', partyId: a.id, amount: '5', issueDate: ISSUE, dueDate: addDays(5) })).statusCode).toBe(403);
    expect((await viewer.client.post('/api/cheques/actions', { action: 'return', chequeIds: [k.cheque.id], date: TODAY })).statusCode).toBe(403);
    expect((await viewer.client.patch(`/api/cheques/${k.cheque.id}`, { branch: 'X' })).statusCode).toBe(403);
    for (const role of ['sales', 'site_manager'] as const) {
      const m = await addMember(app, w.c, w.company.id, role);
      for (const url of reads) expect((await m.client.get(url)).statusCode, `${role} ${url}`).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/cheques' })).statusCode).toBe(401);

    // Modül bağımlılığı: kasa/banka cheques açıkken kapatılamaz
    const blocked = await w.c.put('/api/company/modules/core.treasury', { enabled: false });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('MODULE_REQUIRED_BY');
    expect((await w.c.put('/api/company/modules/treasury.cheques', { enabled: false })).statusCode).toBe(200);
    const off = await w.c.get('/api/cheques');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('MODULE_DISABLED');
    expect((await w.c.get('/api/exports/cheques')).statusCode).toBe(403);
    const nav = ((await w.c.get('/api/navigation')).json().groups as any[]).flatMap((g) => g.items.map((i: any) => i.key));
    expect(nav).not.toContain('cheques');
    expect((await w.c.put('/api/company/modules/treasury.cheques', { enabled: true })).statusCode).toBe(200);
    const nav2 = ((await w.c.get('/api/navigation')).json().groups as any[]).flatMap((g) => g.items.map((i: any) => i.key));
    expect(nav2).toContain('cheques');
  });

  it('RLS: başka şirket çek/senet, olay, toplu işlem ve eşleştirme görmez; başka şirketin carisiyle belge açılamaz; uygulama rolü silemez', async () => {
    const a = await world('ChqRlsA');
    const b = await world('ChqRlsB');
    const cust = await a.party('Müşteri');
    const bank = await a.bankAcct('KTB TL');
    await a.sale(cust.id, '100');
    const item = (await a.open(cust.id)).items[0]!;
    const k = await a.cheque({ docNo: 'L-1', partyId: cust.id, amount: '100', items: [{ lineId: item.lineId, amount: '100', settleAmount: '100' }] });
    await a.acted({ action: 'deposit', chequeIds: [k.cheque.id], bankAccountId: bank.id });
    expect((await b.c.get('/api/cheques')).json().cheques).toHaveLength(0);
    expect((await b.c.get(`/api/cheques/${k.cheque.id}`)).statusCode).toBe(404);
    expect((await b.c.get('/api/cheques/batches')).json().batches).toHaveLength(0);
    expect((await b.c.post('/api/cheques/actions', { action: 'collect', chequeIds: [k.cheque.id], date: TODAY })).statusCode).toBe(404);
    expect((await b.c.patch(`/api/cheques/${k.cheque.id}`, { branch: 'x' })).statusCode).toBe(404);
    expect((await b.cheque({ docNo: 'L-1', partyId: cust.id, amount: '5' }, 422) as any).error.code).toBe('PARTY_NOT_FOUND');
    await asDb(handle, { companyId: b.company.id, orgId: b.orgId }, async (q) => {
      for (const t of ['cheques', 'cheque_events', 'cheque_batches', 'cheque_allocations']) {
        expect((await q(`select count(*)::int as n from ${t} where company_id = $1`, [a.company.id])).rows[0].n, t).toBe(0);
      }
      expect((await expectDbError(q, `delete from cheques`)).code).toBe('42501');
      expect((await expectDbError(q, `delete from cheque_events`)).code).toBe('42501');
      expect((await expectDbError(q, `update cheque_batches set note = 'x'`)).code).toBe('42501');
      expect((await expectDbError(q, `insert into cheque_batches (id, company_id, batch_no, action, event_date, total, doc_count, entry_id) values (gen_random_uuid(), $1, 'X', 'deposit', current_date, 1, 1, gen_random_uuid())`, [a.company.id])).code).toMatch(/42501|23503|ERP14/);
    });
  });
});
