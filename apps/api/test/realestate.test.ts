import { describe, expect, it } from 'vitest';
import { accountIds, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

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
    expect(cancel.json().error.code).toBe('REAL_ESTATE_RULE_VIOLATION');
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
