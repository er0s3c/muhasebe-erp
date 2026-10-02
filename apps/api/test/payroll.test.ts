import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, execAsOwner, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

/**
 * Bordro motoru (Faz D3). Bu dosyadaki oranlar/çarpanlar YALNIZCA TEST DEĞERİDİR; kodda ve veritabanında varsayılan oran yoktur.
 * Tarihler içinde bulunulan aydadır (cari yıl dönemleri vardır; ay kapatılabilir; gelecek ay değildir).
 */
const MONTH = new Date().toISOString().slice(0, 7);
const d = (n: number) => `${MONTH}-${String(n).padStart(2, '0')}`;
const monthEnd = () => {
  const y = Number(MONTH.slice(0, 4));
  const m = Number(MONTH.slice(5, 7));
  return d(new Date(Date.UTC(y, m, 0)).getUTCDate());
};
const FROM = `${thisYear}-01-01`;

describe('bordro motoru (Faz D3)', async () => {
  const { app, handle } = await makeApp();
  type C = ReturnType<typeof client>;

  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const res = await p;
    if (res.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  async function world(name: string, sector = 'CONSTRUCTION') {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { sector });
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const mkEmp = async (body: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/employees', { fullName: 'Ali Veli', hireDate: FROM, iban: 'TR33 0006 1005 1978 6457 8413 26', ...body }), 201)).employee as { id: string; code: string };
    const term = (employeeId: string, amount = '3000', payBasis = 'monthly', effectiveFrom = FROM) => ok(c.post('/api/payroll/pay-terms', { employeeId, effectiveFrom, payBasis, amount }), 201);
    const param = async (key: string, value: string, extra: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/payroll/params', { key, value, effectiveFrom: FROM, enabled: true, ...extra }), 201)).param as { id: string };
    const mkProject = async (name = 'Güneş Sitesi') => (await ok(c.post('/api/projects', { name, kind: 'own' }), 201)).project as { id: string; code: string };
    const mkWbs = async (projectId: string, code: string) =>
      ((await ok(c.post(`/api/projects/${projectId}/wbs`, { code, name: `İş ${code}` }), 201)).wbs as { id: string; code: string }[]).find((w) => w.code === code)!;
    const att = (entries: Record<string, unknown>[]) => ok(c.put('/api/attendance/entries', { entries }));
    const worked = (employeeId: string, n: number, hours = '8', extra: Record<string, unknown> = {}) => ({ employeeId, workDate: d(n), dayType: 'worked', normalHours: hours, ...extra });
    const closeAtt = () => ok(c.post('/api/attendance/months/close', { month: MONTH }));
    const mkRun = async () => (await ok(c.post('/api/payroll/runs', { month: MONTH }), 201)) as Run;
    const item = async (body: Record<string, unknown>) => (await ok(c.post('/api/payroll/items', body), 201)).item as { id: string; code: string };
    return { s, company, c, orgId, mkEmp, term, param, mkProject, mkWbs, att, worked, closeAtt, mkRun, item };
  }

  type Run = { run: Record<string, any>; lines: Record<string, any>[]; adjustments: Record<string, any>[]; missingTerms: Record<string, any>[]; lock: { closed: boolean } };
  const getRun = async (c: C, id: string) => (await ok(c.get(`/api/payroll/runs/${id}`))) as Run;
  const entryOf = async (c: C, id: string) => (await ok(c.get(`/api/journal-entries/${id}`))).entry as { lines: Record<string, any>[]; sourceType: string | null; reversedById: string | null; entryDate: string };
  const sumLines = (lines: Record<string, any>[], code: string, side: 'debitBase' | 'creditBase') => lines.filter((l) => l.accountCode === code).reduce((s, l) => s + Number(l[side]), 0);

  it('parametresiz: motor yalnızca yazılanı yapar (ücret şartı + elle kalemler), yasal kesinti ve işveren yükü yok; uyarılar bildirilir', async () => {
    const w = await world('PrbParametresiz');
    const e = await w.mkEmp();
    await w.term(e.id, '3000');
    await w.att([w.worked(e.id, 2, '8', { overtimeHours: '3' }), { employeeId: e.id, workDate: d(3), dayType: 'unpaid_leave' }]);
    expect((await ok(w.c.get('/api/payroll/params'))).params).toEqual([]);
    const r = await w.mkRun();
    expect(r.run).toMatchObject({ status: 'draft', month: MONTH, employeeCount: 1, grossTotal: '3000.0000', netTotal: '3000.0000', deductionsTotal: '0.0000', employerTotal: '0.0000', hasUnverifiedParams: false, paramsSnapshot: [] });
    expect(r.run.number).toMatch(/^BRD-\d{4}-000001$/);
    expect(r.lines[0]).toMatchObject({ gross: '3000.0000', net: '3000.0000', employeeSocial: '0.0000', incomeTax: '0.0000', overtimePay: '0.0000', absenceDeduction: '0.0000', items: [] });
    expect(r.lines[0].warnings.map((x: any) => x.code).sort()).toEqual(['absence_no_divisor', 'missing_attendance', 'overtime_no_multiplier'].filter((c) => c !== 'partial_month').sort());
    expect(r.lines[0].ibanMasked).toBe('•••• 1326');

    // Elle ek ödeme ve kesinti (kalem kataloğu: bayraklar kullanıcı verisi)
    const meal = await w.item({ code: 'ymk', name: 'Yemek yardımı', kind: 'earning', affectsSocialBase: true, affectsTaxBase: false });
    expect(meal.code).toBe('YMK');
    const adv = await w.item({ code: 'AVS', name: 'Avans kesintisi', kind: 'deduction', liability: 'other' });
    expect((await w.c.post('/api/payroll/items', { code: 'YMK', name: 'Yinelenen', kind: 'earning' })).statusCode).toBe(409);
    const r2 = await ok(w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e.id, itemId: meal.id, amount: '250.50' }));
    expect(r2.lines[0]).toMatchObject({ earningsTotal: '250.5000', gross: '3250.5000', net: '3250.5000' });
    const r3 = await ok(w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e.id, itemId: adv.id, amount: '400' }));
    expect(r3.lines[0]).toMatchObject({ gross: '3250.5000', otherDeductions: '400.0000', deductionsTotal: '400.0000', net: '2850.5000' });
    expect(r3.lines[0].items.map((i: any) => [i.kind, i.source, i.code, i.amount, i.liability])).toEqual([
      ['earning', 'manual', 'YMK', '250.5000', null],
      ['deduction', 'manual', 'AVS', '400.0000', 'other'],
    ]);
    expect(r3.run).toMatchObject({ grossTotal: '3250.5000', deductionsTotal: '400.0000', netTotal: '2850.5000' });
    // Aynı kalem tekrar yazılırsa tutar güncellenir; silinince hesap geri döner
    await ok(w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e.id, itemId: adv.id, amount: '100' }));
    const withAdj = await getRun(w.c, r.run.id);
    expect(withAdj.adjustments).toHaveLength(2);
    const advAdj = withAdj.adjustments.find((a) => a.itemCode === 'AVS')!;
    const r4 = await ok(w.c.delete(`/api/payroll/runs/${r.run.id}/adjustments/${advAdj.id}`));
    expect(r4.lines[0]).toMatchObject({ otherDeductions: '0.0000', net: '3250.5000' });
    // Geçersiz girişler
    expect((await w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e.id, itemId: meal.id, amount: '0' })).statusCode).toBe(422);
    expect((await w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e.id, itemId: meal.id, amount: '-5' })).statusCode).toBe(400);
    await ok(w.c.patch(`/api/payroll/items/${meal.id}`, { isActive: false }));
    expect((await w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e.id, itemId: meal.id, amount: '10' })).json().error.code).toBe('PAYROLL_ITEM_NOT_FOUND');
    // Kalem kodu/türü sonradan değişmez (veritabanı)
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update payroll_items set kind = 'deduction' where id = '${meal.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update payroll_items set code = 'X' where id = '${meal.id}'`)).code).toBe('ERP13');
    });
  });

  it('parametreler: tarihli, varsayılan kapalı, açılınca hesap değişir; yeni kapalı satır eskiyi kapatır; gelecek tarihli satır uygulanmaz; doğrulanmadı bayrağı snapshot\'a işler', async () => {
    const w = await world('PrbParam');
    const e = await w.mkEmp();
    await w.term(e.id, '3000');
    await w.att([w.worked(e.id, 2)]);
    const created = (await ok(w.c.post('/api/payroll/params', { key: 'employee_social_pct', value: '10', effectiveFrom: FROM }), 201)).param;
    expect(created).toMatchObject({ enabled: false, verifiedAt: null, value: '10.000000' });
    const r = await w.mkRun();
    expect(r.lines[0]).toMatchObject({ employeeSocial: '0.0000', net: '3000.0000' }); // satır kapalı: hesap yok
    // Aç → kullanılır; doğrulanmadı
    await ok(w.c.patch(`/api/payroll/params/${created.id}`, { enabled: true }));
    const r1 = await ok(w.c.post(`/api/payroll/runs/${r.run.id}/calculate`));
    expect(r1.lines[0]).toMatchObject({ socialBase: '3000.0000', employeeSocial: '300.0000', net: '2700.0000' });
    expect(r1.run.hasUnverifiedParams).toBe(true);
    expect(r1.run.paramsSnapshot).toEqual([{ key: 'employee_social_pct', value: '10', verified: false, paramId: created.id }]);
    // Doğrula → rozet kalkar; kaynak notu değişince doğrulama sıfırlanır
    const v = (await ok(w.c.post(`/api/payroll/params/${created.id}/verify`, { note: 'Mali müşavir teyidi' }))).param;
    expect(v.verifiedAt).not.toBeNull();
    expect(v.verifiedBy).toBe(w.s.email);
    expect(v.sourceNote).toBe('Mali müşavir teyidi');
    expect((await ok(w.c.post(`/api/payroll/runs/${r.run.id}/calculate`))).run.hasUnverifiedParams).toBe(false);
    const reset = (await ok(w.c.patch(`/api/payroll/params/${created.id}`, { sourceNote: 'Başka kaynak' }))).param;
    expect(reset.verifiedAt).toBeNull();
    // Yeni tarihli, KAPALI satır eskinin yerine geçer: parametre kapanır
    const later = `${thisYear}-${MONTH.slice(5, 7)}-01`;
    const off = (await ok(w.c.post('/api/payroll/params', { key: 'employee_social_pct', value: '12', effectiveFrom: later > FROM ? later : `${thisYear}-01-02`, supersedesId: created.id, enabled: false }), 201)).param;
    expect(off.supersedesId).toBe(created.id);
    expect((await ok(w.c.post(`/api/payroll/runs/${r.run.id}/calculate`))).lines[0].employeeSocial).toBe('0.0000');
    // Ay sonundan SONRA başlayan satır uygulanmaz
    expect((await w.c.delete(`/api/payroll/params/${off.id}`)).statusCode).toBe(204);
    const future = (await ok(w.c.post('/api/payroll/params', { key: 'income_tax_pct', value: '20', effectiveFrom: `${thisYear + 1}-01-01`, enabled: true }), 201)).param;
    expect((await ok(w.c.post(`/api/payroll/runs/${r.run.id}/calculate`))).lines[0].incomeTax).toBe('0.0000');
    expect(future.enabled).toBe(true);
    // Doğrulamalar
    for (const bad of [{ key: 'uydurma', value: '1' }, { key: 'employee_social_pct', value: '101' }, { key: 'overtime_multiplier', value: '0' }, { key: 'days_per_month', value: '40' }, { key: 'tax_base_deducts_social', value: '2' }]) {
      expect((await w.c.post('/api/payroll/params', { ...bad, effectiveFrom: FROM })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.c.post('/api/payroll/params', { key: 'employee_social_pct', value: '9', effectiveFrom: FROM })).json().error.code).toBe('PAYROLL_PARAM_EXISTS');
  });

  it('hesap: aylık ücret, devamsızlık kesintisi, fazla mesai çarpanı, işçi/işveren yükü, elle kalem ve net (test değerleriyle); günlük ve saatlik ücret', async () => {
    const w = await world('PrbHesap');
    const [m, dl, h] = [await w.mkEmp({ fullName: 'Aylık Usta' }), await w.mkEmp({ fullName: 'Günlük İşçi' }), await w.mkEmp({ fullName: 'Saatlik İşçi' })];
    await w.term(m.id, '3000');
    await w.term(dl.id, '150', 'daily');
    await w.term(h.id, '20', 'hourly');
    for (const [k, v] of [['days_per_month', '30'], ['hours_per_day', '7.5'], ['overtime_multiplier', '1.5'], ['employee_social_pct', '10'], ['income_tax_pct', '20'], ['employer_social_pct', '12'], ['employer_other_pct', '1.5']] as const) await w.param(k, v);
    await w.att([
      w.worked(m.id, 2, '8', { overtimeHours: '6' }),
      { employeeId: m.id, workDate: d(3), dayType: 'unpaid_leave' },
      { employeeId: m.id, workDate: d(4), dayType: 'unpaid_leave' },
      { employeeId: m.id, workDate: d(5), dayType: 'absent' },
      w.worked(dl.id, 2), w.worked(dl.id, 3, '7.5', { overtimeHours: '3' }),
      ...Array.from({ length: 13 }, (_, i) => (i === 1 ? w.worked(h.id, 3, '4', { overtimeHours: '4' }) : w.worked(h.id, i + 2, '8'))),
    ]);
    const r = await w.mkRun();
    const by = (code: string) => r.lines.find((l) => l.employeeCode === code)!;
    expect(by(m.code)).toMatchObject({ scheduledPay: '3000.0000', absenceDeduction: '300.0000', basePay: '2700.0000', overtimePay: '120.0000', gross: '2820.0000', employeeSocial: '282.0000', incomeTax: '564.0000', deductionsTotal: '846.0000', net: '1974.0000', employerSocial: '338.4000', employerOther: '42.3000', employerTotal: '380.7000' });
    // günlük: 2 saatli gün × 150 = 300; mesai = 150/7.5 × 3 × 1.5 = 90
    expect(by(dl.code)).toMatchObject({ basePay: '300.0000', overtimePay: '90.0000', gross: '390.0000', employeeSocial: '39.0000', incomeTax: '78.0000', net: '273.0000' });
    // saatlik: 100 saat × 20 = 2000; mesai = 20 × 4 × 1.5 = 120
    expect(by(h.code)).toMatchObject({ basePay: '2000.0000', overtimePay: '120.0000', gross: '2120.0000' });
    const sum = (k: string) => r.lines.reduce((s, l) => s + Number(l[k]), 0);
    expect(Number(r.run.grossTotal)).toBeCloseTo(sum('gross'), 4);
    expect(Number(r.run.netTotal)).toBeCloseTo(sum('net'), 4);
    expect(Number(r.run.employerTotal)).toBeCloseTo(sum('employerTotal'), 4);
    expect(r.run.hasUnverifiedParams).toBe(true);
    expect(r.run.paramsSnapshot.map((p: any) => p.key).sort()).toEqual(['days_per_month', 'employee_social_pct', 'employer_other_pct', 'employer_social_pct', 'hours_per_day', 'income_tax_pct', 'overtime_multiplier']);
    // Slip bileşenleri: parametreden gelen kesintiler yükümlülükle işaretli
    expect(by(m.code).items.filter((i: any) => i.source === 'param').map((i: any) => [i.kind, i.paramKey, i.amount, i.liability])).toEqual([
      ['deduction', 'employee_social_pct', '282.0000', 'social'],
      ['deduction', 'income_tax_pct', '564.0000', 'tax'],
      ['employer', 'employer_social_pct', '338.4000', 'social'],
      ['employer', 'employer_other_pct', '42.3000', 'tax'],
    ]);
    // Ücret şartı olmayan personel satır almaz, "ücret şartı yok" listesinde görünür
    const noTerm = await w.mkEmp({ fullName: 'Şartsız Kişi' });
    await w.att([w.worked(noTerm.id, 2)]);
    const again = await ok(w.c.post(`/api/payroll/runs/${r.run.id}/calculate`));
    expect(again.lines).toHaveLength(3);
    expect(again.missingTerms.map((x: any) => x.id)).toEqual([noTerm.id]);
  });

  it('ücret şartı: tarihli, işe girişten önce başlayamaz, ayın son gününe göre geçerli şart uygulanır', async () => {
    const w = await world('PrbSart');
    const e = await w.mkEmp({ hireDate: d(10) });
    await w.att([w.worked(e.id, 12)]);
    const before = await w.c.post('/api/payroll/pay-terms', { employeeId: e.id, effectiveFrom: d(5), payBasis: 'monthly', amount: '1000' });
    expect(before.statusCode).toBe(422);
    expect(before.json().error.code).toBe('HR_RULE_VIOLATION');
    await w.term(e.id, '1000', 'monthly', d(10));
    await w.term(e.id, '2000', 'monthly', d(20)); // ay içinde zam: ayın son gününe göre → tüm ay 2000
    expect((await w.c.post('/api/payroll/pay-terms', { employeeId: e.id, effectiveFrom: d(20), payBasis: 'monthly', amount: '1' })).json().error.code).toBe('PAY_TERM_EXISTS');
    const r = await w.mkRun();
    expect(r.lines[0]).toMatchObject({ rate: '2000.0000', gross: '2000.0000' });
    expect(r.lines[0].warnings.map((x: any) => x.code)).toContain('partial_month');
    const terms = (await ok(w.c.get(`/api/payroll/pay-terms?employeeId=${e.id}`))).terms as { id: string; effectiveFrom: string; amount: string }[];
    expect(terms.map((t) => [t.effectiveFrom, t.amount])).toEqual([[d(20), '2000.0000'], [d(10), '1000.0000']]);
    for (const bad of [{ payBasis: 'weekly' }, { amount: '0' }, { amount: '-5' }, { amount: 'x' }]) {
      expect((await w.c.post('/api/payroll/pay-terms', { employeeId: e.id, effectiveFrom: d(25), payBasis: 'monthly', amount: '10', ...bad })).statusCode).toBe(400);
    }
    expect((await w.c.delete(`/api/payroll/pay-terms/${terms[0]!.id}`)).statusCode).toBe(204);
    expect((await w.c.delete(`/api/payroll/pay-terms/${terms[0]!.id}`)).statusCode).toBe(404);
  });

  it('onay: puantaj ayı açıkken reddedilir (API + veritabanı); kapalıyken dengeli, etiketli yevmiye; onaylı bordro değişmez', async () => {
    const w = await world('PrbOnay');
    const e1 = await w.mkEmp({ fullName: 'Hasan Usta' });
    const e2 = await w.mkEmp({ fullName: 'Murat Demirci' });
    const p1 = await w.mkProject('Proje Bir');
    const p2 = await w.mkProject('Proje İki');
    const w1 = await w.mkWbs(p1.id, 'A');
    const w2 = await w.mkWbs(p2.id, 'B');
    await w.term(e1.id, '3000');
    await w.term(e2.id, '120', 'daily');
    for (const [k, v] of [['employee_social_pct', '10'], ['income_tax_pct', '15'], ['employer_social_pct', '12']] as const) await w.param(k, v);
    await w.att([
      w.worked(e1.id, 2, '8', { projectId: p1.id, wbsId: w1.id }), // varsayılan işçilik koduna düşer
      w.worked(e1.id, 3, '8', { projectId: p1.id, wbsId: w1.id }),
      w.worked(e1.id, 4, '8', { projectId: p2.id, wbsId: w2.id }),
      w.worked(e1.id, 5, '8'), // etiketsiz
      w.worked(e2.id, 2, '8', { projectId: p2.id, wbsId: w2.id }),
    ]);
    const adv = await w.item({ code: 'VRG', name: 'Vergi kesintisi (elle)', kind: 'deduction', liability: 'tax' });
    const r = await w.mkRun();
    await ok(w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e2.id, itemId: adv.id, amount: '10' }));

    // Puantaj ayı açık → API reddeder; ham SQL ile onay denemesi veritabanı korumasına takılır
    const early = await w.c.post(`/api/payroll/runs/${r.run.id}/approve`);
    expect(early.statusCode).toBe(422);
    expect(early.json().error.code).toBe('ATTENDANCE_MONTH_NOT_CLOSED');
    await asOwner(async (q) => {
      const err = await expectDbError(q, `update payroll_runs set status = 'approved', approved_at = now(), approved_by = '${w.s.userId}' where id = '${r.run.id}'`);
      expect(err.code).toMatch(/ERP13|23514/);
    });
    await w.closeAtt();

    const done = (await ok(w.c.post(`/api/payroll/runs/${r.run.id}/approve`))) as Run;
    expect(done.run).toMatchObject({ status: 'approved', employeeCount: 2 });
    expect(done.run.entryId).toBeTruthy();
    expect(done.run.entryNo).toBeTruthy();
    const net = done.lines.reduce((s, l) => s + Number(l.net), 0);
    const social = done.lines.reduce((s, l) => s + Number(l.employeeSocial) + Number(l.employerSocial), 0);
    const incomeTax = done.lines.reduce((s, l) => s + Number(l.incomeTax), 0) + 10; // + elle vergi kesintisi
    const gross = Number(done.run.grossTotal);
    const employer = Number(done.run.employerTotal);

    const entry = await entryOf(w.c, done.run.entryId);
    expect(entry).toMatchObject({ sourceType: 'payroll_run', entryDate: monthEnd() });
    const debit = entry.lines.reduce((s, l) => s + Number(l.debitBase), 0);
    const credit = entry.lines.reduce((s, l) => s + Number(l.creditBase), 0);
    expect(debit).toBeCloseTo(credit, 4);
    expect(debit).toBeCloseTo(gross + employer, 4);
    expect(sumLines(entry.lines, '720', 'debitBase')).toBeCloseTo(gross + employer, 4); // varsayılan eşleme: 720 işçilik / işveren yükü
    expect(sumLines(entry.lines, '335', 'creditBase')).toBeCloseTo(net, 4);
    expect(sumLines(entry.lines, '361', 'creditBase')).toBeCloseTo(social, 4);
    expect(sumLines(entry.lines, '360', 'creditBase')).toBeCloseTo(incomeTax, 4);
    // Etiketler: iki proje + etiketsiz; etiketli satırlar iş kalemi ve işçilik koduyla
    const expenses = entry.lines.filter((l) => l.accountCode === '720');
    const tagged = expenses.filter((l) => l.projectCode);
    expect(new Set(tagged.map((l) => l.projectCode))).toEqual(new Set([p1.code, p2.code]));
    expect(tagged.every((l) => l.wbsCode && l.costCode === 'ISC')).toBe(true);
    expect(expenses.some((l) => !l.projectId && Number(l.debitBase) > 0)).toBe(true);
    // Hasan: 4 gün × 8 saat; maliyet 3000 üç eşit parçaya (p1: 2/4, p2: 1/4, etiketsiz: 1/4) + işveren yükü
    const hasanGross = Number(done.lines.find((l) => l.employeeCode === e1.code)!.gross);
    expect(tagged.filter((l) => l.projectCode === p1.code).reduce((s, l) => s + Number(l.debitBase), 0)).toBeGreaterThan(hasanGross / 2 - 0.01);

    // Yevmiye otomatik oluşturulduğundan defter ucundan ters çevrilemez; ters kayıt yalnızca bordro iptalinden
    const rev = await w.c.post(`/api/journal-entries/${done.run.entryId}/reverse`, {});
    expect(rev.json().error.code).toBe('ENTRY_HAS_SOURCE');

    // Onaylı bordro değişmez: API ve ham SQL (sahip rolü dahil)
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/calculate`)).json().error.code).toBe('PAYROLL_NOT_DRAFT');
    expect((await w.c.delete(`/api/payroll/runs/${r.run.id}`)).json().error.code).toBe('PAYROLL_NOT_DRAFT');
    expect((await w.c.put(`/api/payroll/runs/${r.run.id}/adjustments`, { employeeId: e2.id, itemId: adv.id, amount: '5' })).json().error.code).toBe('PAYROLL_NOT_DRAFT');
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update payroll_lines set net = net, gross = gross where run_id = '${r.run.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from payroll_lines where run_id = '${r.run.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from payroll_runs where id = '${r.run.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update payroll_runs set gross_total = gross_total + 1, net_total = net_total + 1 where id = '${r.run.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update payroll_runs set status = 'draft', approved_at = null, entry_id = null where id = '${r.run.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from payroll_line_items where line_id in (select id from payroll_lines where run_id = '${r.run.id}')`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from payroll_line_allocations where line_id in (select id from payroll_lines where run_id = '${r.run.id}')`)).code).toBe('ERP13');
    });
    // Kullanılmış parametre silinemez; değeri değişmez
    const used = (await ok(w.c.get('/api/payroll/params'))).params as { id: string }[];
    expect((await w.c.delete(`/api/payroll/params/${used[0]!.id}`)).json().error.code).toBe('HR_RULE_VIOLATION');
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update payroll_params set value = 99 where id = '${used[0]!.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update payroll_params set effective_from = effective_from + 1 where id = '${used[0]!.id}'`)).code).toBe('ERP13');
    });
    // Onaylı bordro varken aynı ay için ikinci bordro açılamaz
    expect((await w.c.post('/api/payroll/runs', { month: MONTH })).json().error.code).toBe('PAYROLL_RUN_EXISTS');
  });

  it('ay kilidi eşleşmesi: onaylı bordro varken puantaj ayı açılamaz (API + ham SQL); bordro iptalinden sonra açılır', async () => {
    const w = await world('PrbKilit');
    const e = await w.mkEmp();
    await w.term(e.id, '3000');
    await w.att([w.worked(e.id, 2)]);
    await w.closeAtt();
    const r = await w.mkRun();
    await ok(w.c.post(`/api/payroll/runs/${r.run.id}/approve`));
    const reopen = await w.c.post('/api/attendance/months/reopen', { month: MONTH, reason: 'Eksik mesai girişi' });
    expect(reopen.statusCode).toBe(422);
    expect(reopen.json().error.code).toBe('HR_RULE_VIOLATION');
    expect(reopen.json().error.message).toMatch(/onaylanmış bordro/);
    await asOwner(async (q) => {
      const err = await expectDbError(q, `update attendance_months set status = 'open', reopened_at = now(), reopened_by = '${w.s.userId}', reopen_reason = 'yeterli gerekçe', reopen_count = reopen_count + 1 where company_id = '${w.company.id}' and month = '${MONTH}'`);
      expect(err.code).toBe('ERP13');
    });
    expect((await ok(w.c.get(`/api/attendance/month?month=${MONTH}`))).lock.closed).toBe(true);
    // Bordro iptal edilince açılır
    await ok(w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'Mesai düzeltmesi gerekti' }));
    expect((await w.c.post('/api/attendance/months/reopen', { month: MONTH, reason: 'Eksik mesai girişi' })).statusCode).toBe(200);
    // Açık ayda yeni bordro taslağı açılabilir ama onaylanamaz
    const second = await w.mkRun();
    expect(second.run.number).not.toBe(r.run.number);
    expect((await w.c.post(`/api/payroll/runs/${second.run.id}/approve`)).json().error.code).toBe('ATTENDANCE_MONTH_NOT_CLOSED');
  });

  it('ödeme takibi ve iptal: ödendi işaretle/geri al, ödenmiş iptal edilemez, iptalde yevmiye ters çevrilir (gerekçeli), denetim izi', async () => {
    const w = await world('PrbOdeme');
    const e = await w.mkEmp();
    await w.term(e.id, '3000');
    await w.param('employee_social_pct', '10');
    await w.att([w.worked(e.id, 2)]);
    await w.closeAtt();
    const r = await w.mkRun();
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/pay`, { paidAt: d(1) })).json().error.code).toBe('PAYROLL_NOT_APPROVED');
    const ap = await ok(w.c.post(`/api/payroll/runs/${r.run.id}/approve`));
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/pay`, { paidAt: `${thisYear + 1}-01-01` })).json().error.code).toBe('PAYROLL_PAID_FUTURE');
    const today = new Date().toISOString().slice(0, 10);
    const paid = await ok(w.c.post(`/api/payroll/runs/${r.run.id}/pay`, { paidAt: today, note: 'Banka havalesi' }));
    expect(paid.run).toMatchObject({ status: 'paid', paidAt: today, paidNote: 'Banka havalesi' });
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'Yanlış ay' })).json().error.code).toBe('PAYROLL_PAID');
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/unpay`, { reason: 'x' })).statusCode).toBe(400);
    const un = await ok(w.c.post(`/api/payroll/runs/${r.run.id}/unpay`, { reason: 'Ödeme iade edildi' }));
    expect(un.run).toMatchObject({ status: 'approved', paidAt: null });
    expect(un.run.paidNote).toMatch(/Ödeme iade edildi/);
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'x' })).statusCode).toBe(400);
    const cancelled = await ok(w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'Yanlış ay seçildi', entryDate: today }));
    expect(cancelled.run).toMatchObject({ status: 'cancelled', cancelReason: 'Yanlış ay seçildi' });
    expect(cancelled.run.reversalEntryId).toBeTruthy();
    const orig = await entryOf(w.c, ap.run.entryId);
    const rev = await entryOf(w.c, cancelled.run.reversalEntryId);
    expect(orig.reversedById).toBe(cancelled.run.reversalEntryId);
    // Ters kayıt: borç/alacak yer değiştirir; etiketler aynı
    expect(rev.lines.map((l) => [l.accountCode, l.creditBase, l.debitBase])).toEqual(orig.lines.map((l) => [l.accountCode, l.debitBase, l.creditBase]));
    // Tekrar iptal / onay / ödeme olmaz; iptal edilmiş ay için yeni bordro açılabilir
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'tekrar iptal' })).json().error.code).toBe('PAYROLL_NOT_APPROVED');
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/approve`)).json().error.code).toBe('PAYROLL_NOT_DRAFT');
    expect((await w.mkRun()).run.status).toBe('draft');
    expect(((await ok(w.c.get('/api/payroll/runs'))).runs as any[]).map((x) => x.status).sort()).toEqual(['cancelled', 'draft']);
    expect(((await ok(w.c.get('/api/payroll/runs?status=draft'))).runs as any[])).toHaveLength(1);
    // Denetim izi: durum değişiklikleri sırayla
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      const rows = (await q(`select action, old_data->>'status' as o, new_data->>'status' as n from audit_log where table_name = 'payroll_runs' and row_id = $1 order by at`, [r.run.id])).rows;
      expect(rows.map((x) => `${x.action}:${x.o ?? ''}>${x.n}`)).toEqual(['INSERT:>draft', 'UPDATE:draft>draft', 'UPDATE:draft>draft', 'UPDATE:draft>approved', 'UPDATE:approved>paid', 'UPDATE:paid>approved', 'UPDATE:approved>cancelled']);
    });
  });

  it('negatif net, boş bordro ve eksik hesap eşlemesi onayı engeller; taslak silinebilir', async () => {
    const w = await world('PrbHata');
    const e = await w.mkEmp();
    await w.att([w.worked(e.id, 2)]);
    await w.closeAtt();
    const empty = await w.mkRun();
    expect(empty.run.employeeCount).toBe(0);
    expect((await w.c.post(`/api/payroll/runs/${empty.run.id}/approve`)).json().error.code).toBe('PAYROLL_EMPTY');
    await w.term(e.id, '1000');
    const big = await w.item({ code: 'ICR', name: 'İcra kesintisi', kind: 'deduction', liability: 'other' });
    await ok(w.c.put(`/api/payroll/runs/${empty.run.id}/adjustments`, { employeeId: e.id, itemId: big.id, amount: '1500' }));
    const neg = await getRun(w.c, empty.run.id);
    expect(neg.lines[0]!.net).toBe('-500.0000');
    expect(neg.lines[0]!.warnings.map((x: any) => x.code)).toContain('negative_net');
    expect((await w.c.post(`/api/payroll/runs/${empty.run.id}/approve`)).json().error.code).toBe('PAYROLL_NEGATIVE_NET');
    await ok(w.c.put(`/api/payroll/runs/${empty.run.id}/adjustments`, { employeeId: e.id, itemId: big.id, amount: '100' }));
    // Eksik eşleme: açık hata, işlem geri alınır (bordro taslak kalır)
    await execAsOwner(`delete from account_mappings where company_id = $1 and key = 'payroll_payable'`, [w.company.id]);
    const miss = await w.c.post(`/api/payroll/runs/${empty.run.id}/approve`);
    expect(miss.statusCode).toBe(422);
    expect(miss.json().error.code).toBe('ACCOUNT_MAPPING_MISSING');
    expect((await getRun(w.c, empty.run.id)).run.status).toBe('draft');
    // Veritabanı: net hesabı tutarsız satır yazılamaz
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update payroll_lines set net = net + 1 where run_id = '${empty.run.id}'`)).code).toBe('23514');
      expect((await expectDbError(q, `insert into payroll_runs (id, company_id, number, month, status) values (gen_random_uuid(), '${w.company.id}', 'X-1', '${thisYear}-01', 'approved')`)).code).toBe('ERP13');
    });
    expect((await w.c.delete(`/api/payroll/runs/${empty.run.id}`)).statusCode).toBe(204);
    expect((await w.c.get(`/api/payroll/runs/${empty.run.id}`)).statusCode).toBe(404);
  });

  it('hesap eşlemeleri: bordro anahtarları varsayılanlarla yüklenir (doğrulanmamış), Ayarlar\'dan değişir', async () => {
    const w = await world('PrbEsleme');
    const list = (await ok(w.c.get('/api/account-mappings'))).mappings as { key: string; accountCode: string }[];
    expect(Object.fromEntries(list.filter((m) => m.key.startsWith('payroll_')).map((m) => [m.key, m.accountCode]))).toEqual({
      payroll_labor_cost: '720', payroll_employer_cost: '720', payroll_payable: '335', payroll_social_payable: '361', payroll_tax_payable: '360', payroll_other_payable: '336',
    });
    // Yeni anahtarlar veritabanı kısıtını geçer: ham ekleme (kısıt) ve geri doldurma INSERT'ü eşleme sayısını tutar
    const n = (await execAsOwner(`select count(*)::int as n from account_mappings where company_id = $1`, [w.company.id])).rows[0].n;
    expect(n).toBe(46);
  });

  it('yetki ve modül: muhasebeci okur ve yönetir; şantiye şefi ve izleyici erişemez; hr.payroll modülü hr.core ve muhasebeye bağlı', async () => {
    const w = await world('PrbYetki');
    const e = await w.mkEmp();
    await w.term(e.id, '3000');
    await w.att([w.worked(e.id, 2)]);
    const r = await w.mkRun();
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    for (const url of ['/api/payroll/runs', `/api/payroll/runs/${r.run.id}`, '/api/payroll/params', '/api/payroll/items', '/api/payroll/pay-terms', `/api/payroll/reports/cost?from=${MONTH}&to=${MONTH}`, `/api/payroll/runs/${r.run.id}/slips/${e.id}`]) {
      expect((await acc.client.get(url)).statusCode, url).toBe(200);
    }
    expect((await acc.client.post('/api/payroll/params', { key: 'income_tax_pct', value: '10', effectiveFrom: FROM })).statusCode).toBe(201);
    for (const role of ['site_manager', 'viewer'] as const) {
      const m = await addMember(app, w.c, w.company.id, role);
      for (const url of ['/api/payroll/runs', `/api/payroll/runs/${r.run.id}`, '/api/payroll/params', '/api/payroll/pay-terms', `/api/payroll/runs/${r.run.id}/slips/${e.id}`, `/api/exports/payroll-register?id=${r.run.id}`]) {
        expect((await m.client.get(url)).statusCode, `${role} ${url}`).toBe(403);
      }
      expect((await m.client.post('/api/payroll/runs', { month: MONTH })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/payroll/runs' })).statusCode).toBe(401);
    // Personel (hr.read) yetkisi ücret verisini açmaz: ücret şartı yalnızca hr.payroll ile okunur
    // Modül bağımlılığı: hr.core kapatılamaz; bordro kapatılınca uçlar 403 MODULE_DISABLED
    expect((await w.c.put('/api/company/modules/hr.core', { enabled: false })).statusCode).toBe(422);
    expect((await w.c.put('/api/company/modules/core.ledger', { enabled: false })).statusCode).toBe(422);
    // Sosyal güvenlik çıktıları (D4) ve personel cari (X5) bordroya bağlıdır: önce onlar kapatılır
    expect((await w.c.put('/api/company/modules/hr.payroll', { enabled: false })).statusCode).toBe(422);
    expect((await w.c.put('/api/company/modules/hr.socialsecurity', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.put('/api/company/modules/hr.employee_ledger', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.put('/api/company/modules/hr.payroll', { enabled: false })).statusCode).toBe(200);
    const off = await w.c.get('/api/payroll/runs');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('MODULE_DISABLED');
    const nav = (await ok(w.c.get('/api/navigation'))).groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(nav).not.toContain('payroll');
    expect(nav).toContain('attendance');
  });

  it('RLS: başka şirket bordro, parametre, ücret şartı ve kalem görmez; başka şirket personeline ücret yazılamaz', async () => {
    const a = await world('PrbRlsA');
    const b = await world('PrbRlsB');
    const ea = await a.mkEmp();
    await a.term(ea.id, '3000');
    await a.param('income_tax_pct', '10');
    await a.item({ code: 'YMK', name: 'Yemek', kind: 'earning' });
    await a.att([a.worked(ea.id, 2)]);
    const ra = await a.mkRun();
    expect(((await ok(b.c.get('/api/payroll/runs'))).runs as any[])).toHaveLength(0);
    expect((await b.c.get(`/api/payroll/runs/${ra.run.id}`)).statusCode).toBe(404);
    expect((await b.c.get(`/api/payroll/runs/${ra.run.id}/slips/${ea.id}`)).statusCode).toBe(404);
    expect(((await ok(b.c.get('/api/payroll/params'))).params as any[])).toHaveLength(0);
    expect(((await ok(b.c.get('/api/payroll/pay-terms'))).terms as any[])).toHaveLength(0);
    expect(((await ok(b.c.get('/api/payroll/items'))).items as any[])).toHaveLength(0);
    expect((await b.c.post('/api/payroll/pay-terms', { employeeId: ea.id, effectiveFrom: FROM, payBasis: 'monthly', amount: '1' })).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    expect((await b.c.post(`/api/payroll/runs/${ra.run.id}/calculate`)).statusCode).toBe(404);
    expect((await b.c.post(`/api/payroll/runs/${ra.run.id}/approve`)).statusCode).toBe(404);
    // Aynı ay için B'nin bordrosu A'dan bağımsız
    const eb = await b.mkEmp();
    await b.term(eb.id, '500');
    await b.att([b.worked(eb.id, 2)]);
    expect((await b.mkRun()).lines).toHaveLength(1);
    await asDb(handle, { companyId: b.company.id, orgId: b.orgId }, async (q) => {
      for (const t of ['payroll_runs', 'payroll_lines', 'payroll_line_items', 'payroll_line_allocations', 'payroll_params', 'employee_pay_terms', 'payroll_items', 'payroll_adjustments']) {
        const n = (await q(`select count(*)::int as n from ${t} where company_id = $1`, [a.company.id])).rows[0].n;
        expect(n, t).toBe(0);
      }
      expect((await expectDbError(q, `insert into employee_pay_terms (id, company_id, employee_id, effective_from, pay_basis, amount) values (gen_random_uuid(), $1, $2, '${FROM}', 'monthly', 1)`, [a.company.id, ea.id])).code).toMatch(/42501|ERP13|23503/);
    });
  });

  it('erişim günlüğü: ücret şartı ve bordro pusulası okuması personel erişim günlüğüne yazılır (alan: payroll), kısa sürede tekrar yazılmaz', async () => {
    const w = await world('PrbGunluk');
    const e = await w.mkEmp();
    await w.term(e.id, '3000');
    await w.att([w.worked(e.id, 2)]);
    const r = await w.mkRun();
    const count = async () => ((await ok(w.c.get(`/api/privacy/access-log?employeeId=${e.id}`))).log as { field: string; reason: string; by: string }[]).filter((l) => l.field === 'payroll');
    expect(await count()).toHaveLength(0);
    await ok(w.c.get('/api/payroll/pay-terms'));
    let log = await count();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ reason: 'Ücret şartı görüntüleme', by: w.s.email });
    const slip = await ok(w.c.get(`/api/payroll/runs/${r.run.id}/slips/${e.id}`));
    expect(slip.line).toMatchObject({ employeeCode: e.code, gross: '3000.0000', ibanMasked: '•••• 1326' });
    expect(slip.run).toMatchObject({ number: r.run.number, hasUnverifiedParams: false });
    await ok(w.c.get(`/api/payroll/runs/${r.run.id}/slips/${e.id}`));
    log = await count();
    expect(log).toHaveLength(1); // 10 dakika içinde aynı kullanıcı + personel: tekrar yazılmaz
    // Salt-eklenir: günlük silinemez/değişmez
    await asOwner(async (q) => {
      expect((await expectDbError(q, `delete from personal_data_access_log where field = 'payroll'`)).code).toBe('ERP13');
    });
    expect((await w.c.get(`/api/payroll/runs/${r.run.id}/slips/${'0198f2c4-7b1a-7000-8000-000000000001'}`)).statusCode).toBe(404);
  });

  it('dışa aktarma: bordro kaydı (IBAN maskeli, iç belge notu, ⚠), maliyet raporu, tüm veriler yalnızca çalıştırma toplamı; kişi verisi dışa aktarma ücreti içerir; envanter tohumu', async () => {
    const w = await world('PrbDisari');
    const e = await w.mkEmp({ fullName: 'Hasan Usta' });
    const p = await w.mkProject();
    const wb = await w.mkWbs(p.id, 'A');
    await w.term(e.id, '3000');
    await w.param('employee_social_pct', '10');
    await w.att([w.worked(e.id, 2, '8', { projectId: p.id, wbsId: wb.id })]);
    await w.closeAtt();
    const r = await w.mkRun();
    await ok(w.c.post(`/api/payroll/runs/${r.run.id}/approve`));

    const reg = await w.c.get(`/api/exports/payroll-register?id=${r.run.id}&format=xlsx`);
    expect(reg.statusCode, reg.body.slice(0, 200)).toBe(200);
    const sheet = readXlsx(new Uint8Array(reg.rawPayload))[0]!;
    const flat = sheet.rows.flat().join('|');
    expect(flat).toContain('Hasan Usta');
    expect(flat).toContain('Taslak / iç belge — resmî bordro değildir');
    expect(flat).toContain('⚠ doğrulanmamış oranlar kullanıldı');
    expect(flat).toContain('•••• 1326');
    expect(flat).not.toContain('TR330006100519786457841326');
    expect(flat).not.toContain('1978');
    const csv = await w.c.get(`/api/exports/payroll-register?id=${r.run.id}&format=csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toContain('TR33');
    // Dışa aktarma okuması günlüğe yazıldı
    const log = ((await ok(w.c.get(`/api/privacy/access-log?employeeId=${e.id}`))).log as { field: string; reason: string }[]).filter((l) => l.field === 'payroll');
    expect(log.some((l) => l.reason === 'Bordro kaydı dışa aktarma')).toBe(true);

    const cost = await w.c.get(`/api/exports/payroll-cost?from=${MONTH}&to=${MONTH}&format=xlsx`);
    expect(cost.statusCode, cost.body.slice(0, 200)).toBe(200);
    expect(readXlsx(new Uint8Array(cost.rawPayload))[0]!.rows.flat().join('|')).toContain(p.code);
    expect((await w.c.get(`/api/exports/payroll-cost?from=2026-13&to=${MONTH}`)).statusCode).toBe(400);
    expect((await w.c.get(`/api/exports/payroll-register?id=bozuk`)).statusCode).toBe(400);

    // Tüm veriler: Bordro sayfası yalnızca çalıştırma toplamlarıdır; personel adı/net ücret yok
    const all = await w.c.get('/api/exports/full-data?format=xlsx');
    expect(all.statusCode, all.body.slice(0, 200)).toBe(200);
    const pay = readXlsx(new Uint8Array(all.rawPayload)).find((s) => s.name === 'Bordro')!;
    const payCells = pay.rows.flat().join('|');
    expect(payCells).toContain(r.run.number);
    expect(payCells).toContain('Taslak / iç belge');
    expect(payCells).not.toContain('Hasan Usta');
    expect(payCells).not.toContain(e.code);

    // İlgili kişi dışa aktarma: ücret şartı ve bordro satırı
    const exp = await ok(w.c.post(`/api/privacy/employees/${e.id}/export`, { reason: 'Erişim talebi' }));
    expect(exp.payroll.payTerms).toHaveLength(1);
    expect(exp.payroll.payTerms[0]).toMatchObject({ payBasis: 'monthly', amount: '3000.0000' });
    expect(exp.payroll.runs[0]).toMatchObject({ number: r.run.number, month: MONTH, status: 'approved', gross: '3000.0000' });

    const inv = (await ok(w.c.get('/api/privacy/inventory'))).inventory as { key: string; isSensitive: boolean; verifiedAt: string | null; legalBasis: string }[];
    for (const k of ['payroll.pay_terms', 'payroll.lines']) {
      expect(inv.find((i) => i.key === k)).toMatchObject({ isSensitive: true, verifiedAt: null });
      expect(inv.find((i) => i.key === k)!.legalBasis).toContain('doğrulanmadı');
    }
  });

  it('rapor ve kârlılık: bordro maliyeti proje/iş kalemi/maliyet koduna göre; yevmiye proje maliyet raporuna işlenir; taslak ve iptal sayılmaz', async () => {
    const w = await world('PrbRapor');
    const e = await w.mkEmp();
    const p = await w.mkProject();
    const wb = await w.mkWbs(p.id, 'A');
    await w.term(e.id, '3000');
    await w.param('employer_social_pct', '10');
    await w.att([w.worked(e.id, 2, '8', { projectId: p.id, wbsId: wb.id }), w.worked(e.id, 3, '8', { projectId: p.id, wbsId: wb.id }), w.worked(e.id, 4, '8')]);
    await w.closeAtt();
    const r = await w.mkRun();
    const empty = await ok(w.c.get(`/api/payroll/reports/cost?from=${MONTH}&to=${MONTH}`));
    expect(empty.rows).toEqual([]); // taslak sayılmaz
    await ok(w.c.post(`/api/payroll/runs/${r.run.id}/approve`));
    const rep = await ok(w.c.get(`/api/payroll/reports/cost?from=${MONTH}&to=${MONTH}`));
    const byProject = Object.fromEntries(rep.rows.map((x: any) => [x.projectCode ?? '-', x]));
    expect(byProject[p.code]).toMatchObject({ wbsCode: 'A', costCode: 'ISC', hours: '16.00', gross: '2000.00', employer: '200.00', total: '2200.00', employees: 1 });
    expect(byProject['-']).toMatchObject({ hours: '8.00', gross: '1000.00', employer: '100.00' });
    expect(rep.totals).toEqual({ hours: '24.00', gross: '3000.00', employer: '300.00', total: '3300.00' });
    expect(rep.months).toHaveLength(1);
    expect(rep.unverified).toBe(true);
    // Proje maliyet raporu (defterden) bordro giderini görür
    const cost = await ok(w.c.get(`/api/projects/${p.id}/cost-report?asOf=${monthEnd()}`));
    expect(JSON.stringify(cost)).toContain('2200');
    // İptal: rapordan düşer
    await ok(w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'Rapor testi' }));
    expect((await ok(w.c.get(`/api/payroll/reports/cost?from=${MONTH}&to=${MONTH}`))).rows).toEqual([]);
    expect((await w.c.get('/api/payroll/reports/cost?from=2026-05&to=2026-01')).statusCode).toBe(400);
  });

  it('veritabanı korumaları (sahip rolü dahil): parametre anahtarı/aralık, ücret şartı tarihi, taslak dışı satır ekleme, onay şartları', async () => {
    const w = await world('PrbSql');
    const e = await w.mkEmp({ hireDate: d(10) });
    await w.term(e.id, '3000', 'monthly', d(10));
    await w.att([w.worked(e.id, 12)]);
    const r = await w.mkRun();
    await w.closeAtt();
    const done = await ok(w.c.post(`/api/payroll/runs/${r.run.id}/approve`));
    await asOwner(async (q) => {
      const ins = (key: string, value: string) => `insert into payroll_params (id, company_id, key, value, effective_from) values (gen_random_uuid(), '${w.company.id}', '${key}', ${value}, '${FROM}')`;
      expect((await expectDbError(q, ins('uydurma', '1'))).code).toBe('23514');
      expect((await expectDbError(q, ins('income_tax_pct', '-1'))).code).toBe('23514');
      expect((await expectDbError(q, `insert into employee_pay_terms (id, company_id, employee_id, effective_from, pay_basis, amount) values (gen_random_uuid(), '${w.company.id}', '${e.id}', '${d(1)}', 'monthly', 10)`)).code).toBe('ERP13');
      expect((await expectDbError(q, `insert into employee_pay_terms (id, company_id, employee_id, effective_from, pay_basis, amount) values (gen_random_uuid(), '${w.company.id}', '${e.id}', '${d(11)}', 'monthly', 0)`)).code).toBe('23514');
      // Onaylı bordroya satır eklenemez
      expect((await expectDbError(q, `insert into payroll_lines (id, company_id, run_id, employee_id, pay_pas, rate) values (gen_random_uuid(), '${w.company.id}', '${r.run.id}', '${e.id}', 'monthly', 1)`)).code).toMatch(/42703|ERP13/);
      expect((await expectDbError(q, `insert into payroll_lines (id, company_id, run_id, employee_id, pay_basis, rate) values (gen_random_uuid(), '${w.company.id}', '${r.run.id}', '${e.id}', 'monthly', 1)`)).code).toMatch(/ERP13|23505/);
      // Yerine geçilen parametre aynı anahtar olmalı
      const p1 = (await q(`insert into payroll_params (id, company_id, key, value, effective_from) values (gen_random_uuid(), '${w.company.id}', 'income_tax_pct', 10, '${FROM}') returning id`)).rows[0].id;
      expect((await expectDbError(q, `insert into payroll_params (id, company_id, key, value, effective_from, supersedes_id) values (gen_random_uuid(), '${w.company.id}', 'employee_social_pct', 5, '${thisYear}-02-01', '${p1}')`)).code).toBe('ERP13');
      // Onaylı bordronun ödeme/iptal geçişleri kurallıdır
      expect((await expectDbError(q, `update payroll_runs set status = 'cancelled', cancelled_at = now() where id = '${r.run.id}'`)).code).toMatch(/ERP13|23514/);
      expect((await expectDbError(q, `update payroll_runs set status = 'paid' where id = '${r.run.id}'`)).code).toMatch(/ERP13|23514/);
      expect((await expectDbError(q, `update payroll_runs set month = '${thisYear}-01' where id = '${r.run.id}'`)).code).toBe('ERP13');
    });
    expect(done.lines[0]).toMatchObject({ gross: '3000.0000' });
  });
});
