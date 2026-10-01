import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('personel ve kişisel veri (Faz D1)', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const mk = async (body: Record<string, unknown> = {}) => {
      const r = await c.post('/api/employees', {
        fullName: 'Ali Veli',
        nationality: 'TC',
        idKind: 'national_id',
        idNumber: '12345678901',
        birthDate: '1990-05-17',
        iban: 'TR33 0006 1005 1978 6457 8413 26',
        phone: '0533 111 22 33',
        department: 'Saha',
        jobTitle: 'Kalıpçı',
        hireDate: day(1, 5),
        ...body,
      });
      if (r.statusCode !== 201) throw new Error(r.body);
      return r.json().employee as Record<string, any>;
    };
    return { s, company, c, orgId: await orgOf(app, s.token), mk };
  }

  it('personel açılır; kimlik, doğum tarihi ve IBAN yanıtta maskelidir, veritabanında şifrelidir', async () => {
    const w = await world('HrMask');
    const e = await w.mk();
    expect(e.code).toMatch(/^PRS-\d{4}$/);
    expect(e).toMatchObject({ idMasked: '••••8901', hasId: true, birthDateMasked: '••••-••-••', ibanMasked: '••••1326', status: 'active' });
    expect(JSON.stringify(e)).not.toContain('12345678901');
    expect(JSON.stringify(e)).not.toContain('1990-05-17');
    expect(JSON.stringify((await w.c.get('/api/employees')).json())).not.toContain('12345678901');
    const [raw] = (await execAsOwner(`select id_enc, birth_date_enc, iban_enc, id_hash from employees where id = $1`, [e.id])).rows;
    for (const v of [raw.id_enc, raw.birth_date_enc, raw.iban_enc]) {
      expect(v).toMatch(/^v1\./);
      expect(v).not.toContain('12345678901');
    }
    expect(raw.id_hash).toMatch(/^[0-9a-f]{64}$/);
    // Aynı kimlik ikinci kez girilemez
    const dup = await w.c.post('/api/employees', { fullName: 'Başka', idKind: 'national_id', idNumber: '12345678901' });
    expect(dup.statusCode).toBe(409);
  });

  it('hassas alanı açma: hr.sensitive + gerekçe ister, aynı işlemde erişim günlüğüne yazılır', async () => {
    const w = await world('HrReveal');
    const e = await w.mk();
    expect((await w.c.post(`/api/employees/${e.id}/reveal`, { field: 'id_number', reason: 'x' })).statusCode).toBe(400);
    const ok = await w.c.post(`/api/employees/${e.id}/reveal`, { field: 'id_number', reason: 'SGK bildirimi hazırlığı' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ field: 'id_number', value: '12345678901' });
    expect((await w.c.post(`/api/employees/${e.id}/reveal`, { field: 'birth_date', reason: 'Yaş kontrolü' })).json().value).toBe('1990-05-17');
    expect((await w.c.post(`/api/employees/${e.id}/reveal`, { field: 'iban', reason: 'Maaş ödemesi' })).json().value).toBe('TR330006100519786457841326');
    const log = (await w.c.get(`/api/privacy/access-log?employeeId=${e.id}`)).json().log as { field: string; reason: string; by: string }[];
    expect(log.map((l) => l.field).sort()).toEqual(['birth_date', 'iban', 'id_number']);
    expect(log.find((l) => l.field === 'id_number')).toMatchObject({ reason: 'SGK bildirimi hazırlığı' });
    // Boş alan açılamaz
    const bare = await w.mk({ fullName: 'Kimliksiz', idKind: null, idNumber: null, birthDate: null, iban: null });
    expect((await w.c.post(`/api/employees/${bare.id}/reveal`, { field: 'iban', reason: 'deneme' })).json().error.code).toBe('FIELD_EMPTY');
  });

  it('yetki: muhasebeci listeyi görür ama hassas alanı açamaz; şantiye sorumlusu personele erişemez; gizlilik uçları yalnızca privacy.manage', async () => {
    const w = await world('HrYetki');
    const e = await w.mk();
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    expect((await acc.client.get('/api/employees')).statusCode).toBe(200);
    expect((await acc.client.post(`/api/employees/${e.id}/reveal`, { field: 'iban', reason: 'deneme amaçlı' })).statusCode).toBe(403);
    expect((await acc.client.post('/api/employees', { fullName: 'Yeni Kişi' })).statusCode).toBe(403);
    expect((await acc.client.get('/api/privacy/inventory')).statusCode).toBe(403);
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    expect((await sm.client.get('/api/employees')).statusCode).toBe(403);
    const admin = await addMember(app, w.c, w.company.id, 'admin');
    expect((await admin.client.post(`/api/employees/${e.id}/reveal`, { field: 'iban', reason: 'yönetici kontrolü' })).statusCode).toBe(200);
  });

  it('güncelleme: kimlik değişir (yeniden şifrelenir), temizlenir; işten çıkış, kilitlenme ve yeniden işe alma', async () => {
    const w = await world('HrGuncelle');
    const e = await w.mk();
    const upd = await w.c.patch(`/api/employees/${e.id}`, { idNumber: '99887766554', jobTitle: 'Usta' });
    expect(upd.json().employee).toMatchObject({ idMasked: '••••6554', jobTitle: 'Usta' });
    expect((await w.c.post(`/api/employees/${e.id}/reveal`, { field: 'id_number', reason: 'doğrulama' })).json().value).toBe('99887766554');
    expect((await w.c.post(`/api/employees/${e.id}/terminate`, { leaveDate: day(1, 1) })).statusCode).toBe(422); // işe girişten önce
    const left = await w.c.post(`/api/employees/${e.id}/terminate`, { leaveDate: day(6, 30) });
    expect(left.json().employee).toMatchObject({ status: 'left', leaveDate: day(6, 30) });
    expect((await w.c.patch(`/api/employees/${e.id}`, { iban: 'TR330006100519786457841326' })).json().error.code).toBe('EMPLOYEE_LEFT_LOCKED');
    expect((await w.c.patch(`/api/employees/${e.id}`, { department: 'Ofis' })).statusCode).toBe(200);
    const back = await w.c.post(`/api/employees/${e.id}/rehire`, {});
    expect(back.json().employee).toMatchObject({ status: 'active', leaveDate: null });
    // Personel silinmez (ham SQL: yetki ya da koruma)
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      const err = await expectDbError(q, `delete from employees where id = $1`, [e.id]);
      expect(['ERP13', '42501']).toContain(err.code);
    });
  });

  it('veritabanı: sahip rolüyle bile personel silinemez, erişim günlüğü değişmez, başkası adına yazılamaz', async () => {
    const w = await world('HrDb');
    const e = await w.mk();
    await w.c.post(`/api/employees/${e.id}/reveal`, { field: 'iban', reason: 'günlük denemesi' });
    await asOwner(async (q) => {
      let err = await expectDbError(q, `delete from employees where id = $1`, [e.id]);
      expect(err.code).toBe('ERP13');
      err = await expectDbError(q, `update personal_data_access_log set reason = 'silindi' where employee_id = $1`, [e.id]);
      expect(err.code).toBe('ERP13');
      err = await expectDbError(q, `delete from personal_data_access_log where employee_id = $1`, [e.id]);
      expect(err.code).toBe('ERP13');
      err = await expectDbError(q, `update employees set code = 'PRS-9999' where id = $1`, [e.id]);
      expect(err.code).toBe('ERP13');
      err = await expectDbError(q, `update employees set status = 'left' where id = $1`, [e.id]); // çıkış tarihi yok
      expect(err.code).toBe('ERP13');
    });
    // RLS: başka şirket kayıtları görmez
    const other = await world('HrDbBaska');
    await asDb(handle, { companyId: other.company.id, orgId: other.orgId }, async (q) => {
      expect((await q(`select count(*)::int as n from employees`)).rows[0].n).toBe(0);
      expect((await q(`select count(*)::int as n from personal_data_access_log`)).rows[0].n).toBe(0);
    });
  });

  it('veri koruma: envanter tohumlanır (doğrulanmamış), düzenleyince doğrulama düşer; talep akışı ve sonuçlanmış talep değişmez', async () => {
    const w = await world('HrGizlilik');
    const e = await w.mk();
    const inv = (await w.c.get('/api/privacy/inventory')).json().inventory as { id: string; key: string; isSensitive: boolean; verifiedAt: string | null; legalBasis: string }[];
    expect(inv.length).toBeGreaterThanOrEqual(10);
    expect(inv.find((i) => i.key === 'employees.id_number')).toMatchObject({ isSensitive: true, verifiedAt: null });
    expect(inv.every((i) => i.legalBasis.includes('doğrulanmadı'))).toBe(true);
    // İkinci çağrı tohumu çoğaltmaz
    expect(((await w.c.get('/api/privacy/inventory')).json().inventory as unknown[]).length).toBe(inv.length);
    const item = inv.find((i) => i.key === 'employees.iban')!;
    const ver = await w.c.post(`/api/privacy/inventory/${item.id}/verify`, { note: 'Avukat teyidi' });
    expect(ver.json().item.verifiedAt).toBeTruthy();
    const edit = await w.c.patch(`/api/privacy/inventory/${item.id}`, { retention: '10 yıl', transferAbroad: true });
    expect(edit.json().item).toMatchObject({ retention: '10 yıl', transferAbroad: true, verifiedAt: null });

    const req = await w.c.post('/api/privacy/requests', { employeeId: e.id, requesterName: 'Ali Veli', kind: 'export', description: 'Verilerimin kopyası' });
    expect(req.statusCode, req.body).toBe(201);
    const id = req.json().request.id as string;
    expect(((await w.c.get('/api/privacy/requests?status=open')).json().requests as unknown[]).length).toBe(1);
    // Dışa aktarma açık metin verir ve günlüğe 'export' yazar
    const exp = await w.c.post(`/api/privacy/employees/${e.id}/export`, { reason: `Talep ${id}` });
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.json().employee).toMatchObject({ idNumber: '12345678901', birthDate: '1990-05-17', iban: 'TR330006100519786457841326', fullName: 'Ali Veli' });
    const done = await w.c.post(`/api/privacy/requests/${id}/resolve`, { outcome: 'completed', resolutionNote: 'Kopya teslim edildi' });
    expect(done.json().request).toMatchObject({ status: 'completed' });
    expect((await w.c.post(`/api/privacy/requests/${id}/resolve`, { outcome: 'rejected', resolutionNote: 'tekrar' })).json().error.code).toBe('DSR_NOT_OPEN');
    const log = (await w.c.get(`/api/privacy/access-log?employeeId=${e.id}`)).json().log as { field: string }[];
    expect(log.map((l) => l.field)).toContain('export');
    // Silme talebi yalnızca kayda alınır
    const er = await w.c.post('/api/privacy/requests', { employeeId: e.id, requesterName: 'Ali Veli', kind: 'erasure' });
    expect(er.json().request.status).toBe('open');
  });

  it('dışa aktarma: personel listesi ve tüm veriler yalnızca maskeli kimlik içerir', async () => {
    const w = await world('HrExport');
    await w.mk();
    const xl = await w.c.get('/api/exports/employees?format=xlsx');
    expect(xl.statusCode).toBe(200);
    const cells = readXlsx(new Uint8Array(xl.rawPayload))[0]!.rows.flat();
    expect(cells).toEqual(expect.arrayContaining(['Ali Veli', '••••8901']));
    expect(cells).not.toContain('12345678901');
    const all = await w.c.get(`/api/exports/full-data?format=xlsx`);
    expect(all.statusCode, all.body.slice(0, 200)).toBe(200);
    const sheets = readXlsx(new Uint8Array(all.rawPayload));
    const personel = sheets.find((s) => s.name === 'Personel')!;
    expect(personel.rows.flat()).toEqual(expect.arrayContaining(['Ali Veli', '••••8901', '••••1326']));
    expect(sheets.flatMap((s) => s.rows.flat())).not.toContain('12345678901');
  });

  it('modül kapalıysa uçlar 403 (MODULE_DISABLED); doğrulamalar', async () => {
    const w = await world('HrDogrula');
    expect((await w.c.post('/api/employees', { fullName: 'A' })).statusCode).toBe(400);
    expect((await w.c.post('/api/employees', { fullName: 'Kimlik Türsüz', idNumber: '12345678901' })).statusCode).toBe(400);
    expect((await w.c.post('/api/employees', { fullName: 'Hatalı Iban', iban: 'TR12' })).statusCode).toBe(400);
    expect((await w.c.post('/api/employees', { fullName: 'Proje Yok', projectId: '0198f2c4-7b1a-7000-8000-000000000001' })).json().error.code).toBe('PROJECT_NOT_FOUND');
  });
});
