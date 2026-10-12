import { describe, expect, it } from 'vitest';
import { OutboxMailer } from '../src/modules/mail/mailer';
import { dispatchEmailOutbox } from '../src/modules/outbox/service';
import { accountIds, client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';

/**
 * Öneri 59: cari mutabakat mektubu ve cevap takibi. Mektup tarihteki bakiyenin değişmez görüntüsüdür; e-postayla kalıcı
 * outbox'tan gider; cevap işlenir, fark hesaplanır; cevaplanan mektup bir daha değişmez.
 */
describe('cari mutabakat', async () => {
  const mailer = new OutboxMailer();
  const { app } = await makeApp({ mailer });

  it('bakiye görüntüsü, e-posta, cevap ve fark; içerik değişmez', async () => {
    const s = await registerUser(app, 'Mutabakat');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const cust = (await c.post('/api/parties', { name: 'Mutabakat Müşterisi', email: 'cari@musteri.example' })).json().party;
    const inv = await c.post('/api/invoices', { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, 10), lines: [{ description: 'Hizmet', accountId: ids['600'], quantity: '1', unitPrice: '100', vatCode: 'KDV-16' }] });
    expect([200, 201], inv.body).toContain(inv.statusCode);
    const base = `/api/parties/${cust.id}/reconciliations`;
    const create = (body: Record<string, unknown>, key: string) => app.inject({ method: 'POST', url: base, payload: body, headers: { authorization: `Bearer ${s.token}`, 'x-company-id': company.id, 'idempotency-key': key } });

    expect((await create({ asOf: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) }, 'mutabakat-anahtari-001')).json().error.code).toBe('RECONCILIATION_FUTURE_DATE');
    const plain = await create({ asOf: day(3, 31) }, 'mutabakat-anahtari-002');
    expect(plain.statusCode, plain.body).toBe(201);
    const first = plain.json().reconciliations[0];
    expect(first).toMatchObject({ status: 'open', baseBalance: '116.0000', byCurrency: [{ currency: 'TRY', balance: '116.00' }], sentTo: null, overdue: false });
    // Tarihten önceki görüntü: mart başında bakiye yok
    expect((await create({ asOf: day(3, 1) }, 'mutabakat-anahtari-003')).json().reconciliations[0].baseBalance).toBe('0.0000');

    // E-postayla gönderim kalıcı outbox'tan
    const sent = (await create({ asOf: day(3, 31), sendTo: 'cari@musteri.example', note: 'Yıl sonu mutabakatı' }, 'mutabakat-anahtari-004')).json().reconciliations[0];
    expect(sent.outboxMessageId).toEqual(expect.any(String));
    await dispatchEmailOutbox(app.db, mailer);
    const mail = mailer.sent.find((m) => m.to === 'cari@musteri.example')!;
    expect(mail.text).toContain('116,00 TRY (borcunuz)');
    expect(mail.text).toContain('Yıl sonu mutabakatı');

    // Cevap: mutabık olunmayan cevapta karşı bakiye zorunlu; fark hesaplanır; ikinci cevap reddedilir
    expect((await c.post(`${base}/${sent.id}/response`, { result: 'disputed' })).statusCode).toBe(400);
    expect((await c.post(`${base}/${sent.id}/response`, { result: 'agreed', counterBalance: '100' })).json().error.code).toBe('RECONCILIATION_BALANCE_MISMATCH');
    const disputed = (await c.post(`${base}/${sent.id}/response`, { result: 'disputed', counterBalance: '100', note: 'İade faturası bizde kayıtlı' })).json().reconciliations.find((r: { id: string }) => r.id === sent.id);
    expect(disputed).toMatchObject({ status: 'disputed', counterBalance: '100.0000', difference: '16.00' });
    expect((await c.post(`${base}/${sent.id}/response`, { result: 'agreed' })).json().error.code).toBe('RECONCILIATION_CLOSED');
    const agreed = (await c.post(`${base}/${first.id}/response`, { result: 'agreed' })).json().reconciliations.find((r: { id: string }) => r.id === first.id);
    expect(agreed).toMatchObject({ status: 'agreed', difference: '0.00' });

    // İçerik değişmez
    await expect(execAsOwner(`update party_reconciliations set base_balance = 1 where id = $1`, [first.id])).rejects.toThrow(/değiştirilemez/);
    // Başka şirket göremez
    const s2 = await registerUser(app, 'MutabakatYabanci');
    const c2 = await createCompany(app, s2.token);
    expect((await client(app, s2.token, c2.id).post(`${base}/${first.id}/cancel`, {})).statusCode).toBe(404);
  });
});
