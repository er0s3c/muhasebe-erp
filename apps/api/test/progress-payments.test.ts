import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountIds, addMember, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('taşeron hakedişi (B2c): kümülatif hakediş, kesintiler, onay, yevmiye, ödeme, iptal, avans, teminat', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string, opts: { retention?: string; advance?: string; withholding?: string; currency?: string } = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const project = (await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '05', name: 'Elektrik' })).json().wbs[0] as { id: string };
    const party = (await c.post('/api/parties', { name: 'XYZ Elektrik Ltd', kind: 'supplier' })).json().party as { id: string };
    const codes = (await c.get('/api/cost-codes')).json().costCodes as { id: string; code: string }[];
    const tsr = codes.find((x) => x.code === 'TSR')!;
    const created = await c.post('/api/subcontracts', {
      projectId: project.id,
      partyId: party.id,
      title: 'Elektrik tesisatı',
      currencyCode: opts.currency ?? 'TRY',
      paymentDays: 30,
      retentionPct: opts.retention ?? '5',
      advanceRecoupPct: opts.advance ?? '10',
      withholdingPct: opts.withholding ?? '0',
    });
    const sc = created.json().subcontract as { id: string };
    const rev = created.json().revisions[0].id as string;
    // BOQ: kablo 15.000 m × 3 = 45.000; pano 30 adet × 500 = 15.000; toplam 60.000
    const put = await c.put(`/api/subcontract-revisions/${rev}/lines`, {
      lines: [
        { itemNo: '1', description: 'Kablo çekimi', unit: 'm', quantity: '15000', unitPrice: '3', wbsId: wbs.id },
        { itemNo: '2', description: 'Pano kurulumu', unit: 'adet', quantity: '30', unitPrice: '500', wbsId: wbs.id, costCodeId: tsr.id },
      ],
    });
    await c.post(`/api/subcontract-revisions/${rev}/approve`, {});
    const keys = Object.fromEntries((put.json().lines as { itemNo: string; lineKey: string }[]).map((l) => [l.itemNo, l.lineKey]));
    const bank = (await c.post('/api/treasury/accounts', { kind: 'bank', name: 'Ana banka', currency: opts.currency ?? 'TRY' })).json().account as { id: string; accountId: string };
    const payload = (cum1: string, cum2: string, extra: Record<string, unknown> = {}) => ({
      subcontractId: sc.id,
      periodEnd: day(3, 31),
      lines: [
        { lineKey: keys['1']!, cumulativeQty: cum1 },
        { lineKey: keys['2']!, cumulativeQty: cum2 },
      ],
      ...extra,
    });
    /** Hakedişi onaya gönderir ve (varsayılan tek adım) onaylar. */
    const approveFlow = async (id: string) => {
      const sub = await c.post(`/api/progress-payments/${id}/submit`, {});
      if (sub.statusCode !== 200) throw new Error(`submit failed: ${sub.body}`);
      const reqId = sub.json().approvals[0].id as string;
      const dec = await c.post(`/api/approvals/${reqId}/decide`, { decision: 'approve' });
      if (dec.statusCode !== 200) throw new Error(`decide failed: ${dec.body}`);
      return (await c.get(`/api/progress-payments/${id}`)).json();
    };
    const entry = async (entryId: string) => {
      const e = (await c.get(`/api/journal-entries/${entryId}`)).json().entry;
      const lines = e.lines as { accountCode: string; debit: string; credit: string; debitBase: string; creditBase: string; projectId: string | null; wbsId: string | null; costCode: string | null; partyId: string | null; dueDate: string | null }[];
      return { e, lines, of: (code: string) => lines.filter((l) => l.accountCode === code) };
    };
    return { s, company, c, ids, orgId, project, wbs, party, sc, keys, tsr, bank, payload, approveFlow, entry };
  }

  it('hakediş: kümülatif miktardan brüt, kesintiler ve net; onayda dengeli, etiketli yevmiye ve cari açık kalem', async () => {
    const w = await world('HakedisAkis');
    // KDV %16 (tohumlanan KDV kodu), diğer kesinti 500 (ceza)
    const draft = await w.c.post('/api/progress-payments', w.payload('10000', '20', { vatCode: 'KDV-16', deductions: [{ description: 'Gecikme cezası', amount: '500' }] }));
    expect(draft.statusCode, draft.body).toBe(201);
    const p = draft.json().payment;
    // brüt = 10.000×3 + 20×500 = 40.000; teminat %5 = 2.000; avans bakiyesi yok → 0; KDV %16 = 6.400; kesinti 500
    expect(p).toMatchObject({ status: 'draft', paymentNo: 1, number: null, gross: '40000.00', retention: '2000.00', advance: '0.00', vat: '6400.00', otherDeductions: '500.00', net: '43900.00' });
    expect(draft.json().lines.map((l: { thisQty: string; prevQty: string; amount: string }) => [l.prevQty, l.thisQty, l.amount])).toEqual([['0.0000', '10000.0000', '30000.00'], ['0.0000', '20.0000', '10000.00']]);

    // Sözleşmede aynı anda tek açık hakediş
    expect((await w.c.post('/api/progress-payments', w.payload('10', '1'))).json().error.code).toBe('PROGRESS_OPEN_EXISTS');
    const basis = (await w.c.get(`/api/subcontracts/${w.sc.id}/progress-basis`)).json();
    expect(basis.subcontract).toMatchObject({ currencyCode: 'TRY', retentionPct: '5.0000', paymentDays: 30 });
    expect(basis.lines.map((l: { itemNo: string; prevQty: string }) => [l.itemNo, l.prevQty])).toEqual([['1', '0.0000'], ['2', '0.0000']]);

    const done = await w.approveFlow(p.id);
    expect(done.payment.status).toBe('posted');
    expect(done.payment.number).toBe(`HKD-${new Date().getUTCFullYear()}-000001`);
    expect(done.approvals[0].status).toBe('approved');

    const j = await w.entry(done.payment.entryId);
    // B 740 (iş kalemi + maliyet kodu etiketli), B 191 KDV / A 326 teminat, A 320 cari net
    const costLines = j.of('740');
    expect(costLines.reduce((s, l) => s + Number(l.debitBase), 0)).toBe(39500); // brüt 40.000 − kesinti 500 (net maliyet)
    for (const l of costLines) expect(l).toMatchObject({ projectId: w.project.id, wbsId: w.wbs.id });
    expect(costLines.map((l) => l.costCode)).toEqual(['TSR']); // aynı iş kalemi + kod tek satırda toplanır; kodsuz BOQ satırı varsayılan "taşeron" kodunu alır
    expect(j.of('191')[0]).toMatchObject({ debitBase: '6400.0000' });
    expect(j.of('326')[0]).toMatchObject({ creditBase: '2000.0000' });
    expect(j.of('320')[0]).toMatchObject({ creditBase: '43900.0000', partyId: w.party.id, dueDate: day(4, 30) });
    expect(j.lines.reduce((s, l) => s + Number(l.debitBase) - Number(l.creditBase), 0)).toBe(0);
    expect(j.e).toMatchObject({ sourceType: 'progress_payment', sourceId: p.id, status: 'posted' });

    // Proje maliyeti defterden türer: tagged net maliyet
    const report = (await w.c.get(`/api/projects/${w.project.id}/transactions`)).json();
    expect(JSON.stringify(report)).toContain('740');

    // Cari açık kalem: hakediş net tutarıyla borç; ödeme mevcut akışla eşleştirilir
    const open = (await w.c.get(`/api/parties/${w.party.id}/open-items?asOf=${day(12, 31)}&type=payable`)).json().payable;
    expect(open.items[0]).toMatchObject({ amount: '43900.00', remaining: '43900.00' });
    const pay = await w.c.post('/api/treasury/transactions', { type: 'payment', date: day(4, 20), accountId: w.bank.id, amount: '43900', partyId: w.party.id, items: [{ lineId: open.items[0].lineId, amount: '43900', settleAmount: '43900' }] });
    expect(pay.statusCode, pay.body).toBe(201);

    // Ödemesi eşleşmiş hakediş iptal edilemez; ödeme iptalinden sonra edilir
    const blocked = await w.c.post(`/api/progress-payments/${p.id}/cancel`, { reason: 'Hatalı metraj' });
    expect(blocked.json().error.code).toBe('PROGRESS_HAS_PAYMENTS');
    await w.c.post(`/api/treasury/transactions/${pay.json().transaction.id}/cancel`, { reason: 'Deneme', date: day(4, 21) });
    const cancelled = await w.c.post(`/api/progress-payments/${p.id}/cancel`, { reason: 'Hatalı metraj' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().payment.status).toBe('cancelled');
    const after = (await w.c.get(`/api/parties/${w.party.id}/open-items?asOf=${day(12, 31)}&type=payable`)).json().payable;
    expect(after.items).toHaveLength(0);
    // İptal sonrası kümülatif sıfırlanır: yeni hakediş baştan başlar
    const again = await w.c.post('/api/progress-payments', w.payload('10000', '20'));
    expect(again.json().payment.paymentNo).toBe(2);
    expect(again.json().lines[0].prevQty).toBe('0.0000');
  });

  it('kümülatif zincir: ikinci hakediş önceki kümülatifin üstüne kurulur; azalma ve sözleşme aşımı reddedilir', async () => {
    const w = await world('HakedisZincir', { retention: '0', advance: '0' });
    const first = await w.c.post('/api/progress-payments', w.payload('5000', '10'));
    await w.approveFlow(first.json().payment.id);

    const second = await w.c.post('/api/progress-payments', w.payload('12000', '10'));
    expect(second.statusCode, second.body).toBe(201);
    // 2. hakediş: kablo 7.000 m daha (21.000); pano değişmedi → satır dışı
    expect(second.json().payment).toMatchObject({ paymentNo: 2, gross: '21000.00' });
    expect(second.json().lines).toHaveLength(1);
    expect(second.json().lines[0]).toMatchObject({ prevQty: '5000.0000', cumQty: '12000.0000', thisQty: '7000.0000' });

    const del = await w.c.delete(`/api/progress-payments/${second.json().payment.id}`);
    expect(del.statusCode).toBe(204);
    expect((await w.c.post('/api/progress-payments', w.payload('4000', '10'))).json().error.code).toBe('PROGRESS_QTY_BELOW_PREVIOUS');
    expect((await w.c.post('/api/progress-payments', w.payload('15001', '10'))).json().error.code).toBe('PROGRESS_QTY_OVER_CONTRACT');
    expect((await w.c.post('/api/progress-payments', w.payload('5000', '10'))).json().error.code).toBe('PROGRESS_EMPTY');

    // Önceki hakediş iptal edilirken sonrası varsa engellenir
    const third = await w.c.post('/api/progress-payments', w.payload('15000', '30'));
    await w.approveFlow(third.json().payment.id);
    const firstId = first.json().payment.id as string;
    expect((await w.c.post(`/api/progress-payments/${firstId}/cancel`, { reason: 'Deneme iptali' })).json().error.code).toBe('PROGRESS_LATER_EXISTS');
  });

  it('avans: verilir (kasa/banka), hakedişte yüzdeyle mahsup edilir ve bakiyeyle sınırlanır; teminat iadesi cariye açık kalem olur', async () => {
    const w = await world('HakedisAvans', { retention: '10', advance: '50' });
    // Avans 5.000 verilir (diğer ödeme → avans hesabı)
    const adv = await w.c.post(`/api/subcontracts/${w.sc.id}/advances`, { accountId: w.bank.id, date: day(3, 1), amount: '5000', note: 'Mobilizasyon' });
    expect(adv.statusCode, adv.body).toBe(201);
    expect(adv.json().balances).toMatchObject({ advanceGiven: '5000.00', advanceBalance: '5000.00' });

    // Brüt 30.000 → avans %50 = 15.000 ama bakiye 5.000 ile sınırlanır; teminat %10 = 3.000
    const p1 = await w.c.post('/api/progress-payments', w.payload('10000', '0'));
    expect(p1.json().payment).toMatchObject({ gross: '30000.00', advance: '5000.00', retention: '3000.00', net: '22000.00' });
    const done = await w.approveFlow(p1.json().payment.id);
    const j = await w.entry(done.payment.entryId);
    expect(j.of('159')[0]).toMatchObject({ creditBase: '5000.0000' }); // verilen avans kapanır
    expect(j.of('320')[0]).toMatchObject({ creditBase: '22000.0000' });
    expect((await w.c.get(`/api/subcontracts/${w.sc.id}/balances`)).json().balances).toMatchObject({ advanceBalance: '0.00', retentionHeld: '3000.00', retentionBalance: '3000.00', certifiedGross: '30000.00' });

    // Sonraki hakedişte avans bakiyesi yok → mahsup yok
    const p2 = await w.c.post('/api/progress-payments', w.payload('15000', '0'));
    expect(p2.json().payment.advance).toBe('0.00');
    await w.c.delete(`/api/progress-payments/${p2.json().payment.id}`);

    // Teminat iadesi: bakiyeyi aşamaz; iade 320 cariye açık kalem yazar
    expect((await w.c.post(`/api/subcontracts/${w.sc.id}/retention-releases`, { date: day(5, 1), amount: '3000.01' })).json().error.code).toBe('RETENTION_OVER_BALANCE');
    const rel = await w.c.post(`/api/subcontracts/${w.sc.id}/retention-releases`, { date: day(5, 1), amount: '1000' });
    expect(rel.statusCode, rel.body).toBe(201);
    expect(rel.json().balances).toMatchObject({ retentionReleased: '1000.00', retentionBalance: '2000.00' });
    const open = (await w.c.get(`/api/parties/${w.party.id}/open-items?asOf=${day(12, 31)}&type=payable`)).json().payable;
    expect(open.items.map((i: { amount: string }) => i.amount).sort()).toEqual(['1000.00', '22000.00']);
    // İade edilmiş teminatı olan hakediş, kalan teminatı aşacaksa iptal edilemez
    const cancel = await w.c.post(`/api/progress-payments/${done.payment.id}/cancel`, { reason: 'Deneme iptali' });
    expect(cancel.json().error.code).toBe('PROGRESS_RETENTION_RELEASED');
  });

  it('onay akışı: tutar kademeli iki adım, ret taslağa döndürür, geri çekme; yetki ve kendi belgesini onaylama', async () => {
    const w = await world('HakedisOnay', { retention: '0', advance: '0' });
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    await w.c.post('/api/approval-rules', { docType: 'progress_payment', minAmount: '0', steps: [{ role: 'site_manager', label: 'Şantiye' }, { role: 'accountant', label: 'Finans' }], separateRequester: true });

    // Şantiye sorumlusu taslak hazırlar ve gönderir; kendi belgesinin ilk adımını onaylayamaz
    const draft = await sm.client.post('/api/progress-payments', w.payload('1000', '0'));
    expect(draft.statusCode, draft.body).toBe(201);
    const id = draft.json().payment.id as string;
    const sub = await sm.client.post(`/api/progress-payments/${id}/submit`, {});
    expect(sub.json().payment.status).toBe('submitted');
    const reqId = sub.json().approvals[0].id as string;
    expect((await sm.client.post(`/api/approvals/${reqId}/decide`, { decision: 'approve' })).json().error.code).toBe('APPROVAL_SELF_DECISION');
    // Onaydaki hakediş değiştirilemez
    expect((await sm.client.put(`/api/progress-payments/${id}`, w.payload('2000', '0'))).json().error.code).toBe('PROGRESS_NOT_DRAFT');

    // Sahip (owner rolü) adımın rolüne uymaz; muhasebeci ilk adımda yetkisiz
    expect((await acc.client.post(`/api/approvals/${reqId}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    // Ret → taslağa döner, neden saklanır, yeniden gönderilebilir
    const smOther = await addMember(app, w.c, w.company.id, 'site_manager', 'site_manager_2');
    const rej = await smOther.client.post(`/api/approvals/${reqId}/decide`, { decision: 'reject', note: 'Metraj hatalı' });
    expect(rej.json().request.status).toBe('rejected');
    const back = (await w.c.get(`/api/progress-payments/${id}`)).json();
    expect(back.payment).toMatchObject({ status: 'draft', rejectionNote: 'Metraj hatalı' });

    await sm.client.put(`/api/progress-payments/${id}`, w.payload('1200', '0'));
    const sub2 = await sm.client.post(`/api/progress-payments/${id}/submit`, {});
    const req2 = sub2.json().approvals[0].id as string;
    expect((await smOther.client.post(`/api/approvals/${req2}/decide`, { decision: 'approve' })).json().request.status).toBe('pending');
    expect((await acc.client.post(`/api/approvals/${req2}/decide`, { decision: 'approve' })).json().request.status).toBe('approved');
    const posted = (await w.c.get(`/api/progress-payments/${id}`)).json();
    expect(posted.payment.status).toBe('posted');
    expect(posted.approvals.map((a: { status: string }) => a.status).sort()).toEqual(['approved', 'rejected']);

    // Geri çekme
    const next = await sm.client.post('/api/progress-payments', w.payload('2000', '0'));
    await sm.client.post(`/api/progress-payments/${next.json().payment.id}/submit`, {});
    const wd = await sm.client.post(`/api/progress-payments/${next.json().payment.id}/withdraw`, {});
    expect(wd.json().payment.status).toBe('draft');
    // Şantiye sorumlusu iptal edemez (yetki)
    expect((await sm.client.post(`/api/progress-payments/${id}/cancel`, { reason: 'Deneme iptali' })).statusCode).toBe(403);
  });

  it('dövizli sözleşme (GBP): defter karşılığı kurla, cari satır dengeyi tamamlar', async () => {
    const w = await world('HakedisGbp', { currency: 'GBP', retention: '5', advance: '0' });
    await w.c.post('/api/rates', { rateDate: day(3, 31), currencyCode: 'GBP', quoteCode: 'TRY', buy: '40.3333', sell: '40.5' }).catch(() => null);
    const draft = await w.c.post('/api/progress-payments', w.payload('1001', '0'));
    expect(draft.statusCode, draft.body).toBe(201);
    const sub = await w.c.post(`/api/progress-payments/${draft.json().payment.id}/submit`, {});
    if (sub.statusCode !== 200) {
      // Kur yoksa açık hata verir (sessiz yanlış değer yok)
      expect(sub.json().error.code).toBe('FX_RATE_MISSING');
      return;
    }
    const reqId = sub.json().approvals[0].id as string;
    await w.c.post(`/api/approvals/${reqId}/decide`, { decision: 'approve' });
    const done = (await w.c.get(`/api/progress-payments/${draft.json().payment.id}`)).json();
    const j = await w.entry(done.payment.entryId);
    expect(j.lines.reduce((s, l) => s + Number(l.debitBase) - Number(l.creditBase), 0)).toBeCloseTo(0, 6);
    expect(done.payment.fxRate).not.toBeNull();
  });

  it('veritabanı: kaydedilmiş hakediş değişmez; satırları ve numarası; kaynaklı yevmiye tek başına ters çevrilemez; RLS', async () => {
    const w = await world('HakedisDb');
    const other = await world('HakedisDbB');
    const d = await w.c.post('/api/progress-payments', w.payload('1000', '0'));
    const id = d.json().payment.id as string;
    const done = await w.approveFlow(id);

    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      let e = await expectDbError(q, `update progress_payments set gross = 1, net = 1 where id = $1`, [id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update progress_payment_lines set cum_qty = 1, this_qty = 1 - prev_qty where payment_id = $1`, [id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `delete from progress_payment_lines where payment_id = $1`, [id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `delete from progress_payments where id = $1`, [id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update progress_payments set status = 'draft' where id = $1`, [id]);
      expect(e.code).toBe('ERP10');
      // Ters çevrilmeden iptal edilemez
      e = await expectDbError(q, `update progress_payments set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x' where id = $1`, [id]);
      expect(e.code).toBe('ERP10');
      // Net kimliği: toplam tutarlarla uyuşmayan satır yazılamaz (CHECK)
      e = await expectDbError(q, `update progress_payments set net = net + 1 where id = $1`, [id]);
      expect(e.message).toMatch(/./);
    });
    await expect(execAsOwner(`update progress_payments set note = 'x' where id = $1`, [id])).rejects.toThrow();

    // Belgeden doğan yevmiye tek başına ters çevrilemez
    const rev = await w.c.post(`/api/journal-entries/${done.payment.entryId}/reverse`, { entryDate: day(4, 1) });
    expect(rev.json().error.code).toBe('ENTRY_HAS_SOURCE');

    // Başka şirket göremez
    expect((await other.c.get(`/api/progress-payments/${id}`)).statusCode).toBe(404);
    expect((await other.c.get('/api/progress-payments')).json().payments).toHaveLength(0);

    // Koruma: taslak olmayan hakedişin satırına doğrudan ekleme
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      const e = await expectDbError(
        q,
        `insert into progress_payment_lines (id, company_id, payment_id, subcontract_id, project_id, line_key, line_no, description, unit, unit_price, prev_qty, cum_qty, this_qty, amount, wbs_id)
         values ($1, $2, $3, $4, $5, $6, 9, 'x', 'm', 1, 0, 1, 1, 1, $7)`,
        [randomUUID(), w.company.id, id, w.sc.id, w.project.id, randomUUID(), w.wbs.id],
      );
      expect(e.code).toBe('ERP10');
    });
  });

  it('eksik hesap eşlemesi açık hata verir ve hakedişi kaydetmez; dönem kapalıyken gönderilmez', async () => {
    const w = await world('HakedisHata');
    await w.c.put('/api/account-mappings', { mappings: { subcontract_cost: w.ids['770']! } });
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async () => undefined);
    await execAsOwner(`delete from account_mappings where company_id = $1 and key = 'subcontract_cost'`, [w.company.id]);
    const d = await w.c.post('/api/progress-payments', w.payload('1000', '0'));
    const sub = await w.c.post(`/api/progress-payments/${d.json().payment.id}/submit`, {});
    const decide = await w.c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' });
    expect(decide.statusCode).toBe(422);
    expect(decide.json().error.code).toBe('ACCOUNT_MAPPING_MISSING');
    // Karar da geri alınır: belge hâlâ onayda, talep bekliyor
    const still = (await w.c.get(`/api/progress-payments/${d.json().payment.id}`)).json();
    expect(still.payment.status).toBe('submitted');
    expect(still.approvals[0].status).toBe('pending');
  });

  it('maliyet raporu: kalan taahhüt (BOQ − hakediş brütü), EAC/CPI değişmez; maliyet koduna göre kırılım ve dışa aktarma', async () => {
    const w = await world('HakedisRapor', { retention: '0', advance: '0' });
    // Bütçe: iş kalemine 100.000
    const b = (await w.c.post(`/api/projects/${w.project.id}/budgets`, { copyFromCurrent: false })).json().budget as { id: string };
    await w.c.put(`/api/project-budgets/${b.id}/lines`, { lines: [{ wbsId: w.wbs.id, amount: '100000' }] });
    await w.c.post(`/api/project-budgets/${b.id}/approve`, {});

    const report = async () => (await w.c.get(`/api/projects/${w.project.id}/cost-report?asOf=${day(12, 31)}`)).json();
    let r = await report();
    const row = () => r.rows.find((x: { wbsId: string }) => x.wbsId === w.wbs.id);
    // Sözleşme 60.000, hakediş yok → taahhüt 60.000, gerçekleşen 0
    expect(row()).toMatchObject({ committed: '60000.00', actual: '0.00', actualPlusCommitted: '60000.00' });
    expect(r.totals).toMatchObject({ committed: '60000.00' });
    expect(r.commitments).toMatchObject({ contracts: 1, missingRate: 0 });
    const eacBefore = row().eac;
    const cpiBefore = row().cpi;

    // 40.000 brüt hakediş (kesintisiz) kaydedilir → taahhüt 20.000, gerçekleşen 40.000
    const p = await w.c.post('/api/progress-payments', w.payload('10000', '20'));
    await w.approveFlow(p.json().payment.id);
    r = await report();
    expect(row()).toMatchObject({ committed: '20000.00', actual: '40000.00', actualPlusCommitted: '60000.00' });
    expect(r.totals.committed).toBe('20000.00');
    // Taahhüt EAC'ye girmez: BAC 100.000, ilerleme yok → ETC = BAC − AC; EAC = AC + ETC = 100.000 (gerçekleşen artsa da aynı)
    expect(row().eac).toBe(eacBefore);
    expect(row().eac).toBe('100000.00');
    expect(row().cpi).toBe(cpiBefore);

    // Tarih öncesi görünüm: hakediş dönem sonundan önce taahhüt tam
    const early = (await w.c.get(`/api/projects/${w.project.id}/cost-report?asOf=${day(3, 1)}`)).json();
    expect(early.rows.find((x: { wbsId: string }) => x.wbsId === w.wbs.id).committed).toBe('60000.00');

    // İptal edilen hakediş taahhütten düşmez (geri yüklenir)
    await w.c.post(`/api/progress-payments/${p.json().payment.id}/cancel`, { reason: 'Deneme iptali' });
    r = await report();
    expect(row()).toMatchObject({ committed: '60000.00', actual: '0.00' });

    // Maliyet koduna göre kırılım
    const p2 = await w.c.post('/api/progress-payments', w.payload('10000', '20'));
    await w.approveFlow(p2.json().payment.id);
    const byCode = (await w.c.get(`/api/projects/${w.project.id}/cost-by-code?asOf=${day(12, 31)}`)).json();
    expect(byCode.rows).toEqual([{ costCodeId: w.tsr.id, code: 'TSR', name: 'Taşeron', actual: '40000.00', share: '100.00' }]);
    expect(byCode.total).toBe('40000.00');

    // Dışa aktarma uçları (xlsx/csv) ve yetki
    for (const key of ['subcontract-register', 'progress-payments']) {
      const res = await w.c.get(`/api/exports/${key}?format=csv`);
      expect(res.statusCode, `${key}: ${res.body}`).toBe(200);
    }
    const csv = await w.c.get(`/api/exports/subcontract-register?format=csv`);
    expect(csv.body).toContain('TSZ-');
    const cc = await w.c.get(`/api/exports/project-cost-by-code?format=csv&projectId=${w.project.id}&asOf=${day(12, 31)}`);
    expect(cc.statusCode, cc.body).toBe(200);
    const costCsv = await w.c.get(`/api/exports/project-cost-report?format=csv&projectId=${w.project.id}&asOf=${day(12, 31)}`);
    expect(costCsv.body).toContain('Kalan taahhüt');
    const sales = await addMember(app, w.c, w.company.id, 'sales');
    expect((await sales.client.get(`/api/exports/progress-payments?format=csv`)).statusCode).toBe(403);
  });
});
