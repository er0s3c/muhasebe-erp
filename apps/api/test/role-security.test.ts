import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { todayIso } from '@erp/shared';
import { addMember, asDb, client, createCompany, expectDbError, makeApp, orgOf, PASSWORD, registerUser } from './helpers';

describe('işlem izinleri, özel şirket rolleri ve güvenlik geçmişi', async () => {
  const { app, handle } = await makeApp();
  const ok = async (promise: ReturnType<ReturnType<typeof client>['get']>, status = 200) => {
    const response = await promise;
    expect(response.statusCode, response.body).toBe(status);
    return response.json();
  };
  const code = async (promise: ReturnType<ReturnType<typeof client>['get']>, status: number, error: string) => {
    const response = await promise;
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json().error.code).toBe(error);
  };
  async function world(name: string) {
    const session = await registerUser(app, name);
    const company = await createCompany(app, session.token);
    const owner = client(app, session.token, company.id);
    const sales = await addMember(app, owner, company.id, 'sales');
    const viewer = await addMember(app, owner, company.id, 'viewer');
    const orgId = await orgOf(app, session.token);
    return { session, company, owner, sales, viewer, orgId };
  }
  const roleInput = (name = 'Cari kayıt görevlisi') => ({ name, baseRole: 'sales', access: { levels: { 'core.parties': 'write' }, permissions: {}, operations: { 'operation.core.parties.create': 'deny' } } });

  it('oluştur/güncelle/sil/dışa aktar bağımsız kapılar; önizleme ile gerçek API aynı sonucu verir', async () => {
    const w = await world('CRUD');
    const target = `/api/company/members/${w.sales.userId}/module-access`;
    const party = (await ok(w.owner.post('/api/parties', { name: 'İşlem kapsamı carisi' }), 201)).party;
    const operations = { 'operation.core.parties.create': 'deny', 'operation.core.parties.delete': 'deny', 'operation.core.parties.export': 'deny' };
    const preview = await ok(w.owner.post(`${target}/preview`, { operations }));
    expect(preview.resourceOperations['operation.core.parties.create']).toBe(false);
    expect(preview.resourceOperations['operation.core.parties.update']).toBe(true);
    await ok(w.owner.put(target, { operations }));
    const importKinds = (await ok(w.sales.client.get('/api/imports/access'))).kinds;
    expect(importKinds).not.toContain('parties');
    expect(importKinds).toContain('items');
    expect((await w.sales.client.get('/api/parties')).statusCode).toBe(200);
    await code(w.sales.client.post('/api/parties', { name: 'Engelli cari' }), 403, 'RESOURCE_OPERATION_DENIED');
    await ok(w.sales.client.patch(`/api/parties/${party.id}`, { name: 'Güncellenen cari' }));
    await code(w.sales.client.delete(`/api/parties/${party.id}`), 403, 'RESOURCE_OPERATION_DENIED');
    await code(w.sales.client.get(`/api/exports/party-aging?asOf=${todayIso()}&format=csv`), 403, 'RESOURCE_OPERATION_DENIED');
    expect((await ok(w.sales.client.get('/api/exports/access'))).reports['party-aging']).toBe(false);
    await ok(w.owner.put(target, { operations: { 'operation.core.parties.update': 'deny' } }));
    await code(w.sales.client.patch(`/api/parties/${party.id}`, { name: 'Engelli güncelleme' }), 403, 'RESOURCE_OPERATION_DENIED');
    await ok(w.owner.put(target, { operations: Object.fromEntries(Object.keys({ ...operations, 'operation.core.parties.update': 'deny' }).map(key => [key, 'default'])) }));
    await ok(w.sales.client.delete(`/api/parties/${party.id}`));
    const exported = await w.sales.client.get(`/api/exports/party-aging?asOf=${todayIso()}&format=csv`);
    expect(exported.statusCode, exported.body).toBe(200);
    // İzin ver, görüntüleyicinin düzenleme veya role bağlı onay sınırını aşmaz.
    await ok(w.owner.put(`/api/company/members/${w.viewer.userId}/module-access`, { operations: { 'operation.core.parties.create': 'allow' } }));
    expect((await w.viewer.client.post('/api/parties', { name: 'Görüntüleyici' })).statusCode).toBe(403);
  });

  it('iş akışının güncelleme kapısı onay/muhasebeleştirme izinleriyle birlikte uygulanır', async () => {
    const w = await world('WorkflowOp');
    const accountant = await addMember(app, w.owner, w.company.id, 'accountant');
    const path = `/api/company/members/${accountant.userId}/module-access`;
    await ok(w.owner.put(path, { operations: { 'operation.core.invoices.update': 'deny' } }));
    await code(accountant.client.post(`/api/invoices/${randomUUID()}/post`, {}), 403, 'RESOURCE_OPERATION_DENIED');
    expect((await accountant.client.post('/api/invoices', {})).statusCode).toBe(400);
    await ok(w.owner.put(path, { operations: { 'operation.core.invoices.update': 'default' } }));
    expect((await accountant.client.post(`/api/invoices/${randomUUID()}/post`, {})).statusCode).toBe(404);
  });

  it('şirket rolü birden çok üyeye uygulanır; sürüm, rol kullanım ve kişisel istisna temizliği korunur', async () => {
    const w = await world('CompanyRole');
    let role = (await ok(w.owner.post('/api/company/roles', roleInput()), 201)).role;
    await ok(w.owner.put(`/api/company/members/${w.sales.userId}/custom-role`, { roleId: role.id }));
    await ok(w.owner.put(`/api/company/members/${w.viewer.userId}/custom-role`, { roleId: role.id }));
    await code(w.sales.client.post('/api/parties', { name: 'Rol engeli' }), 403, 'RESOURCE_OPERATION_DENIED');
    await code(w.viewer.client.post('/api/parties', { name: 'Rol engeli iki' }), 403, 'RESOURCE_OPERATION_DENIED');
    const oldVersion = role.version;
    const updated = { ...roleInput(), version: role.version, isActive: true, access: { ...roleInput().access, operations: { 'operation.core.parties.create': 'allow' } } };
    role = (await ok(w.owner.put(`/api/company/roles/${role.id}`, updated))).role;
    await ok(w.sales.client.post('/api/parties', { name: 'Rol açıldı' }), 201);
    await code(w.owner.put(`/api/company/roles/${role.id}`, { ...updated, version: oldVersion }), 409, 'ROLE_VERSION_CONFLICT');
    await code(w.owner.put(`/api/company/roles/${role.id}`, { ...updated, version: role.version, isActive: false }), 409, 'ROLE_IN_USE');
    const memberAccess = `/api/company/members/${w.sales.userId}/module-access`;
    await ok(w.owner.put(memberAccess, { operations: { 'operation.core.parties.update': 'deny' } }));
    await ok(w.owner.put(`/api/company/members/${w.sales.userId}/custom-role`, { roleId: role.id }));
    expect((await ok(w.owner.get(memberAccess))).areas.find((a: any) => a.key === 'core.parties').resourceOperations.find((p: any) => p.key.endsWith('.update')).override).toBeNull();
    await ok(w.owner.patch(`/api/company/members/${w.sales.userId}`, { role: 'sales' }));
    expect((await ok(w.owner.get('/api/company/members'))).members.find((m: any) => m.userId === w.sales.userId).customRoleId).toBeNull();
    await code(w.owner.put(`/api/company/members/${w.session.userId}/custom-role`, { roleId: role.id }), 403, 'MODULE_ACCESS_SELF');
    expect((await w.sales.client.post('/api/company/roles', roleInput())).statusCode).toBe(403);
  });

  it('kısıtlı yönetici hazır/özel rol veya varsayılana dönüşle kendi işlem sınırını aşamaz', async () => {
    const w = await world('GrantOps');
    const admin = await addMember(app, w.owner, w.company.id, 'admin');
    await ok(w.owner.put(`/api/company/members/${admin.userId}/module-access`, { operations: { 'operation.core.parties.create': 'deny' } }));
    await code(admin.client.post('/api/company/roles', { name: 'Sınırı aşan rol', baseRole: 'sales', access: {} }), 403, 'MODULE_ACCESS_EXCEEDS_OWN');
    const role = (await ok(admin.client.post('/api/company/roles', roleInput()), 201)).role;
    await ok(admin.client.put(`/api/company/members/${w.viewer.userId}/custom-role`, { roleId: role.id }));
    await code(admin.client.put(`/api/company/members/${w.viewer.userId}/custom-role`, { roleId: null }), 403, 'MODULE_ACCESS_EXCEEDS_OWN');
    await code(admin.client.patch(`/api/company/members/${w.viewer.userId}`, { role: 'sales' }), 403, 'MODULE_ACCESS_EXCEEDS_OWN');
    await code(admin.client.put(`/api/company/members/${w.viewer.userId}/module-access`, { operations: { 'operation.core.parties.create': 'allow' } }), 403, 'MODULE_ACCESS_EXCEEDS_OWN');
    await code(admin.client.put(`/api/company/roles/${role.id}`, { ...roleInput(), access: {}, isActive: true, version: role.version }), 403, 'MODULE_ACCESS_EXCEEDS_OWN');
  });

  it('şube sınırı rol/izin atamalarıyla genişletilemez; yeni üye sınırlı yöneticinin kapsamını alır', async () => {
    const w = await world('BranchRole');
    const a = (await ok(w.owner.post('/api/company/branches', { code: 'A', name: 'Birinci şube' }), 201)).branch;
    const b = (await ok(w.owner.post('/api/company/branches', { code: 'B', name: 'İkinci şube' }), 201)).branch;
    const admin = await addMember(app, w.owner, w.company.id, 'admin');
    await ok(w.owner.put(`/api/company/members/${admin.userId}/branches`, { mode: 'restricted', branchIds: [a.id], allowUnassigned: false }));
    const role = (await ok(w.owner.post('/api/company/roles', roleInput()), 201)).role;
    await code(admin.client.post('/api/company/roles', roleInput('Sınırlı rol')), 403, 'BRANCH_ADMIN_SCOPE_REQUIRED');
    await code(admin.client.put(`/api/company/members/${w.viewer.userId}/custom-role`, { roleId: role.id }), 403, 'BRANCH_ACCESS_EXCEEDS_OWN');
    await code(admin.client.put(`/api/company/members/${w.viewer.userId}/module-access`, { levels: { 'core.parties': 'write' } }), 403, 'BRANCH_ACCESS_EXCEEDS_OWN');
    await code(admin.client.patch(`/api/company/members/${w.viewer.userId}`, { role: 'sales' }), 403, 'BRANCH_ACCESS_EXCEEDS_OWN');
    const newId = (await ok(admin.client.post('/api/company/members', { email: `branch-${randomUUID()}@example.com`, fullName: 'Şube üyesi', role: 'viewer', password: PASSWORD, mustChangePassword: false }), 201)).member.userId;
    const scope = (await ok(w.owner.get(`/api/company/members/${newId}/branches`))).scope;
    expect(scope).toMatchObject({ mode: 'restricted', branchIds: [a.id], allowUnassigned: false });
    await ok(admin.client.put(`/api/company/members/${newId}/custom-role`, { roleId: role.id }));
    expect((await ok(w.owner.get(`/api/company/members/${newId}/branches`))).scope.branchIds).not.toContain(b.id);
  });

  it('dışa aktarma geçmişi yalnız başarılı hazırlığı kaydeder; kullanıcı/şirket kapsamı ve append-only güvenliği korunur', async () => {
    const w = await world('ExportAudit');
    expect((await w.sales.client.get(`/api/exports/party-aging?asOf=${todayIso()}&format=csv`)).statusCode).toBe(200);
    await ok(w.owner.put(`/api/company/members/${w.viewer.userId}/module-access`, { operations: { 'operation.core.parties.export': 'deny' } }));
    expect((await w.viewer.client.get(`/api/exports/party-aging?asOf=${todayIso()}&format=csv`)).statusCode).toBe(403);
    const ownEvents = (await ok(w.sales.client.get('/api/company/export-events'))).events;
    expect(ownEvents).toHaveLength(1);
    expect(ownEvents[0]).toMatchObject({ reportKey: 'party-aging', format: 'csv', rowCount: 0, userId: w.sales.userId });
    expect((await ok(w.viewer.client.get('/api/company/export-events'))).events).toHaveLength(0);
    expect((await ok(w.owner.get('/api/company/export-events'))).events).toHaveLength(1);
    const other = await createCompany(app, w.session.token);
    expect((await ok(client(app, w.session.token, other.id).get('/api/company/export-events'))).events).toHaveLength(0);
    await asDb(handle, { userId: w.session.userId, orgId: w.orgId, companyId: w.company.id }, async q => {
      expect((await expectDbError(q, 'update export_events set row_count=99 where id=$1', [ownEvents[0].id])).code).toBeDefined();
      expect((await expectDbError(q, 'delete from export_events where id=$1', [ownEvents[0].id])).code).toBeDefined();
    });
  });

  it('şirket rolü kimliği diğer şirketten atanamaz; ham üyelik/rol tabloları RLS ve atama guardıyla korunur', async () => {
    const w = await world('RoleRLS');
    const role = (await ok(w.owner.post('/api/company/roles', roleInput()), 201)).role;
    const other = await createCompany(app, w.session.token);
    const otherOwner = client(app, w.session.token, other.id);
    const otherMember = await addMember(app, otherOwner, other.id, 'viewer');
    await code(otherOwner.put(`/api/company/members/${otherMember.userId}/custom-role`, { roleId: role.id }), 404, 'NOT_FOUND');
    await asDb(handle, { userId: w.viewer.userId, orgId: w.orgId, companyId: w.company.id }, async q => {
      expect((await expectDbError(q, 'update company_roles set name=$1 where id=$2', ['Yetkisiz', role.id])).code).toBeDefined();
    });
    await asDb(handle, { userId: w.session.userId, orgId: w.orgId, companyId: other.id }, async q => {
      expect((await q('select id from company_roles where id=$1', [role.id])).rows).toHaveLength(0);
      expect((await expectDbError(q, 'update memberships set custom_role_id=$1 where company_id=$2 and user_id=$3', [role.id, other.id, otherMember.userId])).code).toBeDefined();
    });
  });

  it('kendi oturumları listelenir; başkasının oturumu sızmaz/iptal edilemez; iptal edilen erişim belirteci hemen biter', async () => {
    const first = await registerUser(app, 'Sessions');
    const a = client(app, first.token);
    const secondResponse = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: first.email, password: PASSWORD } });
    expect(secondResponse.statusCode).toBe(200);
    const second = client(app, secondResponse.json().accessToken);
    const foreign = await registerUser(app, 'OtherSession');
    const foreignId = (await ok(client(app, foreign.token).get('/api/auth/sessions'))).sessions[0].id;
    const rows = (await ok(a.get('/api/auth/sessions'))).sessions;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r: any) => r.current)).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/tokenHash|token_hash|password|secret/i);
    await code(a.delete(`/api/auth/sessions/${foreignId}`), 404, 'NOT_FOUND');
    expect((await client(app, foreign.token).get('/api/auth/sessions')).statusCode).toBe(200);
    await ok(a.post('/api/auth/sessions/revoke-others'));
    expect((await second.get('/api/auth/sessions')).statusCode).toBe(401);
    expect((await ok(a.get('/api/auth/sessions'))).sessions).toHaveLength(1);
    const third = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: first.email, password: PASSWORD } });
    const thirdClient = client(app, third.json().accessToken);
    const thirdId = (await ok(thirdClient.get('/api/auth/sessions'))).sessions.find((r: any) => r.current).id;
    await ok(a.delete(`/api/auth/sessions/${thirdId}`));
    expect((await thirdClient.get('/api/auth/sessions')).statusCode).toBe(401);
  });
});
