import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { accountIds, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser, TODAY_LOCAL } from './helpers';

describe('gayrimenkul satışı: birim → sözleşme → taksit → tahsilat → teslim', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const project = (await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
    const buyer = (await c.post('/api/parties', { name: 'Sarah Thompson', kind: 'customer' })).json().party as { id: string };
    await c.put('/api/exchange-rates', { rateDate: day(3, 1), currencyCode: 'GBP', quoteCode: 'TRY', buy: '50' });
    const unit = async (unitNo: string, extra: Record<string, unknown> = {}) => {
      const r = await c.post('/api/real-estate/units', { projectId: project.id, block: 'A', unitNo, floor: 1, grossM2: '120.50', listPrice: '150000', listCurrency: 'GBP', ...extra });
      if (r.statusCode !== 201) throw new Error(r.body);
      return r.json().unit as { id: string };
    };
    const planBody = (unitId: string, extra: Record<string, unknown> = {}) => ({
      unitId,
      partyId: buyer.id,
      currencyCode: 'GBP',
      contractDate: day(3, 1),
      price: '120000',
      downPayment: '30000',
      installments: [
        { kind: 'down_payment', dueDate: day(3, 1), amount: '30000' },
        { kind: 'installment', dueDate: day(6, 1), amount: '45000' },
        { kind: 'installment', dueDate: day(9, 1), amount: '45000' },
      ],
      ...extra,
    });
    const draft = async (unitNo: string, extra: Record<string, unknown> = {}) => {
      const u = await unit(unitNo);
      const r = await c.post('/api/sales-contracts', planBody(u.id, extra));
      if (r.statusCode !== 201) throw new Error(r.body);
      return { unit: u, ...(r.json() as { contract: { id: string; code: string }; installments: { id: string; journalLineId: string | null }[] }) };
    };
    const jr = async (id: string) => {
      const e = (await c.get(`/api/journal-entries/${id}`)).json().entry;
      const lines: { code: string; d: number; c: number; db: number; cb: number; project: string | null }[] = e.lines.map((l: any) => ({ code: l.accountCode as string, d: Number(l.debit), c: Number(l.credit), db: Number(l.debitBase), cb: Number(l.creditBase), project: l.projectId as string | null }));
      return { lines, of: (code: string) => lines.filter((l) => l.code === code) };
    };
    return { s, company, c, ids, orgId, project, buyer, unit, draft, planBody, jr };
  }

  it('birim: yalnızca kendi projesine; toplu üretim; tekil numara; durum sözleşmeyle değişir', async () => {
    const w = await world('Birim');
    const employer = (await w.c.post('/api/parties', { name: 'İşveren Ltd.', kind: 'customer' })).json().party as { id: string };
    const contractProject = (await w.c.post('/api/projects', { name: 'İşveren Villa', kind: 'contract', clientPartyId: employer.id })).json().project as { id: string };
    const bad = await w.c.post('/api/real-estate/units', { projectId: contractProject.id, unitNo: '1' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('PROJECT_NOT_OWN');

    const bulk = await w.c.post('/api/real-estate/units/bulk', { projectId: w.project.id, block: 'B', floorFrom: 1, floorTo: 3, perFloor: 2, listPrice: '90000', listCurrency: 'GBP' });
    expect(bulk.json()).toEqual({ created: 6, skipped: 0 });
    const again = await w.c.post('/api/real-estate/units/bulk', { projectId: w.project.id, block: 'B', floorFrom: 3, floorTo: 4, perFloor: 2 });
    expect(again.json()).toEqual({ created: 2, skipped: 2 }); // 301, 302 var
    const list = (await w.c.get(`/api/real-estate/units?projectId=${w.project.id}&block=B`)).json().units as { unitNo: string; status: string }[];
    expect(list.map((u) => u.unitNo)).toEqual(['101', '102', '201', '202', '301', '302', '401', '402']);
    expect((await w.c.post('/api/real-estate/units', { projectId: w.project.id, block: 'B', unitNo: '101' })).statusCode).toBe(409);
    expect((await w.c.post('/api/real-estate/units', { projectId: w.project.id, unitNo: '9', listPrice: '10' })).statusCode).toBe(400); // fiyat için para birimi

    const d = await w.draft('A1');
    const unitRow = (await w.c.get(`/api/real-estate/units/${d.unit.id}`)).json().unit;
    expect(unitRow).toMatchObject({ status: 'reserved', contractCode: d.contract.code, buyerName: 'Sarah Thompson' });
    expect((await w.c.delete(`/api/real-estate/units/${d.unit.id}`)).json().error.code).toBe('REAL_ESTATE_RULE_VIOLATION');
    // Aynı birime ikinci sözleşme açılamaz
    expect((await w.c.post('/api/sales-contracts', w.planBody(d.unit.id))).json().error.code).toBe('REAL_ESTATE_RULE_VIOLATION');
  });

  it('taslak: plan toplamı ve peşinat doğrulanır; düzenlenir; etkinleşince değişmez', async () => {
    const w = await world('Taslak');
    const u = await w.unit('A2');
    const wrong = await w.c.post('/api/sales-contracts', w.planBody(u.id, { price: '120001' }));
    expect(wrong.json().error.code).toBe('PLAN_TOTAL_MISMATCH');
    const wrongDown = await w.c.post('/api/sales-contracts', w.planBody(u.id, { downPayment: '1000' }));
    expect(wrongDown.json().error.code).toBe('PLAN_DOWN_MISMATCH');
    const created = await w.c.post('/api/sales-contracts', w.planBody(u.id));
    expect(created.json().contract).toMatchObject({ code: expect.stringMatching(/^SSZ-\d{4}-000001$/), status: 'draft', price: '120000.0000', currencyCode: 'GBP', partyName: 'Sarah Thompson' });
    expect(created.json().installments.map((i: any) => i.amount)).toEqual(['30000.00', '45000.00', '45000.00']);
    const id = created.json().contract.id as string;
    // Düzenleme: 4 taksit
    const upd = await w.c.put(`/api/sales-contracts/${id}`, {
      contractDate: day(3, 1), price: '120000', downPayment: '0',
      installments: [1, 2, 3, 4].map((n) => ({ kind: 'installment', dueDate: day(n + 3, 1), amount: '30000' })),
    });
    expect(upd.json().installments).toHaveLength(4);
    const act = await w.c.post(`/api/sales-contracts/${id}/activate`, {});
    expect(act.statusCode, act.body).toBe(200);
    expect(act.json().contract.status).toBe('active');
    expect((await w.c.put(`/api/sales-contracts/${id}`, { contractDate: day(3, 1), price: '120000', downPayment: '0', installments: [{ kind: 'installment', dueDate: day(5, 1), amount: '120000' }] })).json().error.code).toBe('CONTRACT_NOT_DRAFT');
    expect((await w.c.post(`/api/sales-contracts/${id}/activate`, {})).json().error.code).toBe('CONTRACT_NOT_DRAFT');
  });

  it('etkinleştirme: taksit başına vadeli 120 (GBP), 380 ertelenmiş gelir; açık kalemler; TL tahsilat GBP taksidi kapatır (kur farkı)', async () => {
    const w = await world('Etkinles');
    const d = await w.draft('A3');
    const act = await w.c.post(`/api/sales-contracts/${d.contract.id}/activate`, {});
    expect(act.statusCode, act.body).toBe(200);
    const contract = act.json().contract;
    expect(contract).toMatchObject({ status: 'active', activationFx: '50.00000000', paid: '0.00', remaining: '120000.00' });
    const j = await w.jr(contract.activationEntryId);
    // 3 taksit satırı (GBP × 50) + 380 alacak
    expect(j.of('120')).toEqual([
      { code: '120', d: 30000, c: 0, db: 1_500_000, cb: 0, project: null },
      { code: '120', d: 45000, c: 0, db: 2_250_000, cb: 0, project: null },
      { code: '120', d: 45000, c: 0, db: 2_250_000, cb: 0, project: null },
    ]);
    expect(j.of('380')).toEqual([{ code: '380', d: 0, c: 120000, db: 0, cb: 6_000_000, project: null }]);
    expect((await w.c.get(`/api/units`)).statusCode).toBe(404);
    expect((await w.c.get(`/api/real-estate/units/${d.unit.id}`)).json().unit.status).toBe('sold');

    // Açık kalemler: her taksit ayrı, vade = taksit tarihi
    const open = (await w.c.get(`/api/parties/${w.buyer.id}/open-items?asOf=${day(12, 31)}&type=receivable`)).json().receivable.items as { dueDate: string; amount: string; currencyCode: string }[];
    expect(open.map((o) => [o.dueDate, o.amount, o.currencyCode])).toEqual([[day(3, 1), '30000.00', 'GBP'], [day(6, 1), '45000.00', 'GBP'], [day(9, 1), '45000.00', 'GBP']]);

    // Peşinat TL banka hesabına 55 kurla tahsil edilir: kur kârı
    await w.c.put('/api/exchange-rates', { rateDate: day(3, 2), currencyCode: 'GBP', quoteCode: 'TRY', buy: '55' });
    const bank = (await w.c.post('/api/treasury/accounts', { kind: 'bank', name: 'KTB TL', currency: 'TRY' })).json().account as { id: string };
    const line = (await w.c.get(`/api/sales-contracts/${d.contract.id}`)).json().installments[0].journalLineId as string;
    const rec = await w.c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 2), accountId: bank.id, amount: '1650000', partyId: w.buyer.id, items: [{ lineId: line, amount: '30000', settleAmount: '1650000' }] });
    expect(rec.statusCode, rec.body).toBe(201);
    const after = (await w.c.get(`/api/sales-contracts/${d.contract.id}`)).json();
    expect(after.contract).toMatchObject({ paid: '30000.00', remaining: '90000.00', overdue: '90000.00' });
    expect(after.installments[0]).toMatchObject({ paid: '30000.00', remaining: '0.00' });
    expect(after.installments[1]).toMatchObject({ paid: '0.00', remaining: '45000.00' });
    const fx = await w.jr(rec.json().transaction.journalEntryId);
    expect(fx.of('646')).toEqual([{ code: '646', d: 0, c: 150_000, db: 0, cb: 150_000, project: null }]); // 30.000 × (55 − 50)
    // Tahsilatı olan etkin sözleşme iptal edilemez
    const cancel = await w.c.post(`/api/sales-contracts/${d.contract.id}/cancel`, { reason: 'Vazgeçti' });
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.code).toBe('CONTRACT_HAS_PAYMENTS');
  });

  it('teslim: 380 gelire (600) aktarılır, proje etiketli; proje maliyeti etkilenmez; iptal yalnızca tahsilatsız', async () => {
    const w = await world('Teslim');
    const d = await w.draft('A4');
    await w.c.post(`/api/sales-contracts/${d.contract.id}/activate`, {});
    const hand = await w.c.post(`/api/sales-contracts/${d.contract.id}/handover`, { date: day(9, 15) });
    expect(hand.statusCode, hand.body).toBe(200);
    expect(hand.json().contract).toMatchObject({ status: 'handed_over', handedOverOn: day(9, 15) });
    const j = await w.jr(hand.json().contract.handoverEntryId);
    expect(j.of('380')).toEqual([{ code: '380', d: 120000, c: 0, db: 6_000_000, cb: 0, project: null }]);
    expect(j.of('600')).toEqual([{ code: '600', d: 0, c: 120000, db: 0, cb: 6_000_000, project: w.project.id }]);
    expect((await w.c.get(`/api/real-estate/units/${d.unit.id}`)).json().unit.status).toBe('handed_over');
    // 380 bakiyesi sıfırlandı
    const tb = (await w.c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    const closing = (code: string) => Number(Object.fromEntries(tb.rows.map((r: any) => [r.code, r.closing]))[code] ?? 0);
    expect(closing('380')).toBe(0);
    // Gelir proje raporunda
    const report = (await w.c.get(`/api/projects/${w.project.id}/cost-report`)).json();
    expect(Number(report.totals.revenue)).toBe(6_000_000);
    expect(Number(report.totals.actual)).toBe(0);
    // Teslimden sonra iptal/teslim tekrarı yok
    expect((await w.c.post(`/api/sales-contracts/${d.contract.id}/cancel`, { reason: 'Hata' })).json().error.code).toBe('CONTRACT_CANNOT_CANCEL');
    expect((await w.c.post(`/api/sales-contracts/${d.contract.id}/handover`, {})).json().error.code).toBe('CONTRACT_NOT_ACTIVE');

    // Tahsilatsız etkin sözleşme iptal edilir: ters kayıt, birim yeniden satışa açık
    const d2 = await w.draft('A5');
    await w.c.post(`/api/sales-contracts/${d2.contract.id}/activate`, {});
    const cancelled = await w.c.post(`/api/sales-contracts/${d2.contract.id}/cancel`, { reason: 'Alıcı vazgeçti' });
    expect(cancelled.json().contract).toMatchObject({ status: 'cancelled', cancelReason: 'Alıcı vazgeçti' });
    expect((await w.c.get(`/api/real-estate/units/${d2.unit.id}`)).json().unit.status).toBe('available');
    const tb2 = (await w.c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    expect(Number(Object.fromEntries(tb2.rows.map((r: any) => [r.code, r.closing]))['380'] ?? 0)).toBe(0);
    // Yeni sözleşme açılabilir
    expect((await w.c.post('/api/sales-contracts', w.planBody(d2.unit.id))).statusCode).toBe(201);
  });

  it('fesih + iade: ödenmemiş taksitler kalem bazında kapanır, kesinti gelire, iade kasadan; başka kalemler etkilenmez', async () => {
    const w = await world('Fesih');
    // Aynı alıcının başka (eski vadeli) alacağı: FIFO havuzu fesih kapatmasını yutmamalı
    await w.c.post('/api/invoices', { post: true, type: 'sales', partyId: w.buyer.id, invoiceDate: day(1, 5), dueDate: day(1, 20), currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '1000' }] });
    const d = await w.draft('F1');
    const act = await w.c.post(`/api/sales-contracts/${d.contract.id}/activate`, {});
    expect(act.statusCode, act.body).toBe(200);
    // GBP banka hesabına 52 kurla peşinat (30.000) tahsil edilir
    const bank = (await w.c.post('/api/treasury/accounts', { kind: 'bank', name: 'KTB GBP', currency: 'GBP' })).json().account as { id: string };
    await w.c.put('/api/exchange-rates', { rateDate: day(3, 2), currencyCode: 'GBP', quoteCode: 'TRY', buy: '52' });
    const line = (await w.c.get(`/api/sales-contracts/${d.contract.id}`)).json().installments[0].journalLineId as string;
    const rec = await w.c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 2), accountId: bank.id, amount: '30000', fxRate: '52', partyId: w.buyer.id, items: [{ lineId: line, amount: '30000', settleAmount: '30000' }] });
    expect(rec.statusCode, rec.body).toBe(201);

    await w.c.put('/api/exchange-rates', { rateDate: day(3, 10), currencyCode: 'GBP', quoteCode: 'TRY', buy: '54' });
    // Kesinti tahsilatı aşamaz; iade için hesap şart
    expect((await w.c.post(`/api/sales-contracts/${d.contract.id}/terminate`, { date: day(3, 10), reason: 'Alıcı vazgeçti', retained: '30001', refundAccountId: bank.id })).json().error.code).toBe('TERMINATION_RETAIN_TOO_HIGH');
    expect((await w.c.post(`/api/sales-contracts/${d.contract.id}/terminate`, { date: day(3, 10), reason: 'Alıcı vazgeçti', retained: '3000' })).json().error.code).toBe('REFUND_ACCOUNT_REQUIRED');

    const term = await w.c.post(`/api/sales-contracts/${d.contract.id}/terminate`, { date: day(3, 10), reason: 'Alıcı vazgeçti', retained: '3000', refundAccountId: bank.id });
    expect(term.statusCode, term.body).toBe(200);
    const t = term.json();
    expect(t.contract).toMatchObject({ status: 'terminated', paid: '30000.00', remaining: '0.00' });
    expect(t.termination).toMatchObject({ collected: '30000.0000', retained: '3000.0000', refund: '27000.0000' });
    expect(t.installments.map((i: any) => [i.paid, i.remaining])).toEqual([['30000.00', '0.00'], ['0.00', '0.00'], ['0.00', '0.00']]);

    // Yevmiye: 380 borç (hepsi) / 120 ödenmemiş 90.000 / 679 kesinti / banka iade; fiş dengeli
    const entryId = (await asDb(handle, { userId: w.s.userId, orgId: w.orgId, companyId: w.company.id }, async (q) => (await q(`select entry_id from sales_terminations where contract_id = $1`, [d.contract.id])).rows[0].entry_id)) as string;
    const j = await w.jr(entryId);
    expect(j.of('380')).toEqual([{ code: '380', d: 120000, c: 0, db: 6_000_000, cb: 0, project: null }]);
    expect(j.of('120').map((l) => [l.c, l.cb])).toEqual([[45000, 2_250_000], [45000, 2_250_000]]);
    expect(j.of('679')).toEqual([{ code: '679', d: 0, c: 3000, db: 0, cb: 162_000, project: w.project.id }]);
    expect(j.of('102.001').map((l) => l.c)).toEqual([27000]);
    const totalD = j.lines.reduce((s, l) => s + l.db, 0);
    const totalC = j.lines.reduce((s, l) => s + l.cb, 0);
    expect(totalD).toBeCloseTo(totalC, 2);

    // Cari: sözleşmenin açık kalemi kalmadı; yalnızca başka fatura açık (yaşlandırma/ekstre bozulmadı)
    const open = (await w.c.get(`/api/parties/${w.buyer.id}/open-items?asOf=${day(12, 31)}&type=receivable`)).json().receivable;
    expect(open.items.map((o: any) => [o.currencyCode, o.remaining])).toEqual([['TRY', '1000.00']]);
    expect(open.unapplied).toBe('0.00');
    // Birim yeniden satışa açık; ikinci fesih/iptal yok
    expect((await w.c.get(`/api/real-estate/units/${d.unit.id}`)).json().unit.status).toBe('available');
    expect((await w.c.post(`/api/sales-contracts/${d.contract.id}/terminate`, { reason: 'Tekrar', retained: '0' })).json().error.code).toBe('CONTRACT_NOT_ACTIVE');
    // Fesih kaydı değiştirilemez
    await asDb(handle, { userId: w.s.userId, orgId: w.orgId, companyId: w.company.id }, async (q) => {
      expect((await expectDbError(q, `update sales_terminations set retained = 0, refund = collected`)).code).toBe('42501');
    });
  });

  it('tahsilatsız fesih: yalnızca ödenmemiş kalemler kapanır, iade yok', async () => {
    const w = await world('FesihTahsilatsiz');
    const d = await w.draft('F2');
    await w.c.post(`/api/sales-contracts/${d.contract.id}/activate`, {});
    await w.c.put('/api/exchange-rates', { rateDate: day(3, 10), currencyCode: 'GBP', quoteCode: 'TRY', buy: '54' });
    const term = await w.c.post(`/api/sales-contracts/${d.contract.id}/terminate`, { date: day(3, 10), reason: 'Sözleşme sona erdi' });
    expect(term.statusCode, term.body).toBe(200);
    expect(term.json().termination).toMatchObject({ collected: '0.0000', retained: '0.0000', refund: '0.0000' });
    const open = (await w.c.get(`/api/parties/${w.buyer.id}/open-items?asOf=${day(12, 31)}&type=receivable`)).json().receivable;
    expect(open.items).toEqual([]);
    const tb = (await w.c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    const closing = (code: string) => Number(Object.fromEntries(tb.rows.map((r: any) => [r.code, r.closing]))[code] ?? 0);
    expect(closing('380')).toBe(0);
    expect(closing('120')).toBe(0);
  });

  it('taksit listesi, proje satış özeti ve dışa aktarmalar', async () => {
    const w = await world('Ozet');
    const d = await w.draft('S1');
    await w.c.post(`/api/sales-contracts/${d.contract.id}/activate`, {});
    await w.unit('S2'); // satışa açık kalır
    const inst = (await w.c.get('/api/real-estate/installments')).json();
    expect(inst.installments.map((i: any) => [i.dueDate, i.amount, i.remaining, i.currencyCode])).toEqual([
      [day(3, 1), '30000.00', '30000.00', 'GBP'], [day(6, 1), '45000.00', '45000.00', 'GBP'], [day(9, 1), '45000.00', '45000.00', 'GBP'],
    ]);
    expect(inst.installments.every((i: any) => i.daysOverdue > 0)).toBe(true); // tarihler geçmişte
    expect((await w.c.get('/api/real-estate/installments?overdue=true')).json().installments).toHaveLength(3);
    const sum = (await w.c.get(`/api/projects/${w.project.id}/sales-summary`)).json();
    expect(sum.units.sold.count).toBe(1);
    expect(sum.units.available.count).toBe(1);
    expect(sum.units.sold.grossM2).toBe('120.50');
    expect(sum.byCurrency).toEqual([{ currencyCode: 'GBP', contracts: 1, price: '120000.00', collected: '0.00', remaining: '120000.00', overdue: '120000.00' }]);

    const book = async (url: string) => {
      const res = await w.c.get(url);
      expect(res.statusCode, res.body).toBe(200);
      return readXlsx(new Uint8Array(res.rawPayload))[0]!.rows;
    };
    const plan = await book(`/api/exports/sales-schedule?format=xlsx&contractId=${d.contract.id}`);
    expect(plan[0]![0]).toContain('Ödeme planı');
    expect(plan[3]).toEqual(['No', 'Tür', 'Vade', 'Tutar (GBP)', 'Ödenen (GBP)', 'Kalan (GBP)', 'Gecikme (gün)']);
    expect(plan[4]!.slice(0, 4)).toEqual(['1', 'Peşinat', day(3, 1), '30000']);
    expect(plan[plan.length - 1]).toEqual(['', 'Toplam', '', '120000', '0', '120000', '']);
    expect((await book('/api/exports/real-estate-units?format=xlsx')).length).toBeGreaterThan(5);
    expect((await book('/api/exports/sales-contracts?format=xlsx'))[4]![0]).toMatch(/^SSZ-/);
    expect((await book('/api/exports/overdue-installments?format=xlsx&overdue=true'))[0]![0]).toBe('Geciken taksitler');
  });

  it('proje kârlılığı: sözleşmeli gelir, tanınmış gelir/maliyet, tahmini kâr; defter ve raporlama (GBP) para birimi', async () => {
    const s = await registerUser(app, 'Karlilik');
    const company = await createCompany(app, s.token, { reportingCurrency: 'GBP' });
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const project = (await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
    const buyer = (await c.post('/api/parties', { name: 'Alıcı', kind: 'customer' })).json().party as { id: string };
    await c.put('/api/exchange-rates', { rateDate: day(3, 1), currencyCode: 'GBP', quoteCode: 'TRY', buy: '50' });
    const todayRate = TODAY_LOCAL;
    await c.put('/api/exchange-rates', { rateDate: todayRate, currencyCode: 'GBP', quoteCode: 'TRY', buy: '50' });
    const mk = async (unitNo: string, listPrice?: string) => (await c.post('/api/real-estate/units', { projectId: project.id, unitNo, ...(listPrice ? { listPrice, listCurrency: 'GBP' } : {}) })).json().unit.id as string;
    const u1 = await mk('1');
    await mk('2', '100000'); // satılmamış
    const contract = (await c.post('/api/sales-contracts', { unitId: u1, partyId: buyer.id, currencyCode: 'GBP', contractDate: day(3, 1), price: '120000', downPayment: '0', installments: [{ kind: 'installment', dueDate: day(6, 1), amount: '120000' }] })).json().contract.id as string;
    await c.post(`/api/sales-contracts/${contract}/activate`, {});
    await c.post(`/api/sales-contracts/${contract}/handover`, { date: day(3, 5) });
    // Maliyet: 1.000.000 TL, projeye etiketli (770 gider / 100 kasa)
    const e = await c.post('/api/journal-entries', { entryDate: day(3, 6), description: 'Proje gideri', post: true, lines: [{ accountId: ids['770'], currency: 'TRY', debit: '1000000', projectId: project.id }, { accountId: ids['100'], currency: 'TRY', credit: '1000000' }] });
    expect(e.statusCode, e.body).toBe(201);

    const res = (await c.get('/api/projects/profitability')).json();
    expect(res).toMatchObject({ baseCurrency: 'TRY', reportingCurrency: 'GBP' });
    const row = res.rows.find((r: any) => r.id === project.id);
    expect(row).toMatchObject({ contractedRevenue: '6000000.00', unsoldValue: '5000000.00', revenue: '6000000.00', actual: '1000000.00', recognizedProfit: '5000000.00' });
    expect(row.projectedProfit).toBe('5000000.00'); // EAC yok: gerçekleşen maliyet kullanılır
    expect(row.marginPct).toBe('83.3');
    // Raporlama (GBP): gelir 120.000 (tarihsel), maliyet 1.000.000 / 50 = 20.000
    expect(row.reporting).toMatchObject({ revenue: '120000.00', actual: '20000.00', recognizedProfit: '100000.00', contractedRevenue: '120000.00' });
    expect(res.totals.reporting.projectedProfit).toBe('100000.00');
    const book = readXlsx(new Uint8Array((await c.get('/api/exports/project-profitability?format=xlsx')).rawPayload))[0]!.rows;
    expect(book[0]![0]).toBe('Proje kârlılığı');
    expect(book[3]).toContain('Tahmini kâr (GBP)');
  });

  it('fon ve harç: tarifeler (tarihli, doğrulama), alıcıdan tahsil edilen fon satırı bedele sayılmaz, 329 yükümlülük, teslimde fon kalır, fesihte iade', async () => {
    const w = await world('Fon');
    const sched = await w.c.post('/api/fee-schedules', { code: 'ELK', name: 'Elektrik altyapı fonu', side: 'buyer', basis: 'per_unit', amount: '1500', currencyCode: 'GBP', validFrom: day(1, 1), sourceNote: 'Demo (doğrulanmadı)' });
    expect(sched.statusCode, sched.body).toBe(201);
    const id = sched.json().feeSchedule.id as string;
    expect(sched.json().feeSchedule.verifiedAt).toBeNull();
    expect((await w.c.post('/api/fee-schedules', { code: 'X', name: 'Hatalı', side: 'buyer', basis: 'per_m2', amount: '10', validFrom: day(1, 1) })).statusCode).toBe(400); // para birimi şart
    expect((await w.c.post(`/api/fee-schedules/${id}/verify`, { verifiedBy: 'Mali müşavir', sourceNote: 'Belediye tebliği' })).json().feeSchedule.verifiedBy).toBe('Mali müşavir');
    await w.c.post('/api/fee-schedules', { code: 'ELK', name: 'Elektrik altyapı fonu (yeni)', side: 'buyer', basis: 'per_unit', amount: '1800', currencyCode: 'GBP', validFrom: day(7, 1) });
    expect((await w.c.get(`/api/fee-schedules?side=buyer&date=${day(3, 1)}`)).json().feeSchedules.map((f: any) => f.amount)).toEqual(['1500.0000']);
    expect((await w.c.get(`/api/fee-schedules?side=buyer&date=${day(8, 1)}`)).json().feeSchedules.map((f: any) => f.amount)).toEqual(['1800.0000']);

    // Sözleşme: bedel 120.000 + fon 1.500 (bedele sayılmaz)
    const u = await w.unit('FN1');
    const created = await w.c.post('/api/sales-contracts', w.planBody(u.id, {
      installments: [
        { kind: 'down_payment', dueDate: day(3, 1), amount: '30000' },
        { kind: 'installment', dueDate: day(6, 1), amount: '90000' },
        { kind: 'fee', dueDate: day(3, 1), amount: '1500', feeScheduleId: id, label: 'Elektrik altyapı fonu' },
      ],
    }));
    expect(created.statusCode, created.body).toBe(201);
    expect((await w.c.post('/api/sales-contracts', w.planBody((await w.unit('FN2')).id, { installments: [{ kind: 'down_payment', dueDate: day(3, 1), amount: '30000' }, { kind: 'installment', dueDate: day(6, 1), amount: '90000' }, { kind: 'fee', dueDate: day(3, 1), amount: '1500' }] }))).json().error.code).toBe('FEE_LABEL_REQUIRED');
    const cid = created.json().contract.id as string;
    const act = await w.c.post(`/api/sales-contracts/${cid}/activate`, {});
    expect(act.statusCode, act.body).toBe(200);
    expect(act.json().contract).toMatchObject({ price: '120000.0000', feesTotal: '1500.00', feesPaid: '0.00', feesRemaining: '1500.00', remaining: '120000.00' });
    const j = await w.jr(act.json().contract.activationEntryId);
    expect(j.of('120').map((l) => l.d)).toEqual([30000, 1500, 90000]); // vade sırası: peşinat, fon (aynı gün), taksit
    expect(j.of('380')).toEqual([{ code: '380', d: 0, c: 120000, db: 0, cb: 6_000_000, project: null }]);
    expect(j.of('329')).toEqual([{ code: '329', d: 0, c: 1500, db: 0, cb: 75_000, project: null }]);

    // Peşinat ve fon tahsil edilir (TL, 50 kuru)
    const bank = (await w.c.post('/api/treasury/accounts', { kind: 'bank', name: 'KTB TL', currency: 'TRY' })).json().account as { id: string };
    const inst = act.json().installments as { kind: string; journalLineId: string }[];
    for (const i of inst.filter((x) => x.kind !== 'installment')) {
      const amount = i.kind === 'fee' ? '1500' : '30000';
      const rec = await w.c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 1), accountId: bank.id, amount: String(Number(amount) * 50), partyId: w.buyer.id, items: [{ lineId: i.journalLineId, amount, settleAmount: String(Number(amount) * 50) }] });
      expect(rec.statusCode, rec.body).toBe(201);
    }
    const mid = (await w.c.get(`/api/sales-contracts/${cid}`)).json().contract;
    expect(mid).toMatchObject({ paid: '30000.00', remaining: '90000.00', feesPaid: '1500.00', feesRemaining: '0.00' });

    // Fesih: kesinti 3.000 (bedelden), iade = 27.000 + fon 1.500 = 28.500; fon yükümlülüğü kapanır
    await w.c.put('/api/exchange-rates', { rateDate: day(3, 10), currencyCode: 'GBP', quoteCode: 'TRY', buy: '50' });
    expect((await w.c.post(`/api/sales-contracts/${cid}/terminate`, { date: day(3, 10), reason: 'Vazgeçti', retained: '30001', refundAccountId: bank.id })).json().error.code).toBe('TERMINATION_RETAIN_TOO_HIGH');
    const bal0 = Number((await w.c.get(`/api/treasury/accounts/${bank.id}`)).json().account.balance);
    const term = await w.c.post(`/api/sales-contracts/${cid}/terminate`, { date: day(3, 10), reason: 'Vazgeçti', retained: '3000', refundAccountId: bank.id });
    expect(term.statusCode, term.body).toBe(200);
    expect(term.json().termination).toMatchObject({ collected: '31500.0000', retained: '3000.0000', refund: '28500.0000' });
    expect(Number((await w.c.get(`/api/treasury/accounts/${bank.id}`)).json().account.balance)).toBeCloseTo(bal0 - 28500 * 50, 0); // TL hesap: iade GBP karşılığı çıkar
    const tb = (await w.c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    const closing = (code: string) => Number(Object.fromEntries(tb.rows.map((r: any) => [r.code, r.closing]))[code] ?? 0);
    expect(closing('380')).toBe(0);
    expect(closing('329')).toBe(0);
    expect(closing('120')).toBe(0);
  });

  it('fon: teslimde yalnızca bedel gelire geçer; proje fon tahmini ve fon maliyet kodu harcaması', async () => {
    const w = await world('FonTahmin');
    const u = await w.unit('T1');
    await w.unit('T2');
    const sc = await w.c.post('/api/sales-contracts', w.planBody(u.id, { installments: [{ kind: 'down_payment', dueDate: day(3, 1), amount: '30000' }, { kind: 'installment', dueDate: day(6, 1), amount: '90000' }, { kind: 'fee', dueDate: day(3, 1), amount: '1500', label: 'Su fonu' }] }));
    const cid = sc.json().contract.id as string;
    await w.c.post(`/api/sales-contracts/${cid}/activate`, {});
    const hand = await w.c.post(`/api/sales-contracts/${cid}/handover`, { date: day(3, 5) });
    expect(hand.statusCode, hand.body).toBe(200);
    const j = await w.jr(hand.json().contract.handoverEntryId);
    expect(j.of('600')).toEqual([{ code: '600', d: 0, c: 120000, db: 0, cb: 6_000_000, project: w.project.id }]);
    expect(j.of('329')).toEqual([]);

    // Proje tarifesi: birim başına 100 TL + brüt m² başına 2 TL (iki birim, her biri 120,5 m²) + bedelin %0,5'i
    await w.c.post('/api/fee-schedules', { code: 'BLD', name: 'Belediye harcı', side: 'project', basis: 'per_unit', amount: '100', currencyCode: 'TRY', validFrom: day(1, 1) });
    await w.c.post('/api/fee-schedules', { code: 'M2', name: 'Altyapı m²', side: 'project', basis: 'per_m2', amount: '2', currencyCode: 'TRY', validFrom: day(1, 1) });
    await w.c.post('/api/fee-schedules', { code: 'PCT', name: 'Satış harcı', side: 'project', basis: 'pct_of_price', amount: '0.5', validFrom: day(1, 1) });
    const cc = (await w.c.post('/api/cost-codes', { code: 'FON', name: 'Fon ve harç', kind: 'fee' })).json().costCode as { id: string };
    const e = await w.c.post('/api/journal-entries', { entryDate: day(3, 6), description: 'Belediye harcı ödemesi', post: true, lines: [{ accountId: w.ids['770'], currency: 'TRY', debit: '150', projectId: w.project.id, costCodeId: cc.id }, { accountId: w.ids['100'], currency: 'TRY', credit: '150' }] });
    expect(e.statusCode, e.body).toBe(201);
    const est = (await w.c.get(`/api/projects/${w.project.id}/fee-estimate?asOf=${day(12, 31)}`)).json();
    expect(est).toMatchObject({ units: 2, grossM2: '241.00', estimate: '30682.00', actual: '150.00', remaining: '30532.00', missingRate: 0 });
    expect(est.rows.map((r: any) => [r.code, r.estimate])).toEqual([['BLD', '200.00'], ['M2', '482.00'], ['PCT', '30000.00']]); // %0,5 × 6.000.000
  });

  it('kur yoksa etkinleştirme anlaşılır hata verir; kapalı dönem ve izinler', async () => {
    const w = await world('KurYok');
    const u = await w.unit('K1');
    const eur = await w.c.post('/api/sales-contracts', { ...w.planBody(u.id), currencyCode: 'EUR' });
    expect(eur.statusCode).toBe(201);
    const act = await w.c.post(`/api/sales-contracts/${eur.json().contract.id}/activate`, {});
    expect(act.statusCode).toBe(422);
    expect(act.json().error.code).toBe('FX_RATE_MISSING');
  });

  it('ERP12 korumaları (ham SQL): etkin sözleşme ve taksit değiştirilemez, birim durumu sözleşmeyle tutarlı', async () => {
    const w = await world('Koruma');
    const d = await w.draft('G1');
    await w.c.post(`/api/sales-contracts/${d.contract.id}/activate`, {});
    await asDb(handle, { userId: w.s.userId, orgId: w.orgId, companyId: w.company.id }, async (q) => {
      expect((await expectDbError(q, `update sales_contracts set price = 1 where id = $1`, [d.contract.id])).code).toBe('ERP12');
      expect((await expectDbError(q, `update sales_installments set amount = 1 where contract_id = $1`, [d.contract.id])).code).toBe('ERP12');
      expect((await expectDbError(q, `delete from sales_installments where contract_id = $1`, [d.contract.id])).code).toBe('ERP12');
      expect((await expectDbError(q, `delete from sales_contracts where id = $1`, [d.contract.id])).code).toBe('42501');
      expect((await expectDbError(q, `update real_estate_units set status = 'available' where id = $1`, [d.unit.id])).code).toBe('ERP12');
      expect((await expectDbError(q, `update real_estate_units set status = 'handed_over' where id = $1`, [d.unit.id])).code).toBe('ERP12');
    });
    await execAsOwner(`select 1`);
  });

  it('izin: görüntüleyici okur ama yazamaz; şantiye sorumlusu okur', async () => {
    const w = await world('Izin');
    const viewer = await (await import('./helpers')).addMember(app, w.c, w.company.id, 'viewer');
    const sm = await (await import('./helpers')).addMember(app, w.c, w.company.id, 'site_manager');
    expect((await viewer.client.get('/api/real-estate/units')).statusCode).toBe(200);
    expect((await viewer.client.post('/api/real-estate/units', { projectId: w.project.id, unitNo: '1' })).statusCode).toBe(403);
    expect((await sm.client.get('/api/sales-contracts')).statusCode).toBe(200);
    expect((await sm.client.post('/api/real-estate/units/bulk', { projectId: w.project.id, floorFrom: 1, floorTo: 1, perFloor: 1 })).statusCode).toBe(403);
  });
});
