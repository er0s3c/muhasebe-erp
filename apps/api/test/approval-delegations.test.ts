import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountIds, addMember, client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';

/**
 * Öneri 98: süre ve kapsam sınırlı onay vekâleti. Vekil, asıl onaylayıcının adına yalnız kapsamdaki belge türü ve tutarda,
 * süre içinde karar verir; karar adımda "adına" olarak kalır. Geri alınan ya da süresi dolan vekâlet hiçbir hak vermez.
 */
describe('onay vekâleti', async () => {
  const { app } = await makeApp();
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const owner = client(app, s.token, company.id);
    const accountant = await addMember(app, owner, company.id, 'accountant');
    const sales = await addMember(app, owner, company.id, 'sales');
    const site = await addMember(app, owner, company.id, 'site_manager');
    const ids = await accountIds(app, s.token, company.id);
    const party = (await owner.post('/api/parties', { name: 'Vekâlet müşterisi' })).json().party;
    const rule = await owner.post('/api/document-approvals/rules', { docType: 'invoice', minAmount: '0', separateRequester: true, steps: [{ userId: accountant.userId, label: 'Muhasebe onayı' }] });
    expect(rule.statusCode, rule.body).toBe(201);
    const request = async () => {
      const inv = (await owner.post('/api/invoices', { type: 'sales', partyId: party.id, invoiceDate: day(3, 10), lines: [{ description: 'Hizmet', accountId: ids['600'], quantity: '1', unitPrice: '100', vatCode: null }] })).json().invoice;
      const sub = await owner.post(`/api/document-approvals/documents/invoice/${inv.id}/submit`, {});
      expect(sub.statusCode, sub.body).toBe(201);
      return sub.json().request as { id: string };
    };
    return { company, owner, accountant, sales, site, request };
  }
  const delegate = (from: ReturnType<typeof client>, body: Record<string, unknown>) =>
    from.post('/api/approval-delegations', { docTypes: ['invoice'], startsAt: iso(-60_000), endsAt: iso(86_400_000), reason: 'Yıllık izin', ...body });
  const decide = (c: ReturnType<typeof client>, id: string) => c.post(`/api/document-approvals/${id}/decide`, { decision: 'approve' });

  it('vekil kapsam ve tutar içinde asıl onaylayıcı adına karar verir; geri alınınca hak biter', async () => {
    const w = await world('Vekalet');
    const req = await w.request();
    expect((await decide(w.sales.client, req.id)).statusCode).toBe(403);

    // Tutar sınırı (100 > 50) kapsam dışı: hak vermez
    const small = await delegate(w.accountant.client, { delegateUserId: w.sales.userId, maxAmount: '50' });
    expect(small.statusCode, small.body).toBe(201);
    expect((await decide(w.sales.client, req.id)).statusCode).toBe(403);
    expect((await w.accountant.client.post(`/api/approval-delegations/${small.json().delegation.id}/revoke`, {})).statusCode).toBe(200);

    const full = (await delegate(w.accountant.client, { delegateUserId: w.sales.userId })).json().delegation;
    const inbox = (await w.sales.client.get('/api/document-approvals/inbox')).json().requests as { id: string; onBehalfOf?: { userId: string; name: string } }[];
    expect(inbox.find((r) => r.id === req.id)?.onBehalfOf).toMatchObject({ userId: w.accountant.userId });
    const decided = await decide(w.sales.client, req.id);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().request.status).toBe('approved');
    const step = (await execAsOwner('select decided_by, on_behalf_of, delegation_id from approval_steps where request_id = $1', [req.id])).rows[0];
    expect(step).toEqual({ decided_by: w.sales.userId, on_behalf_of: w.accountant.userId, delegation_id: full.id });

    // Listeyi veren ve vekil görür; vekil geri alamaz, veren alır; sonra hak biter
    expect((await w.sales.client.get('/api/approval-delegations')).json().delegations.find((d: { id: string }) => d.id === full.id).state).toBe('active');
    expect((await w.sales.client.post(`/api/approval-delegations/${full.id}/revoke`, {})).statusCode).toBe(403);
    expect((await w.accountant.client.post(`/api/approval-delegations/${full.id}/revoke`, {})).statusCode).toBe(200);
    const next = await w.request();
    expect((await decide(w.sales.client, next.id)).statusCode).toBe(403);

    // Süresi dolmuş vekâlet de hak vermez
    await execAsOwner(
      `insert into approval_delegations (id, company_id, delegator_user_id, delegate_user_id, doc_types, starts_at, ends_at, reason, created_by)
       values ($1, $2, $3, $4, array['invoice'], now() - interval '3 days', now() - interval '1 day', 'Geçmiş izin', $3)`,
      [randomUUID(), w.company.id, w.accountant.userId, w.sales.userId],
    );
    expect((await decide(w.sales.client, next.id)).statusCode).toBe(403);
    expect((await w.accountant.client.get('/api/approval-delegations')).json().delegations.map((d: { state: string }) => d.state)).toEqual(expect.arrayContaining(['expired', 'revoked']));
  });

  it('yalnız kendi onay yetkisi, görebilen vekile ve en çok 90 gün devredilir; kapsam sonradan değişmez', async () => {
    const w = await world('VekaletSinir');
    expect((await delegate(w.sales.client, { delegateUserId: w.accountant.userId })).json().error.code).toBe('DELEGATION_SCOPE_DENIED');
    expect((await delegate(w.accountant.client, { delegateUserId: w.site.userId })).json().error.code).toBe('DELEGATE_CANNOT_READ');
    expect((await delegate(w.accountant.client, { delegateUserId: w.accountant.userId })).json().error.code).toBe('DELEGATION_SELF');
    expect((await delegate(w.accountant.client, { delegateUserId: w.sales.userId, endsAt: iso(91 * 86_400_000) })).json().error.code).toBe('DELEGATION_WINDOW_INVALID');
    expect((await delegate(w.accountant.client, { delegateUserId: w.sales.userId, startsAt: iso(-2 * 86_400_000), endsAt: iso(-86_400_000) })).json().error.code).toBe('DELEGATION_WINDOW_INVALID');
    expect((await delegate(w.accountant.client, { delegateUserId: randomUUID() })).json().error.code).toBe('DELEGATE_NOT_MEMBER');
    const ok = (await delegate(w.accountant.client, { delegateUserId: w.sales.userId })).json().delegation;
    await expect(execAsOwner(`update approval_delegations set doc_types = array['invoice','payment'] where id = $1`, [ok.id])).rejects.toThrow(/değiştirilemez/);
    // Başka şirket göremez
    const other = await world('VekaletYabanci');
    expect((await other.owner.post(`/api/approval-delegations/${ok.id}/revoke`, {})).statusCode).toBe(404);
  });
});
