import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { effectivePermissions, type Role } from '@erp/shared';
import { withContext } from '../src/db/client';
import { cancelRequest, decide, requestApproval, registerApprovalHandler } from '../src/modules/approvals/service';
import { resolveParam } from '../src/modules/subcontracts/params';
import { addMember, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('inşaat parametreleri ve onay motoru (B2a)', async () => {
  const { app, handle } = await makeApp();
  // Gerçek hakediş işleyicisi yerine etkisiz işleyici: bu testler yalnızca motoru sınar (uydurma belge kimlikleri)
  registerApprovalHandler('progress_payment', { onResolved: async () => undefined });

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const me = app.jwt.decode<{ sub: string }>(s.token)!.sub;
    const ctxFor = (userId: string, role: Role) => ({ companyId: company.id, userId, role, permissions: effectivePermissions(role) });
    const run = <T>(userId: string, fn: Parameters<typeof withContext<T>>[2]) => withContext(handle.db, { userId, orgId, companyId: company.id }, fn);
    return { s, company, c, orgId, me, ctxFor, run };
  }

  it('parametre: tarihli geçerlilik, doğrulama alanı, yetki ve modül kapısı', async () => {
    const x = await setup('ParamSahip');
    const created = await x.c.post('/api/construction-params', { kind: 'retention_pct', value: '5', validFrom: day(1, 1), sourceNote: 'sözleşme şartı' });
    expect(created.statusCode).toBe(201);
    expect(created.json().param.verifiedAt).toBeNull();
    await x.c.post('/api/construction-params', { kind: 'retention_pct', value: '10', validFrom: day(7, 1) });
    expect((await x.c.post('/api/construction-params', { kind: 'retention_pct', value: '10', validFrom: day(7, 1) })).statusCode).toBe(409);
    expect((await x.c.post('/api/construction-params', { kind: 'bogus', value: '5', validFrom: day(1, 1) })).statusCode).toBe(400);
    expect((await x.c.post('/api/construction-params', { kind: 'retention_pct', value: '101', validFrom: day(1, 2) })).statusCode).toBe(400);

    const before = await x.run(x.me, (tx) => resolveParam(tx, 'retention_pct', day(3, 1)));
    const after = await x.run(x.me, (tx) => resolveParam(tx, 'retention_pct', day(8, 1)));
    expect(Number(before!.value)).toBe(5);
    expect(Number(after!.value)).toBe(10);
    expect(before!.verified).toBe(false);
    expect(await x.run(x.me, (tx) => resolveParam(tx, 'withholding_pct', day(3, 1)))).toBeNull();

    const v = await x.c.post(`/api/construction-params/${created.json().param.id}/verify`, { verifiedBy: 'Mali müşavir A.' });
    expect(v.json().param.verifiedAt).not.toBeNull();

    const sm = await addMember(app, x.c, x.company.id, 'site_manager');
    expect((await sm.client.get('/api/construction-params')).statusCode).toBe(200);
    expect((await sm.client.post('/api/construction-params', { kind: 'withholding_pct', value: '1', validFrom: day(1, 1) })).statusCode).toBe(403);

    const market = await registerUser(app, 'ParamMarket');
    const mc = await createCompany(app, market.token, { sector: 'RETAIL_MARKET' });
    const res = await client(app, market.token, mc.id).get('/api/construction-params');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODULE_DISABLED');
  });

  it('kural yokken varsayılan tek adım: onay izni olan onaylar, gönderen de olabilir', async () => {
    const x = await setup('Varsayilan');
    const docId = randomUUID();
    const req = await x.run(x.me, (tx) => requestApproval(tx, x.ctxFor(x.me, 'owner'), { docType: 'progress_payment', docId, projectId: null, amount: '1000.00' }));
    expect(req.steps).toHaveLength(1);
    expect(req.separateRequester).toBe(false);
    const done = await x.run(x.me, (tx) => decide(tx, x.ctxFor(x.me, 'owner'), req.id, { decision: 'approve' }));
    expect(done.status).toBe('approved');
    expect(done.steps[0]!.status).toBe('approved');
  });

  it('tutar kademeli kural: sıralı adımlar, yanlış rol reddi, kendi belgesini onaylama engeli', async () => {
    const x = await setup('Kademe');
    const sm = await addMember(app, x.c, x.company.id, 'site_manager');
    const acc = await addMember(app, x.c, x.company.id, 'accountant');
    // 0–10.000: tek adım muhasebeci; ≥10.000: önce şantiye sorumlusu, sonra muhasebeci; gönderen kendi belgesini onaylayamaz
    const low = await x.c.post('/api/approval-rules', { docType: 'progress_payment', minAmount: '0', maxAmount: '10000', steps: [{ role: 'accountant' }], separateRequester: true });
    expect(low.statusCode).toBe(201);
    const high = await x.c.post('/api/approval-rules', { docType: 'progress_payment', minAmount: '10000', steps: [{ role: 'site_manager', label: 'Şantiye' }, { role: 'accountant', label: 'Finans' }], separateRequester: true });
    expect(high.statusCode).toBe(201);
    expect((await x.c.post('/api/approval-rules', { docType: 'progress_payment', steps: [{ role: 'admin', userId: randomUUID() }] })).statusCode).toBe(400);

    const big = await x.run(x.me, (tx) => requestApproval(tx, x.ctxFor(x.me, 'owner'), { docType: 'progress_payment', docId: randomUUID(), projectId: null, amount: '25000.00' }));
    expect(big.steps.map((s) => s.approverRole)).toEqual(['site_manager', 'accountant']);
    const small = await x.run(x.me, (tx) => requestApproval(tx, x.ctxFor(x.me, 'owner'), { docType: 'progress_payment', docId: randomUUID(), projectId: null, amount: '9999.99' }));
    expect(small.steps.map((s) => s.approverRole)).toEqual(['accountant']);

    // Sıra: muhasebeci ilk adımda yetkisiz; gönderen (owner) rolü eşleşmediği için de olamaz
    await expect(x.run(acc.userId, (tx) => decide(tx, x.ctxFor(acc.userId, 'accountant'), big.id, { decision: 'approve' }))).rejects.toMatchObject({ status: 403 });
    const afterFirst = await x.run(sm.userId, (tx) => decide(tx, x.ctxFor(sm.userId, 'site_manager'), big.id, { decision: 'approve', note: 'metraj doğru' }));
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.steps.map((s) => s.status)).toEqual(['approved', 'pending']);
    const inbox = await acc.client.get('/api/approvals/inbox');
    expect((inbox.json().requests as { id: string }[]).map((r) => r.id)).toContain(big.id);
    const final = await acc.client.post(`/api/approvals/${big.id}/decide`, { decision: 'approve' });
    expect(final.json().request.status).toBe('approved');
    expect((await acc.client.post(`/api/approvals/${big.id}/decide`, { decision: 'approve' })).statusCode).toBe(422);

    // Gönderen = onaylayıcı: kendi belgesi engellenir
    const own = await x.run(acc.userId, (tx) => requestApproval(tx, x.ctxFor(acc.userId, 'accountant'), { docType: 'progress_payment', docId: randomUUID(), projectId: null, amount: '100.00' }));
    await expect(x.run(acc.userId, (tx) => decide(tx, x.ctxFor(acc.userId, 'accountant'), own.id, { decision: 'approve' }))).rejects.toMatchObject({ code: 'APPROVAL_SELF_DECISION' });
  });

  it('ret talebi sonlandırır, işleyici aynı işlemde çalışır; talep ve adım koruması veritabanında', async () => {
    const x = await setup('RetKoruma');
    const seen: string[] = [];
    registerApprovalHandler('progress_payment', { onResolved: async (_tx, _ctx, r, outcome) => void seen.push(`${r.docId}:${outcome}`) });
    const docId = randomUUID();
    const req = await x.run(x.me, (tx) => requestApproval(tx, x.ctxFor(x.me, 'owner'), { docType: 'progress_payment', docId, projectId: null, amount: '50.00' }));
    await expect(x.run(x.me, (tx) => requestApproval(tx, x.ctxFor(x.me, 'owner'), { docType: 'progress_payment', docId, projectId: null, amount: '50.00' }))).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_PENDING' });
    const rejected = await x.run(x.me, (tx) => decide(tx, x.ctxFor(x.me, 'owner'), req.id, { decision: 'reject', note: 'metraj hatalı' }));
    expect(rejected.status).toBe('rejected');
    expect(seen).toEqual([`${docId}:rejected`]);
    // Reddedilen belge yeniden gönderilebilir
    const again = await x.run(x.me, (tx) => requestApproval(tx, x.ctxFor(x.me, 'owner'), { docType: 'progress_payment', docId, projectId: null, amount: '50.00' }));
    const cancelled = await x.run(x.me, (tx) => cancelRequest(tx, x.ctxFor(x.me, 'owner'), again.id));
    expect(cancelled.status).toBe('cancelled');

    await asDb(handle, { userId: x.me, companyId: x.company.id, orgId: x.orgId }, async (q) => {
      expect((await q('select id from approval_steps where request_id=$1', [req.id])).rows).toHaveLength(1);
      let e = await expectDbError(q, `update approval_steps set status = 'approved', decided_by = $2, decided_at = now() where request_id = $1`, [req.id, x.me]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update approval_requests set status = 'approved' where id = $1`, [req.id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `delete from approval_requests where id = $1`, [req.id]);
      expect(e.message).toMatch(/./);
    });
    // Sahip rolüyle bile: karar verilmiş adım değişmez
    await expect(execAsOwner(`update approval_steps set note = 'x' where request_id = $1`, [req.id])).rejects.toThrow(/değiştirilemez/);
  });
});
