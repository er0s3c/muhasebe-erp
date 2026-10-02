import { todayIso } from '@erp/shared';
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, expectDbError, makeApp, orgOf, registerUser } from './helpers';

/**
 * Banka teminat mektubu portföyü (Faz X1): nazım takip. Komisyon oranları, gün sayıları ve tutarlar YALNIZCA TEST DEĞERİDİR;
 * kodda ve veritabanında varsayılan komisyon oranı ya da uyarı günü yoktur.
 */
const TODAY = todayIso();
const addDays = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const PAST = '2020-01-01';

describe('banka teminat mektubu portföyü (Faz X1)', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const party = async (n: string, kind = 'supplier') => (await c.post('/api/parties', { name: n, kind })).json().party as { id: string };
    const letter = async (body: Record<string, unknown> = {}, status = 201) => {
      const r = await c.post('/api/bank-guarantees', { direction: 'given', letterNo: 'TM-1', bankName: 'Test Bankası', counterpartyName: 'İşveren Kurumu', amount: '5000', currencyCode: 'TRY', issueDate: PAST, expiryDate: addDays(100), ...body });
      if (r.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${r.statusCode}: ${r.body}`);
      return r.json() as { guarantee: Record<string, any> };
    };
    const list = async (qs = '') => (await c.get(`/api/bank-guarantees${qs}`)).json() as { guarantees: Record<string, any>[]; warningDays: number | null; expiring: number; lapsed: number; activeTotals: any[] };
    return { s, company, c, orgId, party, letter, list };
  }

  it('kayıt: verilen/alınan mektup, cari ve proje/sözleşme bağlantısı; komisyon yalnızca kullanıcı verisi; yinelenen numara', async () => {
    const w = await world('GuaKayit');
    const sup = await w.party('XYZ Elektrik Ltd');
    const project = (await w.c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
    const other = (await w.c.post('/api/projects', { name: 'Diğer Proje', kind: 'own' })).json().project as { id: string };
    const sc = (await w.c.post('/api/subcontracts', { projectId: project.id, partyId: sup.id, title: 'Elektrik', currencyCode: 'TRY' })).json().subcontract as { id: string; code: string };
    const g = (await w.letter({ direction: 'received', letterNo: 'KTM-77', counterpartyName: undefined, partyId: sup.id, projectId: project.id, subcontractId: sc.id, purpose: 'Kesin teminat', commissionRate: '1.5', commissionAmount: '75', commissionNote: 'Yıllık', amount: '5000', currencyCode: 'GBP' })).guarantee;
    expect(g).toMatchObject({
      direction: 'received', letterNo: 'KTM-77', bankName: 'Test Bankası', counterpartyName: 'XYZ Elektrik Ltd', projectId: project.id, subcontractCode: sc.code,
      amount: '5000.0000', currencyCode: 'GBP', commissionRate: '1.5000', commissionAmount: '75.0000', status: 'active', expiryState: 'ok', daysToExpiry: 100,
    });
    // Yalnızca sözleşme verilirse proje sözleşmeden gelir; sözleşme/proje çelişirse reddedilir
    const g2 = (await w.letter({ letterNo: 'TM-2', subcontractId: sc.id })).guarantee;
    expect(g2.projectId).toBe(project.id);
    expect(((await w.letter({ letterNo: 'TM-3', subcontractId: sc.id, projectId: other.id }, 422)) as any).error.code).toBe('GUARANTEE_PROJECT_MISMATCH');
    // Süresiz mektup; komisyon verilmezse boş (kodda oran yok)
    const open = (await w.letter({ letterNo: 'TM-4', expiryDate: null })).guarantee;
    expect(open).toMatchObject({ expiryDate: null, expiryState: 'none', commissionRate: null, commissionAmount: null });
    // Doğrulamalar
    expect(((await w.letter({ letterNo: 'TM-2' }, 409)) as any).error.code).toBe('GUARANTEE_DUPLICATE');
    expect(((await w.letter({ letterNo: 'TM-5', expiryDate: '2019-01-01' }, 400)) as any).error.code).toBe('VALIDATION_ERROR');
    expect(((await w.letter({ letterNo: 'TM-6', counterpartyName: '' }, 400)) as any).error.code).toBe('VALIDATION_ERROR');
    expect(((await w.letter({ letterNo: 'TM-7', commissionRate: '101' }, 400)) as any).error.code).toBe('VALIDATION_ERROR');
    expect(((await w.letter({ letterNo: 'TM-8', amount: '0' }, 400)) as any).error.code).toBe('VALIDATION_ERROR');
    expect(((await w.letter({ letterNo: 'TM-9', currencyCode: 'XXX' }, 422)) as any).error.code).toBe('CURRENCY_NOT_FOUND');
    expect(((await w.letter({ letterNo: 'TM-10', projectId: '00000000-0000-4000-8000-000000000000' }, 422)) as any).error.code).toBe('PROJECT_NOT_FOUND');
    // Aynı numara başka bankada ya da başka yönde serbest
    await w.letter({ letterNo: 'TM-2', bankName: 'Başka Banka' });
    await w.letter({ letterNo: 'TM-2', direction: 'received' });
    // Yevmiye yazılmaz (nazım takip)
    expect((await w.c.get('/api/journal-entries')).json().entries ?? []).toHaveLength(0);
  });

  it('süre uyarısı: kullanıcı ayarı yoksa dolmak üzere üretilmez; ayarla eşik dahil dolmak üzere; süresi geçmiş kapatılmamış ayrı; withinDays süzgeci', async () => {
    const w = await world('GuaUyari');
    await w.letter({ letterNo: 'U-1', expiryDate: addDays(5) });
    await w.letter({ letterNo: 'U-2', expiryDate: addDays(30) });
    await w.letter({ letterNo: 'U-3', expiryDate: addDays(31) });
    await w.letter({ letterNo: 'U-4', expiryDate: addDays(-2), issueDate: PAST });
    await w.letter({ letterNo: 'U-5', expiryDate: null });
    // Ayar yok
    let l = await w.list();
    expect(l.warningDays).toBeNull();
    expect(l.guarantees.map((g) => [g.letterNo, g.expiryState])).toEqual([['U-4', 'lapsed'], ['U-1', 'ok'], ['U-2', 'ok'], ['U-3', 'ok'], ['U-5', 'none']]);
    expect((await w.c.get('/api/bank-guarantees/warnings')).json()).toMatchObject({ configured: false });
    expect(((await w.c.get('/api/bank-guarantees/warnings')).json().rows as any[]).map((r) => r.letterNo)).toEqual(['U-4']);
    // Ayar: 30 gün (test değeri)
    expect((await w.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: 30 })).json()).toEqual({ guaranteeWarningDays: 30 });
    l = await w.list();
    expect(l.guarantees.map((g) => [g.letterNo, g.expiryState])).toEqual([['U-4', 'lapsed'], ['U-1', 'expiring'], ['U-2', 'expiring'], ['U-3', 'ok'], ['U-5', 'none']]);
    expect([l.expiring, l.lapsed]).toEqual([2, 1]);
    const warn = (await w.c.get('/api/bank-guarantees/warnings')).json();
    expect(warn).toMatchObject({ configured: true, warningDays: 30 });
    expect(warn.rows.map((r: any) => r.letterNo)).toEqual(['U-4', 'U-1', 'U-2']);
    // withinDays süzgeci (ayardan bağımsız)
    expect((await w.list('?withinDays=7')).guarantees.map((g) => g.letterNo)).toEqual(['U-4', 'U-1']);
    // Ayar temizlenir; geçersiz değerler reddedilir
    expect((await w.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: null })).json()).toEqual({ guaranteeWarningDays: null });
    expect((await w.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: -1 })).statusCode).toBe(400);
    expect((await w.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: 1.5 })).statusCode).toBe(400);
  });

  it('sonuçlandırma: iade, nakde çevrildi, süresi doldu; sonuçlanan donar; süresi dolmamış mektup "süresi doldu" olamaz; değiştirme ve silme', async () => {
    const w = await world('GuaSonuc');
    const a = (await w.letter({ letterNo: 'S-1' })).guarantee;
    const b = (await w.letter({ letterNo: 'S-2', expiryDate: addDays(-1) })).guarantee;
    const c = (await w.letter({ letterNo: 'S-3', expiryDate: null })).guarantee;
    // Güncelleme (süre uzatma, komisyon bilgisi); değişmez alanlar şemada yok
    const upd = await w.c.patch(`/api/bank-guarantees/${a.id}`, { expiryDate: addDays(200), commissionRate: '2', commissionAmount: '100', note: 'Süre uzatıldı' });
    expect(upd.json().guarantee).toMatchObject({ expiryDate: addDays(200), commissionRate: '2.0000', commissionAmount: '100.0000', daysToExpiry: 200 });
    expect((await w.c.patch(`/api/bank-guarantees/${a.id}`, { amount: '1' })).statusCode).toBe(400);
    expect((await w.c.patch(`/api/bank-guarantees/${a.id}`, { expiryDate: '2019-01-01' })).json().error.code).toBe('GUARANTEE_DATES');
    // Süresi dolmamış mektup "süresi doldu"; süresiz mektup "süresi doldu"
    expect((await w.c.post(`/api/bank-guarantees/${a.id}/resolve`, { status: 'expired', resolvedDate: TODAY })).json().error.code).toBe('GUARANTEE_NOT_EXPIRED');
    expect((await w.c.post(`/api/bank-guarantees/${c.id}/resolve`, { status: 'expired', resolvedDate: TODAY })).json().error.code).toBe('GUARANTEE_NO_EXPIRY');
    expect((await w.c.post(`/api/bank-guarantees/${a.id}/resolve`, { status: 'returned', resolvedDate: '2019-01-01' })).json().error.code).toBe('GUARANTEE_DATES');
    const ret = (await w.c.post(`/api/bank-guarantees/${a.id}/resolve`, { status: 'returned', resolvedDate: TODAY, note: 'Banka iade aldı' })).json().guarantee;
    expect(ret).toMatchObject({ status: 'returned', resolvedDate: TODAY, resolutionNote: 'Banka iade aldı', expiryState: 'closed', daysToExpiry: null });
    const exp = (await w.c.post(`/api/bank-guarantees/${b.id}/resolve`, { status: 'expired', resolvedDate: TODAY })).json().guarantee;
    expect(exp.status).toBe('expired');
    const liq = (await w.c.post(`/api/bank-guarantees/${c.id}/resolve`, { status: 'liquidated', resolvedDate: TODAY })).json().guarantee;
    expect(liq.status).toBe('liquidated');
    // Sonuçlanan mektup değişmez/silinmez
    expect((await w.c.post(`/api/bank-guarantees/${a.id}/resolve`, { status: 'liquidated', resolvedDate: TODAY })).json().error.code).toBe('GUARANTEE_ALREADY_RESOLVED');
    expect((await w.c.patch(`/api/bank-guarantees/${a.id}`, { note: 'x' })).json().error.code).toBe('GUARANTEE_ALREADY_RESOLVED');
    expect((await w.c.delete(`/api/bank-guarantees/${a.id}`)).json().error.code).toBe('GUARANTEE_ALREADY_RESOLVED');
    // Aktif mektup silinebilir
    const d = (await w.letter({ letterNo: 'S-4' })).guarantee;
    expect((await w.c.delete(`/api/bank-guarantees/${d.id}`)).statusCode).toBe(204);
    expect((await w.c.get(`/api/bank-guarantees/${d.id}`)).statusCode).toBe(404);
    // Süzgeçler ve aktif toplamlar
    expect((await w.list('?status=returned')).guarantees).toHaveLength(1);
    expect((await w.list('?status=active')).guarantees).toHaveLength(0);
  });

  it('DB korumaları (tablo sahibiyle ham SQL): sonuçlanmış mektup değişmez/silinmez; kimlik/tutar/taraf değişmez; geçersiz durum; süresi doldu için son kullanma tarihi', async () => {
    const w = await world('GuaGuard');
    const a = (await w.letter({ letterNo: 'G-1' })).guarantee;
    const r = (await w.letter({ letterNo: 'G-2' })).guarantee;
    await w.c.post(`/api/bank-guarantees/${r.id}/resolve`, { status: 'returned', resolvedDate: TODAY });
    const open = (await w.letter({ letterNo: 'G-3', expiryDate: null })).guarantee;
    await asOwner(async (q) => {
      const err = (sql: string, params?: unknown[]) => expectDbError(q, sql, params);
      expect((await err(`update bank_guarantees set amount = 1 where id = $1`, [a.id])).code).toBe('ERP14');
      expect((await err(`update bank_guarantees set letter_no = 'X' where id = $1`, [a.id])).code).toBe('ERP14');
      expect((await err(`update bank_guarantees set issue_date = '2019-01-01' where id = $1`, [a.id])).code).toBe('ERP14');
      expect((await err(`update bank_guarantees set note = 'x' where id = $1`, [r.id])).code).toBe('ERP14');
      expect((await err(`update bank_guarantees set status = 'active', resolved_date = null where id = $1`, [r.id])).code).toBe('ERP14');
      expect((await err(`delete from bank_guarantees where id = $1`, [r.id])).code).toBe('ERP14');
      expect((await err(`update bank_guarantees set status = 'bogus' where id = $1`, [a.id])).code).toBe('23514');
      expect((await err(`update bank_guarantees set status = 'returned' where id = $1`, [a.id])).code).toBe('23514'); // sonuç tarihi yok
      expect((await err(`update bank_guarantees set status = 'expired', resolved_date = current_date where id = $1`, [open.id])).code).toBe('23514'); // süresiz
      expect((await err(`update bank_guarantees set commission_rate = 150 where id = $1`, [a.id])).code).toBe('23514');
      // Geçerli kapanış çalışır
      await q(`update bank_guarantees set status = 'liquidated', resolved_date = current_date where id = $1`, [a.id]);
      expect((await q(`select status from bank_guarantees where id = $1`, [a.id])).rows[0].status).toBe('liquidated');
    });
  });

  it('rapor ve dışa aktarma: banka/proje kırılımı, aktif toplam para birimi ayrı; xlsx uyarı notu', async () => {
    const w = await world('GuaRapor');
    await w.letter({ letterNo: 'R-1', amount: '1000', commissionAmount: '10' });
    await w.letter({ letterNo: 'R-2', amount: '2000', commissionAmount: '20' });
    await w.letter({ letterNo: 'R-3', amount: '500', currencyCode: 'GBP', bankName: 'Başka Banka', direction: 'received' });
    const rep = (await w.c.get('/api/bank-guarantees/report')).json();
    expect(rep.byBank).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'given', bankName: 'Test Bankası', currency: 'TRY', count: 2, amount: '3000.00', commission: '30.00' }),
      expect.objectContaining({ direction: 'received', bankName: 'Başka Banka', currency: 'GBP', count: 1, amount: '500.00' }),
    ]));
    const totals = (await w.list()).activeTotals;
    expect(totals).toHaveLength(2);
    await w.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: 10 });
    const res = await w.c.get('/api/exports/bank-guarantees');
    expect(res.statusCode).toBe(200);
    const sheets = readXlsx(new Uint8Array(res.rawPayload));
    expect(sheets[0]!.rows[0]![0]).toBe('Banka teminat mektupları');
    expect(String(sheets[0]!.rows[1]![0])).toContain('doğrulanmadı');
    expect(sheets[0]!.rows.some((r) => r.includes('R-1'))).toBe(true);
    expect((await w.c.get('/api/exports/bank-guarantees?format=csv')).statusCode).toBe(200);
  });

  it('yetki ve modül: muhasebeci yönetir, izleyici okur, satış/şantiye erişemez; modül kapalıyken 403; kasa/banka kapatılamaz', async () => {
    const w = await world('GuaYetki');
    const g = (await w.letter({ letterNo: 'Y-1' })).guarantee;
    const reads = ['/api/bank-guarantees', `/api/bank-guarantees/${g.id}`, '/api/bank-guarantees/settings', '/api/bank-guarantees/warnings', '/api/bank-guarantees/report', '/api/exports/bank-guarantees'];
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    for (const url of reads) expect((await acc.client.get(url)).statusCode, url).toBe(200);
    expect((await acc.client.post(`/api/bank-guarantees/${g.id}/resolve`, { status: 'returned', resolvedDate: TODAY })).statusCode).toBe(200);
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    for (const url of reads) expect((await viewer.client.get(url)).statusCode, `viewer ${url}`).toBe(200);
    expect((await viewer.client.post('/api/bank-guarantees', { direction: 'given', letterNo: 'Y-2', bankName: 'B', counterpartyName: 'K', amount: '1', currencyCode: 'TRY', issueDate: PAST })).statusCode).toBe(403);
    expect((await viewer.client.put('/api/bank-guarantees/settings', { guaranteeWarningDays: 5 })).statusCode).toBe(403);
    expect((await viewer.client.delete(`/api/bank-guarantees/${g.id}`)).statusCode).toBe(403);
    for (const role of ['sales', 'site_manager'] as const) {
      const m = await addMember(app, w.c, w.company.id, role);
      for (const url of reads) expect((await m.client.get(url)).statusCode, `${role} ${url}`).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/bank-guarantees' })).statusCode).toBe(401);
    const blocked = await w.c.put('/api/company/modules/core.treasury', { enabled: false });
    expect(blocked.json().error.code).toBe('MODULE_REQUIRED_BY');
    expect((await w.c.put('/api/company/modules/treasury.guarantees', { enabled: false })).statusCode).toBe(200);
    const off = await w.c.get('/api/bank-guarantees');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('MODULE_DISABLED');
    const nav = ((await w.c.get('/api/navigation')).json().groups as any[]).flatMap((x) => x.items.map((i: any) => i.key));
    expect(nav).not.toContain('bank-guarantees');
    expect((await w.c.put('/api/company/modules/treasury.guarantees', { enabled: true })).statusCode).toBe(200);
  });

  it('RLS: başka şirket mektup ve ayar görmez/değiştiremez; başka şirketin cari ve projesiyle mektup açılamaz; uygulama rolü sonuçlanmışı silemez', async () => {
    const a = await world('GuaRlsA');
    const b = await world('GuaRlsB');
    const sup = await a.party('Tedarikçi A');
    const project = (await a.c.post('/api/projects', { name: 'A Projesi', kind: 'own' })).json().project as { id: string };
    const g = (await a.letter({ letterNo: 'L-1', partyId: sup.id, projectId: project.id })).guarantee;
    await a.c.put('/api/bank-guarantees/settings', { guaranteeWarningDays: 15 });
    expect((await b.list()).guarantees).toHaveLength(0);
    expect((await b.c.get('/api/bank-guarantees/settings')).json()).toEqual({ guaranteeWarningDays: null });
    expect((await b.c.get(`/api/bank-guarantees/${g.id}`)).statusCode).toBe(404);
    expect((await b.c.patch(`/api/bank-guarantees/${g.id}`, { note: 'x' })).statusCode).toBe(404);
    expect((await b.c.post(`/api/bank-guarantees/${g.id}/resolve`, { status: 'returned', resolvedDate: TODAY })).statusCode).toBe(404);
    expect((await b.c.delete(`/api/bank-guarantees/${g.id}`)).statusCode).toBe(404);
    expect(((await b.letter({ letterNo: 'L-2', partyId: sup.id }, 422)) as any).error.code).toBe('PARTY_NOT_FOUND');
    expect(((await b.letter({ letterNo: 'L-3', projectId: project.id }, 422)) as any).error.code).toBe('PROJECT_NOT_FOUND');
    await asDb(handle, { companyId: b.company.id, orgId: b.orgId }, async (q) => {
      for (const t of ['bank_guarantees', 'portfolio_settings']) {
        expect((await q(`select count(*)::int as n from ${t} where company_id = $1`, [a.company.id])).rows[0].n, t).toBe(0);
      }
      expect((await q(`update bank_guarantees set note = 'x'`)).rows).toEqual([]);
      expect((await q(`select count(*)::int as n from bank_guarantees`)).rows[0].n).toBe(0);
    });
  });
});
