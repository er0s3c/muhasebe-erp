import { describe, expect, it } from 'vitest';
import { turkeyPayroll2026, type CountryPayrollConfig } from '@erp/shared';
import { addMember, asDb, asOwner, client, createCompany, expectDbError, makeApp, orgOf, registerUser } from './helpers';
import { createLegacyCompany } from './legacy-company';

describe('ülke bordrosu ve kayıtlı mevzuat hesabı', async () => {
  const { app, handle } = await makeApp();
  const ok = async (p: ReturnType<ReturnType<typeof client>['get']>, status = 200) => {
    const response = await p;
    if (response.statusCode !== status) throw new Error(`${status} bekleniyordu: ${response.statusCode} ${response.body}`);
    return response.json();
  };
  const configKKTC: CountryPayrollConfig = {
    jurisdiction: 'KKTC', regime: 'TEST', taxYear: 2026, rulePackVersion: 'TEST-KKTC-2026', sourceRefs: ['https://www.vergi.gov.ct.tr/'],
    incomeTaxBands: [{ upTo: '45000', ratePct: '10' }, { upTo: '90000', ratePct: '20' }, { upTo: '210000', ratePct: '25' }, { upTo: '400000', ratePct: '30' }, { upTo: null, ratePct: '37' }],
    salaryPeriods: 12, personalAnnualAllowance: '655000', specialAllowancePct: '10', employeeDeductibleLimitPct: '13', employeeInsurancePct: '9', employerInsurancePct: '11', occupationalRiskPct: '1', employeeProvidentPct: '4', employerProvidentPct: '4', employerLocalEmploymentPct: '0', socialFloorMonthly: '0', socialCapMonthly: null,
  };
  async function world(name: string, jurisdiction: 'TR' | 'KKTC' = 'TR', legacy = false) {
    const session = await registerUser(app, name);
    const company = await (legacy ? createLegacyCompany : createCompany)(app, session.token, { jurisdiction });
    const c = client(app, session.token, company.id);
    const employee = (await ok(c.post('/api/employees', { fullName: 'Ülke Bordro Personeli', hireDate: '2026-01-01' }), 201)).employee;
    await ok(c.post('/api/payroll/pay-terms', { employeeId: employee.id, effectiveFrom: '2026-01-01', payBasis: 'monthly', amount: '33030' }), 201);
    const config = jurisdiction === 'TR' ? turkeyPayroll2026() : configKKTC;
    const addConfig = async (effectiveFrom = '2026-01-01', override: CountryPayrollConfig = config) => (await ok(c.post('/api/payroll/country-configs', { effectiveFrom, config: override, sourceNote: 'Yalnız test: oran ve rejim test için doğrulandı' }), 201)).config;
    const configure = async () => {
      const row = await addConfig();
      await ok(c.post(`/api/payroll/country-configs/${row.id}/verify`));
      await ok(c.patch(`/api/payroll/country-configs/${row.id}`, { enabled: true }));
      return row;
    };
    const profile = async (effectiveFrom = '2026-01-01', extras: Record<string, unknown> = {}) => (await ok(c.post('/api/payroll/tax-profiles', { employeeId: employee.id, effectiveFrom, profile: { jurisdiction, regime: config.regime, openingBalancesAsOf: effectiveFrom.slice(0, 7), openingTaxBase: '0', openingExemptionBase: '0', minimumWageExemption: jurisdiction === 'TR', additionalAnnualAllowance: '0', taxCreditPct: '0', ...extras } }), 201)).profile;
    const run = async (month = '2026-01') => ok(c.post('/api/payroll/runs', { month }), 201);
    const approve = async (id: string, month = '2026-01') => {
      await ok(c.post('/api/attendance/months/close', { month }));
      return ok(c.post(`/api/payroll/runs/${id}/approve`));
    };
    return { session, company, c, employee, config, configure, addConfig, profile, run, approve };
  }

  it('ülke seçilmiş şirkette doğrulanmış paket ve personel vergi profili zorunlu', async () => {
    const w = await world('CountryPayrollPrerequisites');
    expect((await w.c.post('/api/payroll/runs', { month: '2026-01' })).json().error.code).toBe('PAYROLL_COUNTRY_CONFIG_REQUIRED');
    const cfg = await w.addConfig();
    expect((await w.c.patch(`/api/payroll/country-configs/${cfg.id}`, { enabled: true })).json().error.code).toBe('PAYROLL_COUNTRY_UNVERIFIED');
    await ok(w.c.post(`/api/payroll/country-configs/${cfg.id}/verify`));
    await ok(w.c.patch(`/api/payroll/country-configs/${cfg.id}`, { enabled: true }));
    expect((await w.c.post('/api/payroll/runs', { month: '2026-01' })).json().error.code).toBe('PAYROLL_TAX_PROFILE_REQUIRED');
    await w.profile();
    const d = await w.run();
    expect(d.run).toMatchObject({ jurisdiction: 'TR', engineVersion: 'country-payroll-v1', netTotal: '28075.5000' });
    expect(d.lines[0].legalCalculationSnapshot).toMatchObject({ jurisdiction: 'TR', socialDays: 30, cumulativeTaxBaseBefore: '0.00', cumulativeTaxBaseAfter: '28075.50' });
    expect(d.run.countryConfigSnapshot.configId).toBe(cfg.id);
    expect(d.run.legalProfileSnapshot.profileVersionId).toBeTruthy();
  });

  it('yeni ay önceki kesinleşmiş matrahı kullanır; ters sıra onay/iptal engellenir', async () => {
    const w = await world('CountryPayrollCumulative');
    await w.configure(); await w.profile();
    const january = await w.run();
    expect((await w.c.post('/api/payroll/runs', { month: '2026-02' })).json().error.code).toBe('PAYROLL_PRIOR_DRAFT');
    await w.approve(january.run.id);
    const february = await w.run('2026-02');
    expect(february.lines[0].legalCalculationSnapshot.cumulativeTaxBaseBefore).toBe('28075.50');
    expect(february.lines[0].legalCalculationSnapshot.cumulativeExemptionBaseBefore).toBe('28075.50');
    await w.approve(february.run.id, '2026-02');
    expect((await w.c.post(`/api/payroll/runs/${january.run.id}/cancel`, { reason: 'Düzeltme' })).json().error.code).toBe('PAYROLL_COUNTRY_LATER_POSTED');
    await ok(w.c.post(`/api/payroll/runs/${february.run.id}/cancel`, { reason: 'Düzeltme', entryDate: '2026-02-28' }));
    const before = await ok(w.c.get(`/api/payroll/runs/${february.run.id}`));
    expect(before.lines[0].legalCalculationSnapshot).toEqual(february.lines[0].legalCalculationSnapshot);
    const replacement = await w.run('2026-02');
    expect(replacement.lines[0].legalCalculationSnapshot.cumulativeTaxBaseBefore).toBe('28075.50');
  });

  it('KKTC sigorta, ihtiyat ve yerel katkı bildirimde ve dışa aktarımda ayrılır', async () => {
    const w = await world('CountryPayrollKKTC', 'KKTC');
    await w.configure(); await w.profile();
    await ok(w.c.post('/api/payroll/pay-terms', { employeeId: w.employee.id, effectiveFrom: '2026-02-01', payBasis: 'monthly', amount: '100000' }), 201);
    const r = await w.run('2026-02');
    expect(r.lines[0]).toMatchObject({ net: '79872.5000', employeeSocial: '13000.0000', employerTotal: '16000.0000' });
    await w.approve(r.run.id, '2026-02');
    const decl = await ok(w.c.post('/api/social-security/declarations', { month: '2026-02' }), 201);
    expect(decl.declaration.jurisdiction).toBe('KKTC');
    expect(decl.lines[0]).toMatchObject({ employeePremium: '9000.0000', employerPremium: '12000.0000', employeeProvident: '4000.0000', employerProvident: '4000.0000', daysWorked: 30 });
    await ok(w.c.post(`/api/social-security/declarations/${decl.declaration.id}/finalize`));
    expect((await w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'Düzeltme' })).json().error.code).toBe('PAYROLL_COUNTRY_FINALIZED_DECLARATION');
    await ok(w.c.post(`/api/social-security/declarations/${decl.declaration.id}/reopen`, { reason: 'Bordro düzeltilecek' }));
    await ok(w.c.post(`/api/payroll/runs/${r.run.id}/cancel`, { reason: 'Düzeltme', entryDate: '2026-02-28' }));
  });

  it('kesinleşmiş hesap görüntüsü ve tarihli kural/personel profili veritabanında değişmez', async () => {
    const w = await world('CountryPayrollImmutable');
    const cfg = await w.configure(); const prof = await w.profile(); const r = await w.run(); await w.approve(r.run.id);
    await asOwner(async (q) => {
      expect((await expectDbError(q, 'update payroll_country_configs set config=$1::jsonb where id=$2', [JSON.stringify({ ...w.config, employeeSocialPct: '0' }), cfg.id])).code).toBe('ERP13');
      expect((await expectDbError(q, "update employee_payroll_tax_profiles set profile='{}' where id=$1", [prof.id])).code).toBe('ERP13');
      expect((await expectDbError(q, "update payroll_runs set country_config_snapshot='{}' where id=$1", [r.run.id])).code).toBe('ERP13');
      expect((await expectDbError(q, "update payroll_lines set legal_calculation_snapshot='{}' where run_id=$1", [r.run.id])).code).toBe('ERP13');
    });
    expect((await w.c.post('/api/payroll/country-configs', { effectiveFrom: '2026-01-01', config: w.config, sourceNote: 'Yeni sürüm' })).json().error.code).toBe('PAYROLL_COUNTRY_POSTED_HISTORY');
    expect((await w.c.post('/api/payroll/tax-profiles', { employeeId: w.employee.id, effectiveFrom: '2026-01-02', profile: prof.profile })).json().error.code).toBe('PAYROLL_TAX_PROFILE_POSTED_HISTORY');
  });

  it('legacy run ülke seçimi sonradan değişse de düz-yüzde hesabını ve snapshotını korur', async () => {
    const w = await world('CountryPayrollLegacy', 'TR', true);
    await ok(w.c.post('/api/payroll/params', { key: 'income_tax_pct', value: '10', effectiveFrom: '2026-01-01', enabled: true }), 201);
    const run = await w.run();
    expect(run.run).toMatchObject({ jurisdiction: null, engineVersion: 'legacy-v1', netTotal: '29727.0000' });
    const input = { jurisdiction: 'TR', effectiveFrom: '2026-02-01' };
    const preview = await ok(w.c.post('/api/company/profile/preview', input));
    await ok(w.c.post('/api/company/profile/activate', { ...input, revision: preview.revision }));
    const recalculated = await ok(w.c.post(`/api/payroll/runs/${run.run.id}/calculate`));
    expect(recalculated.lines[0].net).toBe('29727.0000');
    expect(recalculated.lines[0].legalCalculationSnapshot).toBe(null);
    expect(recalculated.run.countryConfigSnapshot).toBe(null);
  });

  it('şirketler arası kural/personel verisi izole; yazma yetkisi ve erişim günlüğü korunur', async () => {
    const a = await world('CountryPayrollRLSa'); const b = await world('CountryPayrollRLSb');
    const cfg = await a.configure(); await a.profile();
    expect((await ok(b.c.get('/api/payroll/country-configs'))).configs).toEqual([]);
    expect((await b.c.post(`/api/payroll/country-configs/${cfg.id}/verify`)).statusCode).toBe(404);
    expect((await ok(b.c.get('/api/payroll/tax-profiles'))).profiles).toEqual([]);
    const viewer = await addMember(app, a.c, a.company.id, 'viewer', 'CountryPayrollViewer');
    expect((await viewer.client.post('/api/payroll/country-configs', { effectiveFrom: '2026-02-01', config: a.config, sourceNote: 'Yetkisiz' })).statusCode).toBe(403);
    await ok(a.c.get('/api/payroll/tax-profiles'));
    const orgId = await orgOf(app, a.session.token);
    await asDb(handle, { userId: a.session.userId, orgId, companyId: a.company.id }, async (q) => {
      expect(Number((await q("select count(*) as n from personal_data_access_log where employee_id=$1 and field='payroll'", [a.employee.id])).rows[0].n)).toBeGreaterThan(0);
      expect(Number((await q('select count(*) as n from employee_payroll_tax_profiles where company_id=$1', [b.company.id])).rows[0].n)).toBe(0);
    });
  });
});
