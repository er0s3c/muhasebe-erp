import { describe, expect, it } from 'vitest';
import { addMember, asOwner, client, createCompany, expectDbError, makeApp, registerUser, thisYear } from './helpers';

/**
 * F10 personel: çalışan portalı (93), puantaj düzeltme talepleri (94), işe giriş/ayrılış kontrol listeleri (97).
 * Tarihler geçen yılın mart–nisan aylarıdır (ay kapatılabilir, test günden bağımsız).
 */
const Y = thisYear - 1;
const d = (month: string, n: number) => `${Y}-${month}-${String(n).padStart(2, '0')}`;

describe('çalışan portalı ve personel süreçleri (F10)', async () => {
  const { app } = await makeApp();
  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };

  it('portal yalnız bağlı personeli gösterir; düzeltme talebi onayda puantaja yazılır, kapalı ayda yazılmaz', async () => {
    const owner = await registerUser(app, 'PortalSahip');
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);
    const emp = (await ok(c.post('/api/employees', { fullName: 'Portal Çalışanı', hireDate: `${Y}-01-01` }), 201)).employee;
    const other = (await ok(c.post('/api/employees', { fullName: 'Başka Çalışan', hireDate: `${Y}-01-01` }), 201)).employee;
    const worker = await addMember(app, c, company.id, 'operator', 'Portalci');

    // Bağlanmamış kullanıcı: kayıt yok
    expect((await ok(worker.client.get('/api/me/employee'))).employee).toBeNull();
    await ok(c.put(`/api/employees/${emp.id}/user`, { userId: worker.userId }));
    expect((await c.put(`/api/employees/${other.id}/user`, { userId: worker.userId })).json().error.code).toBe('EMPLOYEE_USER_TAKEN');
    const me = await ok(worker.client.get('/api/me/employee'));
    expect(me.employee).toMatchObject({ id: emp.id, fullName: 'Portal Çalışanı' });
    expect(me.payslips).toEqual([]);
    // Başkasının bordrosuna giden parametre yok; olmayan bordro 404
    expect((await worker.client.get(`/api/me/employee/payslips/${other.id}`)).statusCode).toBe(404);

    // Çalışan kendi adına talep açar; başka personel adına açamaz
    expect((await worker.client.post('/api/me/attendance-corrections', { employeeId: other.id, workDate: d('03', 10), dayType: 'worked', normalHours: '8', reason: 'Başkası' })).json().error.code).toBe('CORRECTION_OWN_ONLY');
    const req = await ok(worker.client.post('/api/me/attendance-corrections', { workDate: d('03', 10), dayType: 'worked', normalHours: '8', overtimeHours: '2', reason: 'Mesaiye kaldım' }), 201);
    expect(req.correction).toMatchObject({ employeeId: emp.id, status: 'pending' });
    // Çalışan İK listesini göremez
    expect((await worker.client.get('/api/attendance-corrections')).statusCode).toBe(403);

    const pending = (await ok(c.get('/api/attendance-corrections?status=pending'))).corrections;
    expect(pending).toEqual([expect.objectContaining({ id: req.correction.id, employeeName: 'Portal Çalışanı', reason: 'Mesaiye kaldım' })]);
    const approved = await ok(c.post(`/api/attendance-corrections/${req.correction.id}/decision`, { decision: 'approve', note: 'Kayıtla uyumlu' }));
    expect(approved.correction).toMatchObject({ status: 'approved', decisionNote: 'Kayıtla uyumlu' });
    const sheet = await ok(c.get(`/api/attendance/month?month=${Y}-03`));
    expect(sheet.entries.find((e: any) => e.employeeId === emp.id && e.workDate === d('03', 10))).toMatchObject({ dayType: 'worked', normalHours: '8.00', overtimeHours: '2.00' });
    expect((await c.post(`/api/attendance-corrections/${req.correction.id}/decision`, { decision: 'reject' })).json().error.code).toBe('CORRECTION_DECIDED');

    // Kapalı ay: talep açılamaz; açıkken açılan talep ay kapanınca onaylanamaz, beklemede kalır
    const late = await ok(worker.client.post('/api/me/attendance-corrections', { workDate: d('04', 7), dayType: 'annual_leave', reason: 'İzinliydim' }), 201);
    await ok(c.post('/api/attendance/months/close', { month: `${Y}-04` }));
    expect((await worker.client.post('/api/me/attendance-corrections', { workDate: d('04', 8), dayType: 'annual_leave', reason: 'İzinliydim' })).json().error.code).toBe('ATTENDANCE_MONTH_CLOSED');
    expect((await c.post(`/api/attendance-corrections/${late.correction.id}/decision`, { decision: 'approve' })).json().error.code).toBe('ATTENDANCE_MONTH_CLOSED');
    expect((await ok(c.get('/api/attendance-corrections?status=pending'))).corrections.map((x: any) => x.id)).toEqual([late.correction.id]);
    const mine = await ok(worker.client.get('/api/me/employee'));
    expect(mine.closedMonths).toContain(`${Y}-04`);
    expect(mine.corrections.map((x: any) => x.status).sort()).toEqual(['approved', 'pending']);

    // Karar verilmiş talep değişmez
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update attendance_corrections set reason = 'x' where id = $1`, [req.correction.id])).code).toBe('ERP25');
    });
  });

  it('işe giriş kontrol listesi şablondan başlar, tüm maddelerle kapanır ve sonra değişmez', async () => {
    const owner = await registerUser(app, 'KontrolListesi');
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);
    const emp = (await ok(c.post('/api/employees', { fullName: 'Yeni Başlayan', hireDate: `${Y}-01-01` }), 201)).employee;

    const tpl = await ok(c.get('/api/employee-checklist-templates/onboarding'));
    expect(tpl).toMatchObject({ isDefault: true });
    expect(tpl.items.length).toBeGreaterThan(0);
    await ok(c.put('/api/employee-checklist-templates/onboarding', { items: [{ label: 'Sözleşme imzalandı' }, { label: 'Ekipman verildi' }] }));

    const started = (await ok(c.post(`/api/employees/${emp.id}/checklists`, { kind: 'onboarding' }), 201)).checklist;
    expect(started.items.map((i: any) => [i.key, i.label, i.done])).toEqual([
      ['m1', 'Sözleşme imzalandı', false],
      ['m2', 'Ekipman verildi', false],
    ]);
    expect((await c.post(`/api/employees/${emp.id}/checklists`, { kind: 'onboarding' })).json().error.code).toBe('CHECKLIST_OPEN');
    const one = (await ok(c.post(`/api/employee-checklists/${started.id}/items`, { key: 'm1', done: true }))).checklist;
    expect(one).toMatchObject({ status: 'open' });
    expect(one.items[0]).toMatchObject({ done: true, doneBy: 'KontrolListesi Kullanıcı' });
    const done = (await ok(c.post(`/api/employee-checklists/${started.id}/items`, { key: 'm2', done: true }))).checklist;
    expect(done.status).toBe('completed');
    expect((await c.post(`/api/employee-checklists/${started.id}/items`, { key: 'm2', done: false })).json().error.code).toBe('CHECKLIST_COMPLETED');
    // Tamamlanan listeden sonra yenisi başlatılabilir
    await ok(c.post(`/api/employees/${emp.id}/checklists`, { kind: 'onboarding' }), 201);
    expect((await ok(c.get(`/api/employees/${emp.id}/checklists`))).checklists).toHaveLength(2);
  });
});
