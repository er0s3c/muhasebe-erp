import { describe, expect, it } from 'vitest';
import { accountIds, addMember, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

describe('işveren (alınan) hakedişi (B2e)', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string, opts: { retention?: string; advance?: string; withholding?: string } = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const employer = (await c.post('/api/parties', { name: 'Deniz Yatırım Ltd.', kind: 'customer' })).json().party as { id: string };
    const project = (await c.post('/api/projects', { name: 'Kuzey Villa', kind: 'contract', clientPartyId: employer.id })).json().project as { id: string };
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '01', name: 'Kaba inşaat' })).json().wbs[0] as { id: string };
    const created = await c.post('/api/subcontracts', {
      direction: 'receivable', projectId: project.id, partyId: employer.id, title: 'Anahtar teslim villa', currencyCode: 'TRY', paymentDays: 30,
      retentionPct: opts.retention ?? '10', advanceRecoupPct: opts.advance ?? '20', withholdingPct: opts.withholding ?? '0',
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    const sc = created.json().subcontract as { id: string; code: string };
    const rev = created.json().revisions[0].id as string;
    // İşveren BOQ'su: temel 1 götürü 400.000; karkas 1 götürü 600.000 → sözleşme 1.000.000
    const put = await c.put(`/api/subcontract-revisions/${rev}/lines`, {
      lines: [
        { itemNo: '1', description: 'Temel', unit: 'götürü', quantity: '1', unitPrice: '400000', wbsId: wbs.id },
        { itemNo: '2', description: 'Karkas', unit: 'götürü', quantity: '1', unitPrice: '600000', wbsId: wbs.id },
      ],
    });
    await c.post(`/api/subcontract-revisions/${rev}/approve`, {});
    const keys = Object.fromEntries((put.json().lines as { itemNo: string; lineKey: string }[]).map((l) => [l.itemNo, l.lineKey]));
    const bank = (await c.post('/api/treasury/accounts', { kind: 'bank', name: 'Ana banka', currency: 'TRY' })).json().account as { id: string };
    const payload = (c1: string, c2: string, extra: Record<string, unknown> = {}) => ({
      subcontractId: sc.id,
      periodEnd: day(3, 31),
      lines: [{ lineKey: keys['1']!, cumulativeQty: c1 }, { lineKey: keys['2']!, cumulativeQty: c2 }],
      ...extra,
    });
    const approveFlow = async (id: string) => {
      const sub = await c.post(`/api/progress-payments/${id}/submit`, {});
      if (sub.statusCode !== 200) throw new Error(`submit failed: ${sub.body}`);
      expect(sub.json().approvals[0].docType).toBe('employer_claim');
      const dec = await c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' });
      if (dec.statusCode !== 200) throw new Error(`decide failed: ${dec.body}`);
      return (await c.get(`/api/progress-payments/${id}`)).json();
    };
    const entry = async (entryId: string) => {
      const e = (await c.get(`/api/journal-entries/${entryId}`)).json().entry;
      const lines = e.lines as { accountCode: string; debitBase: string; creditBase: string; projectId: string | null; wbsId: string | null; costCode: string | null; partyId: string | null; dueDate: string | null }[];
      return { e, lines, of: (code: string) => lines.filter((l) => l.accountCode === code) };
    };
    return { s, company, c, ids: await accountIds(app, s.token, company.id), orgId, employer, project, wbs, sc, keys, bank, payload, approveFlow, entry };
  }

  it('sözleşme kuralları: yalnızca contract projesi ve proje işvereni; müşteri carisi; proje başına tek sözleşme; ayrı numara', async () => {
    const w = await world('IsverenKural');
    expect(w.sc.code).toMatch(/^IVS-\d{4}$/);
    const own = (await w.c.post('/api/projects', { name: 'Kendi projemiz', kind: 'own' })).json().project as { id: string };
    const r1 = await w.c.post('/api/subcontracts', { direction: 'receivable', projectId: own.id, partyId: w.employer.id, title: 'X', currencyCode: 'TRY' });
    expect(r1.json().error.code).toBe('EMPLOYER_PROJECT_KIND');
    const other = (await w.c.post('/api/parties', { name: 'Başka Müşteri', kind: 'customer' })).json().party as { id: string };
    expect((await w.c.post('/api/subcontracts', { direction: 'receivable', projectId: w.project.id, partyId: other.id, title: 'X', currencyCode: 'TRY' })).json().error.code).toBe('EMPLOYER_PARTY_MISMATCH');
    expect((await w.c.post('/api/subcontracts', { direction: 'receivable', projectId: w.project.id, partyId: w.employer.id, title: 'İkinci', currencyCode: 'TRY' })).json().error.code).toBe('EMPLOYER_CONTRACT_EXISTS');
    const supplier = (await w.c.post('/api/parties', { name: 'Tedarikçi', kind: 'supplier' })).json().party as { id: string };
    expect((await w.c.post('/api/subcontracts', { direction: 'receivable', projectId: w.project.id, partyId: supplier.id, title: 'X', currencyCode: 'TRY' })).json().error.code).toBe('PARTY_KIND_MISMATCH');
    // Taşeron sözleşmesi müşteri carisiyle açılamaz (mevcut kural)
    expect((await w.c.post('/api/subcontracts', { projectId: w.project.id, partyId: w.employer.id, title: 'Y', currencyCode: 'TRY' })).json().error.code).toBe('PARTY_KIND_MISMATCH');
    // Listeler yönle süzülür
    expect((await w.c.get('/api/subcontracts?direction=payable')).json().subcontracts).toHaveLength(0);
    expect((await w.c.get('/api/subcontracts?direction=receivable')).json().subcontracts).toHaveLength(1);
  });

  it('alınan hakediş: B 120 / A 600 (+KDV 391), teminat 126, avans 340, stopaj 193; gelir proje+iş kalemi etiketli; maliyet/EAC değişmez', async () => {
    const w = await world('IsverenYevmiye', { retention: '10', advance: '20', withholding: '5' });
    // İşverenden 50.000 avans alınır (diğer tahsilat → 340)
    const adv = await w.c.post(`/api/subcontracts/${w.sc.id}/advances`, { accountId: w.bank.id, date: day(3, 1), amount: '50000' });
    expect(adv.statusCode, adv.body).toBe(201);
    expect(adv.json().balances).toMatchObject({ advanceBalance: '50000.00' });

    // Temel bitti (400.000): brüt 400.000, KDV %16 = 64.000, teminat %10 = 40.000, avans %20 = 80.000 → bakiye 50.000 ile sınırlı,
    // stopaj %5 = 20.000, ceza 5.000. net = 400.000 + 64.000 − 40.000 − 50.000 − 20.000 − 5.000 = 349.000
    const d = await w.c.post('/api/progress-payments', w.payload('1', '0', { vatCode: 'KDV-16', deductions: [{ description: 'Gecikme cezası', amount: '5000' }] }));
    expect(d.statusCode, d.body).toBe(201);
    expect(d.json().payment).toMatchObject({ direction: 'receivable', gross: '400000.00', vat: '64000.00', retention: '40000.00', advance: '50000.00', withholding: '20000.00', otherDeductions: '5000.00', net: '349000.00' });
    const done = await w.approveFlow(d.json().payment.id);
    expect(done.payment.status).toBe('posted');
    expect(done.payment.number).toBe(`AHK-${thisYear}-000001`);

    const j = await w.entry(done.payment.entryId);
    expect(j.of('120')[0]).toMatchObject({ debitBase: '349000.0000', partyId: w.employer.id, dueDate: day(4, 30) });
    expect(j.of('126')[0]).toMatchObject({ debitBase: '40000.0000' });
    expect(j.of('340')[0]).toMatchObject({ debitBase: '50000.0000' });
    expect(j.of('193')[0]).toMatchObject({ debitBase: '20000.0000' });
    expect(j.of('391')[0]).toMatchObject({ creditBase: '64000.0000' });
    expect(j.of('600')[0]).toMatchObject({ creditBase: '395000.0000', projectId: w.project.id, wbsId: w.wbs.id }); // brüt − ceza
    expect(j.lines.reduce((s, l) => s + Number(l.debitBase) - Number(l.creditBase), 0)).toBe(0);
    expect(j.e).toMatchObject({ sourceType: 'progress_payment', status: 'posted' });

    // Gelir proje raporunda; maliyet, EAC ve taahhüt değişmez
    const report = (await w.c.get(`/api/projects/${w.project.id}/cost-report?asOf=${day(12, 31)}`)).json();
    expect(report.totals).toMatchObject({ revenue: '395000.00', actual: '0.00', committed: '0.00' });
    expect(report.commitments.contracts).toBe(0);

    // Özet: sözleşme 1.000.000, kümülatif 400.000, tahsil edilen 0, kalan alacak 349.000
    const sum = (await w.c.get(`/api/projects/${w.project.id}/employer-contract`)).json().summary;
    expect(sum).toMatchObject({ contractAmount: '1000000.00', cumulativeGross: '400000.00', thisPeriodGross: '400000.00', previousGross: '0.00', remainingContract: '600000.00', billedNet: '349000.00', collected: '0.00', outstanding: '349000.00', retentionBalance: '40000.00', advanceBalance: '0.00' });

    // Tahsilat mevcut akışla 120 açık kalemini kapatır
    const open = (await w.c.get(`/api/parties/${w.employer.id}/open-items?asOf=${day(12, 31)}&type=receivable`)).json().receivable;
    expect(open.items[0]).toMatchObject({ amount: '349000.00', remaining: '349000.00' });
    const rec = await w.c.post('/api/treasury/transactions', { type: 'receipt', date: day(4, 20), accountId: w.bank.id, amount: '149000', partyId: w.employer.id, items: [{ lineId: open.items[0].lineId, amount: '149000', settleAmount: '149000' }] });
    expect(rec.statusCode, rec.body).toBe(201);
    const sum2 = (await w.c.get(`/api/projects/${w.project.id}/employer-contract`)).json().summary;
    expect(sum2).toMatchObject({ collected: '149000.00', outstanding: '200000.00' });

    // Tahsilatı eşleşmiş hakediş iptal edilemez; tahsilat iptalinden sonra ters kayıtla iptal olur
    expect((await w.c.post(`/api/progress-payments/${d.json().payment.id}/cancel`, { reason: 'Hatalı metraj' })).json().error.code).toBe('PROGRESS_HAS_PAYMENTS');
    await w.c.post(`/api/treasury/transactions/${rec.json().transaction.id}/cancel`, { reason: 'Deneme', date: day(4, 21) });
    const cancelled = await w.c.post(`/api/progress-payments/${d.json().payment.id}/cancel`, { reason: 'Hatalı metraj' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await w.c.get(`/api/parties/${w.employer.id}/open-items?asOf=${day(12, 31)}&type=receivable`)).json().receivable.items).toHaveLength(0);
  });

  it('kümülatif zincir, teminat iadesi (B 120 / A 126) ve işveren ile taşeron listeleri ayrı', async () => {
    const w = await world('IsverenZincir', { retention: '10', advance: '0' });
    const p1 = await w.c.post('/api/progress-payments', w.payload('1', '0'));
    await w.approveFlow(p1.json().payment.id);
    expect((await w.c.post('/api/progress-payments', w.payload('0', '1'))).json().error.code).toBe('PROGRESS_QTY_BELOW_PREVIOUS');
    const p2 = await w.c.post('/api/progress-payments', w.payload('1', '1'));
    expect(p2.json().payment).toMatchObject({ paymentNo: 2, gross: '600000.00', retention: '60000.00' });
    expect(p2.json().lines).toHaveLength(1);
    await w.approveFlow(p2.json().payment.id);

    // Tutulan teminat 100.000; 30.000 iade → işveren cari alacağı (120 borç) doğar
    const rel = await w.c.post(`/api/subcontracts/${w.sc.id}/retention-releases`, { date: day(6, 1), amount: '30000' });
    expect(rel.statusCode, rel.body).toBe(201);
    expect(rel.json().balances).toMatchObject({ retentionHeld: '100000.00', retentionReleased: '30000.00', retentionBalance: '70000.00' });
    const open = (await w.c.get(`/api/parties/${w.employer.id}/open-items?asOf=${day(12, 31)}&type=receivable`)).json().receivable;
    expect(open.items.map((i: { amount: string }) => i.amount).sort()).toEqual(['30000.00', '360000.00', '540000.00']);

    expect((await w.c.get('/api/progress-payments?direction=receivable')).json().payments).toHaveLength(2);
    expect((await w.c.get('/api/progress-payments?direction=payable')).json().payments).toHaveLength(0);
    const all = (await w.c.get('/api/exports/progress-payments?format=csv&direction=receivable')).body as string;
    expect(all).toContain('AHK-');
    expect(all).toContain('"İşveren"');
  });

  it('onay kuralı employer_claim ayrıdır; yetki ve DB korumaları (yön değişmez, yanlış cari, sahip rolü)', async () => {
    const w = await world('IsverenOnay', { retention: '0', advance: '0' });
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    // Yalnızca taşeron hakedişi (progress_payment) için tanımlı kural işveren hakedişini etkilemez
    await w.c.post('/api/approval-rules', { docType: 'progress_payment', minAmount: '0', steps: [{ role: 'site_manager' }, { role: 'accountant' }] });
    const d = await sm.client.post('/api/progress-payments', w.payload('1', '0'));
    const sub = await sm.client.post(`/api/progress-payments/${d.json().payment.id}/submit`, {});
    expect(sub.json().approvals[0].steps).toHaveLength(1); // varsayılan tek adım
    await w.c.post('/api/approval-rules', { docType: 'employer_claim', minAmount: '0', steps: [{ role: 'site_manager' }, { role: 'accountant' }] });
    await sm.client.post(`/api/progress-payments/${d.json().payment.id}/withdraw`, {});
    const again = await sm.client.post(`/api/progress-payments/${d.json().payment.id}/submit`, {});
    expect(again.json().approvals.find((a: { status: string }) => a.status === 'pending').steps).toHaveLength(2);
    expect((await sm.client.post(`/api/subcontracts/${w.sc.id}/advances`, { accountId: w.bank.id, date: day(3, 1), amount: '10' })).statusCode).toBe(403);

    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      let e = await expectDbError(q, `update subcontracts set direction = 'payable' where id = $1`, [w.sc.id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update progress_payments set direction = 'payable' where id = $1`, [d.json().payment.id]);
      expect(e.code).toBe('ERP10');
    });
    await expect(execAsOwner(`update subcontracts set direction = 'payable' where id = $1`, [w.sc.id])).rejects.toThrow();
  });
});
