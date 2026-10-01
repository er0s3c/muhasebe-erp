import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, execAsOwner, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

/**
 * Sosyal güvenlik çıktıları (Faz D4). Bu dosyadaki oranlar/değerler/kodlar YALNIZCA TEST DEĞERİDİR; kodda ve veritabanında
 * varsayılan oran, bordro tipi kodu, destek kuralı ya da resmî biçim yoktur.
 */
const MONTH = new Date().toISOString().slice(0, 7);
const d = (n: number) => `${MONTH}-${String(n).padStart(2, '0')}`;
const FROM = `${thisYear}-01-01`;
const SSN = '12345678901';

describe('sosyal güvenlik çıktıları (Faz D4)', async () => {
  const { app, handle } = await makeApp();
  type C = ReturnType<typeof client>;

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
    const mkEmp = async (body: Record<string, unknown> = {}) => (await ok(c.post('/api/employees', { fullName: 'Ali Veli', hireDate: FROM, ...body }), 201)).employee as { id: string; code: string };
    const term = (employeeId: string, amount = '3000') => ok(c.post('/api/payroll/pay-terms', { employeeId, effectiveFrom: FROM, payBasis: 'monthly', amount }), 201);
    const param = async (key: string, value: string) => (await ok(c.post('/api/payroll/params', { key, value, effectiveFrom: FROM, enabled: true }), 201)).param as { id: string };
    const att = (entries: Record<string, unknown>[]) => ok(c.put('/api/attendance/entries', { entries }));
    const worked = (employeeId: string, n: number, extra: Record<string, unknown> = {}) => ({ employeeId, workDate: d(n), dayType: 'worked', normalHours: '8', ...extra });
    const profile = (employeeId: string, extra: Record<string, unknown> = {}) => ok(c.post('/api/social-security/profiles', { employeeId, effectiveFrom: FROM, payrollTypeCode: 'TEST-TIP-A', insuranceStart: FROM, socialSecurityNo: SSN, ...extra }), 201);
    const rule = async (extra: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/social-security/support-rules', { code: 'tst1', name: 'Test desteği', effectiveFrom: FROM, target: 'employer', mode: 'percent_of_premium', value: '50', ...extra }), 201)).rule as { id: string; code: string; enabled: boolean };
    const eligible = (employeeId: string, ruleCode = 'TST1', extra: Record<string, unknown> = {}) => ok(c.post('/api/social-security/eligibility', { employeeId, ruleCode, validFrom: FROM, ...extra }), 201);
    /** Bordro: iki personel, test oranları, onaylı. */
    async function approvedPayroll(opts: { two?: boolean } = {}) {
      const e1 = await mkEmp({ fullName: 'Hasan Usta' });
      await term(e1.id, '3000');
      await param('employee_social_pct', '10');
      await param('employer_social_pct', '12');
      const emps = [e1];
      const entries = [worked(e1.id, 2), worked(e1.id, 3)];
      if (opts.two) {
        const e2 = await mkEmp({ fullName: 'Murat Demirci' });
        await term(e2.id, '1500');
        emps.push(e2);
        entries.push(worked(e2.id, 2));
      }
      await att(entries);
      await ok(c.post('/api/attendance/months/close', { month: MONTH }));
      const run = await ok(c.post('/api/payroll/runs', { month: MONTH }), 201);
      await ok(c.post(`/api/payroll/runs/${run.run.id}/approve`));
      return { emps, runId: run.run.id as string };
    }
    const build = () => ok(c.post('/api/social-security/declarations', { month: MONTH }), 201);
    return { s, company, c, orgId, mkEmp, term, param, att, worked, profile, rule, eligible, approvedPayroll, build };
  }

  type Decl = { declaration: Record<string, any>; lines: Record<string, any>[]; totals: Record<string, any>; lock: { closed: boolean } };
  const getDecl = async (c: C, id: string) => (await ok(c.get(`/api/social-security/declarations/${id}`))) as Decl;

  it('profil: tarihli, bordro tipi serbest veri, numara şifreli+maskeli; açık okuma gerekçe ister, günlüğe yazılır, yetkisiz rol okuyamaz', async () => {
    const w = await world('SgProfil');
    const e = await w.mkEmp();
    const p = (await w.profile(e.id, { note: 'test' })).profile;
    expect(p).toMatchObject({ payrollTypeCode: 'TEST-TIP-A', insuranceStart: FROM, insuranceEnd: null, hasSsn: true, ssnMasked: '••••8901' });
    expect(JSON.stringify(p)).not.toContain(SSN);
    const list = (await ok(w.c.get('/api/social-security/profiles'))).profiles as any[];
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(SSN);
    expect(list[0]).toMatchObject({ employeeCode: e.code, ssnMasked: '••••8901' });
    // Veritabanında açık metin yok
    const raw = (await execAsOwner(`select ssn_enc, ssn_last4 from employee_social_profiles where id = $1`, [p.id])).rows[0];
    expect(raw.ssn_enc).toMatch(/^v1\./);
    expect(raw.ssn_enc).not.toContain(SSN);
    expect(raw.ssn_last4).toBe('8901');
    // Kopya / geçersiz girişler
    expect((await w.c.post('/api/social-security/profiles', { employeeId: e.id, effectiveFrom: FROM })).statusCode).toBe(409);
    expect((await w.c.post('/api/social-security/profiles', { employeeId: e.id, effectiveFrom: d(5), insuranceStart: d(9), insuranceEnd: d(3) })).statusCode).toBe(400);
    expect((await w.c.post('/api/social-security/profiles', { employeeId: '0198f2c4-7b1a-7000-8000-000000000001', effectiveFrom: d(5) })).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    // Açık okuma: gerekçe zorunlu
    expect((await w.c.post(`/api/social-security/profiles/${p.id}/reveal`, { reason: 'x' })).statusCode).toBe(400);
    const rev = await ok(w.c.post(`/api/social-security/profiles/${p.id}/reveal`, { reason: 'Bildirim doğrulaması' }));
    expect(rev).toMatchObject({ field: 'social_security_no', value: SSN });
    const log = (await ok(w.c.get(`/api/privacy/access-log?employeeId=${e.id}`))).log as { field: string; reason: string; by: string }[];
    expect(log.find((l) => l.field === 'social_security_no')).toMatchObject({ reason: 'Bildirim doğrulaması', by: w.s.email });
    expect(log.filter((l) => l.field === 'social_security')).toHaveLength(1); // liste okuması (10 dk içinde tekrar yazılmaz)
    // Muhasebeci profili okur ama açık numarayı okuyamaz (hr.sensitive yok)
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    expect((await acc.client.get('/api/social-security/profiles')).statusCode).toBe(200);
    expect((await acc.client.post(`/api/social-security/profiles/${p.id}/reveal`, { reason: 'Deneme amaçlı' })).statusCode).toBe(403);
    // Düzeltme = sil + yeniden ekle
    expect((await w.c.delete(`/api/social-security/profiles/${p.id}`)).statusCode).toBe(204);
    expect(((await ok(w.c.get('/api/social-security/profiles'))).profiles as any[])).toHaveLength(0);
  });

  it('bildirim yalnızca onaylı/ödenmiş bordrodan üretilir; prim tutarları bordrodan aynen gelir; gün sayıları puantajdandır; yeniden üretim aynı sonucu verir', async () => {
    const w = await world('SgOlustur');
    const e = await w.mkEmp({ fullName: 'Hasan Usta' });
    await w.term(e.id, '3000');
    await w.param('employee_social_pct', '10');
    await w.param('employer_social_pct', '12');
    await w.att([w.worked(e.id, 2), w.worked(e.id, 3), { employeeId: e.id, workDate: d(4), dayType: 'unpaid_leave' }]);
    // Bordro yok / taslak: üretilmez
    expect((await w.c.post('/api/social-security/declarations', { month: MONTH })).json().error.code).toBe('SOCIAL_NO_PAYROLL');
    const run = await ok(w.c.post('/api/payroll/runs', { month: MONTH }), 201);
    expect((await w.c.post('/api/social-security/declarations', { month: MONTH })).json().error.code).toBe('SOCIAL_NO_PAYROLL');
    await ok(w.c.post('/api/attendance/months/close', { month: MONTH }));
    await ok(w.c.post(`/api/payroll/runs/${run.run.id}/approve`));
    await w.profile(e.id);

    const b = await w.build();
    expect(b.declaration).toMatchObject({ status: 'draft', month: MONTH, employeeCount: 1, payrollRunNumber: run.run.number, hasUnverifiedParams: true, supportSnapshot: [] });
    expect(b.declaration.number).toMatch(/^SGB-\d{4}-000001$/);
    const payroll = (await ok(w.c.get(`/api/payroll/runs/${run.run.id}`))).lines[0];
    expect(b.lines[0]).toMatchObject({
      employeeCode: e.code,
      payrollTypeCode: 'TEST-TIP-A',
      ssnMasked: '••••8901',
      daysWorked: 2,
      unpaidLeaveDays: 1,
      premiumBase: payroll.socialBase,
      employeePremium: payroll.employeeSocial,
      employerPremium: payroll.employerSocial,
      supportEmployee: '0.0000',
      supportEmployer: '0.0000',
      employeeDue: payroll.employeeSocial,
      employerDue: payroll.employerSocial,
    });
    expect(Number(b.lines[0].employeePremium)).toBeGreaterThan(0);
    expect(b.totals).toMatchObject({ count: 1, supportTotal: '0.00' });
    // Aynı ay ikinci bildirim açılmaz; yeniden üretim (rebuild) aynı numara ve aynı sayıları verir
    const again = await ok(w.c.post(`/api/social-security/declarations/${b.declaration.id}/rebuild`));
    expect(again.declaration.number).toBe(b.declaration.number);
    expect(again.lines.map((l: any) => [l.premiumBase, l.employeePremium, l.employerPremium, l.daysWorked])).toEqual(b.lines.map((l: any) => [l.premiumBase, l.employeePremium, l.employerPremium, l.daysWorked]));
    const post = await w.build(); // taslak varken POST aynı bildirimi yeniden üretir
    expect(post.declaration.id).toBe(b.declaration.id);
    expect(((await ok(w.c.get('/api/social-security/declarations'))).declarations as any[])).toHaveLength(1);
    // Profili olmayan / numarasız personel uyarılır (bildirim yine üretilir)
    expect((await w.c.delete(`/api/social-security/profiles/${(await ok(w.c.get('/api/social-security/profiles'))).profiles[0].id}`)).statusCode).toBe(204);
    const noProf = await ok(w.c.post(`/api/social-security/declarations/${b.declaration.id}/rebuild`));
    expect(noProf.lines[0].warnings).toContain('no_profile');
    expect(noProf.lines[0]).toMatchObject({ payrollTypeCode: null, ssnMasked: null });
    await w.profile(e.id, { socialSecurityNo: null, payrollTypeCode: null });
    const partial = await ok(w.c.post(`/api/social-security/declarations/${b.declaration.id}/rebuild`));
    expect(partial.lines[0].warnings).toEqual(expect.arrayContaining(['no_ssn', 'no_payroll_type']));
    // Bordro parametresiz ay: prim tutarı yok (motor yalnızca yazılanı yapar), prim matrahı da yoktur
  });

  it('prim desteği: yalnızca tarihli, AÇIK kural + personel uygunluğu birlikteyse uygulanır; kapalı/uygunluksuz/tarih dışı kural destek vermez; tutar primi aşamaz', async () => {
    const w = await world('SgDestek');
    const { emps } = await w.approvedPayroll({ two: true });
    const [e1, e2] = emps as [{ id: string; code: string }, { id: string; code: string }];
    await w.profile(e1.id);
    await w.profile(e2.id);
    const base = await w.build();
    const er1 = Number(base.lines.find((l: Record<string, any>) => l.employeeId === e1.id)!.employerPremium);
    expect(er1).toBeGreaterThan(0);

    // Kural varsayılan KAPALI: uygunluk beyanı olsa da destek yok, uyarı var
    const r = await w.rule();
    expect(r).toMatchObject({ code: 'TST1', enabled: false });
    await w.eligible(e1.id);
    let b = await ok(w.c.post(`/api/social-security/declarations/${base.declaration.id}/rebuild`));
    expect(b.lines.find((l: any) => l.employeeId === e1.id)).toMatchObject({ supportEmployer: '0.0000', supportEmployee: '0.0000', supportCodes: null });
    expect(b.lines.find((l: any) => l.employeeId === e1.id).warnings).toContain('support_rule_off');
    expect(b.totals.supportTotal).toBe('0.00');
    // Açılınca yalnızca uygun personele (yarım prim); uygunluğu olmayan e2 etkilenmez
    await ok(w.c.patch(`/api/social-security/support-rules/${r.id}`, { enabled: true }));
    b = await ok(w.c.post(`/api/social-security/declarations/${base.declaration.id}/rebuild`));
    const l1 = b.lines.find((l: any) => l.employeeId === e1.id);
    const l2 = b.lines.find((l: any) => l.employeeId === e2.id);
    expect(Number(l1.supportEmployer)).toBeCloseTo(er1 / 2, 2);
    expect(l1).toMatchObject({ supportEmployee: '0.0000', supportCodes: 'TST1' });
    expect(Number(l1.employerDue)).toBeCloseTo(er1 / 2, 2);
    expect(l2).toMatchObject({ supportEmployer: '0.0000', supportCodes: null });
    expect(l2.warnings).not.toContain('support_rule_off');
    expect(b.declaration.supportSnapshot).toEqual([expect.objectContaining({ code: 'TST1', ruleId: r.id, target: 'employer', mode: 'percent_of_premium', value: '50', verified: false })]);
    expect(b.declaration.hasUnverifiedParams).toBe(true);
    expect(Number(b.totals.supportEmployer)).toBeCloseTo(er1 / 2, 2);
    expect(Number(b.totals.employerDue)).toBeCloseTo(Number(b.totals.employerPremium) - er1 / 2, 2);
    // Sabit tutar kuralı prim ile sınırlıdır (primi aşamaz)
    const big = await w.rule({ code: 'TST2', name: 'Büyük sabit', mode: 'fixed_amount', value: '999999', target: 'employee', enabled: true });
    await w.eligible(e2.id, big.code);
    b = await ok(w.c.post(`/api/social-security/declarations/${base.declaration.id}/rebuild`));
    const l2b = b.lines.find((l: any) => l.employeeId === e2.id);
    expect(l2b.supportEmployee).toBe(l2b.employeePremium);
    expect(l2b.employeeDue).toBe('0.0000');
    // Ayın dışındaki kural (bitişi ay öncesi / başlangıcı ay sonrası) uygulanmaz
    const future = await w.rule({ code: 'TST3', name: 'Gelecek', effectiveFrom: `${thisYear + 1}-01-01`, enabled: true });
    const past = await w.rule({ code: 'TST4', name: 'Geçmiş', effectiveFrom: FROM, effectiveTo: `${thisYear}-01-31`, enabled: true });
    expect(future.enabled && past.enabled).toBe(true);
    await w.eligible(e1.id, 'TST3');
    await w.eligible(e1.id, 'TST4');
    b = await ok(w.c.post(`/api/social-security/declarations/${base.declaration.id}/rebuild`));
    expect(b.lines.find((l: any) => l.employeeId === e1.id).supportCodes).toBe('TST1');
    // Doğrulama: kaynak notu değişince sıfırlanır; doğrulanınca bildirimde "doğrulandı" işlenir
    await ok(w.c.post(`/api/social-security/support-rules/${r.id}/verify`, { note: 'Mali müşavir teyidi (test)' }));
    b = await ok(w.c.post(`/api/social-security/declarations/${base.declaration.id}/rebuild`));
    expect(b.declaration.supportSnapshot.find((s: any) => s.code === 'TST1').verified).toBe(true);
    const patched = (await ok(w.c.patch(`/api/social-security/support-rules/${r.id}`, { sourceNote: 'Değişti' }))).rule;
    expect(patched.verifiedAt).toBeNull();
    // Kural değeri/tarihi sonradan değişmez (veritabanı); geçersiz girişler
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update social_support_rules set value = 99 where id = '${r.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update social_support_rules set effective_from = effective_from + 1 where id = '${r.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update social_support_rules set mode = 'fixed_amount' where id = '${r.id}'`)).code).toBe('ERP13');
    });
    expect((await w.c.post('/api/social-security/support-rules', { code: 'X', name: 'Y', effectiveFrom: FROM, target: 'employer', mode: 'percent_of_premium', value: '150' })).statusCode).toBe(400);
    expect((await w.c.post('/api/social-security/support-rules', { code: 'TST1', name: 'Kopya', effectiveFrom: FROM, target: 'employer', mode: 'fixed_amount', value: '1' })).statusCode).toBe(409);
    expect((await w.c.post('/api/social-security/eligibility', { employeeId: e1.id, ruleCode: 'YOK', validFrom: FROM })).json().error.code).toBe('SUPPORT_RULE_NOT_FOUND');
    expect((await w.c.post('/api/social-security/eligibility', { employeeId: e1.id, ruleCode: 'TST1', validFrom: FROM })).statusCode).toBe(409);
    const elig = (await ok(w.c.get(`/api/social-security/eligibility?employeeId=${e1.id}`))).eligibility as any[];
    expect(elig.map((x) => x.ruleCode).sort()).toEqual(['TST1', 'TST3', 'TST4']);
    expect((await w.c.delete(`/api/social-security/eligibility/${elig[0].id}`)).statusCode).toBe(204);
    expect((await w.c.delete(`/api/social-security/support-rules/${future.id}`)).statusCode).toBe(204);
  });

  it('kesinleştirme ve kilit eşleşmesi: kesinleşmiş bildirim bordro iptalini ve puantaj ayı açılmasını engeller (API + ham SQL), değişmez; yeniden açılınca kilit kalkar', async () => {
    const w = await world('SgKilit');
    const { emps, runId } = await w.approvedPayroll();
    await w.profile(emps[0]!.id);
    const b = await w.build();
    const id = b.declaration.id as string;
    const fin = await ok(w.c.post(`/api/social-security/declarations/${id}/finalize`, { note: 'Ay sonu' }));
    expect(fin.declaration).toMatchObject({ status: 'finalized', finalizeNote: 'Ay sonu', finalizedBy: w.s.userId });
    // Kesinleşmiş bildirim: yeniden üretilemez / silinemez / tekrar kesinleştirilemez
    expect((await w.c.post(`/api/social-security/declarations/${id}/rebuild`)).statusCode).toBe(409);
    expect((await w.c.post('/api/social-security/declarations', { month: MONTH })).statusCode).toBe(409);
    expect((await w.c.delete(`/api/social-security/declarations/${id}`)).json().error.code).toBe('SOCIAL_NOT_DRAFT');
    expect((await w.c.post(`/api/social-security/declarations/${id}/finalize`, {})).json().error.code).toBe('SOCIAL_NOT_DRAFT');
    // Bordro iptali ve puantaj ayı açma engellenir
    const cancel = await w.c.post(`/api/payroll/runs/${runId}/cancel`, { reason: 'Düzeltme gerekli' });
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.code).toBe('HR_RULE_VIOLATION');
    expect(cancel.json().error.message).toMatch(/sosyal güvenlik bildirimi/);
    const reopenAtt = await w.c.post('/api/attendance/months/reopen', { month: MONTH, reason: 'Eksik mesai girişi' });
    expect(reopenAtt.statusCode).toBe(422);
    expect(reopenAtt.json().error.message).toMatch(/sosyal güvenlik bildirimi/);
    // Ham SQL (sahip rolü dahil)
    await asOwner(async (q) => {
      const cancelSql = `update payroll_runs set status = 'cancelled', cancelled_at = now(), cancelled_by = '${w.s.userId}', cancel_reason = 'yeterli gerekçe', reversal_entry_id = entry_id where id = '${runId}'`;
      expect((await expectDbError(q, cancelSql)).code).toBe('ERP13');
      const reopenSql = `update attendance_months set status = 'open', reopened_at = now(), reopened_by = '${w.s.userId}', reopen_reason = 'yeterli gerekçe', reopen_count = reopen_count + 1 where company_id = '${w.company.id}' and month = '${MONTH}'`;
      expect((await expectDbError(q, reopenSql)).code).toBe('ERP13');
      expect((await expectDbError(q, `update social_declaration_lines set employee_premium = employee_premium where declaration_id = '${id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from social_declaration_lines where declaration_id = '${id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `insert into social_declaration_lines (id, company_id, declaration_id, employee_id, payroll_line_id) select gen_random_uuid(), company_id, '${id}', employee_id, id from payroll_lines where run_id = '${runId}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update social_declarations set employee_premium_total = employee_premium_total + 1 where id = '${id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update social_declarations set month = '2020-01' where id = '${id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from social_declarations where id = '${id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update social_declarations set status = 'draft' where id = '${id}'`)).code).toBe('ERP13'); // gerekçesiz yeniden açma
    });
    expect((await getDecl(w.c, id)).lock.closed).toBe(true);
    // Gerekçesiz yeniden açma API'de reddedilir; gerekçeyle açılır, sayaç artar
    expect((await w.c.post(`/api/social-security/declarations/${id}/reopen`, { reason: 'x' })).statusCode).toBe(400);
    const re = await ok(w.c.post(`/api/social-security/declarations/${id}/reopen`, { reason: 'Prim düzeltmesi' }));
    expect(re.declaration).toMatchObject({ status: 'draft', reopenReason: 'Prim düzeltmesi', reopenCount: 1, finalizedAt: null });
    expect((await w.c.post(`/api/social-security/declarations/${id}/reopen`, { reason: 'Yine' })).json().error.code).toBe('SOCIAL_NOT_FINALIZED');
    // Taslak bildirim bordro iptalini engellemez; iptalde bayat taslak silinir
    await ok(w.c.post(`/api/payroll/runs/${runId}/cancel`, { reason: 'Düzeltme gerekli' }));
    expect(((await ok(w.c.get('/api/social-security/declarations'))).declarations as any[])).toHaveLength(0);
    expect((await execAsOwner(`select count(*)::int as n from social_declaration_lines where company_id = $1`, [w.company.id])).rows[0].n).toBe(0);
    expect((await w.c.post('/api/social-security/declarations', { month: MONTH })).json().error.code).toBe('SOCIAL_NO_PAYROLL');
  });

  it('kesinleştirme güncel veriyle yeniden üretir; ödendi işaretli bordro kabul edilir; kesinleşmiş bildirimde kullanılan destek kuralı silinemez', async () => {
    const w = await world('SgKesin');
    const { emps, runId } = await w.approvedPayroll();
    await w.profile(emps[0]!.id);
    const ruleA = await w.rule({ enabled: true });
    const ruleB = await w.rule({ code: 'TST2', name: 'Sabit işçi desteği', target: 'employee', mode: 'fixed_amount', value: '1', enabled: true });
    await w.eligible(emps[0]!.id);
    await w.eligible(emps[0]!.id, 'TST2');
    const b = await w.build();
    expect(Number(b.lines[0].supportEmployer)).toBeGreaterThan(0);
    expect(b.lines[0].supportEmployee).toBe('1.0000');
    // Taslakta kural A kapatılırsa kesinleştirme güncel durumu kullanır (A'nın desteği kalkar, B kalır)
    await ok(w.c.patch(`/api/social-security/support-rules/${ruleA.id}`, { enabled: false }));
    await ok(w.c.post(`/api/payroll/runs/${runId}/pay`, { paidAt: new Date().toISOString().slice(0, 10) }));
    const fin = await ok(w.c.post(`/api/social-security/declarations/${b.declaration.id}/finalize`, {}));
    expect(fin.lines[0]).toMatchObject({ supportEmployer: '0.0000', supportEmployee: '1.0000', supportCodes: 'TST2' });
    expect(fin.declaration.payrollRunStatus).toBe('paid');
    expect(fin.declaration.supportSnapshot.map((s: any) => s.code)).toEqual(['TST2']);
    // Ödeme geri alınabilir (bordro onaylı kalır, bildirim geçerli)
    await ok(w.c.post(`/api/payroll/runs/${runId}/unpay`, { reason: 'Test geri alma' }));
    // Kesinleşmiş bildirimde anılan kural silinemez; anılmayan silinebilir
    const del = await w.c.delete(`/api/social-security/support-rules/${ruleB.id}`);
    expect(del.statusCode).toBe(422);
    expect(del.json().error.code).toBe('HR_RULE_VIOLATION');
    expect((await w.c.delete(`/api/social-security/support-rules/${ruleA.id}`)).statusCode).toBe(204);
    // Yeniden açılınca kural silinebilir hâle gelir (bildirim taslak)
    await ok(w.c.post(`/api/social-security/declarations/${b.declaration.id}/reopen`, { reason: 'Kural revizyonu' }));
    expect((await w.c.delete(`/api/social-security/support-rules/${ruleB.id}`)).statusCode).toBe(204);
  });

  it('yetki, modül ve bağımlılık: muhasebeci okur ve yönetir; şantiye şefi ve izleyici erişemez; hr.socialsecurity hr.payroll\'a bağlı; kapalıyken uçlar 403', async () => {
    const w = await world('SgYetki');
    const { emps } = await w.approvedPayroll();
    await w.profile(emps[0]!.id);
    const b = await w.build();
    const urls = ['/api/social-security/profiles', '/api/social-security/support-rules', '/api/social-security/eligibility', '/api/social-security/declarations', `/api/social-security/declarations/${b.declaration.id}`, `/api/social-security/reports/premium?from=${MONTH}&to=${MONTH}`, `/api/exports/social-declaration?id=${b.declaration.id}`, `/api/exports/social-premium-summary?from=${MONTH}&to=${MONTH}`];
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    for (const url of urls) expect((await acc.client.get(url)).statusCode, url).toBe(200);
    expect((await acc.client.post('/api/social-security/support-rules', { code: 'M1', name: 'Muh', effectiveFrom: FROM, target: 'employer', mode: 'fixed_amount', value: '5' })).statusCode).toBe(201);
    for (const role of ['site_manager', 'viewer'] as const) {
      const m = await addMember(app, w.c, w.company.id, role);
      for (const url of urls) expect((await m.client.get(url)).statusCode, `${role} ${url}`).toBe(403);
      expect((await m.client.post('/api/social-security/declarations', { month: MONTH })).statusCode).toBe(403);
      expect((await m.client.post(`/api/social-security/declarations/${b.declaration.id}/finalize`, {})).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/social-security/declarations' })).statusCode).toBe(401);
    // Bağımlılık: bordro, sosyal güvenlik açıkken kapatılamaz; önce sosyal güvenlik kapatılır
    expect((await w.c.put('/api/company/modules/hr.payroll', { enabled: false })).statusCode).toBe(422);
    expect((await w.c.put('/api/company/modules/hr.socialsecurity', { enabled: false })).statusCode).toBe(200);
    const off = await w.c.get('/api/social-security/declarations');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('MODULE_DISABLED');
    expect((await w.c.get(`/api/exports/social-declaration?id=${b.declaration.id}`)).statusCode).toBe(403);
    const nav = (await ok(w.c.get('/api/navigation'))).groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(nav).not.toContain('social-security');
    expect(nav).toContain('payroll');
    expect((await w.c.put('/api/company/modules/hr.socialsecurity', { enabled: true })).statusCode).toBe(200);
    expect((await w.c.put('/api/company/modules/hr.payroll', { enabled: false })).statusCode).toBe(422);
  });

  it('RLS: başka şirket profil, kural, uygunluk ve bildirim görmez; başka şirket personeline profil yazılamaz', async () => {
    const a = await world('SgRlsA');
    const b = await world('SgRlsB');
    const { emps } = await a.approvedPayroll();
    await a.profile(emps[0]!.id);
    await a.rule();
    await a.eligible(emps[0]!.id);
    const da = await a.build();
    expect(((await ok(b.c.get('/api/social-security/declarations'))).declarations as any[])).toHaveLength(0);
    expect((await b.c.get(`/api/social-security/declarations/${da.declaration.id}`)).statusCode).toBe(404);
    expect(((await ok(b.c.get('/api/social-security/profiles'))).profiles as any[])).toHaveLength(0);
    expect(((await ok(b.c.get('/api/social-security/support-rules'))).rules as any[])).toHaveLength(0);
    expect(((await ok(b.c.get('/api/social-security/eligibility'))).eligibility as any[])).toHaveLength(0);
    expect((await b.c.post(`/api/social-security/declarations/${da.declaration.id}/finalize`, {})).statusCode).toBe(404);
    expect((await b.c.post(`/api/social-security/declarations/${da.declaration.id}/rebuild`)).statusCode).toBe(404);
    expect((await b.c.post('/api/social-security/profiles', { employeeId: emps[0]!.id, effectiveFrom: FROM })).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    const pid = (await ok(a.c.get('/api/social-security/profiles'))).profiles[0].id;
    expect((await b.c.post(`/api/social-security/profiles/${pid}/reveal`, { reason: 'Başka şirket' })).statusCode).toBe(404);
    await asDb(handle, { companyId: b.company.id, orgId: b.orgId }, async (q) => {
      for (const t of ['employee_social_profiles', 'social_support_rules', 'employee_support_eligibility', 'social_declarations', 'social_declaration_lines']) {
        expect((await q(`select count(*)::int as n from ${t} where company_id = $1`, [a.company.id])).rows[0].n, t).toBe(0);
      }
      expect((await expectDbError(q, `insert into employee_social_profiles (id, company_id, employee_id, effective_from) values (gen_random_uuid(), $1, $2, '${FROM}')`, [a.company.id, emps[0]!.id])).code).toMatch(/42501|ERP13|23503/);
    });
  });

  it('dışa aktarma: bildirim xlsx/csv (GENEL düzen, resmî değildir notu, numara maskeli), prim özeti ay/proje sayfaları, tüm veriler yalnızca toplam; kişi verisi dışa aktarma açık numarayı içerir; envanter tohumu', async () => {
    const w = await world('SgDisari');
    const { emps } = await w.approvedPayroll({ two: true });
    await w.profile(emps[0]!.id);
    const rule = await w.rule({ enabled: true });
    await w.eligible(emps[0]!.id);
    const b = await w.build();
    const id = b.declaration.id as string;
    const x = await w.c.get(`/api/exports/social-declaration?id=${id}&format=xlsx`);
    expect(x.statusCode, x.body.slice(0, 200)).toBe(200);
    const sheets = readXlsx(new Uint8Array(x.rawPayload));
    const cells = sheets[0]!.rows.flat().join('|');
    expect(cells).toContain('resmî bildirim formatı değildir, doğrulanmadı');
    expect(cells).toContain('Hasan Usta');
    expect(cells).toContain('••••8901');
    expect(cells).toContain('TEST-TIP-A');
    expect(cells).not.toContain(SSN);
    expect(cells).toContain('doğrulanmamış');
    const csv = await w.c.get(`/api/exports/social-declaration?id=${id}&format=csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('••••8901');
    expect(csv.body).not.toContain(SSN);
    // Erişim günlüğü: dışa aktarma okumayı kaydeder
    const log = (await ok(w.c.get(`/api/privacy/access-log?employeeId=${emps[0]!.id}`))).log as { field: string; reason: string }[];
    expect(log.some((l) => l.field === 'social_security' && /dışa aktarma|görüntüleme/.test(l.reason))).toBe(true);
    // Kesinleşme sonrası prim özeti
    await ok(w.c.post(`/api/social-security/declarations/${id}/finalize`, {}));
    const sum = await w.c.get(`/api/exports/social-premium-summary?from=${MONTH}&to=${MONTH}&format=xlsx`);
    expect(sum.statusCode, sum.body.slice(0, 200)).toBe(200);
    const sumSheets = readXlsx(new Uint8Array(sum.rawPayload));
    expect(sumSheets.map((s) => s.name)).toEqual(['Aya göre', 'Projeye göre']);
    expect(sumSheets[0]!.rows.flat().join('|')).toContain('resmî bildirim formatı değildir');
    expect(sumSheets[0]!.rows.flat().join('|')).toContain('SGB-');
    expect((await w.c.get(`/api/exports/social-premium-summary?from=2026-13&to=${MONTH}`)).statusCode).toBe(400);
    expect((await w.c.get('/api/exports/social-declaration?id=bozuk')).statusCode).toBe(400);
    // Tüm veriler: yalnızca bildirim toplamları
    const all = await w.c.get('/api/exports/full-data?format=xlsx');
    expect(all.statusCode, all.body.slice(0, 200)).toBe(200);
    const soc = readXlsx(new Uint8Array(all.rawPayload)).find((s) => s.name === 'Sosyal güvenlik')!;
    const socCells = soc.rows.flat().join('|');
    expect(socCells).toContain(b.declaration.number);
    expect(socCells).toContain('resmî bildirim formatı değildir');
    expect(socCells).not.toContain('Hasan Usta');
    expect(socCells).not.toContain('8901');
    // İlgili kişi dışa aktarma: açık numara + bildirim satırı
    const exp = await ok(w.c.post(`/api/privacy/employees/${emps[0]!.id}/export`, { reason: 'Erişim talebi' }));
    expect(exp.socialSecurity.profiles[0]).toMatchObject({ payrollTypeCode: 'TEST-TIP-A', socialSecurityNo: SSN });
    expect(exp.socialSecurity.declarations[0]).toMatchObject({ number: b.declaration.number, month: MONTH, status: 'finalized' });
    // Envanter
    const inv = (await ok(w.c.get('/api/privacy/inventory'))).inventory as { key: string; isSensitive: boolean; verifiedAt: string | null; legalBasis: string; purpose: string }[];
    for (const k of ['social.profile', 'social.declaration_lines']) {
      const row = inv.find((i) => i.key === k)!;
      expect(row, k).toMatchObject({ isSensitive: true, verifiedAt: null });
      expect(row.legalBasis).toContain('doğrulanmadı');
      expect(row.purpose).toContain('doğrulanmadı');
    }
    void rule;
  });

  it('prim özeti: aya ve projeye göre; projeye dağıtım bordro etiket dağılımına göredir ve toplam bildirimle birebir tutar; taslak toplama girmez', async () => {
    const w = await world('SgRapor');
    const e = await w.mkEmp({ fullName: 'Hasan Usta' });
    await w.term(e.id, '3000');
    await w.param('employee_social_pct', '10');
    await w.param('employer_social_pct', '12');
    const p1 = (await ok(w.c.post('/api/projects', { name: 'Proje Bir', kind: 'own' }), 201)).project as { id: string; code: string };
    const p2 = (await ok(w.c.post('/api/projects', { name: 'Proje İki', kind: 'own' }), 201)).project as { id: string; code: string };
    await w.att([w.worked(e.id, 2, { projectId: p1.id }), w.worked(e.id, 3, { projectId: p1.id }), w.worked(e.id, 4, { projectId: p2.id }), w.worked(e.id, 5)]);
    await ok(w.c.post('/api/attendance/months/close', { month: MONTH }));
    const run = await ok(w.c.post('/api/payroll/runs', { month: MONTH }), 201);
    await ok(w.c.post(`/api/payroll/runs/${run.run.id}/approve`));
    const b = await w.build();
    // Taslak: ay satırı var, toplam sıfır; proje dağılımı yok
    let rep = await ok(w.c.get(`/api/social-security/reports/premium?from=${MONTH}&to=${MONTH}`));
    expect(rep.months).toHaveLength(1);
    expect(rep.months[0]).toMatchObject({ status: 'draft', number: b.declaration.number });
    expect(rep.totals.employeePremium).toBe('0.00');
    expect(rep.projects).toEqual([]);
    await ok(w.c.post(`/api/social-security/declarations/${b.declaration.id}/finalize`, {}));
    rep = await ok(w.c.get(`/api/social-security/reports/premium?from=${MONTH}&to=${MONTH}`));
    const sum = (k: string) => rep.projects.reduce((s: number, r: any) => s + Number(r[k]), 0);
    expect(rep.totals.employeePremium).toBe(b.totals.employeePremium);
    expect(sum('employeePremium')).toBeCloseTo(Number(b.totals.employeePremium), 2);
    expect(sum('employerPremium')).toBeCloseTo(Number(b.totals.employerPremium), 2);
    expect(rep.projects.map((r: any) => r.projectCode)).toEqual([p1.code, p2.code, null]);
    // 2 gün Proje Bir, 1 gün Proje İki, 1 gün etiketsiz → yarısı, çeyreği, çeyreği
    const emp = Number(b.totals.employeePremium);
    expect(Number(rep.projects[0].employeePremium)).toBeCloseTo(emp / 2, 2);
    expect(Number(rep.projects[1].employeePremium)).toBeCloseTo(emp / 4, 2);
    expect(rep.unverified).toBe(true);
    expect((await w.c.get(`/api/social-security/reports/premium?from=${MONTH}&to=2000-01`)).statusCode).toBe(400);
  });

  it('veritabanı korumaları (sahip rolü dahil): taslak/aynı ay dışı bordrodan bildirim açılamaz, satırsız bildirim kesinleşmez, tutar sınırları', async () => {
    const w = await world('SgDb');
    const e = await w.mkEmp();
    await w.term(e.id, '3000');
    await w.att([w.worked(e.id, 2)]);
    const draft = await ok(w.c.post('/api/payroll/runs', { month: MONTH }), 201);
    await asOwner(async (q) => {
      const ins = (status: string, month = MONTH) =>
        `insert into social_declarations (id, company_id, number, month, status, payroll_run_id, payroll_run_number) values (gen_random_uuid(), '${w.company.id}', 'X-1', '${month}', '${status}', '${draft.run.id}', '${draft.run.number}')`;
      expect((await expectDbError(q, ins('draft'))).code).toBe('ERP13'); // taslak bordro
      expect((await expectDbError(q, ins('finalized'))).code).toMatch(/ERP13|23514/);
    });
    await ok(w.c.post('/api/attendance/months/close', { month: MONTH }));
    await ok(w.c.post(`/api/payroll/runs/${draft.run.id}/approve`));
    await w.profile(e.id);
    const b = await w.build();
    await asOwner(async (q) => {
      // Satırsız kesinleştirme: tüm satırları (taslakken) silip kesinleştirmeyi dene
      await q(`delete from social_declaration_lines where declaration_id = '${b.declaration.id}'`);
      expect((await expectDbError(q, `update social_declarations set status = 'finalized', finalized_at = now(), finalized_by = '${w.s.userId}' where id = '${b.declaration.id}'`)).code).toBe('ERP13');
      // Toplamlar satırlarla tutarsızsa kesinleşmez
      expect((await expectDbError(q, `update social_declarations set employee_count = 0, status = 'finalized', finalized_at = now(), finalized_by = '${w.s.userId}' where id = '${b.declaration.id}'`)).code).toBe('ERP13');
      // Destek primi aşamaz (kontrol kısıtı)
      expect((await expectDbError(q, `update social_declarations set support_employer_total = employer_premium_total + 1 where id = '${b.declaration.id}'`)).code).toBe('23514');
      expect((await expectDbError(q, `insert into social_support_rules (id, company_id, code, name, effective_from, target, mode, value) values (gen_random_uuid(), '${w.company.id}', 'T', 'T', '${FROM}', 'employer', 'percent_of_premium', 101)`)).code).toBe('23514');
      expect((await expectDbError(q, `insert into social_support_rules (id, company_id, code, name, effective_from, target, mode, value) values (gen_random_uuid(), '${w.company.id}', 'T', 'T', '${FROM}', 'kurum', 'fixed_amount', 1)`)).code).toBe('23514');
      expect((await expectDbError(q, `insert into employee_social_profiles (id, company_id, employee_id, effective_from, insurance_start, insurance_end) values (gen_random_uuid(), '${w.company.id}', '${e.id}', '${d(9)}', '${d(9)}', '${d(3)}')`)).code).toBe('23514');
    });
  });
});
