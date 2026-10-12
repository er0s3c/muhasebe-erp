import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { todayIso } from '@erp/shared';
import { accountIds, asDb, client, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('tarihli şirket ülkesi ve geçmiş koruması', async () => {
  const { app, handle } = await makeApp();
  const setup = async (jurisdiction: 'TR' | 'KKTC' = 'TR') => {
    const session = await registerUser(app, 'Ulke');
    const response = await client(app, session.token).post('/api/companies', { name: 'Ülke Test', sector: 'COMMERCE', jurisdiction });
    expect(response.statusCode).toBe(201);
    const company = response.json().company;
    return { session, company, c: client(app, session.token, company.id) };
  };
  const input = (jurisdiction: 'TR' | 'KKTC') => ({ jurisdiction, effectiveFrom: todayIso(), legalEntityType: 'company', vatRegistered: true });

  it('yeni şirket ülkesiz oluşturulamaz; TR doğru oran ve kur bağlamını alır', async () => {
    const s = await registerUser(app, 'ZorunluUlke');
    expect((await client(app, s.token).post('/api/companies', { name: 'Ülkesiz', sector: 'COMMERCE' })).statusCode).toBe(400);
    const { c, company } = await setup();
    expect(company).toMatchObject({ jurisdiction: 'TR', profileMode: 'country', fxProvider: 'tcmb', timeZone: 'Europe/Istanbul', taxSetupStatus: 'needs_review' });
    const rates = (await c.get('/api/tax-rates')).json().taxRates;
    expect(rates.map((r: any) => r.code).sort()).toEqual(['KDV-0','KDV-1','KDV-10','KDV-20']);
    expect(rates.every((r: any) => r.jurisdiction === 'TR' && r.validFrom === '2023-07-10' && r.verifiedAt === null && r.sourceUrl)).toBe(true);
    expect((await c.get('/api/navigation')).json().company.timeZone).toBe('Europe/Istanbul');
  });

  it('KKTC oranları güncel kaynak tarihinde başlar; sıfır oranı bir kez eklenir', async () => {
    const { c } = await setup('KKTC');
    const rates = (await c.get('/api/tax-rates')).json().taxRates;
    expect(rates.map((r: any) => r.code).sort()).toEqual(['KDV-0','KDV-10','KDV-16','KDV-20','KDV-5']);
    expect(rates.every((r: any) => r.validFrom === '2026-09-16' && r.verifiedAt === null && r.jurisdiction === 'KKTC')).toBe(true);
  });

  it('ülke ilk kez legacy şirkette etkinleştirilirken eski oranlar değişmez', async () => {
    const session = await registerUser(app, 'EskiUlke');
    const orgId = await orgOf(app, session.token), companyId = randomUUID(), oldRateId = randomUUID();
    await execAsOwner("insert into companies(id,organization_id,name,sector) values($1,$2,'Eski Şirket','COMMERCE')", [companyId,orgId]);
    await execAsOwner("insert into memberships(id,company_id,user_id,role) values($1,$2,$3,'owner')", [randomUUID(),companyId,session.userId]);
    await execAsOwner("insert into tax_rates(id,company_id,code,name,rate,valid_from,source_note) values($1,$2,'KDV-16','Eski oran',16,'2020-01-01','Eski manuel kaynak')", [oldRateId,companyId]);
    const c = client(app, session.token, companyId);
    expect((await c.get('/api/company/profile')).json().company).toMatchObject({ jurisdiction: null, profileMode: 'legacy_manual' });
    const body = input('TR'), preview = (await c.post('/api/company/profile/preview',body)).json();
    expect(preview.canActivate).toBe(true);
    expect((await c.post('/api/company/profile/activate',{...body,revision:preview.revision})).statusCode).toBe(200);
    const rates = (await c.get('/api/tax-rates')).json().taxRates;
    expect(rates.find((r: any) => r.id === oldRateId)).toMatchObject({ rate:'16.0000',validFrom:'2020-01-01',jurisdiction:null,verifiedAt:null,sourceNote:'Eski manuel kaynak' });
    expect(rates.find((r: any) => r.jurisdiction === 'TR').validFrom).toBe(todayIso());
  });

  it('geçmişi olmayan ülke geçişi atomiktir; eski oranları yeni ülkeye taşımaz', async () => {
    const { c } = await setup('KKTC');
    const body = input('TR'), preview = (await c.post('/api/company/profile/preview',body)).json();
    expect(preview.canActivate).toBe(true);
    const results = await Promise.all([c.post('/api/company/profile/activate',{...body,revision:preview.revision}),c.post('/api/company/profile/activate',{...body,revision:preview.revision})]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200,409]);
    const rates = (await c.get('/api/tax-rates')).json().taxRates;
    expect(rates.find((r: any) => r.code === 'KDV-16').jurisdiction).toBe('KKTC');
    const party = (await c.post('/api/parties',{code:'ALICI',name:'Test Alıcı',kind:'customer'})).json().party;
    const invoice = await c.post('/api/invoices',{type:'sales',invoiceDate:todayIso(),partyId:party.id,currencyCode:'TRY',lines:[{description:'Ülke kontrol',quantity:'1',unitPrice:'100',vatCode:'KDV-16'}]});
    expect(invoice.statusCode).toBe(422);
    expect(invoice.json().error.code).toBe('VAT_CODE_INVALID');
  });

  it('önizleme sonrası ayar değişikliği tekrar önizleme ister', async () => {
    const { c } = await setup();
    const body = input('TR'), preview = (await c.post('/api/company/profile/preview',body)).json();
    await c.patch('/api/company',{ name: 'Değişen Şirket' });
    const response = await c.post('/api/company/profile/activate',{...body,revision:preview.revision});
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('PROFILE_PREVIEW_STALE');
  });

  it('kesinleşmiş kayıt ülke değişimini engeller ve mali snapshot değişmez', async () => {
    const { c, session, company } = await setup();
    const ids = await accountIds(app,session.token,company.id);
    const posted = await c.post('/api/journal-entries',{entryDate:todayIso(),description:'Sabit ülke',post:true,lines:[{accountId:ids['100'],debit:'100',currency:'TRY'},{accountId:ids['500'],credit:'100',currency:'TRY'}]});
    expect(posted.statusCode).toBe(201);
    const entry = posted.json().entry;
    expect(entry.legalProfileSnapshot).toMatchObject({jurisdiction:'TR',profileVersionId:company.profileVersionId});
    const preview = (await c.post('/api/company/profile/preview',input('KKTC'))).json();
    expect(preview.canActivate).toBe(false);
    expect(preview.blockers.some((b: any) => b.code === 'COUNTRY_CHANGE_HAS_HISTORY')).toBe(true);
    await asDb(handle,{userId:session.userId,orgId:await orgOf(app,session.token),companyId:company.id},async (q) => {
      expect((await expectDbError(q,'update companies set jurisdiction=$1 where id=$2',['KKTC',company.id])).code).toBe('ERP24');
      expect((await expectDbError(q,"update journal_entries set legal_profile_snapshot='{}'::jsonb where id=$1",[entry.id])).code).toBe('ERP24');
      expect((await expectDbError(q,"update company_profile_versions set rule_pack_version='changed' where id=$1",[company.profileVersionId])).code).toBe('ERP24');
    });
  });

  it('ülke profilleri RLS ile diğer şirketten görünmez', async () => {
    const a = await setup(), b = await setup('KKTC');
    expect((await client(app,b.session.token,a.company.id).get('/api/company/profile')).statusCode).toBe(403);
    await asDb(handle,{userId:b.session.userId,orgId:await orgOf(app,b.session.token),companyId:b.company.id},async (q) => {
      expect((await q('select * from company_profile_versions where company_id=$1',[a.company.id])).rows).toHaveLength(0);
    });
  });
});
