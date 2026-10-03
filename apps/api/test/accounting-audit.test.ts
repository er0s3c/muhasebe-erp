import { describe, expect, it } from 'vitest';
import { accountIds, asOwner, client, createCompany, day, expectDbError, makeApp, registerUser } from './helpers';
import { computeOpenItems, type PartyLine } from '../src/modules/parties/aging';

/**
 * Muhasebe doğruluğu denetimi (ACC-1…ACC-11) regresyon testleri. Her senaryo denetimde hatayı gösteren durumun kendisidir:
 * düzeltmeden önce başarısız olur. Tutarlar test değeridir; hesap eşlemeleri varsayılandır.
 */
describe('muhasebe doğruluğu denetimi (ACC)', async () => {
  const { app } = await makeApp();

  type C = ReturnType<typeof client>;
  async function world(name: string, extra: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, extra);
    const c = client(app, s.token, company.id);
    return { s, company, c, ids: await accountIds(app, s.token, company.id) };
  }
  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, codes = [200, 201]) => {
    const r = await p;
    if (!codes.includes(r.statusCode)) throw new Error(`HTTP ${r.statusCode}: ${r.body}`);
    return r.json();
  };
  const party = async (c: C, name: string, kind = 'customer') => (await ok(c.post('/api/parties', { name, kind }))).party as { id: string };
  const tacc = async (c: C, kind: 'cash' | 'bank', name: string, currency = 'TRY') => (await ok(c.post('/api/treasury/accounts', { kind, name, currency }))).account as { id: string };
  const rate = (c: C, d: string, cur: string, buy: string) => ok(c.put('/api/exchange-rates', { rateDate: d, currencyCode: cur, quoteCode: 'TRY', buy, sell: buy }));
  const openOf = async (c: C, p: string, type = 'receivable') => (await ok(c.get(`/api/parties/${p}/open-items?asOf=${day(12, 31)}&type=${type}`)))[type];
  const tb = async (c: C, from = day(1, 1), to = day(12, 31)) => ok(c.get(`/api/reports/trial-balance?from=${from}&to=${to}`));
  const row = (t: any, code: string) => t.rows.find((r: any) => r.code === code) ?? { debit: '0', credit: '0', closing: '0' };
  const n = (v: string | number) => Math.round(Number(v) * 100) / 100;
  const sales = async (c: C, p: string, amount: string, date: string, vatCode: string | null = 'KDV-0', extra: Record<string, unknown> = {}) =>
    (await ok(c.post('/api/invoices', { post: true, type: 'sales', partyId: p, invoiceDate: date, currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: amount, vatCode }], ...extra }))).invoice;

  it('ACC-1: tahsil edilmiş fatura iptal edilemez (uygulama + veritabanı); tahsilat iptalinden sonra iptal edilir, cari tutarlı', async () => {
    const { c, company } = await world('AccIptal');
    const cust = await party(c, 'Müşteri A');
    const bank = await tacc(c, 'bank', 'Banka TL');
    const inv = await sales(c, cust.id, '1000', day(3, 1));
    const it0 = (await openOf(c, cust.id)).items[0];
    const rec = await ok(c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 10), accountId: bank.id, amount: '1000', partyId: cust.id, items: [{ lineId: it0.lineId, amount: '1000', settleAmount: '1000' }] }));

    const blocked = await c.post(`/api/invoices/${inv.id}/cancel`, { reason: 'hatalı fatura', date: day(3, 20) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('INVOICE_HAS_PAYMENTS');
    expect(blocked.json().error.message).toContain(rec.transaction.txnNo);
    // Genel ters kayıt yolu da kapalı (fatura yevmiyesi elle ters çevrilemez; kaynaklı fiş ya da kapatılmış kalem)
    expect((await c.post(`/api/journal-entries/${inv.journalEntryId}/reverse`, { reason: 'x' })).statusCode).toBe(422);
    // Veritabanı kuralı: kapatılmış kalemi olan fiş ters çevrilmiş olarak işaretlenemez
    await asOwner(async (q) => {
      await q(`select set_config('app.company_id', $1, true)`, [company.id]);
      const err = await expectDbError(q, `update journal_entries set reversed_by_id = $1 where id = $2`, [rec.transaction.journalEntryId, inv.journalEntryId]);
      expect(err.message).toContain('kapatılmış');
    });

    // Önce tahsilat iptal edilir, sonra fatura: açık kalem yok, avans yok, 120 bakiyesi 0
    await ok(c.post(`/api/treasury/transactions/${rec.transaction.id}/cancel`, { reason: 'geri al', date: day(3, 15) }));
    await ok(c.post(`/api/invoices/${inv.id}/cancel`, { reason: 'hatalı fatura', date: day(3, 20) }));
    const after = await openOf(c, cust.id);
    expect(after.items).toEqual([]);
    expect(after.unapplied).toBe('0.00');
    expect(n(row(await tb(c), '120').closing)).toBe(0);
    // İptal edilmiş faturanın kalemi sonradan (geriye tarihli) kapatılamaz
    const late = await c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 12), accountId: bank.id, amount: '1000', partyId: cust.id, items: [{ lineId: it0.lineId, amount: '1000', settleAmount: '1000' }] });
    expect(late.statusCode).toBe(422);
    expect(late.json().error.code).toBe('ITEM_NOT_OPEN');
  });

  it('ACC-2: aynı para biriminde karşılık ≠ kapatılan tutar kur farkı yazmaz (reddedilir); kısmi kapatma doğru çalışır', async () => {
    const { c, company } = await world('AccKur');
    const cust = await party(c, 'Müşteri B');
    const bank = await tacc(c, 'bank', 'Banka TL');
    await sales(c, cust.id, '1000', day(3, 1));
    const it0 = (await openOf(c, cust.id)).items[0];
    const bad = await c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 10), accountId: bank.id, amount: '100', partyId: cust.id, items: [{ lineId: it0.lineId, amount: '1000', settleAmount: '100' }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('SETTLE_AMOUNT_MISMATCH');
    // Doğrusu kısmi kapatma: kalem 900 açık kalır, kur farkı (646/656) yok
    const part = await ok(c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 10), accountId: bank.id, amount: '100', partyId: cust.id, items: [{ lineId: it0.lineId, amount: '100', settleAmount: '100' }] }));
    expect((await openOf(c, cust.id)).items[0]).toMatchObject({ remaining: '900.00' });
    const t = await tb(c);
    expect(n(row(t, '646').closing)).toBe(0);
    expect(n(row(t, '656').closing)).toBe(0);
    // Avans olarak alınan 50 TL'lik tahsilatın satırıyla elle eşitsiz eşleştirme veritabanında da reddedilir
    const adv = await ok(c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 11), accountId: bank.id, amount: '50', partyId: cust.id, items: [] }));
    await asOwner(async (q) => {
      await q(`select set_config('app.company_id', $1, true)`, [company.id]);
      const st = (await q(`select l.id from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = $1 and a.party_control = 'receivable'`, [adv.transaction.journalEntryId])).rows[0].id;
      const err = await expectDbError(
        q,
        `insert into party_allocations (company_id, party_id, control, transaction_id, charge_line_id, settle_line_id, amount, amount_base, settle_amount) values ($1, $2, 'receivable', $3, $4, $5, 50, 50, 40)`,
        [company.id, cust.id, adv.transaction.id, it0.lineId, st],
      );
      expect(err.message).toContain('Aynı para biriminde');
    });
    void part;
  });

  it('ACC-3: aynı kalem çek/senet + geriye tarihli tahsilatla iki kez kapatılamaz (uygulama + veritabanı)', async () => {
    const { c, company } = await world('AccCift');
    const cust = await party(c, 'Müşteri C');
    const bank = await tacc(c, 'bank', 'Banka TL');
    await sales(c, cust.id, '500', day(3, 1));
    const it0 = (await openOf(c, cust.id)).items[0];
    await ok(c.post('/api/cheques', { direction: 'received', docType: 'cheque', docNo: 'A1', bankName: 'X', partyId: cust.id, amount: '500', issueDate: day(3, 20), dueDate: day(6, 20), registerDate: day(3, 20), items: [{ lineId: it0.lineId, amount: '500', settleAmount: '500' }] }));
    const r = await c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 10), accountId: bank.id, amount: '500', partyId: cust.id, items: [{ lineId: it0.lineId, amount: '500', settleAmount: '500' }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('ALLOCATION_EXCEEDED');
    // Veritabanı kuralı: kasa/banka eşleştirme toplamı çek/senet eşleştirmesini de sayar
    const adv = await ok(c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 10), accountId: bank.id, amount: '500', partyId: cust.id, items: [] }));
    await asOwner(async (q) => {
      await q(`select set_config('app.company_id', $1, true)`, [company.id]);
      const st = (await q(`select l.id from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = $1 and a.party_control = 'receivable'`, [adv.transaction.journalEntryId])).rows[0].id;
      const err = await expectDbError(
        q,
        `insert into party_allocations (company_id, party_id, control, transaction_id, charge_line_id, settle_line_id, amount, amount_base, settle_amount) values ($1, $2, 'receivable', $3, $4, $5, 500, 500, 500)`,
        [company.id, cust.id, adv.transaction.id, it0.lineId, st],
      );
      expect(err.message).toContain('aşıyor');
    });
    // Cari: kalem kapalı, 500 avans (defter 120 = −500) — açık kalem ve avans defterle uyumlu
    const o = await openOf(c, cust.id);
    expect(o.items).toEqual([]);
    expect(o.unapplied).toBe('500.00');
    expect(n(row(await tb(c), '120').closing)).toBe(-500);
  });

  it('ACC-3 (savunma): kalemini aşan ya da kalemi görünmeyen eşleştirme avans havuzuna döner (açık kalem = defter)', () => {
    const L = (id: string, date: string, debit: string, credit: string): PartyLine => ({ lineId: id, partyId: 'p', entryId: id, entryNo: id, entryDate: date, lineNo: 1, dueDate: null, description: id, currencyCode: 'TRY', debit, credit, debitBase: debit, creditBase: credit });
    const lines = [L('inv', '2026-03-01', '500', '0'), L('chq', '2026-03-20', '0', '500'), L('rec', '2026-03-10', '0', '500')];
    const over = computeOpenItems(lines, 'receivable', '2026-12-31', [
      { chargeLineId: 'inv', settleLineId: 'chq', amount: '500', amountBase: '500' },
      { chargeLineId: 'inv', settleLineId: 'rec', amount: '500', amountBase: '500' },
    ]);
    expect(over).toMatchObject({ items: [], unapplied: '500.00', unappliedByCurrency: [{ currencyCode: 'TRY', amount: '500.00', amountBase: '500.00' }] });
    // Kalemi ters çevrilmiş (listede olmayan) eşleştirme: kapatan satır havuza döner
    const orphan = computeOpenItems([L('rec', '2026-03-10', '0', '1000')], 'receivable', '2026-12-31', [{ chargeLineId: 'gone', settleLineId: 'rec', amount: '1000', amountBase: '1000' }]);
    expect(orphan.unapplied).toBe('1000.00');
  });

  it('ACC-4: KDV özeti iptali iptal döneminde eksi gösterir; gider fişi ve hakediş KDV dahil; özet = 391/191 hareketi', async () => {
    const { c, ids } = await world('AccKdv');
    const cust = await party(c, 'Müşteri V');
    const sup = await party(c, 'Tedarikçi V', 'supplier');
    const inv = await sales(c, cust.id, '1000', day(3, 5), 'KDV-16');
    await sales(c, cust.id, '500', day(3, 6), 'KDV-16');
    await ok(c.post(`/api/invoices/${inv.id}/cancel`, { reason: 'iptal nisan', date: day(4, 2) }));
    const card = (await ok(c.post('/api/expense-cards', { code: 'KIRA', name: 'Kira', accountId: ids['770'], taxCode: 'KDV-16' }))).card;
    await ok(c.post('/api/expense-entries', { entryDate: day(3, 7), cardId: card.id, description: 'Mart kira', paymentKind: 'party', partyId: sup.id, net: '300' }));
    const march = await ok(c.get(`/api/reports/vat-summary?from=${day(3, 1)}&to=${day(3, 31)}`));
    expect(march.totals).toMatchObject({ salesVat: '240.0000', purchaseVat: '48.0000', payable: '192.0000' });
    expect(march.reconciliation).toMatchObject({ outputDifference: '0.0000', inputDifference: '0.0000' });
    const april = await ok(c.get(`/api/reports/vat-summary?from=${day(4, 1)}&to=${day(4, 30)}`));
    expect(april.totals).toMatchObject({ salesVat: '-160.0000', salesNet: '-1000.0000' });
    // Satış raporu ve stok kârlılığı aynı kural: Mart 1.500, Nisan −1.000 (iptal satırı)
    expect((await ok(c.get(`/api/reports/sales-report?from=${day(3, 1)}&to=${day(3, 31)}&groupBy=month`))).totals.net).toBe('1500.0000');
    const aprInv = await ok(c.get(`/api/reports/sales-report?from=${day(4, 1)}&to=${day(4, 30)}&groupBy=invoice`));
    expect(aprInv.totals.net).toBe('-1000.0000');
    expect(aprInv.rows[0]).toMatchObject({ cancellation: true, invoiceId: inv.id });
    expect((await ok(c.get(`/api/reports/item-profitability?from=${day(4, 1)}&to=${day(4, 30)}`))).totals.sales).toBe('-1000.0000');
  });

  it('ACC-4 mutabakat: rastgele senaryoda her ay KDV özeti = KDV hesaplarının hareketi (fatura, iade, iptal, gider fişi, iki yönlü hakediş, döviz)', async () => {
    const { c, ids } = await world('AccKdvRnd');
    // Belirli tohumlu sözde rastgele (her çalıştırmada aynı senaryo)
    let seed = 20261003;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const amt = (lo: number, hi: number) => (lo + rnd() * (hi - lo)).toFixed(2);
    const months = [2, 3, 4, 5, 6];
    for (const m of months) for (const d of [1, 10, 20, 28]) await rate(c, day(m, d), 'USD', amt(30, 40));
    const cust = await party(c, 'Müşteri R');
    const sup = await party(c, 'Tedarikçi R', 'supplier');
    const card = (await ok(c.post('/api/expense-cards', { code: 'GID', name: 'Gider', accountId: ids['770'], taxCode: 'KDV-16' }))).card;
    const invoices: { id: string; date: string }[] = [];
    let ext = 0;
    for (let k = 0; k < 18; k++) {
      const m = pick(months);
      const date = day(m, pick([2, 9, 15, 23]));
      const kind = pick(['sales', 'sales', 'purchase', 'expense'] as const);
      const usd = rnd() < 0.3;
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => ({ description: `Satır ${i + 1}`, quantity: String(1 + Math.floor(rnd() * 4)), unitPrice: amt(10, 900), vatCode: pick(['KDV-16', 'KDV-5', 'KDV-0']), discountPct: pick(['0', '0', '7.5']) }));
      const body = { post: true, type: kind, partyId: kind === 'sales' ? cust.id : sup.id, invoiceDate: date, currency: usd ? 'USD' : 'TRY', ...(usd ? { fxRate: amt(30, 40) } : {}), vatIncluded: rnd() < 0.3, lines, ...(kind !== 'sales' ? { externalNo: `E-${++ext}` } : {}) };
      const inv = (await ok(c.post('/api/invoices', body))).invoice;
      invoices.push({ id: inv.id, date });
      if (k % 4 === 1) {
        await ok(c.post('/api/expense-entries', { entryDate: date, cardId: card.id, description: 'Gider', paymentKind: 'party', partyId: sup.id, net: amt(50, 800) }));
      }
    }
    // Bazı faturalar sonraki ayda iptal (orijinal ay değişmez, iptal ayında eksi)
    for (const inv of invoices.filter((_, i) => i % 5 === 0)) {
      const later = inv.date < day(6, 1) ? day(Number(inv.date.slice(5, 7)) + 1, 5) : day(6, 28);
      await ok(c.post(`/api/invoices/${inv.id}/cancel`, { reason: 'iptal', date: later }));
    }
    // Hakedişler: taşeron (TL, indirilecek KDV) ve işveren (USD, hesaplanan KDV); biri sonradan iptal
    const project = (await ok(c.post('/api/projects', { name: 'Proje R', kind: 'contract', clientPartyId: cust.id }))).project;
    const wbs = (await ok(c.post(`/api/projects/${project.id}/wbs`, { code: '01', name: 'İş' }))).wbs[0];
    const contract = async (direction: 'payable' | 'receivable', partyId: string, currencyCode: string) => {
      const created = await ok(c.post('/api/subcontracts', { direction, projectId: project.id, partyId, title: `Sözleşme ${direction}`, currencyCode, paymentDays: 30, retentionPct: '5', advanceRecoupPct: '0', withholdingPct: '0' }));
      const rev = created.revisions[0].id;
      const put = await ok(c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: [{ itemNo: '1', description: 'İş', unit: 'adet', quantity: '100', unitPrice: amt(100, 300), wbsId: wbs.id }] }));
      await ok(c.post(`/api/subcontract-revisions/${rev}/approve`, {}));
      return { id: created.subcontract.id as string, lineKey: put.lines[0].lineKey as string };
    };
    const progress = async (sc: { id: string; lineKey: string }, periodEnd: string, qty: string) => {
      const d = await ok(c.post('/api/progress-payments', { subcontractId: sc.id, periodEnd, vatCode: 'KDV-16', lines: [{ lineKey: sc.lineKey, cumulativeQty: qty }] }));
      const sub = await ok(c.post(`/api/progress-payments/${d.payment.id}/submit`, {}));
      await ok(c.post(`/api/approvals/${sub.approvals[0].id}/decide`, { decision: 'approve' }));
      return d.payment.id as string;
    };
    const subPay = await contract('payable', sup.id, 'TRY');
    const subRec = await contract('receivable', cust.id, 'USD');
    await progress(subPay, day(3, 28), '30');
    await progress(subRec, day(4, 28), '20');
    await progress(subPay, day(4, 28), '55');
    const lastRec = await progress(subRec, day(5, 28), '45');
    await ok(c.post(`/api/progress-payments/${lastRec}/cancel`, { reason: 'Hatalı hakediş', entryDate: day(6, 10) }));

    for (const m of [...months, 0]) {
      const from = m ? day(m, 1) : day(1, 1);
      const to = m ? day(m, new Date(Date.UTC(2026, m, 0)).getUTCDate()) : day(12, 31);
      const v = await ok(c.get(`/api/reports/vat-summary?from=${from}&to=${to}`));
      const t = await tb(c, from, to);
      const out = Number(row(t, '391').credit) - Number(row(t, '391').debit);
      const inp = Number(row(t, '191').debit) - Number(row(t, '191').credit);
      expect(n(v.totals.salesVat), `hesaplanan KDV ${from}`).toBe(n(out));
      expect(n(v.totals.purchaseVat), `indirilecek KDV ${from}`).toBe(n(inp));
      expect(v.reconciliation, from).toMatchObject({ outputDifference: '0.0000', inputDifference: '0.0000' });
    }
  });

  it('ACC-5: dövizli taşeron avansı ve teminatı tamamen kapanınca 159/326 TL artığı kalmaz; fark kambiyo kâr/zararıdır', async () => {
    const { c } = await world('AccTaseronKur');
    for (const [d, r] of [[day(2, 1), '35'], [day(3, 31), '40'], [day(5, 2), '45']] as const) await rate(c, d, 'USD', r);
    const project = (await ok(c.post('/api/projects', { name: 'Proje', kind: 'own' }))).project;
    const wbs = (await ok(c.post(`/api/projects/${project.id}/wbs`, { code: '05', name: 'Elektrik' }))).wbs[0];
    const sup = await party(c, 'Taşeron USD', 'supplier');
    const created = await ok(c.post('/api/subcontracts', { projectId: project.id, partyId: sup.id, title: 'İş', currencyCode: 'USD', paymentDays: 30, retentionPct: '10', advanceRecoupPct: '20', withholdingPct: '3' }));
    const sc = created.subcontract;
    const rev = created.revisions[0].id;
    const put = await ok(c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: [{ itemNo: '1', description: 'Kablo', unit: 'm', quantity: '10000', unitPrice: '3', wbsId: wbs.id }] }));
    await ok(c.post(`/api/subcontract-revisions/${rev}/approve`, {}));
    const bank = await tacc(c, 'bank', 'Banka USD', 'USD');
    await ok(c.post(`/api/subcontracts/${sc.id}/advances`, { accountId: bank.id, date: day(2, 1), amount: '1000' }));
    const draft = await ok(c.post('/api/progress-payments', { subcontractId: sc.id, periodEnd: day(3, 31), vatCode: 'KDV-16', lines: [{ lineKey: put.lines[0].lineKey, cumulativeQty: '5000' }] }));
    expect(draft.payment).toMatchObject({ advance: '1000.00', retention: '1500.00' });
    const sub = await ok(c.post(`/api/progress-payments/${draft.payment.id}/submit`, {}));
    await ok(c.post(`/api/approvals/${sub.approvals[0].id}/decide`, { decision: 'approve' }));
    await ok(c.post(`/api/subcontracts/${sc.id}/retention-releases`, { date: day(5, 2), amount: '1500' }));
    expect((await ok(c.get(`/api/subcontracts/${sc.id}/balances`))).balances).toMatchObject({ advanceBalance: '0.00', retentionBalance: '0.00' });
    const t = await tb(c);
    expect(n(row(t, '159').closing)).toBe(0);
    expect(n(row(t, '326').closing)).toBe(0);
    // Avans: 1.000 USD 35'ten verildi, 40'tan mahsup → 5.000 kâr; teminat: 1.500 USD 40'tan tutuldu, 45'ten iade → 7.500 zarar
    expect(n(row(t, '646').credit)).toBe(5000);
    expect(n(row(t, '656').debit)).toBe(7500);
    expect(t.totals.difference).toBe('0.0000');
  });

  it('ACC-6: konsolide gelir tablosu yalnızca dönem hareketidir; önceki dönem sonucu bilançoda ayrı satırdadır', async () => {
    const u = await registerUser(app, 'AccKons');
    const A = await createCompany(app, u.token, { name: 'A Ltd' });
    const B = await createCompany(app, u.token, { name: 'B Ltd' });
    for (const co of [A, B]) {
      const c = client(app, u.token, co.id);
      const ids = await accountIds(app, u.token, co.id);
      for (const [d, amt] of [[day(1, 15), '1000'], [day(3, 15), '500']] as const)
        await ok(c.post('/api/journal-entries', { entryDate: d, description: 'Satış', post: true, lines: [{ accountId: ids['100'], currency: 'TRY', debit: amt }, { accountId: ids['600'], currency: 'TRY', credit: amt }] }));
    }
    const g = await ok(client(app, u.token).post('/api/consolidation/groups', { name: 'Grup G', reportingCurrency: 'TRY', companyIds: [A.id, B.id] }));
    const gid = g.group?.id ?? g.id;
    const r = await ok(client(app, u.token, A.id).get(`/api/consolidation/groups/${gid}/report?from=${day(3, 1)}&to=${day(3, 31)}`));
    const R = r.report ?? r;
    const is = (k: string) => R.statements.incomeStatement.find((x: any) => x.key === k)?.values;
    const bs = (k: string) => R.statements.balanceSheet.find((x: any) => x.key === k)?.values;
    expect(is('is60')).toMatchObject({ [A.id]: '500.0000', [B.id]: '500.0000', consolidated: '1000.0000' });
    expect(is('net_profit').consolidated).toBe('1000.0000');
    expect(bs('period_result').consolidated).toBe('1000.0000');
    expect(bs('prior_result').consolidated).toBe('2000.0000');
    expect(R.statements.difference.consolidated).toBe('0.0000');
  });

  it('ACC-7/ACC-8: büyük tutarlar — kebir genel toplamı kuruş kaybetmez; taşan hesaplanan tutar 500 değil 400 doğrulama hatası', async () => {
    const { c, ids } = await world('AccBuyuk');
    const cust = await party(c, 'Büyük');
    const r1 = await c.post('/api/invoices', { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), lines: [{ description: 'x', quantity: '999999999', unitPrice: '999999999', vatCode: 'KDV-16' }] });
    expect(r1.statusCode).toBe(400);
    const r2 = await c.post('/api/invoices', { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), currency: 'USD', fxRate: '99999999999', lines: [{ description: 'x', quantity: '1', unitPrice: '99999999', vatCode: 'KDV-16' }] });
    expect(r2.statusCode).toBe(400);
    for (const d of [day(3, 1), day(3, 2)]) {
      await ok(c.post('/api/journal-entries', { entryDate: d, description: 'b', post: true, lines: [{ accountId: ids['100'], currency: 'TRY', debit: '999999999999999.99' }, { accountId: ids['500'], currency: 'TRY', credit: '999999999999999.99' }] }));
    }
    const csv = await c.get(`/api/exports/general-ledger?format=csv&from=${day(1, 1)}&to=${day(12, 31)}`);
    expect(csv.statusCode).toBe(200);
    const total = csv.body.trim().split('\n').at(-1)!;
    expect(total).toContain('1.999.999.999.999.999,98');
    expect(total).not.toContain('2.000.000.000.000.000,00');
  });

  it('ACC-10: döviz pozisyonu dövizli avansı (uygulanamayan tahsilat) ters yönlü kalem olarak sayar', async () => {
    const { c } = await world('AccPoz');
    await rate(c, day(3, 1), 'USD', '35');
    const cust = await party(c, 'Müşteri USD');
    const bank = await tacc(c, 'bank', 'Banka USD', 'USD');
    // 1.000 USD fatura, 1.500 USD tahsilat (500 USD avans): alacak pozisyonu 0, avans −500 → alacak sütunu net −500
    await ok(c.post('/api/invoices', { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), currency: 'USD', fxRate: '35', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '1000', vatCode: 'KDV-0' }] }));
    await ok(c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 1), accountId: bank.id, amount: '1500', fxRate: '35', partyId: cust.id, items: [] }));
    const pos = await ok(c.get(`/api/reports/fx-position?asOf=${day(3, 31)}`));
    const usd = (pos.report ?? pos).rows.find((r: any) => r.currency === 'USD');
    expect(usd).toMatchObject({ cash: '1500.0000', receivables: '-500.0000', net: '1000.0000' });
  });
});
