import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

/** Puantaj (Faz D2). Tarihler geçen yılın mart ayındadır: ay kapatılabilir (gelecek ay kapatılamaz) ve test günden bağımsızdır. */
const Y = thisYear - 1;
const MONTH = `${Y}-03`;
const d = (n: number, month = '03') => `${Y}-${month}-${String(n).padStart(2, '0')}`;

describe('puantaj (Faz D2)', async () => {
  const { app, handle } = await makeApp();

  type C = ReturnType<typeof client>;
  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const res = await p;
    if (res.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const mkEmp = async (body: Record<string, unknown> = {}) =>
      (await ok(c.post('/api/employees', { fullName: 'Ali Veli', hireDate: `${Y}-01-01`, ...body }), 201)).employee as { id: string; code: string };
    const mkProject = async (body: Record<string, unknown> = {}) => (await ok(c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own', ...body }), 201)).project as { id: string; code: string };
    const mkWbs = async (projectId: string, code: string, parentId?: string) =>
      ((await ok(c.post(`/api/projects/${projectId}/wbs`, { code, name: `İş ${code}`, ...(parentId ? { parentId } : {}) }), 201)).wbs as { id: string; code: string }[]).find((w) => w.code === code)!;
    const costCode = async (code = 'ISC') => ((await ok(c.get('/api/cost-codes'))).costCodes as { id: string; code: string }[]).find((x) => x.code === code) ?? (await ok(c.post('/api/cost-codes', { code, name: 'İşçilik', kind: 'labor' }), 201)).costCode;
    return { s, company, c, orgId, mkEmp, mkProject, mkWbs, costCode };
  }

  const save = (c: C, body: Record<string, unknown>) => c.put('/api/attendance/entries', body);
  const worked = (employeeId: string, date: string, hours = '8', extra: Record<string, unknown> = {}) => ({ employeeId, workDate: date, dayType: 'worked', normalHours: hours, ...extra });
  const sheet = async (c: C, month = MONTH) => (await ok(c.get(`/api/attendance/month?month=${month}`))) as { lock: { closed: boolean; reopenCount: number; reopenReason: string | null; closedBy: string | null }; employees: { id: string; code: string }[]; entries: Record<string, any>[]; missingHireDate: number };

  it('toplu kayıt: personel+tarih tekildir (ikinci kayıt günceller), değişmeyen satıra dokunulmaz, silme ve çizelge', async () => {
    const w = await world('AttToplu');
    const e = await w.mkEmp();
    const r1 = await ok(save(w.c, { entries: [worked(e.id, d(2)), worked(e.id, d(3), '7.5', { overtimeHours: '2', note: 'Beton döküm' }), { employeeId: e.id, workDate: d(4), dayType: 'annual_leave' }, { employeeId: e.id, workDate: d(5), dayType: 'weekly_rest' }] }));
    expect(r1).toEqual({ created: 4, updated: 0, deleted: 0, unchanged: 0 });
    // Aynı istek tekrar: hiçbir şey değişmez; değişen satır güncellenir; tekil anahtar korunur
    const r2 = await ok(save(w.c, { entries: [worked(e.id, d(2)), worked(e.id, d(3), '8', { overtimeHours: '1' })] }));
    expect(r2).toEqual({ created: 0, updated: 1, deleted: 0, unchanged: 1 });
    const sh = await sheet(w.c);
    expect(sh.entries).toHaveLength(4);
    // PUT tam kaydı gönderir: not verilmediği için temizlenir
    expect(sh.entries.find((x) => x.workDate === d(3))).toMatchObject({ dayType: 'worked', normalHours: '8.00', overtimeHours: '1.00', note: null });
    expect(sh.employees.map((x) => x.code)).toEqual([e.code]);
    expect(sh.lock.closed).toBe(false);
    // Silme
    const r3 = await ok(save(w.c, { clear: [{ employeeId: e.id, workDate: d(5) }, { employeeId: e.id, workDate: d(20) }] }));
    expect(r3).toMatchObject({ deleted: 1 });
    expect((await sheet(w.c)).entries).toHaveLength(3);
    // Veritabanı: aynı personel+tarih ikinci satır olarak eklenemez
    const err = await asOwner(async (q) => expectDbError(q, `insert into attendance_entries (id, company_id, employee_id, work_date, day_type, normal_hours) values (gen_random_uuid(), $1, $2, $3, 'worked', 8)`, [w.company.id, e.id, d(2)]));
    expect(err.code).toBe('23505');
    // İşe giriş öncesi ay çizelgeye girmez; kaydı olmayan ay boş döner
    expect((await sheet(w.c, `${Y - 1}-03`)).employees).toHaveLength(0);
  });

  it('şema doğrulamaları: izin gününde saat yok, çalışılan günde saat şart, 24 saat sınırı, saatsiz günde etiket yok', async () => {
    const w = await world('AttSema');
    const e = await w.mkEmp();
    const p = await w.mkProject();
    const bad = async (entry: Record<string, unknown>) => (await save(w.c, { entries: [{ employeeId: e.id, workDate: d(2), ...entry }] })).statusCode;
    expect(await bad({ dayType: 'annual_leave', normalHours: '8' })).toBe(400);
    expect(await bad({ dayType: 'absent', overtimeHours: '1' })).toBe(400);
    expect(await bad({ dayType: 'worked', normalHours: '0' })).toBe(400);
    expect(await bad({ dayType: 'worked', normalHours: '20', overtimeHours: '5' })).toBe(400);
    expect(await bad({ dayType: 'worked', normalHours: '-1' })).toBe(400);
    expect(await bad({ dayType: 'worked', normalHours: '8.555' })).toBe(400);
    expect(await bad({ dayType: 'sick_leave', projectId: p.id })).toBe(400);
    expect(await bad({ dayType: 'worked', normalHours: '8', wbsId: '0198f2c4-7b1a-7000-8000-000000000001' })).toBe(400); // iş kalemi projesiz
    expect(await bad({ dayType: 'sürpriz' })).toBe(400);
    expect((await save(w.c, {})).statusCode).toBe(400);
    expect((await save(w.c, { entries: [worked(e.id, d(2)), worked(e.id, d(2), '4')] })).statusCode).toBe(400); // aynı gün iki kez
    // Tatilde / hafta tatilinde çalışma: saatli ve geçerli
    expect((await save(w.c, { entries: [{ employeeId: e.id, workDate: d(8), dayType: 'weekly_rest', normalHours: '6' }, { employeeId: e.id, workDate: d(9), dayType: 'public_holiday', overtimeHours: '3' }] })).statusCode).toBe(200);
    // Ham SQL: aynı kurallar veritabanında da (şema atlansa bile)
    await asOwner(async (q) => {
      const ins = (type: string, n: number, o: number, tag = 'null') =>
        `insert into attendance_entries (id, company_id, employee_id, work_date, day_type, normal_hours, overtime_hours, project_id) values (gen_random_uuid(), '${w.company.id}', '${e.id}', '${d(15)}', '${type}', ${n}, ${o}, ${tag === 'null' ? 'null' : `'${tag}'`})`;
      expect((await expectDbError(q, ins('annual_leave', 8, 0))).code).toBe('23514');
      expect((await expectDbError(q, ins('worked', 0, 0))).code).toBe('23514');
      expect((await expectDbError(q, ins('worked', 20, 5))).code).toBe('23514');
      expect((await expectDbError(q, ins('absent', 0, 0, p.id))).code).toBe('23514');
      expect((await expectDbError(q, ins('uydurma', 0, 0))).code).toBe('23514');
    });
  });

  it('çalışma aralığı: işe giriş öncesi, çıkış sonrası ve işe giriş tarihsiz personele puantaj yazılamaz (API + veritabanı)', async () => {
    const w = await world('AttAralik');
    const e = await w.mkEmp({ hireDate: d(10) });
    const noHire = await w.mkEmp({ fullName: 'Tarihsiz Kişi', hireDate: null });
    const early = await save(w.c, { entries: [worked(e.id, d(9))] });
    expect(early.statusCode).toBe(422);
    expect(early.json().error.code).toBe('ATTENDANCE_OUT_OF_RANGE');
    expect((await save(w.c, { entries: [worked(noHire.id, d(9))] })).json().error.code).toBe('EMPLOYEE_HIRE_DATE_MISSING');
    expect((await sheet(w.c)).missingHireDate).toBe(1);
    await ok(save(w.c, { entries: [worked(e.id, d(10)), worked(e.id, d(20))] }));
    // Çıkış tarihi son puantajdan önce olamaz (ERP13 → HR_RULE_VIOLATION); sonra olabilir
    const bad = await w.c.post(`/api/employees/${e.id}/terminate`, { leaveDate: d(15) });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('HR_RULE_VIOLATION');
    expect(bad.json().error.message).toMatch(/puantaj kaydı var/);
    expect((await w.c.post(`/api/employees/${e.id}/terminate`, { leaveDate: d(25) })).statusCode).toBe(200);
    // Çıkış sonrası gün reddedilir; çıkış gününe kadar ve ayrılmış personel için de (aralık içinde) yazılır
    const late = await save(w.c, { entries: [worked(e.id, d(26))] });
    expect(late.json().error.code).toBe('ATTENDANCE_OUT_OF_RANGE');
    expect((await save(w.c, { entries: [worked(e.id, d(25))] })).statusCode).toBe(200);
    // Ay çizelgesi/özeti ayrılan personeli de gösterir; ayrılıştan sonraki ay göstermez
    expect((await sheet(w.c)).employees.map((x) => x.id)).toContain(e.id);
    expect((await sheet(w.c, `${Y}-04`)).employees.map((x) => x.id)).not.toContain(e.id);
    // Veritabanı korumaları (sahip rolü dahil)
    await asOwner(async (q) => {
      const ins = (date: string, emp = e.id) => `insert into attendance_entries (id, company_id, employee_id, work_date, day_type, normal_hours) values (gen_random_uuid(), '${w.company.id}', '${emp}', '${date}', 'worked', 8)`;
      expect((await expectDbError(q, ins(d(9)))).code).toBe('ERP13');
      expect((await expectDbError(q, ins(d(26)))).code).toBe('ERP13');
      expect((await expectDbError(q, ins(d(9), noHire.id))).code).toBe('ERP13');
      let err = await expectDbError(q, `update attendance_entries set work_date = '${d(12)}' where employee_id = '${e.id}' and work_date = '${d(10)}'`);
      expect(err.code).toBe('ERP13');
      err = await expectDbError(q, `update employees set leave_date = '${d(12)}' where id = '${e.id}'`);
      expect(err.code).toBe('ERP13');
    });
  });

  it('etiketler: proje + yaprak iş kalemi + maliyet kodu; yaprak olmayan, başka projenin, kapalı proje ve proje modülü kapalıyken reddedilir', async () => {
    const w = await world('AttEtiket');
    const e = await w.mkEmp();
    const p = await w.mkProject();
    const other = await w.mkProject({ name: 'Diğer Proje' });
    const parent = await w.mkWbs(p.id, '1');
    const leaf = await w.mkWbs(p.id, '1.1', parent.id);
    const otherWbs = await w.mkWbs(other.id, 'X');
    const cc = await w.costCode();
    const tagged = { projectId: p.id, wbsId: leaf.id, costCodeId: cc.id };
    expect((await save(w.c, { entries: [worked(e.id, d(2), '8', tagged)] })).statusCode).toBe(200);
    const row = (await sheet(w.c)).entries[0]!;
    expect(row).toMatchObject({ projectCode: p.code, wbsCode: '1.1', costCode: 'ISC' });

    const notLeaf = await save(w.c, { entries: [worked(e.id, d(3), '8', { projectId: p.id, wbsId: parent.id })] });
    expect(notLeaf.json().error.code).toBe('WBS_NOT_LEAF');
    const foreign = await save(w.c, { entries: [worked(e.id, d(3), '8', { projectId: p.id, wbsId: otherWbs.id })] });
    expect(foreign.json().error.code).toBe('WBS_NOT_FOUND');
    expect((await save(w.c, { entries: [worked(e.id, d(3), '8', { projectId: '0198f2c4-7b1a-7000-8000-000000000001' })] })).json().error.code).toBe('PROJECT_NOT_FOUND');

    // Etiketli iş kalemine alt iş eklenemez (kayıt sayılır); etiketli projenin kapatılması yeni etiketi engeller, eski kaydın notu düzeltilebilir
    const child = await w.c.post(`/api/projects/${p.id}/wbs`, { code: '1.1.1', name: 'Alt', parentId: leaf.id });
    expect(child.statusCode).toBe(422);
    expect(child.json().error.code).toBe('PROJECT_RULE_VIOLATION');
    await ok(w.c.post(`/api/projects/${p.id}/status`, { status: 'active' }));
    await ok(w.c.post(`/api/projects/${p.id}/status`, { status: 'completed' }));
    expect((await save(w.c, { entries: [worked(e.id, d(4), '8', { projectId: p.id })] })).json().error.code).toBe('PROJECT_CLOSED');
    expect((await save(w.c, { entries: [worked(e.id, d(2), '8', { ...tagged, note: 'Düzeltme' })] })).statusCode).toBe(200);
    // Etiketli projeye iptal (maliyet kaydı sayılır) uygulanamaz
    const second = await w.mkProject({ name: 'İkinci' });
    await ok(save(w.c, { entries: [worked(e.id, d(5), '8', { projectId: second.id })] }));
    expect((await w.c.post(`/api/projects/${second.id}/status`, { status: 'cancelled' })).statusCode).toBe(422);

    // Proje modülü kapalı bir şirkette (ticaret) etiket yazılmaz; etiketsiz puantaj sürer
    const s2 = await registerUser(app, 'AttEtiket2');
    const company2 = await createCompany(app, s2.token, { sector: 'COMMERCE' });
    const c2 = client(app, s2.token, company2.id);
    const e2 = (await ok(c2.post('/api/employees', { fullName: 'Ticaret Personeli', hireDate: `${Y}-01-01` }), 201)).employee as { id: string };
    expect((await save(c2, { entries: [worked(e2.id, d(6), '8', { projectId: p.id })] })).json().error.code).toBe('PROJECT_MODULE_DISABLED');
    expect((await save(c2, { entries: [worked(e2.id, d(6))] })).statusCode).toBe(200);
  });

  it('aylık kapanış: kapalı ayda ekleme/güncelleme/silme reddedilir, açma gerekçe ister ve denetlenir', async () => {
    const w = await world('AttKapanis');
    const e = await w.mkEmp();
    await ok(save(w.c, { entries: [worked(e.id, d(2)), worked(e.id, d(3))] }));
    // Gelecek ay kapatılamaz; geçmiş ay kapanır; ikinci kapatma 409
    expect((await w.c.post('/api/attendance/months/close', { month: `${thisYear + 1}-01` })).json().error.code).toBe('ATTENDANCE_MONTH_FUTURE');
    const closed = await ok(w.c.post('/api/attendance/months/close', { month: MONTH, note: 'Mart bordroya gitti' }));
    expect(closed.lock).toMatchObject({ closed: true, closeNote: 'Mart bordroya gitti', reopenCount: 0 });
    expect((await w.c.post('/api/attendance/months/close', { month: MONTH })).statusCode).toBe(409);
    expect((await sheet(w.c)).lock.closed).toBe(true);

    // API: kapalı ayda her yazım 422 (kullanıcıya anlaşılır kod)
    for (const body of [{ entries: [worked(e.id, d(4))] }, { entries: [worked(e.id, d(2), '6')] }, { clear: [{ employeeId: e.id, workDate: d(2) }] }]) {
      const res = await save(w.c, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('ATTENDANCE_MONTH_CLOSED');
    }
    // Başka ay etkilenmez
    expect((await save(w.c, { entries: [worked(e.id, d(2, '04'))] })).statusCode).toBe(200);

    // Veritabanı koruması (API atlansa, sahip rolüyle bile): ERP13
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId, userId: w.s.userId }, async (q) => {
      expect((await expectDbError(q, `insert into attendance_entries (id, company_id, employee_id, work_date, day_type, normal_hours) values (gen_random_uuid(), $1, $2, $3, 'worked', 8)`, [w.company.id, e.id, d(6)])).code).toBe('ERP13');
      expect((await expectDbError(q, `update attendance_entries set normal_hours = 1 where employee_id = $1 and work_date = $2`, [e.id, d(2)])).code).toBe('ERP13');
      expect((await expectDbError(q, `delete from attendance_entries where employee_id = $1 and work_date = $2`, [e.id, d(3)])).code).toBe('ERP13');
      // Kapanış kaydı silinmez; gerekçesiz açılmaz; başkası adına açılmaz
      expect((await expectDbError(q, `delete from attendance_months where month = '${MONTH}'`)).code).toMatch(/ERP13|42501/);
      expect((await expectDbError(q, `update attendance_months set status = 'open' where month = '${MONTH}'`)).code).toBe('ERP13');
      expect((await expectDbError(q, `update attendance_months set status = 'open', reopened_at = now(), reopened_by = $1, reopen_reason = 'ab', reopen_count = 1 where month = '${MONTH}'`, [w.s.userId])).code).toBe('ERP13');
      expect((await expectDbError(q, `update attendance_months set status = 'open', reopened_at = now(), reopened_by = gen_random_uuid(), reopen_reason = 'yeterli gerekçe', reopen_count = 1 where month = '${MONTH}'`)).code).toMatch(/ERP13|23503/);
    });

    // Açma: gerekçe zorunlu (şema), sonra yazılır; sayaç/gerekçe/kullanıcı kaydı tutulur; denetim izine yazılır
    expect((await w.c.post('/api/attendance/months/reopen', { month: MONTH, reason: 'x' })).statusCode).toBe(400);
    expect((await w.c.post('/api/attendance/months/reopen', { month: `${Y}-05`, reason: 'kapalı olmayan ay' })).json().error.code).toBe('ATTENDANCE_MONTH_NOT_CLOSED');
    const reopened = await ok(w.c.post('/api/attendance/months/reopen', { month: MONTH, reason: 'Eksik mesai girişi' }));
    expect(reopened.lock).toMatchObject({ closed: false, reopenCount: 1, reopenReason: 'Eksik mesai girişi', reopenedBy: w.s.email });
    expect((await save(w.c, { entries: [worked(e.id, d(4))] })).statusCode).toBe(200);
    const again = await ok(w.c.post('/api/attendance/months/close', { month: MONTH }));
    expect(again.lock).toMatchObject({ closed: true, reopenCount: 1 });
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      const rows = (await q(`select action, old_data->>'status' as old_status, new_data->>'status' as new_status, new_data->>'reopen_reason' as reason from audit_log where table_name = 'attendance_months' order by at`)).rows;
      expect(rows.map((r) => `${r.action}:${r.old_status ?? ''}>${r.new_status}`)).toEqual(['INSERT:>closed', 'UPDATE:closed>open', 'UPDATE:open>closed']);
      expect(rows[1].reason).toBe('Eksik mesai girişi');
      // Puantaj değişiklikleri de denetim izinde
      expect((await q(`select count(*)::int as n from audit_log where table_name = 'attendance_entries'`)).rows[0].n).toBeGreaterThanOrEqual(3);
    });
  });

  it('kapalı ay: sahip rolüyle ham SQL (ERP13) ve ay içindeki personel çıkışı/aktif durum etkilenmez', async () => {
    const w = await world('AttKapanisSql');
    const e = await w.mkEmp();
    await ok(save(w.c, { entries: [worked(e.id, d(2))] }));
    await asOwner(async (q) => {
      await q(`insert into attendance_months (id, company_id, month, status, closed_by) values (gen_random_uuid(), $1, $2, 'closed', $3)`, [w.company.id, MONTH, w.s.userId]);
      const ins = `insert into attendance_entries (id, company_id, employee_id, work_date, day_type, normal_hours) values (gen_random_uuid(), $1, $2, $3, 'worked', 8)`;
      let err = await expectDbError(q, ins, [w.company.id, e.id, d(7)]);
      expect(err.code).toBe('ERP13');
      expect(err.message).toMatch(/kapalı/);
      err = await expectDbError(q, `update attendance_entries set day_type = 'absent', normal_hours = 0 where employee_id = $1`, [e.id]);
      expect(err.code).toBe('ERP13');
      err = await expectDbError(q, `delete from attendance_entries where employee_id = $1`, [e.id]);
      expect(err.code).toBe('ERP13');
      // Aynı işlemde açılınca (gerekçeli) yazım serbest
      await q(`update attendance_months set status = 'open', reopened_at = now(), reopened_by = $2, reopen_reason = 'düzeltme', reopen_count = 1 where company_id = $1 and month = $3`, [w.company.id, w.s.userId, MONTH]);
      await q(ins, [w.company.id, e.id, d(7)]);
      // Kapanış kaydı sahip rolüyle de silinemez
      err = await expectDbError(q, `delete from attendance_months where company_id = $1`, [w.company.id]);
      expect(err.code).toBe('ERP13');
      // Ay biçimi
      err = await expectDbError(q, `insert into attendance_months (id, company_id, month, status, closed_by) values (gen_random_uuid(), $1, '2026-13', 'closed', $2)`, [w.company.id, w.s.userId]);
      expect(err.code).toBe('23514');
    });
  });

  it('eşzamanlılık: ayı kapatan işlem, uçuştaki puantaj yazımının bitmesini bekler; kapanıştan sonra yazım reddedilir', async () => {
    const w = await world('AttYaris');
    const e = await w.mkEmp();
    const url = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';
    const writer = new pg.Client({ connectionString: url });
    const closer = new pg.Client({ connectionString: url });
    await writer.connect();
    await closer.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`insert into attendance_entries (id, company_id, employee_id, work_date, day_type, normal_hours) values (gen_random_uuid(), $1, $2, $3, 'worked', 8)`, [w.company.id, e.id, d(2)]);
      await closer.query('BEGIN');
      let closed = false;
      const closing = closer
        .query(`insert into attendance_months (id, company_id, month, status, closed_by) values (gen_random_uuid(), $1, $2, 'closed', $3)`, [w.company.id, MONTH, w.s.userId])
        .then(() => (closed = true));
      await new Promise((r) => setTimeout(r, 400));
      expect(closed).toBe(false); // yazımın bitmesini bekliyor
      await writer.query('COMMIT');
      await closing;
      await closer.query('COMMIT');
    } finally {
      await writer.end();
      await closer.end();
    }
    expect((await sheet(w.c)).entries).toHaveLength(1); // uçuştaki yazım kapanıştan önce tamamlandı
    expect((await save(w.c, { entries: [worked(e.id, d(3))] })).json().error.code).toBe('ATTENDANCE_MONTH_CLOSED');
  });

  it('yetki: muhasebeci okur ve rapor alır, yazamaz/kapatamaz; şantiye şefi erişemez; yönetici yazar', async () => {
    const w = await world('AttYetki');
    const e = await w.mkEmp();
    await ok(save(w.c, { entries: [worked(e.id, d(2))] }));
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    expect((await acc.client.get(`/api/attendance/month?month=${MONTH}`)).statusCode).toBe(200);
    expect((await acc.client.get(`/api/attendance/reports/summary?month=${MONTH}`)).statusCode).toBe(200);
    expect((await acc.client.get(`/api/attendance/reports/labor?from=${d(1)}&to=${d(31)}`)).statusCode).toBe(200);
    expect((await acc.client.get(`/api/exports/attendance-summary?month=${MONTH}&format=xlsx`)).statusCode).toBe(200);
    expect((await save(acc.client, { entries: [worked(e.id, d(3))] })).statusCode).toBe(403);
    expect((await acc.client.post('/api/attendance/months/close', { month: MONTH })).statusCode).toBe(403);
    expect((await acc.client.post('/api/attendance/months/reopen', { month: MONTH, reason: 'deneme' })).statusCode).toBe(403);
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    expect((await sm.client.get(`/api/attendance/month?month=${MONTH}`)).statusCode).toBe(403);
    expect((await sm.client.get(`/api/attendance/reports/summary?month=${MONTH}`)).statusCode).toBe(403);
    expect((await sm.client.get(`/api/exports/attendance-summary?month=${MONTH}`)).statusCode).toBe(403);
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    expect((await viewer.client.get(`/api/attendance/month?month=${MONTH}`)).statusCode).toBe(403);
    const admin = await addMember(app, w.c, w.company.id, 'admin');
    expect((await save(admin.client, { entries: [worked(e.id, d(3))] })).statusCode).toBe(200);
    expect((await admin.client.post('/api/attendance/months/close', { month: MONTH })).statusCode).toBe(200);
    expect((await admin.client.post('/api/attendance/months/reopen', { month: MONTH, reason: 'yönetici düzeltmesi' })).statusCode).toBe(200);
  });

  it('modül kapalıysa uçlar 403 (MODULE_DISABLED); kimlik doğrulaması yok → 401', async () => {
    const w = await world('AttModul');
    // hr.core'a bağlı bordro modülü açıkken hr.core kapatılamaz: önce bordro kapatılır
    expect((await w.c.put('/api/company/modules/hr.core', { enabled: false })).statusCode).toBe(422);
    expect((await w.c.put('/api/company/modules/hr.employee_ledger', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.put('/api/company/modules/hr.socialsecurity', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.put('/api/company/modules/hr.payroll', { enabled: false })).statusCode).toBe(200);
    // Yabancı işçi takibi (D5) da hr.core'a bağlıdır
    expect((await w.c.put('/api/company/modules/hr.core', { enabled: false })).statusCode).toBe(422);
    expect((await w.c.put('/api/company/modules/hr.foreign', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.put('/api/company/modules/hr.core', { enabled: false })).statusCode).toBe(200);
    const res = await w.c.get(`/api/attendance/month?month=${MONTH}`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODULE_DISABLED');
    expect((await app.inject({ method: 'GET', url: `/api/attendance/month?month=${MONTH}` })).statusCode).toBe(401);
    expect((await w.c.get('/api/attendance/month?month=2026-13')).statusCode).toBe(403); // modül kapısı doğrulamadan önce
  });

  it('RLS: başka şirket kayıtları ve kapanışları görmez, başka şirketin personeline yazamaz', async () => {
    const a = await world('AttRlsA');
    const b = await world('AttRlsB');
    const ea = await a.mkEmp();
    await ok(save(a.c, { entries: [worked(ea.id, d(2))] }));
    await ok(a.c.post('/api/attendance/months/close', { month: MONTH }));
    // B şirketi: çizelge boş ve kapanış açık; A'nın personeline yazamaz (RLS yüzünden personel görünmez)
    const sb = await sheet(b.c);
    expect(sb.entries).toHaveLength(0);
    expect(sb.lock.closed).toBe(false);
    const cross = await save(b.c, { entries: [worked(ea.id, d(3))] });
    expect(cross.statusCode).toBe(422);
    expect(cross.json().error.code).toBe('EMPLOYEE_NOT_FOUND');
    await asDb(handle, { companyId: b.company.id, orgId: b.orgId }, async (q) => {
      expect((await q(`select count(*)::int as n from attendance_entries`)).rows[0].n).toBe(0);
      expect((await q(`select count(*)::int as n from attendance_months`)).rows[0].n).toBe(0);
      // Başka şirket adına satır yazılamaz (RLS WITH CHECK)
      expect((await expectDbError(q, `insert into attendance_entries (id, company_id, employee_id, work_date, day_type, normal_hours) values (gen_random_uuid(), $1, $2, $3, 'worked', 8)`, [a.company.id, ea.id, d(9)])).code).toMatch(/ERP13|42501/);
    });
    // B'nin kendi ayı A'nın kapanışından etkilenmez
    const eb = await b.mkEmp();
    expect((await save(b.c, { entries: [worked(eb.id, d(2))] })).statusCode).toBe(200);
  });

  it('raporlar: aylık özet (gün türü sayıları, saatler, kaydı olmayan günler) ve işçilik saatleri (proje/iş kalemi/maliyet kodu, etiketsiz, süzgeç)', async () => {
    const w = await world('AttRapor');
    const e1 = await w.mkEmp({ fullName: 'Ali Veli', hireDate: `${Y}-01-01` });
    const e2 = await w.mkEmp({ fullName: 'Veli Can', hireDate: d(20) }); // ay ortasında işe başladı: 12 gün (20..31)
    const p = await w.mkProject();
    const q2 = await w.mkProject({ name: 'İkinci Proje' });
    const w1 = await w.mkWbs(p.id, 'A');
    const w2 = await w.mkWbs(p.id, 'B');
    const cc = await w.costCode();
    await ok(
      save(w.c, {
        entries: [
          worked(e1.id, d(1), '8', { projectId: p.id, wbsId: w1.id, costCodeId: cc.id }),
          worked(e1.id, d(2), '8', { overtimeHours: '2', projectId: p.id, wbsId: w1.id, costCodeId: cc.id }),
          worked(e1.id, d(3), '7.5', { projectId: p.id, wbsId: w2.id }),
          worked(e1.id, d(4), '4', { projectId: q2.id }),
          worked(e1.id, d(5), '8'), // etiketsiz
          { employeeId: e1.id, workDate: d(6), dayType: 'weekly_rest' },
          { employeeId: e1.id, workDate: d(7), dayType: 'annual_leave' },
          { employeeId: e1.id, workDate: d(8), dayType: 'sick_leave' },
          { employeeId: e1.id, workDate: d(9), dayType: 'unpaid_leave' },
          { employeeId: e1.id, workDate: d(10), dayType: 'absent' },
          { employeeId: e1.id, workDate: d(11), dayType: 'public_holiday' },
          { employeeId: e1.id, workDate: d(12), dayType: 'public_holiday', normalHours: '6', projectId: p.id }, // tatilde çalışma
          worked(e2.id, d(20), '9', { projectId: p.id, wbsId: w1.id }),
          worked(e2.id, d(21), '9', { projectId: p.id, wbsId: w1.id }),
        ],
      }),
    );

    const sum = await ok(w.c.get(`/api/attendance/reports/summary?month=${MONTH}`));
    const r1 = sum.rows.find((r: any) => r.employeeId === e1.id);
    expect(r1.days).toEqual({ worked: 5, absent: 1, annual_leave: 1, sick_leave: 1, unpaid_leave: 1, public_holiday: 2, weekly_rest: 1 });
    expect(r1).toMatchObject({ entryDays: 12, normalHours: '41.50', overtimeHours: '2.00', missingDays: 31 - 12 });
    const r2 = sum.rows.find((r: any) => r.employeeId === e2.id);
    expect(r2).toMatchObject({ entryDays: 2, normalHours: '18.00', missingDays: 12 - 2 });
    expect(sum.totals).toMatchObject({ normalHours: '59.50', overtimeHours: '2.00', missingDays: 19 + 10 });
    expect(sum.lock.closed).toBe(false);

    const labor = await ok(w.c.get(`/api/attendance/reports/labor?from=${d(1)}&to=${d(31)}`));
    const key = (r: any) => `${r.projectCode ?? '-'}/${r.wbsCode ?? '-'}/${r.costCode ?? '-'}`;
    const got = Object.fromEntries(labor.rows.map((r: any) => [key(r), [r.personDays, r.employees, r.normalHours, r.overtimeHours]]));
    expect(got).toEqual({
      [`${p.code}/-/-`]: [1, 1, '6.00', '0.00'], // tatilde çalışma (etiketli, iş kalemsiz)
      [`${p.code}/A/ISC`]: [2, 1, '16.00', '2.00'],
      [`${p.code}/A/-`]: [2, 1, '18.00', '0.00'],
      [`${p.code}/B/-`]: [1, 1, '7.50', '0.00'],
      [`${q2.code}/-/-`]: [1, 1, '4.00', '0.00'],
      '-/-/-': [1, 1, '8.00', '0.00'],
    });
    expect(labor.totals).toEqual({ personDays: 8, normalHours: '59.50', overtimeHours: '2.00' });
    // Proje süzgeci: etiketsiz satır görünmez; tarih aralığı daralır
    const only = await ok(w.c.get(`/api/attendance/reports/labor?from=${d(1)}&to=${d(31)}&projectId=${q2.id}`));
    expect(only.rows).toHaveLength(1);
    const early = await ok(w.c.get(`/api/attendance/reports/labor?from=${d(1)}&to=${d(2)}`));
    expect(early.totals).toMatchObject({ personDays: 2, normalHours: '16.00', overtimeHours: '2.00' });
    expect((await w.c.get(`/api/attendance/reports/labor?from=${d(5)}&to=${d(1)}`)).statusCode).toBe(400);
    // Saatsiz günler işçilik raporuna girmez (izin, devamsızlık)
    expect(labor.rows.every((r: any) => Number(r.normalHours) + Number(r.overtimeHours) > 0)).toBe(true);
  });

  it('dışa aktarma: puantaj özeti ve işçilik saatleri Excel, tüm veriler "Puantaj" sayfası; kişi verisi dışa aktarma puantajı içerir; envanter tohumlanır', async () => {
    const w = await world('AttDisari');
    const e = await w.mkEmp({ fullName: 'Hasan Usta' });
    const p = await w.mkProject();
    await ok(save(w.c, { entries: [worked(e.id, d(2), '8', { projectId: p.id, note: 'Kalıp' }), { employeeId: e.id, workDate: d(3), dayType: 'sick_leave' }] }));

    const xl = await w.c.get(`/api/exports/attendance-summary?month=${MONTH}&format=xlsx`);
    expect(xl.statusCode, xl.body.slice(0, 200)).toBe(200);
    const cells = readXlsx(new Uint8Array(xl.rawPayload))[0]!.rows.flat();
    expect(cells).toEqual(expect.arrayContaining(['Hasan Usta', e.code]));
    const lab = await w.c.get(`/api/exports/attendance-labor?from=${d(1)}&to=${d(31)}&format=xlsx`);
    expect(lab.statusCode, lab.body.slice(0, 200)).toBe(200);
    expect(readXlsx(new Uint8Array(lab.rawPayload))[0]!.rows.flat().join('|')).toContain(p.code);
    expect((await w.c.get(`/api/exports/attendance-summary?month=bozuk`)).statusCode).toBe(400);

    const all = await w.c.get(`/api/exports/full-data?format=xlsx`);
    expect(all.statusCode, all.body.slice(0, 200)).toBe(200);
    const sheet = readXlsx(new Uint8Array(all.rawPayload)).find((s) => s.name === 'Puantaj')!;
    expect(sheet.rows.flat()).toEqual(expect.arrayContaining(['Hasan Usta', 'Çalıştı', 'Hastalık izni', 'Kalıp']));

    const exp = await ok(w.c.post(`/api/privacy/employees/${e.id}/export`, { reason: 'Erişim talebi' }));
    expect(exp.attendance).toHaveLength(2);
    expect(exp.attendance[0]).toMatchObject({ workDate: d(2), dayType: 'worked', normalHours: '8.00', project: p.code, note: 'Kalıp' });

    const inv = (await ok(w.c.get('/api/privacy/inventory'))).inventory as { key: string; isSensitive: boolean; verifiedAt: string | null; legalBasis: string }[];
    expect(inv.find((i) => i.key === 'attendance.entries')).toMatchObject({ isSensitive: false, verifiedAt: null });
    expect(inv.find((i) => i.key === 'attendance.leave_type')).toMatchObject({ isSensitive: true, verifiedAt: null });
    expect(inv.filter((i) => i.key.startsWith('attendance.')).every((i) => i.legalBasis.includes('doğrulanmadı'))).toBe(true);
  });

  it('büyük toplu kayıt: tam ay çizelgesi tek istekte, hata tüm işlemi geri alır', async () => {
    const w = await world('AttBuyuk');
    const emps = await Promise.all([1, 2, 3].map((i) => w.mkEmp({ fullName: `Personel ${i}` })));
    const entries = emps.flatMap((e) => Array.from({ length: 31 }, (_, i) => worked(e.id, d(i + 1))));
    expect(await ok(save(w.c, { entries }))).toEqual({ created: 93, updated: 0, deleted: 0, unchanged: 0 });
    // Bir satır kuraldışıysa (aralık dışı) hiçbiri yazılmaz
    const before = (await sheet(w.c, `${Y}-04`)).entries.length;
    const res = await save(w.c, { entries: [worked(emps[0]!.id, d(1, '04')), worked(emps[0]!.id, `${Y - 1}-04-01`)] });
    expect(res.statusCode).toBe(422);
    expect((await sheet(w.c, `${Y}-04`)).entries.length).toBe(before);
  });
});
