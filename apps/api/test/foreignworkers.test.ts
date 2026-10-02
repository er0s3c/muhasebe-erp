import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

/**
 * Yabancı işçi belge ve teminat takibi (Faz D5). Bu dosyadaki tutarlar, gün sayıları, uyruklar ve makamlar YALNIZCA TEST DEĞERİDİR;
 * kodda ve veritabanında varsayılan teminat tutarı, geçerlilik süresi, uyarı günü ya da resmî makam yoktur.
 */
const DOC_NO = 'TST-9876543';
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Nicosia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const PAST = '2020-01-01';

describe('yabancı işçi belge ve teminat takibi (Faz D5)', async () => {
  const { app, handle } = await makeApp();

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
      (await ok(c.post('/api/employees', { fullName: 'Ali Veli', nationality: 'Test-Uyruk', hireDate: PAST, ...body }), 201)).employee as { id: string; code: string };
    const types = async () => (await ok(c.get('/api/foreign-workers/doc-types'))).types as { id: string; code: string; name: string; active: boolean }[];
    const typeId = async (code = 'WORK_PERMIT') => (await types()).find((t) => t.code === code)!.id;
    const doc = async (employeeId: string, extra: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/foreign-workers/documents', { employeeId, typeId: await typeId(), documentNo: DOC_NO, issuingAuthority: 'Test Makamı', issueDate: PAST, expiryDate: addDays(TODAY, 100), ...extra }), 201)).doc as Record<string, any>;
    const param = async (key: string, value: string, extra: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/foreign-workers/params', { key, value, effectiveFrom: PAST, ...(key === 'guarantee_amount' ? { currency: 'EUR' } : {}), ...extra }), 201)).param as Record<string, any>;
    const guarantee = (employeeId: string, extra: Record<string, unknown> = {}) => c.post('/api/foreign-workers/guarantees', { employeeId, depositedDate: TODAY, depositReference: 'MKB-1', ...extra });
    const docs = async (qs = '') => (await ok(c.get(`/api/foreign-workers/documents${qs}`))) as { asOf: string; warning: any; summary: Record<string, number>; docs: Record<string, any>[] };
    return { s, company, c, orgId, mkEmp, types, typeId, doc, param, guarantee, docs };
  }

  it('belge türü: yalnızca genel adlar tohumlanır (süre/ücret/makam yok); kullanıcı ekler, pasifleştirir; silinemez; pasif tür belgeye verilemez', async () => {
    const w = await world('FwTur');
    const t = await w.types();
    expect(t.map((x) => x.code).sort()).toEqual(['HEALTH_REPORT', 'PASSPORT', 'RESIDENCE_PERMIT', 'WORK_PERMIT']);
    expect(Object.keys(t[0]!).sort()).toEqual(['active', 'code', 'companyId', 'createdAt', 'id', 'name']);
    const mine = (await ok(w.c.post('/api/foreign-workers/doc-types', { code: 'ozel-1', name: 'Özel belge' }), 201)).type;
    expect(mine.code).toBe('OZEL-1');
    expect((await w.c.post('/api/foreign-workers/doc-types', { code: 'OZEL-1', name: 'Tekrar' })).statusCode).toBe(409);
    const e = await w.mkEmp();
    await ok(w.c.patch(`/api/foreign-workers/doc-types/${mine.id}`, { active: false }));
    expect((await w.c.post('/api/foreign-workers/documents', { employeeId: e.id, typeId: mine.id })).json().error.code).toBe('FOREIGN_DOC_TYPE_INACTIVE');
    // Seed tekrar çalışınca pasif/yeniden adlandırılmış tür ezilmez
    await ok(w.c.patch(`/api/foreign-workers/doc-types/${await w.typeId('PASSPORT')}`, { name: 'Pasaport (kopya)', active: false }));
    const again = await w.types();
    expect(again.find((x) => x.code === 'PASSPORT')).toMatchObject({ name: 'Pasaport (kopya)', active: false });
    await asOwner(async (q) => {
      expect((await expectDbError(q, `delete from foreign_doc_types where id = '${mine.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_doc_types set code = 'X' where id = '${mine.id}'`)).code).toBe('ERP13');
    });
  });

  it('belge: uyruk gerekli; numara şifreli + maskeli; açık okuma gerekçe + hr.sensitive + erişim günlüğü; liste görüntüleme günlüğe yazılır', async () => {
    const w = await world('FwBelge');
    const noNat = await w.mkEmp({ nationality: undefined });
    const res = await w.c.post('/api/foreign-workers/documents', { employeeId: noNat.id, typeId: await w.typeId() });
    expect(res.json().error.code).toBe('EMPLOYEE_NATIONALITY_MISSING');
    const e = await w.mkEmp();
    const d = await w.doc(e.id);
    expect(d).toMatchObject({ hasNumber: true, numberMasked: '••••6543', status: 'valid', renewalCount: 0, employeeCode: e.code, nationality: 'Test-Uyruk' });
    expect(JSON.stringify(d)).not.toContain(DOC_NO);
    const raw = (await execAsOwner(`select number_enc, number_last4 from foreign_worker_docs where id = $1`, [d.id])).rows[0];
    expect(raw.number_enc).toMatch(/^v1\./);
    expect(raw.number_enc).not.toContain(DOC_NO);
    expect(raw.number_last4).toBe('6543');
    expect(JSON.stringify((await w.docs()).docs)).not.toContain(DOC_NO);
    expect((await w.c.post('/api/foreign-workers/documents', { employeeId: e.id, typeId: await w.typeId(), issueDate: '2030-02-01', expiryDate: '2030-01-01' })).statusCode).toBe(400);
    expect((await w.c.post('/api/foreign-workers/documents', { employeeId: '0198f2c4-7b1a-7000-8000-000000000001', typeId: await w.typeId() })).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    // Açık okuma
    expect((await w.c.post(`/api/foreign-workers/documents/${d.id}/reveal`, { reason: 'x' })).statusCode).toBe(400);
    expect(await ok(w.c.post(`/api/foreign-workers/documents/${d.id}/reveal`, { reason: 'Kayıt doğrulaması' }))).toMatchObject({ field: 'foreign_doc_no', value: DOC_NO });
    const log = (await ok(w.c.get(`/api/privacy/access-log?employeeId=${e.id}`))).log as { field: string; reason: string; by: string }[];
    expect(log.find((l) => l.field === 'foreign_doc_no')).toMatchObject({ reason: 'Kayıt doğrulaması', by: w.s.email });
    expect(log.filter((l) => l.field === 'foreign_docs').length).toBeGreaterThanOrEqual(1);
    // Belgesiz numara: açık okuma boş alan
    const bare = await w.doc(e.id, { documentNo: null });
    expect((await w.c.post(`/api/foreign-workers/documents/${bare.id}/reveal`, { reason: 'Boş alan' })).json().error.code).toBe('FIELD_EMPTY');
    // Meta düzenleme: ek belge atfı (dosya yükleme yok; metin atfı)
    const upd = await ok(w.c.patch(`/api/foreign-workers/documents/${d.id}`, { referenceNote: 'Klasör A / 12', issuingAuthority: 'Başka Makam' }));
    expect(upd.doc).toMatchObject({ referenceNote: 'Klasör A / 12', issuingAuthority: 'Başka Makam' });
    expect((await w.c.patch(`/api/foreign-workers/documents/${d.id}`, { expiryDate: '2040-01-01' })).statusCode).toBe(400); // tarih yalnızca yenileme ile
    // Yenilenmemiş belge silinebilir
    expect((await w.c.delete(`/api/foreign-workers/documents/${bare.id}`)).statusCode).toBe(204);
  });

  it('durum hesabı: parametre yokken "dolmak üzere" yok; uyarı günü tarihli ve kullanıcı girişidir; süzgeçler (durum, kalan gün, uyruk, tür, arama); enjekte gün (asOf)', async () => {
    const w = await world('FwDurum');
    const e1 = await w.mkEmp({ fullName: 'Birinci Kişi', nationality: 'Alfa' });
    const e2 = await w.mkEmp({ fullName: 'İkinci Kişi', nationality: 'Beta' });
    const e3 = await w.mkEmp({ fullName: 'Üçüncü Kişi', nationality: 'Alfa' });
    const soon = await w.doc(e1.id, { expiryDate: addDays(TODAY, 10) });
    const later = await w.doc(e2.id, { expiryDate: addDays(TODAY, 200), typeId: await w.typeId('PASSPORT') });
    const gone = await w.doc(e3.id, { expiryDate: addDays(TODAY, -1) });
    const indefinite = await w.doc(e3.id, { expiryDate: null, typeId: await w.typeId('HEALTH_REPORT') });
    // Parametre yok: dolmak üzere üretilmez
    let r = await w.docs();
    expect(r.warning).toEqual({ days: null, configured: false, verified: false });
    expect(r.summary).toEqual({ valid: 3, expiring: 0, expired: 1, revoked: 0 });
    expect(r.docs.find((d) => d.id === soon.id)).toMatchObject({ status: 'valid', daysToExpiry: 10 });
    expect(r.docs.find((d) => d.id === gone.id)).toMatchObject({ status: 'expired', daysToExpiry: -1 });
    expect(r.docs.find((d) => d.id === indefinite.id)).toMatchObject({ status: 'valid', daysToExpiry: null });
    // Sıralama: son kullanma artan, süresizler sonda
    expect(r.docs.map((d) => d.id)).toEqual([gone.id, soon.id, later.id, indefinite.id]);
    // Parametre varsayılan KAPALI: eklense bile kullanılmaz
    const p30 = await w.param('expiry_warning_days', '30');
    expect(p30).toMatchObject({ enabled: false, verifiedAt: null, currency: null });
    expect((await w.docs()).warning.configured).toBe(false);
    await ok(w.c.patch(`/api/foreign-workers/params/${p30.id}`, { enabled: true }));
    r = await w.docs();
    expect(r.warning).toEqual({ days: 30, configured: true, verified: false });
    expect(r.summary).toEqual({ valid: 2, expiring: 1, expired: 1, revoked: 0 });
    expect(r.docs.find((d) => d.id === soon.id)!.status).toBe('expiring');
    // Doğrulama; kaynak notu değişirse doğrulama sıfırlanır
    await ok(w.c.post(`/api/foreign-workers/params/${p30.id}/verify`, { note: 'Test kaynağı' }));
    expect((await w.docs()).warning.verified).toBe(true);
    await ok(w.c.patch(`/api/foreign-workers/params/${p30.id}`, { sourceNote: 'Başka kaynak' }));
    expect((await w.docs()).warning.verified).toBe(false);
    // Tarihli: gelecekte başlayan satır, asOf o güne gelmeden uygulanmaz; en yeni satır kapalıysa parametre kapalıdır
    await w.param('expiry_warning_days', '5', { effectiveFrom: addDays(TODAY, 20), enabled: true });
    expect((await w.docs()).warning.days).toBe(30);
    const future = await w.docs(`?asOf=${addDays(TODAY, 20)}`);
    expect(future.warning.days).toBe(5);
    expect(future.asOf).toBe(addDays(TODAY, 20));
    expect(future.docs.find((d) => d.id === soon.id)).toMatchObject({ status: 'expired', daysToExpiry: -10 });
    await w.param('expiry_warning_days', '99', { effectiveFrom: addDays(TODAY, 40), enabled: false });
    expect((await w.docs(`?asOf=${addDays(TODAY, 41)}`)).warning).toMatchObject({ days: null, configured: false });
    // Süzgeçler
    expect(((await w.docs('?status=expired')).docs).map((d) => d.id)).toEqual([gone.id]);
    expect(((await w.docs('?withinDays=15')).docs).map((d) => d.id)).toEqual([gone.id, soon.id]); // dolmuşlar da girer
    expect(((await w.docs('?nationality=alf')).docs).map((d) => d.employeeCode).sort()).toEqual([e1.code, e3.code, e3.code].sort());
    expect(((await w.docs(`?typeId=${await w.typeId('PASSPORT')}`)).docs).map((d) => d.id)).toEqual([later.id]);
    expect(((await w.docs('?q=ikinci')).docs).map((d) => d.id)).toEqual([later.id]);
    expect(((await w.docs(`?employeeId=${e3.id}`)).docs)).toHaveLength(2);
    expect((await w.c.get('/api/foreign-workers/documents?status=bozuk')).statusCode).toBe(400);
    // Parametre doğrulama kuralları
    expect((await w.c.post('/api/foreign-workers/params', { key: 'expiry_warning_days', value: '30', effectiveFrom: PAST })).statusCode).toBe(409);
    expect((await w.c.post('/api/foreign-workers/params', { key: 'expiry_warning_days', value: '12.5', effectiveFrom: '2019-01-01' })).statusCode).toBe(400);
    expect((await w.c.post('/api/foreign-workers/params', { key: 'sgk_orani', value: '1', effectiveFrom: PAST })).statusCode).toBe(400);
  });

  it('yenileme: önceki değerler salt-eklenir geçmişe yazılır; tarih/numara yalnızca yenilemeyle değişir; iptal gerekçe ister, geri alınmaz, iptal belge yenilenmez; geçmiş değiştirilemez', async () => {
    const w = await world('FwYenile');
    const e = await w.mkEmp();
    const d = await w.doc(e.id, { expiryDate: addDays(TODAY, 5) });
    const newExpiry = addDays(TODAY, 300);
    expect((await w.c.post(`/api/foreign-workers/documents/${d.id}/renew`, { expiryDate: addDays(TODAY, 5) })).json().error.code).toBe('RENEWAL_NO_CHANGE');
    expect((await w.c.post(`/api/foreign-workers/documents/${d.id}/renew`, { issueDate: addDays(TODAY, 9), expiryDate: addDays(TODAY, 8) })).statusCode).toBe(400);
    const r1 = (await ok(w.c.post(`/api/foreign-workers/documents/${d.id}/renew`, { issueDate: TODAY, expiryDate: newExpiry, documentNo: 'TST-1112223', note: 'Yenilendi' }))).doc;
    expect(r1).toMatchObject({ renewalCount: 1, issueDate: TODAY, expiryDate: newExpiry, numberMasked: '••••2223', status: 'valid' });
    const detail = await ok(w.c.get(`/api/foreign-workers/documents/${d.id}`));
    expect(detail.renewals).toHaveLength(1);
    expect(detail.renewals[0]).toMatchObject({ prevExpiryDate: addDays(TODAY, 5), newExpiryDate: newExpiry, prevNumberMasked: '••••6543', newNumberMasked: '••••2223', note: 'Yenilendi' });
    expect(JSON.stringify(detail)).not.toContain('TST-1112223');
    // Numara değişmeden ikinci yenileme
    const r2 = (await ok(w.c.post(`/api/foreign-workers/documents/${d.id}/renew`, { expiryDate: addDays(TODAY, 600) }))).doc;
    expect(r2).toMatchObject({ renewalCount: 2, numberMasked: '••••2223', issueDate: TODAY });
    expect((await ok(w.c.get(`/api/foreign-workers/documents/${d.id}`))).renewals).toHaveLength(2);
    // Doğrudan SQL: tarih geçmiş satırsız değişmez; geçmiş salt-eklenir; yenilenmiş belge silinmez
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update foreign_worker_docs set expiry_date = expiry_date + 1 where id = '${d.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_docs set number_last4 = '0000' where id = '${d.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_docs set renewal_count = renewal_count + 1 where id = '${d.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_docs set type_id = (select id from foreign_doc_types where code = 'PASSPORT' and company_id = '${w.company.id}') where id = '${d.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_doc_renewals set note = 'x' where doc_id = '${d.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from foreign_doc_renewals where doc_id = '${d.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from foreign_worker_docs where id = '${d.id}'`)).code).toBe('ERP13');
      // Geçmiş satırı eklenir ama belge buna uymuyorsa tarih yine değişmez
      await q(`insert into foreign_doc_renewals (id, company_id, doc_id, prev_expiry_date, new_expiry_date) values (gen_random_uuid(), '${w.company.id}', '${d.id}', '${r2.expiryDate}', '2099-01-01')`);
      expect((await expectDbError(q, `update foreign_worker_docs set expiry_date = '2098-01-01', renewal_count = renewal_count + 1 where id = '${d.id}'`)).code).toBe('ERP13');
    });
    // İptal
    expect((await w.c.post(`/api/foreign-workers/documents/${d.id}/revoke`, { reason: 'x' })).statusCode).toBe(400);
    const rv = (await ok(w.c.post(`/api/foreign-workers/documents/${d.id}/revoke`, { reason: 'İş sözleşmesi bitti' }))).doc;
    expect(rv).toMatchObject({ status: 'revoked', revokeReason: 'İş sözleşmesi bitti' });
    expect((await w.c.post(`/api/foreign-workers/documents/${d.id}/revoke`, { reason: 'Tekrar iptal' })).statusCode).toBe(409);
    expect((await w.c.post(`/api/foreign-workers/documents/${d.id}/renew`, { expiryDate: addDays(TODAY, 900) })).json().error.code).toBe('FOREIGN_DOC_REVOKED');
    expect((await w.docs()).summary.revoked).toBe(1);
    expect(((await w.docs('?withinDays=3650')).docs)).toHaveLength(0); // iptal belge süre listesine girmez
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update foreign_worker_docs set revoked_at = null, revoke_reason = null, revoked_by = null where id = '${d.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_docs set revoke_reason = 'başka' where id = '${d.id}'`)).code).toMatch(/ERP13/);
    });
    // İptal: kısa gerekçe/kullanıcısız doğrudan SQL reddedilir
    const e2 = await w.mkEmp();
    const d2 = await w.doc(e2.id);
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update foreign_worker_docs set revoked_at = now(), revoke_reason = 'ab', revoked_by = '${w.s.userId}' where id = '${d2.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_docs set revoked_at = now(), revoke_reason = 'yeterli', revoked_by = null where id = '${d2.id}'`)).code).toMatch(/ERP13|23514/);
      expect((await expectDbError(q, `insert into foreign_worker_docs (id, company_id, employee_id, type_id, number_enc) select gen_random_uuid(), company_id, employee_id, type_id, 'v1.x' from foreign_worker_docs where id = '${d2.id}'`)).code).toBe('ERP13'); // numara + son haneler
    });
  });

  it('teminat: tutar yalnızca kullanıcı parametresinden (kodda/tohumda yok); parametre yoksa/kapalıysa/tarihi gelmediyse kayıt açılmaz; tutar anlık görüntüdür; tarihli parametre seçimi', async () => {
    const w = await world('FwTeminat');
    const e = await w.mkEmp();
    // Parametre yok
    expect(((await ok(w.c.get('/api/foreign-workers/params'))).params as any[])).toHaveLength(0);
    expect((await w.guarantee(e.id)).json().error.code).toBe('GUARANTEE_PARAM_MISSING');
    // Parametre eklendi ama KAPALI
    const p1 = await w.param('guarantee_amount', '250', { effectiveFrom: '2025-01-01' });
    expect(p1).toMatchObject({ enabled: false, currency: 'EUR', verifiedAt: null });
    expect((await w.guarantee(e.id)).json().error.code).toBe('GUARANTEE_PARAM_MISSING');
    await ok(w.c.patch(`/api/foreign-workers/params/${p1.id}`, { enabled: true }));
    // İstekte tutar alanı yok sayılır: kaynak parametredir
    const g1 = (await ok(w.guarantee(e.id, { amount: '9999', currency: 'USD' }), 201)).guarantee;
    expect(g1).toMatchObject({ amount: '250.0000', currency: 'EUR', status: 'held', paramVerified: false, depositReference: 'MKB-1', employeeCode: e.code });
    // Başlangıçtan önceki tarih: parametre geçerli değil
    expect((await w.guarantee(e.id, { depositedDate: '2024-12-31' })).json().error.code).toBe('GUARANTEE_PARAM_MISSING');
    // Daha yeni tarihli satır (farklı tutar, doğrulanmış): eski kayıt değişmez, yeni kayıt yeni tutarı alır
    const p2 = await w.param('guarantee_amount', '300', { effectiveFrom: addDays(TODAY, -10), enabled: true });
    await ok(w.c.post(`/api/foreign-workers/params/${p2.id}/verify`, { note: 'Test kaynağı' }));
    const g2 = (await ok(w.guarantee(e.id), 201)).guarantee;
    expect(g2).toMatchObject({ amount: '300.0000', currency: 'EUR', paramVerified: true });
    const old = (await ok(w.guarantee(e.id, { depositedDate: addDays(TODAY, -20) }), 201)).guarantee;
    expect(old.amount).toBe('250.0000');
    const list = (await ok(w.c.get('/api/foreign-workers/guarantees'))).guarantees as any[];
    expect(list.find((g) => g.id === g1.id)!.amount).toBe('250.0000');
    // En yeni satır kapatılırsa o tarihten sonra kayıt açılmaz (eski satıra düşmez)
    await w.param('guarantee_amount', '400', { effectiveFrom: addDays(TODAY, -5), enabled: false });
    expect((await w.guarantee(e.id)).json().error.code).toBe('GUARANTEE_PARAM_MISSING');
    expect((await w.guarantee(e.id, { depositedDate: addDays(TODAY, -7) })).statusCode).toBe(201);
    // Belge bağlantısı aynı personele ait olmalı
    const other = await w.mkEmp();
    const od = await w.doc(other.id);
    expect((await w.guarantee(e.id, { docId: od.id, depositedDate: addDays(TODAY, -7) })).json().error.code).toBe('FOREIGN_DOC_MISMATCH');
    expect((await w.guarantee(other.id, { docId: od.id, depositedDate: addDays(TODAY, -7) })).statusCode).toBe(201);
    // Parametre kuralları
    expect((await w.c.post('/api/foreign-workers/params', { key: 'guarantee_amount', value: '10', effectiveFrom: '2019-01-01' })).statusCode).toBe(400); // para birimi yok
    expect((await w.c.post('/api/foreign-workers/params', { key: 'guarantee_amount', value: '0', currency: 'EUR', effectiveFrom: '2019-01-01' })).statusCode).toBe(400);
    // Kullanılmış parametre silinmez; boş olan silinir
    expect((await asOwner(async (q) => expectDbError(q, `delete from foreign_worker_params where id = '${p1.id}'`))).code).toBe('ERP13');
    const spare = await w.param('guarantee_amount', '1', { effectiveFrom: '2018-01-01' });
    expect((await w.c.delete(`/api/foreign-workers/params/${spare.id}`)).statusCode).toBe(204);
  });

  it('teminat durumu: tutuluyor → iade/irat (geri dönüşsüz); tarih kuralları; DB korumaları (tutar/parametre/değişmezlik) sahip rolde de geçerli', async () => {
    const w = await world('FwDurumT');
    const e = await w.mkEmp();
    const p = await w.param('guarantee_amount', '250', { enabled: true });
    const g = (await ok(w.guarantee(e.id, { depositedDate: addDays(TODAY, -3) }), 201)).guarantee;
    expect((await w.c.post(`/api/foreign-workers/guarantees/${g.id}/resolve`, { status: 'refunded', resolvedDate: addDays(TODAY, -4) })).json().error.code).toBe('GUARANTEE_DATES');
    expect((await w.c.post(`/api/foreign-workers/guarantees/${g.id}/resolve`, { status: 'held', resolvedDate: TODAY })).statusCode).toBe(400);
    const done = (await ok(w.c.post(`/api/foreign-workers/guarantees/${g.id}/resolve`, { status: 'refunded', resolvedDate: TODAY, note: 'Çıkışta iade' }))).guarantee;
    expect(done).toMatchObject({ status: 'refunded', resolvedDate: TODAY, resolutionNote: 'Çıkışta iade' });
    expect((await w.c.post(`/api/foreign-workers/guarantees/${g.id}/resolve`, { status: 'forfeited', resolvedDate: TODAY })).json().error.code).toBe('GUARANTEE_ALREADY_RESOLVED');
    expect((await w.c.delete(`/api/foreign-workers/guarantees/${g.id}`)).statusCode).toBe(422); // ERP13 -> HR_RULE_VIOLATION
    const h = (await ok(w.guarantee(e.id), 201)).guarantee;
    await asOwner(async (q) => {
      // Sonuçlanmış kayıt değişmez
      expect((await expectDbError(q, `update foreign_worker_guarantees set status = 'forfeited' where id = '${g.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_guarantees set resolution_note = 'x' where id = '${g.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from foreign_worker_guarantees where id = '${g.id}'`)).code).toBe('ERP13');
      // Tutulan kayıtta tutar/para birimi/tarih/personel değişmez
      expect((await expectDbError(q, `update foreign_worker_guarantees set amount = 1 where id = '${h.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_guarantees set currency = 'USD' where id = '${h.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_guarantees set deposited_date = deposited_date - 1 where id = '${h.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_guarantees set status = 'refunded' where id = '${h.id}'`)).code).toBe('ERP13'); // tarihsiz
      expect((await expectDbError(q, `update foreign_worker_guarantees set status = 'refunded', resolved_date = '2020-01-01' where id = '${h.id}'`)).code).toBe('23514'); // yatırmadan önce
      expect((await expectDbError(q, `update foreign_worker_guarantees set resolved_date = '${TODAY}' where id = '${h.id}'`)).code).toBe('ERP13'); // tutulana tarih
      // Ekleme: tutar parametreden gelmeli, parametre açık ve en yeni olmalı
      const ins = (amount: string, cur: string, param: string, status = 'held') =>
        `insert into foreign_worker_guarantees (id, company_id, employee_id, param_id, amount, currency, param_verified, deposited_date, status, resolved_date)
         values (gen_random_uuid(), '${w.company.id}', '${e.id}', '${param}', ${amount}, '${cur}', false, '${TODAY}', '${status}', ${status === 'held' ? 'null' : `'${TODAY}'`})`;
      expect((await expectDbError(q, ins('1', 'EUR', p.id))).code).toBe('ERP13');
      expect((await expectDbError(q, ins('250', 'USD', p.id))).code).toBe('ERP13');
      expect((await expectDbError(q, ins('250', 'EUR', p.id, 'refunded'))).code).toBe('ERP13');
      expect((await expectDbError(q, ins('0', 'EUR', p.id))).code).toMatch(/ERP13|23514/);
      expect((await expectDbError(q, ins('250', 'EUR', '0198f2c4-7b1a-7000-8000-000000000001'))).code).toMatch(/ERP13|23503/);
      await q(ins('250', 'EUR', p.id)); // geçerli ekleme
      // Parametre değişmezliği
      expect((await expectDbError(q, `update foreign_worker_params set value = 1 where id = '${p.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_params set currency = 'USD' where id = '${p.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update foreign_worker_params set effective_from = '2000-01-01' where id = '${p.id}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `insert into foreign_worker_params (id, company_id, key, value, effective_from) values (gen_random_uuid(), '${w.company.id}', 'guarantee_amount', 5, '2001-01-01')`)).code).toBe('23514'); // para birimi
      expect((await expectDbError(q, `insert into foreign_worker_params (id, company_id, key, value, currency, effective_from) values (gen_random_uuid(), '${w.company.id}', 'uydurma_anahtar', 5, null, '2001-01-01')`)).code).toBe('23514');
    });
    // Tutulan kayıt silinebilir (yanlış giriş)
    expect((await w.c.delete(`/api/foreign-workers/guarantees/${h.id}`)).statusCode).toBe(204);
  });

  it('tutulan teminat raporu: personel ve projeye göre, para birimi ayrı; iade/irat sayılmaz; doğrulanmamış tutar işaretlenir', async () => {
    const w = await world('FwRapor');
    const p1 = (await ok(w.c.post('/api/projects', { name: 'Proje Bir', kind: 'own' }), 201)).project as { id: string; code: string };
    const e1 = await w.mkEmp({ fullName: 'Birinci Kişi', projectId: p1.id });
    const e2 = await w.mkEmp({ fullName: 'İkinci Kişi' });
    const pe = await w.param('guarantee_amount', '250', { effectiveFrom: '2020-01-01', enabled: true });
    const pu = await w.param('guarantee_amount', '100', { effectiveFrom: addDays(TODAY, -30), enabled: true, currency: 'USD' });
    await ok(w.c.post(`/api/foreign-workers/params/${pu.id}/verify`, {}));
    const a = (await ok(w.guarantee(e1.id, { depositedDate: addDays(TODAY, -60) }), 201)).guarantee; // 250 EUR doğrulanmamış
    const b = (await ok(w.guarantee(e1.id), 201)).guarantee; // 100 USD doğrulanmış
    const c2 = (await ok(w.guarantee(e2.id, { depositedDate: addDays(TODAY, -60) }), 201)).guarantee;
    await ok(w.c.post(`/api/foreign-workers/guarantees/${c2.id}/resolve`, { status: 'forfeited', resolvedDate: TODAY }));
    expect(a.amount).toBe('250.0000');
    expect(b).toMatchObject({ amount: '100.0000', currency: 'USD', projectCode: p1.code });
    void pe;
    const rep = await ok(w.c.get('/api/foreign-workers/reports/guarantees'));
    expect(rep.byEmployee.map((r: any) => [r.employeeCode, r.currency, r.amount, r.count, r.unverified])).toEqual([
      [e1.code, 'EUR', '250.00', 1, 1],
      [e1.code, 'USD', '100.00', 1, 0],
    ]);
    expect(rep.byProject.map((r: any) => [r.projectCode, r.currency, r.amount])).toEqual([[p1.code, 'EUR', '250.00'], [p1.code, 'USD', '100.00']]);
    expect(rep.unverified).toBe(true);
    expect(rep.totals).toEqual([
      { currency: 'EUR', held: '250.00', refunded: '0.00', forfeited: '250.00' },
      { currency: 'USD', held: '100.00', refunded: '0.00', forfeited: '0.00' },
    ]);
    // Proje süzgeci ve durum/personel süzgeçleri
    expect((await ok(w.c.get(`/api/foreign-workers/reports/guarantees?projectId=${p1.id}`))).byEmployee).toHaveLength(2);
    expect(((await ok(w.c.get(`/api/foreign-workers/guarantees?employeeId=${e2.id}&status=forfeited`))).guarantees as any[])).toHaveLength(1);
    expect(((await ok(w.c.get('/api/foreign-workers/guarantees?status=held'))).guarantees as any[])).toHaveLength(2);
  });

  it('dışa aktarma: belge kaydı ve teminat xlsx/csv (numara maskeli, doğrulanmadı notu, erişim günlüğü); kişi verisi dışa aktarma açık numarayı ve teminatı içerir; envanter tohumu', async () => {
    const w = await world('FwDisari');
    const e = await w.mkEmp({ fullName: 'Hasan Usta' });
    const d = await w.doc(e.id, { expiryDate: addDays(TODAY, 10), referenceNote: 'Klasör 7' });
    const pp = await w.param('expiry_warning_days', '30', { enabled: true });
    void pp;
    await w.param('guarantee_amount', '250', { enabled: true });
    const g = (await ok(w.guarantee(e.id), 201)).guarantee;
    const x = await w.c.get('/api/exports/foreign-documents?format=xlsx');
    expect(x.statusCode, x.body.slice(0, 200)).toBe(200);
    const sheets = readXlsx(new Uint8Array(x.rawPayload));
    const cells = sheets[0]!.rows.flat().join('|');
    expect(sheets[0]!.name).toBe('Belgeler');
    expect(cells).toContain('Hasan Usta');
    expect(cells).toContain('••••6543');
    expect(cells).toContain('Dolmak üzere');
    expect(cells).toContain('doğrulanmadı');
    expect(cells).toContain('Klasör 7');
    expect(cells).not.toContain(DOC_NO);
    const csv = await w.c.get('/api/exports/foreign-documents?format=csv&status=expiring');
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('••••6543');
    expect(csv.body).not.toContain(DOC_NO);
    expect((await w.c.get('/api/exports/foreign-documents?status=yok')).statusCode).toBe(400);
    // Süzgeç dışa aktarmaya da uygulanır
    const none = await w.c.get('/api/exports/foreign-documents?format=csv&status=expired');
    expect(none.body).not.toContain('Hasan Usta');
    const gx = await w.c.get('/api/exports/foreign-guarantees?format=xlsx');
    expect(gx.statusCode, gx.body.slice(0, 200)).toBe(200);
    const gs = readXlsx(new Uint8Array(gx.rawPayload));
    expect(gs.map((s) => s.name)).toEqual(['Teminatlar', 'Tutulan teminat']);
    expect(gs[0]!.rows.flat().join('|')).toContain('MKB-1');
    expect(gs[0]!.rows.flat().join('|')).toContain('doğrulanmadı');
    expect(gs[1]!.rows.flat().join('|')).toContain('Hasan Usta');
    // Erişim günlüğü
    const log = (await ok(w.c.get(`/api/privacy/access-log?employeeId=${e.id}`))).log as { field: string; reason: string }[];
    expect(log.some((l) => l.field === 'foreign_docs')).toBe(true);
    // İlgili kişi dışa aktarma
    const exp = await ok(w.c.post(`/api/privacy/employees/${e.id}/export`, { reason: 'Erişim talebi' }));
    expect(exp.foreignWorker.documents[0]).toMatchObject({ type: 'Çalışma izni', documentNo: DOC_NO, issuingAuthority: 'Test Makamı' });
    expect(exp.foreignWorker.guarantees[0]).toMatchObject({ amount: '250.0000', currency: 'EUR', status: 'held' });
    expect(exp.foreignWorker.renewals).toEqual([]);
    // Envanter
    const inv = (await ok(w.c.get('/api/privacy/inventory'))).inventory as { key: string; isSensitive: boolean; verifiedAt: string | null; legalBasis: string; purpose: string }[];
    for (const k of ['foreign.docs', 'foreign.guarantees']) {
      const row = inv.find((i) => i.key === k)!;
      expect(row, k).toMatchObject({ verifiedAt: null });
      expect(row.legalBasis).toContain('doğrulanmadı');
      expect(row.purpose).toContain('doğrulanmadı');
    }
    expect(inv.find((i) => i.key === 'foreign.docs')!.isSensitive).toBe(true);
    void d;
    void g;
  });

  it('yetki ve modül: muhasebeci okur ama yönetemez/açık numarayı okuyamaz; şantiye şefi ve izleyici erişemez; hr.foreign hr.core\'a bağlı; kapalıyken uçlar 403', async () => {
    const w = await world('FwYetki');
    const e = await w.mkEmp();
    const d = await w.doc(e.id);
    const urls = ['/api/foreign-workers/doc-types', '/api/foreign-workers/params', '/api/foreign-workers/documents', `/api/foreign-workers/documents/${d.id}`, '/api/foreign-workers/guarantees', '/api/foreign-workers/reports/guarantees', '/api/exports/foreign-documents', '/api/exports/foreign-guarantees'];
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    for (const url of urls) expect((await acc.client.get(url)).statusCode, url).toBe(200);
    expect((await acc.client.post('/api/foreign-workers/documents', { employeeId: e.id, typeId: await w.typeId() })).statusCode).toBe(403);
    expect((await acc.client.post('/api/foreign-workers/params', { key: 'expiry_warning_days', value: '30', effectiveFrom: PAST })).statusCode).toBe(403);
    expect((await acc.client.post('/api/foreign-workers/guarantees', { employeeId: e.id, depositedDate: TODAY })).statusCode).toBe(403);
    expect((await acc.client.post(`/api/foreign-workers/documents/${d.id}/renew`, { expiryDate: addDays(TODAY, 400) })).statusCode).toBe(403);
    expect((await acc.client.post(`/api/foreign-workers/documents/${d.id}/reveal`, { reason: 'Deneme amaçlı' })).statusCode).toBe(403);
    for (const role of ['site_manager', 'viewer'] as const) {
      const m = await addMember(app, w.c, w.company.id, role);
      for (const url of urls) expect((await m.client.get(url)).statusCode, `${role} ${url}`).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/foreign-workers/documents' })).statusCode).toBe(401);
    // Bağımlılık
    expect((await w.c.put('/api/company/modules/hr.core', { enabled: false })).statusCode).toBe(422);
    expect((await w.c.put('/api/company/modules/hr.payroll', { enabled: false })).statusCode).toBe(422); // sosyal güvenlik hâlâ açık
    expect((await w.c.put('/api/company/modules/hr.foreign', { enabled: false })).statusCode).toBe(200);
    const off = await w.c.get('/api/foreign-workers/documents');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('MODULE_DISABLED');
    expect((await w.c.get('/api/exports/foreign-documents')).statusCode).toBe(403);
    const nav = (await ok(w.c.get('/api/navigation'))).groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(nav).not.toContain('foreign-workers');
    expect(nav).toContain('employees');
    expect((await w.c.put('/api/company/modules/hr.foreign', { enabled: true })).statusCode).toBe(200);
    expect(((await ok(w.c.get('/api/navigation'))).groups.flatMap((g: any) => g.items.map((i: any) => i.key)) as string[])).toEqual(expect.arrayContaining(['foreign-workers', 'foreign-settings']));
  });

  it('RLS: başka şirket tür, belge, geçmiş, parametre ve teminat görmez; başka şirket personeline kayıt yazılamaz', async () => {
    const a = await world('FwRlsA');
    const b = await world('FwRlsB');
    const e = await a.mkEmp();
    const d = await a.doc(e.id, { expiryDate: addDays(TODAY, 10) });
    await ok(a.c.post(`/api/foreign-workers/documents/${d.id}/renew`, { expiryDate: addDays(TODAY, 200) }));
    await a.param('guarantee_amount', '250', { enabled: true });
    const g = (await ok(a.guarantee(e.id), 201)).guarantee;
    expect((await ok(b.c.get('/api/foreign-workers/documents'))).docs).toHaveLength(0);
    expect((await b.c.get(`/api/foreign-workers/documents/${d.id}`)).statusCode).toBe(404);
    expect((await b.c.post(`/api/foreign-workers/documents/${d.id}/renew`, { expiryDate: addDays(TODAY, 300) })).statusCode).toBe(404);
    expect((await b.c.post(`/api/foreign-workers/documents/${d.id}/revoke`, { reason: 'Başka şirket' })).statusCode).toBe(404);
    expect((await b.c.post(`/api/foreign-workers/documents/${d.id}/reveal`, { reason: 'Başka şirket' })).statusCode).toBe(404);
    expect((await ok(b.c.get('/api/foreign-workers/params'))).params).toHaveLength(0);
    expect((await ok(b.c.get('/api/foreign-workers/guarantees'))).guarantees).toHaveLength(0);
    expect((await b.c.post(`/api/foreign-workers/guarantees/${g.id}/resolve`, { status: 'refunded', resolvedDate: TODAY })).statusCode).toBe(404);
    expect((await b.c.post('/api/foreign-workers/documents', { employeeId: e.id, typeId: await b.typeId() })).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    expect((await b.c.post('/api/foreign-workers/guarantees', { employeeId: e.id, depositedDate: TODAY })).json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    // Başka şirketin türüyle belge: bileşik FK / tür bulunamadı
    expect((await a.c.post('/api/foreign-workers/documents', { employeeId: e.id, typeId: await b.typeId() })).json().error.code).toBe('FOREIGN_DOC_TYPE_NOT_FOUND');
    await asDb(handle, { companyId: b.company.id, orgId: b.orgId }, async (q) => {
      for (const t of ['foreign_doc_types', 'foreign_worker_docs', 'foreign_doc_renewals', 'foreign_worker_params', 'foreign_worker_guarantees']) {
        expect((await q(`select count(*)::int as n from ${t} where company_id = $1`, [a.company.id])).rows[0].n, t).toBe(0);
      }
      expect((await expectDbError(q, `insert into foreign_worker_docs (id, company_id, employee_id, type_id) values (gen_random_uuid(), $1, $2, gen_random_uuid())`, [a.company.id, e.id])).code).toMatch(/42501|ERP13|23503/);
      expect((await expectDbError(q, `delete from foreign_doc_renewals`)).code).toMatch(/42501/); // uygulama rolünde silme yetkisi yok
      expect((await expectDbError(q, `delete from foreign_doc_types`)).code).toMatch(/42501/);
    });
  });
});
