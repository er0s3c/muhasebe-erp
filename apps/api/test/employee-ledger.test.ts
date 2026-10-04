import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asOwner, client, createCompany, expectDbError, makeApp, orgOf, registerUser, thisYear, TODAY_LOCAL } from './helpers';

/**
 * Personel cari ve avans takibi (Faz X5). Tutarlar test değeridir; hesap eşlemeleri (196 personel avansları, 335 ödenecek net ücret)
 * varsayılan ve DOĞRULANMAMIŞTIR: testler davranışı (yevmiye dengesi, korumalar, bakiye) sınar, muhasebe doğruluğunu değil.
 * Avans kesintisi üst sınırı yalnızca kullanıcı parametresidir.
 */
const MONTH = TODAY_LOCAL.slice(0, 7);
const TODAY = TODAY_LOCAL;
const d = (n: number) => `${MONTH}-${String(n).padStart(2, '0')}`;
const FROM = `${thisYear}-01-01`;

describe('personel cari ve avans takibi (Faz X5)', async () => {
  const { app, handle: _handle } = await makeApp();

  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const res = await p;
    if (res.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { sector: 'CONSTRUCTION' });
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const mkEmp = async (body: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/employees', { fullName: 'Ali Veli', hireDate: FROM, iban: 'TR33 0006 1005 1978 6457 8413 26', ...body }), 201)).employee as { id: string; code: string };
    const payable = async (body: Record<string, unknown> = {}, salary = '3000') => {
      const e = await mkEmp(body);
      await ok(c.post('/api/payroll/pay-terms', { employeeId: e.id, effectiveFrom: FROM, payBasis: 'monthly', amount: salary }), 201);
      await ok(c.put('/api/attendance/entries', { entries: [{ employeeId: e.id, workDate: d(2), dayType: 'worked', normalHours: '8' }] }));
      return e;
    };
    const bank = async (n = 'Banka TL', currency = 'TRY', kind = 'bank') => (await ok(c.post('/api/treasury/accounts', { kind, name: n, currency }), 201)).account as { id: string; accountId: string };
    const advance = async (employeeId: string, accountId: string, amount = '1000', extra: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/employee-ledger/advances', { employeeId, date: TODAY, amount, purpose: 'Şantiye harcırahı', treasuryAccountId: accountId, ...extra }), 201)) as { advance: Record<string, any>; settlements: any[]; events: any[] };
    const getAdvance = async (id: string) => (await ok(c.get(`/api/employee-ledger/advances/${id}`))) as { advance: Record<string, any>; settlements: any[]; events: any[] };
    const balances = async () => (await ok(c.get('/api/employee-ledger/balances'))).rows as Record<string, any>[];
    const mkRun = async () => (await ok(c.post('/api/payroll/runs', { month: MONTH }), 201)) as { run: Record<string, any>; lines: Record<string, any>[]; adjustments: Record<string, any>[] };
    const closeAtt = () => ok(c.post('/api/attendance/months/close', { month: MONTH }));
    const entryOf = async (id: string) => (await ok(c.get(`/api/journal-entries/${id}`))).entry as { lines: Record<string, any>[] };
    const txnEntry = async (txnId: string) => entryOf((await ok(c.get(`/api/treasury/transactions/${txnId}`))).transaction.journalEntryId);
    const sumLines = (lines: Record<string, any>[], code: string, side: 'debitBase' | 'creditBase') => lines.filter((l) => l.accountCode === code).reduce((x, l) => x + Number(l[side]), 0);
    const deduct = (runId: string, employeeId: string, deductions: { advanceId: string; amount: string }[]) => c.put(`/api/employee-ledger/runs/${runId}/deductions`, { employeeId, deductions });
    return { s, company, c, orgId, mkEmp, payable, bank, advance, getAdvance, balances, mkRun, closeAtt, entryOf, txnEntry, sumLines, deduct };
  }

  it('personel carisi: kartından açılır (yalnız ad), personel başına tek, cari listesinde görünmez, ticari yevmiyede kullanılamaz, değişmez/silinmez', async () => {
    const w = await world('XcCari');
    const e = await w.mkEmp({ fullName: 'Hasan Usta' });
    const o = await ok(w.c.post(`/api/employee-ledger/employees/${e.id}/open-party`, {}), 201);
    expect(o).toMatchObject({ created: true, party: { name: 'Hasan Usta', kind: 'employee' } });
    expect(o.party.code).toMatch(/^CR-/);
    const again = await ok(w.c.post(`/api/employee-ledger/employees/${e.id}/open-party`, {}), 200);
    expect(again).toMatchObject({ created: false, party: { id: o.party.id } });
    // Kart cari bağlantısını gösterir; ad değişince cari adı eşitlenir; hassas alan cariye kopyalanmaz
    expect((await ok(w.c.get(`/api/employees/${e.id}`))).employee.partyId).toBe(o.party.id);
    await ok(w.c.patch(`/api/employees/${e.id}`, { fullName: 'Hasan Usta Yılmaz' }));
    const party = (await ok(w.c.get(`/api/parties/${o.party.id}`))).party;
    expect(party).toMatchObject({ name: 'Hasan Usta Yılmaz', kind: 'employee', taxNumber: null, phone: null, email: null, address: null });
    // Cari listesinde görünmez; müşteri/tedarikçi ticari hareketinde kullanılamaz
    expect(((await ok(w.c.get('/api/parties'))).parties as any[]).map((p) => p.id)).not.toContain(o.party.id);
    const inv = await w.c.post('/api/invoices', { type: 'sales', partyId: o.party.id, invoiceDate: d(1), lines: [{ description: 'x', quantity: '1', unitPrice: '10', vatCode: 'KDV-16' }] });
    expect(inv.statusCode).toBe(422);
    // Kullanıcı cari formundan 'personel' türü açamaz/değiştiremez
    expect((await w.c.post('/api/parties', { name: 'Sahte', kind: 'employee' })).statusCode).toBe(400);
    const kindChange = await w.c.patch(`/api/parties/${o.party.id}`, { kind: 'supplier' });
    expect(kindChange.statusCode).toBe(422);
    expect(kindChange.json().error.code).toBe('EMPLOYEE_LEDGER_RULE_VIOLATION');
    const del = await w.c.delete(`/api/parties/${o.party.id}`);
    expect(del.statusCode).toBe(422);
    expect(del.json().error.code).toBe('EMPLOYEE_LEDGER_RULE_VIOLATION');
    // Veritabanı korumaları (sahip rolü dahil): tek cari, değişmez, tür değişmez
    const e2 = await w.mkEmp({ fullName: 'Veli Can' });
    const p2 = (await ok(w.c.post(`/api/employee-ledger/employees/${e2.id}/open-party`, {}), 201)).party;
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update employees set party_id = '${o.party.id}' where id = '${e2.id}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update employees set party_id = null where id = '${e.id}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update parties set kind = 'both' where id = '${p2.id}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `delete from parties where id = '${p2.id}'`)).code).toBe('ERP20');
      // Müşteri türündeki cari personele bağlanamaz
      const cust = (await q(`select id from parties where company_id = '${w.company.id}' and kind <> 'employee' limit 1`)).rows[0];
      if (cust) expect((await expectDbError(q, `update employees set party_id = '${cust.id}' where id = '${e.id}' and party_id is null`)).code).toBeDefined();
    });
    // Aynı cariye iki personel bağlanamaz (benzersiz dizin)
    const third = await w.mkEmp({ fullName: 'Üçüncü Kişi' });
    await asOwner(async (q) => {
      const err = await expectDbError(q, `update employees set party_id = '${p2.id}' where id = '${third.id}'`);
      expect(['ERP20', '23505']).toContain(err.code);
    });
    // Başka şirketin personeli bulunamaz (RLS)
    const other = await world('XcCariB');
    expect((await other.c.post(`/api/employee-ledger/employees/${e.id}/open-party`, {})).statusCode).toBe(404);
  });

  it('avans verme: kasa/banka ödemesi + yevmiye (borç personel avansları), bakiye, sicil, ekstre; döviz hesabı ve geleceğe tarih reddedilir; iptal ters kayıt yazar', async () => {
    const w = await world('XcAvans');
    const e = await w.mkEmp({ fullName: 'Avans Alan' });
    const bank = await w.bank();
    const a = await w.advance(e.id, bank.id, '1000');
    expect(a.advance).toMatchObject({ status: 'open', amount: '1000.00', settledAmount: '0.00', openAmount: '1000.00', employeeName: 'Avans Alan' });
    expect(a.advance.number).toMatch(/^AVN-\d{4}-000001$/);
    expect(a.events.map((x) => [x.fromStatus, x.toStatus])).toEqual([[null, 'open']]);
    // Yevmiye: borç 196, alacak banka; denge
    const je = await w.txnEntry(a.advance.treasuryTxnId);
    const bankCode = je.lines.find((l) => Number(l.creditBase) > 0)!.accountCode as string;
    expect(w.sumLines(je.lines, '196', 'debitBase')).toBe(1000);
    expect(w.sumLines(je.lines, bankCode, 'creditBase')).toBe(1000);
    expect(je.lines.reduce((x, l) => x + Number(l.debitBase) - Number(l.creditBase), 0)).toBe(0);
    // Bakiye listesi: personel şirkete 1000 borçlu
    const row = (await w.balances()).find((r) => r.employeeId === e.id)!;
    expect(row).toMatchObject({ advanceGiven: '1000.00', openAdvance: '1000.00', net: '-1000.00', salaryNet: '0.00' });
    const reg = await ok(w.c.get('/api/employee-ledger/advances'));
    expect(reg.rows[0]).toMatchObject({ number: a.advance.number, open: '1000.00', ageDays: 0, status: 'open' });
    expect(reg.totals.open).toBe('1000.00');
    const st = await ok(w.c.get(`/api/employee-ledger/employees/${e.id}/statement?from=${FROM}&to=${TODAY}`));
    expect(st.lines.map((l: any) => [l.kind, l.debit, l.credit, l.balance])).toEqual([['advance', '1000.00', '0.00', '-1000.00']]);
    expect(st.closing).toBe('-1000.00');
    expect(st.openAdvances).toHaveLength(1);
    // Geçersizler
    expect((await w.c.post('/api/employee-ledger/advances', { employeeId: e.id, date: `${thisYear + 1}-01-01`, amount: '10', purpose: 'Gelecek', treasuryAccountId: bank.id })).json().error.code).toBe('ADVANCE_DATE_FUTURE');
    const usd = await w.bank('Banka USD', 'USD');
    expect((await w.c.post('/api/employee-ledger/advances', { employeeId: e.id, date: TODAY, amount: '10', purpose: 'Döviz', treasuryAccountId: usd.id })).json().error.code).toBe('EMPLOYEE_LEDGER_CURRENCY');
    expect((await w.c.post('/api/employee-ledger/advances', { employeeId: e.id, date: TODAY, amount: '0', purpose: 'Sıfır', treasuryAccountId: bank.id })).statusCode).toBe(400);
    expect((await w.c.post('/api/employee-ledger/advances', { employeeId: e.id, date: TODAY, amount: '10', purpose: 'x', treasuryAccountId: bank.id })).statusCode).toBe(400);
    // Avansı ödeyen hareket kasa/banka ekranından doğrudan iptal edilemez
    const direct = await w.c.post(`/api/treasury/transactions/${a.advance.treasuryTxnId}/cancel`, { reason: 'Doğrudan iptal denemesi' });
    expect(direct.statusCode).toBe(422);
    expect(direct.json().error.code).toBe('EMPLOYEE_LEDGER_RULE_VIOLATION');
    // İptal: ters kayıt, durum iptal, bakiye sıfırlanır, geçmiş yazılır
    const cancelled = await ok(w.c.post(`/api/employee-ledger/advances/${a.advance.id}/cancel`, { reason: 'Yanlış personel' }));
    expect(cancelled.advance.status).toBe('cancelled');
    expect(cancelled.events.map((x: any) => x.toStatus)).toEqual(['open', 'cancelled']);
    expect((await ok(w.c.get(`/api/treasury/transactions/${a.advance.treasuryTxnId}`))).transaction.status).toBe('cancelled');
    expect((await w.balances()).find((r) => r.employeeId === e.id)).toBeUndefined();
    expect((await w.c.post(`/api/employee-ledger/advances/${a.advance.id}/cancel`, { reason: 'Tekrar' })).json().error.code).toBe('ADVANCE_CANCELLED');
  });

  it('elle geri ödeme: kısmi → kapandı, kalanı aşamaz, kasa/banka tahsilatı yevmiyesi dengeli; hareket iptali taksiti geri alır; veritabanı korumaları', async () => {
    const w = await world('XcGeri');
    const e = await w.mkEmp();
    const bank = await w.bank();
    const a = await w.advance(e.id, bank.id, '1000');
    const repay = (amount: string) => w.c.post(`/api/employee-ledger/advances/${a.advance.id}/repay`, { amount, date: TODAY, treasuryAccountId: bank.id });
    const r1 = await ok(repay('400'));
    expect(r1.advance).toMatchObject({ status: 'partial', settledAmount: '400.00', openAmount: '600.00' });
    expect(r1.settlements).toHaveLength(1);
    const rec = ((await ok(w.c.get('/api/treasury/transactions?type=other_receipt'))).transactions as { id: string; txnNo: string }[]).find((t) => t.txnNo === r1.settlements[0].txnNo)!;
    const je = await w.txnEntry(rec.id);
    expect(w.sumLines(je.lines, '196', 'creditBase')).toBe(400);
    expect(je.lines.reduce((x, l) => x + Number(l.debitBase), 0)).toBe(400);
    expect((await repay('700')).json().error.code).toBe('ADVANCE_EXCEEDS_OPEN');
    const r2 = await ok(repay('600'));
    expect(r2.advance).toMatchObject({ status: 'settled', settledAmount: '1000.00', openAmount: '0.00' });
    expect(r2.events.map((x: any) => x.toStatus)).toEqual(['open', 'partial', 'settled']);
    expect((await repay('1')).json().error.code).toBe('ADVANCE_NOT_OPEN');
    expect((await w.balances()).find((r) => r.employeeId === e.id)).toMatchObject({ advanceRepaid: '1000.00', openAdvance: '0.00', net: '0.00' });
    expect((await w.c.post(`/api/employee-ledger/advances/${a.advance.id}/cancel`, { reason: 'Kapanmış avans' })).json().error.code).toBe('ADVANCE_HAS_SETTLEMENTS');

    // Geri ödeme hareketini kasa/banka ekranından iptal etmek taksiti geri alır, avans yeniden kısmen açılır
    const txns = (await ok(w.c.get('/api/treasury/transactions?type=other_receipt'))).transactions as { id: string; amount: string }[];
    const t600 = txns.find((t) => t.amount === '600.0000' || t.amount === '600.00' || Number(t.amount) === 600)!;
    await ok(w.c.post(`/api/treasury/transactions/${t600.id}/cancel`, { reason: 'Hatalı tahsilat' }));
    const after = await w.getAdvance(a.advance.id);
    expect(after.advance).toMatchObject({ status: 'partial', settledAmount: '400.00' });
    expect(after.settlements.filter((s) => s.reversedAt)).toHaveLength(1);
    expect(after.events.map((x) => x.toStatus)).toEqual(['open', 'partial', 'settled', 'partial']);

    // Veritabanı korumaları (sahip rolü dahil)
    await asOwner(async (q) => {
      const adv = a.advance.id;
      expect((await expectDbError(q, `delete from employee_advances where id = '${adv}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update employee_advances set amount = 5000 where id = '${adv}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update employee_advances set settled_amount = 900 where id = '${adv}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update employee_advances set settled_amount = 5000, status = 'settled' where id = '${adv}'`)).code).toMatch(/ERP20|23514/);
      expect((await expectDbError(q, `update employee_advances set status = 'settled' where id = '${adv}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `delete from employee_advance_settlements where advance_id = '${adv}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update employee_advance_settlements set amount = 1 where advance_id = '${adv}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `delete from employee_advance_events where advance_id = '${adv}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update employee_advance_events set to_status = 'open' where advance_id = '${adv}'`)).code).toBe('ERP20');
      // Kalanı aşan taksit eklenemez (kalan 600; ham ekleme: geri ödeme hareketi doğrulaması da çalışır)
      const t = (await q(`select id, txn_date from treasury_transactions where id = '${t600.id}'`)).rows[0];
      const bad = await expectDbError(q, `insert into employee_advance_settlements (id, company_id, advance_id, kind, amount, settled_date, treasury_txn_id) values (gen_random_uuid(), '${w.company.id}', '${adv}', 'repayment', 600, '${t.txn_date.toISOString?.().slice(0, 10) ?? TODAY}', '${t600.id}')`);
      expect(bad.code).toBe('ERP20');
    });
  });

  it('bordro entegrasyonu: avans kesintisi net ücreti düşürür, yevmiye dengeli (335 net + 196 kesinti, 336 yok), onayda taksit, iptalde geri alınır; kesinti elle girilemez', async () => {
    const w = await world('XcBordro');
    const e = await w.payable({ fullName: 'Maaşlı Personel' }, '3000');
    const bank = await w.bank();
    const adv = await w.advance(e.id, bank.id, '1000');
    await w.closeAtt();
    const run = await w.mkRun();
    expect(run.lines[0]).toMatchObject({ net: '3000.0000' });

    // Elle ek kalem olarak girilemez (rezerve kod)
    expect((await w.c.post('/api/payroll/items', { code: 'AVANS_KESINTISI', name: 'Elle', kind: 'deduction', liability: 'other' })).statusCode).toBe(409);
    // Kesinti seçimi: avans başka personele ait / kalanı aşıyor
    const other = await w.mkEmp({ fullName: 'Başka' });
    const otherAdv = await w.advance(other.id, bank.id, '50');
    expect((await w.deduct(run.run.id, e.id, [{ advanceId: otherAdv.advance.id, amount: '10' }])).json().error.code).toBe('ADVANCE_EMPLOYEE_MISMATCH');
    expect((await w.deduct(run.run.id, e.id, [{ advanceId: adv.advance.id, amount: '1000.01' }])).json().error.code).toBe('ADVANCE_EXCEEDS_OPEN');

    const set = await ok(w.deduct(run.run.id, e.id, [{ advanceId: adv.advance.id, amount: '600' }]));
    expect(set.deductions).toHaveLength(1);
    expect(set.settings.deductionCapPct).toBeNull(); // varsayılan: sınır yok
    const draft = (await ok(w.c.get(`/api/payroll/runs/${run.run.id}`))) as any;
    expect(draft.lines[0]).toMatchObject({ gross: '3000.0000', otherDeductions: '600.0000', net: '2400.0000' });
    const advAdj = draft.adjustments.find((a: any) => a.itemCode === 'AVANS_KESINTISI');
    expect(advAdj).toMatchObject({ amount: '600.0000' });
    expect((await w.c.put(`/api/payroll/runs/${run.run.id}/adjustments`, { employeeId: e.id, itemId: advAdj.itemId, amount: '5' })).json().error.code).toBe('PAYROLL_ITEM_RESERVED');
    expect((await w.c.delete(`/api/payroll/runs/${run.run.id}/adjustments/${advAdj.id}`)).json().error.code).toBe('PAYROLL_ITEM_RESERVED');
    expect((await w.c.patch(`/api/payroll/items/${advAdj.itemId}`, { isActive: false })).statusCode).toBe(409);
    // Taslakta avans kapanmaz; avans taslak bordroda seçiliyken iptal edilemez
    expect((await w.getAdvance(adv.advance.id)).advance).toMatchObject({ status: 'open', settledAmount: '0.00' });
    expect((await w.c.post(`/api/employee-ledger/advances/${adv.advance.id}/cancel`, { reason: 'Bordroda seçili' })).json().error.code).toBe('ADVANCE_IN_DRAFT_RUN');

    // Onay: yevmiye dengeli; net 335, kesinti 196; diğer kesinti borcu (336) yok
    const ap = (await ok(w.c.post(`/api/payroll/runs/${run.run.id}/approve`))) as any;
    const je = await w.entryOf(ap.run.entryId);
    expect(w.sumLines(je.lines, '335', 'creditBase')).toBe(2400);
    expect(w.sumLines(je.lines, '196', 'creditBase')).toBe(600);
    expect(w.sumLines(je.lines, '336', 'creditBase')).toBe(0);
    expect(je.lines.reduce((x, l) => x + Number(l.debitBase), 0)).toBe(je.lines.reduce((x, l) => x + Number(l.creditBase), 0));
    expect(w.sumLines(je.lines, '720', 'debitBase')).toBe(3000);
    const settled = await w.getAdvance(adv.advance.id);
    expect(settled.advance).toMatchObject({ status: 'partial', settledAmount: '600.00', openAmount: '400.00' });
    expect(settled.settlements[0]).toMatchObject({ kind: 'payroll', amount: '600.00', runNumber: ap.run.number });
    // Onaylı bordronun kesinti planı değişmez
    expect((await w.deduct(run.run.id, e.id, [])).json().error.code).toBe('PAYROLL_NOT_DRAFT');
    await asOwner(async (q) => {
      expect((await expectDbError(q, `delete from employee_advance_deductions where run_id = '${run.run.id}'`)).code).toBe('ERP20');
    });
    // Personel cari: bordro net 2400 alacak + kesinti 600 alacak − avans 1000 borç = +2000 (şirket personele borçlu)
    const bal = (await w.balances()).find((r) => r.employeeId === e.id)!;
    expect(bal).toMatchObject({ salaryNet: '2400.00', advanceGiven: '1000.00', advanceDeducted: '600.00', openAdvance: '400.00', net: '2000.00', unpaidSalary: '2400.00' });

    // Maaş ödemesi: ödenmemiş net ücreti aşamaz; kasa/banka çıkışı (borç 335); bakiye
    expect((await w.c.post('/api/employee-ledger/salary-payments', { employeeId: e.id, date: TODAY, amount: '2400.01', treasuryAccountId: bank.id })).json().error.code).toBe('SALARY_PAYMENT_EXCEEDS');
    const pay = await ok(w.c.post('/api/employee-ledger/salary-payments', { employeeId: e.id, date: TODAY, amount: '2400', treasuryAccountId: bank.id, payrollRunId: run.run.id }), 201);
    expect(pay.txnNo).toBeTruthy();
    const pj = await w.txnEntry(pay.payment.treasuryTxnId);
    expect(w.sumLines(pj.lines, '335', 'debitBase')).toBe(2400);
    expect((await w.c.post('/api/employee-ledger/salary-payments', { employeeId: e.id, date: TODAY, amount: '1', treasuryAccountId: bank.id })).json().error.code).toBe('SALARY_PAYMENT_EXCEEDS');
    expect((await w.balances()).find((r) => r.employeeId === e.id)).toMatchObject({ salaryPaid: '2400.00', net: '-400.00', openAdvance: '400.00' });
    // Maaş ödemesi kaydı değişmez/silinmez
    await asOwner(async (q) => {
      expect((await expectDbError(q, `delete from employee_salary_payments where employee_id = '${e.id}'`)).code).toBe('ERP20');
      expect((await expectDbError(q, `update employee_salary_payments set amount = 1 where employee_id = '${e.id}'`)).code).toBe('ERP20');
    });

    // Bordro iptali: ödenmiş işaretli değil; ters yevmiye; kesinti taksiti geri alınır, avans yeniden açık
    await ok(w.c.post(`/api/payroll/runs/${run.run.id}/cancel`, { reason: 'Hatalı bordro' }));
    const back = await w.getAdvance(adv.advance.id);
    expect(back.advance).toMatchObject({ status: 'open', settledAmount: '0.00', openAmount: '1000.00' });
    expect(back.settlements[0].reversedAt).not.toBeNull();
    expect(back.events.map((x) => x.toStatus)).toEqual(['open', 'partial', 'open']);
    const ledgerAfter = (await w.balances()).find((r) => r.employeeId === e.id)!;
    expect(ledgerAfter).toMatchObject({ salaryNet: '0.00', advanceDeducted: '0.00', openAdvance: '1000.00' });
    // Yeni bordroda aynı avans yeniden kesilebilir
    const run2 = await w.mkRun();
    await ok(w.deduct(run2.run.id, e.id, [{ advanceId: adv.advance.id, amount: '1000' }]));
    const ap2 = (await ok(w.c.post(`/api/payroll/runs/${run2.run.id}/approve`))) as any;
    expect((await w.getAdvance(adv.advance.id)).advance).toMatchObject({ status: 'settled', settledAmount: '1000.00' });
    expect(ap2.lines[0]).toMatchObject({ net: '2000.0000' });
    // Taslak silinirken kesinti planı da silinir (onaylı değil; ayrı bordro)
    await ok(w.c.post(`/api/payroll/runs/${run2.run.id}/cancel`, { reason: 'Tekrar iptal' }));
    const run3 = await w.mkRun();
    await ok(w.deduct(run3.run.id, e.id, [{ advanceId: adv.advance.id, amount: '100' }]));
    expect((await w.c.delete(`/api/payroll/runs/${run3.run.id}`)).statusCode).toBe(204);
  });

  it('avans kesintisi üst sınırı: varsayılan yok; kullanıcı parametresi doğrulanmadı rozetli, onay ve düzenleme doğrulamayı sıfırlar; aşan kesinti reddedilir', async () => {
    const w = await world('XcSinir');
    const e = await w.payable({}, '3000');
    const bank = await w.bank();
    const adv = await w.advance(e.id, bank.id, '2000');
    const run = await w.mkRun();
    expect((await ok(w.c.get('/api/employee-ledger/settings'))).settings).toMatchObject({ deductionCapPct: null, verifiedAt: null });
    expect((await w.c.put('/api/employee-ledger/settings', { deductionCapPct: '0' })).statusCode).toBe(400);
    expect((await w.c.put('/api/employee-ledger/settings', { deductionCapPct: '101' })).statusCode).toBe(400);
    expect((await w.c.post('/api/employee-ledger/settings/verify', {})).json().error.code).toBe('LEDGER_SETTINGS_EMPTY');
    const s = (await ok(w.c.put('/api/employee-ledger/settings', { deductionCapPct: '25', sourceNote: 'Kullanıcı politikası (test)' }))).settings;
    expect(s).toMatchObject({ deductionCapPct: '25.0000', verifiedAt: null });
    // Kesinti öncesi net 3000 → üst sınır 750
    expect((await w.deduct(run.run.id, e.id, [{ advanceId: adv.advance.id, amount: '750.01' }])).json().error.code).toBe('ADVANCE_DEDUCTION_CAP');
    expect((await ok(w.deduct(run.run.id, e.id, [{ advanceId: adv.advance.id, amount: '750' }]))).deductions).toHaveLength(1);
    const v = (await ok(w.c.post('/api/employee-ledger/settings/verify', { note: 'Hukuk müşaviri teyidi' }))).settings;
    expect(v.verifiedBy).toBe(w.s.email);
    expect((await ok(w.c.put('/api/employee-ledger/settings', { deductionCapPct: '10' }))).settings.verifiedAt).toBeNull();
    // Onay anında da denetlenir: sınır sonradan düşürüldü (10% = 300) → 750 kesinti onaylanamaz
    await w.closeAtt();
    expect((await w.c.post(`/api/payroll/runs/${run.run.id}/approve`)).json().error.code).toBe('ADVANCE_DEDUCTION_CAP');
    // Sınırı kaldır → onaylanır
    await ok(w.c.put('/api/employee-ledger/settings', { deductionCapPct: null }));
    await ok(w.c.post(`/api/payroll/runs/${run.run.id}/approve`));
    expect((await w.getAdvance(adv.advance.id)).advance.settledAmount).toBe('750.00');
  });

  it('yetki, modül, erişim günlüğü, maskeli dışa aktarma, ilgili kişi dışa aktarması ve envanter', async () => {
    const w = await world('XcYetki');
    const e = await w.payable({ fullName: 'Gizli Maaşlı' }, '3000');
    const bank = await w.bank();
    const adv = await w.advance(e.id, bank.id, '500');
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    for (const url of ['/api/employee-ledger/balances', '/api/employee-ledger/advances', `/api/employee-ledger/advances/${adv.advance.id}`, `/api/employee-ledger/employees/${e.id}/statement?from=${FROM}&to=${TODAY}`, '/api/employee-ledger/settings', '/api/employee-ledger/salary-payments', '/api/employee-ledger/advances/outstanding']) {
      expect((await acc.client.get(url)).statusCode, url).toBe(200);
    }
    for (const role of ['site_manager', 'viewer', 'sales'] as const) {
      const m = await addMember(app, w.c, w.company.id, role);
      for (const url of ['/api/employee-ledger/balances', '/api/employee-ledger/advances', `/api/employee-ledger/employees/${e.id}/statement?from=${FROM}&to=${TODAY}`, '/api/exports/employee-balances']) {
        expect((await m.client.get(url)).statusCode, `${role} ${url}`).toBe(403);
      }
      expect((await m.client.post('/api/employee-ledger/advances', { employeeId: e.id, date: TODAY, amount: '1', purpose: 'Yetkisiz', treasuryAccountId: bank.id })).statusCode).toBe(403);
      expect((await m.client.post(`/api/employee-ledger/employees/${e.id}/open-party`, {})).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/employee-ledger/balances' })).statusCode).toBe(401);
    // Başka şirket verisi görünmez (RLS)
    const b = await world('XcYetkiB');
    expect((await b.c.get(`/api/employee-ledger/advances/${adv.advance.id}`)).statusCode).toBe(404);
    expect(await b.balances()).toEqual([]);

    // Erişim günlüğü: alan employee_ledger, 10 dk içinde tekrar yazılmaz
    const count = async () => ((await ok(w.c.get(`/api/privacy/access-log?employeeId=${e.id}`))).log as { field: string; reason: string; by: string }[]).filter((l) => l.field === 'employee_ledger');
    const mine = async () => (await count()).filter((l) => l.by === w.s.email);
    expect(await mine()).toHaveLength(0);
    await w.balances();
    await w.balances();
    const log = await mine();
    expect(log).toHaveLength(1); // 10 dakika içinde aynı kullanıcı + personel: tekrar yazılmaz
    expect(log[0]!.reason).toBe('Personel bakiye listesi görüntüleme');
    expect((await count()).some((l) => l.by === acc.email)).toBe(true); // muhasebecinin okumaları kendi adına yazıldı
    await asOwner(async (q) => {
      expect((await expectDbError(q, `delete from personal_data_access_log where field = 'employee_ledger'`)).code).toBe('ERP13');
    });

    // Dışa aktarma: maskeli (IBAN/kimlik yok), ücret bilgisi notu
    const x = await w.c.get('/api/exports/employee-balances?format=xlsx');
    expect(x.statusCode, x.body.slice(0, 200)).toBe(200);
    const flat = readXlsx(new Uint8Array(x.rawPayload))[0]!.rows.flat().join('|');
    expect(flat).toContain('Gizli Maaşlı');
    expect(flat).toContain('kişisel veri: ücret bilgisi');
    expect(flat).not.toContain('TR33');
    expect(flat).not.toContain('1978');
    const csv = await w.c.get('/api/exports/employee-advances?format=csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(adv.advance.number);
    expect(csv.body).not.toContain('TR33');
    const stx = await w.c.get(`/api/exports/employee-statement?employeeId=${e.id}&from=${FROM}&to=${TODAY}&format=csv`);
    expect(stx.statusCode).toBe(200);
    expect(stx.body).not.toContain('TR33');

    // İlgili kişi dışa aktarması personelin avanslarını içerir
    const subject = await ok(w.c.post(`/api/privacy/employees/${e.id}/export`, { reason: 'İlgili kişi erişim talebi' }));
    expect(subject.employeeLedger.advances[0]).toMatchObject({ number: adv.advance.number, amount: '500.00', status: 'open' });
    // Envanter tohumu: hassas, doğrulanmadı
    const inv = ((await ok(w.c.get('/api/privacy/inventory'))).inventory as any[]).filter((i) => i.key.startsWith('employee_ledger.'));
    expect(inv.map((i) => i.key).sort()).toEqual(['employee_ledger.advances', 'employee_ledger.salary_payments']);
    expect(inv.every((i) => i.isSensitive && !i.verifiedAt && /doğrulanmadı/.test(i.legalBasis))).toBe(true);

    // Modül kapatılınca uçlar kapanır
    expect((await w.c.put('/api/company/modules/hr.employee_ledger', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.get('/api/employee-ledger/balances')).statusCode).toBe(403);
    expect((await w.c.get('/api/exports/employee-balances')).statusCode).toBe(403);
  });
});
