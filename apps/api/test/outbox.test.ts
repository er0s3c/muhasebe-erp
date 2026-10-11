import { describe, expect, it } from 'vitest';
import { OutboxMailer } from '../src/modules/mail/mailer';
import { dispatchEmailOutbox } from '../src/modules/outbox/service';
import { outboxOutcome, outboxRetryAt } from '../src/modules/outbox/contract';
import { client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';

/**
 * Öneri 7 ve 111: fatura belgesi kalıcı outbox'tan gönderilir. Tekrarlı istek tek ileti üretir; ileti işlemle birlikte yazılır,
 * gönderim hatasında yeniden denenir, kira dolunca (süreç çöktü) yeniden alınır; belge sürümü ve sonuç geçmişte görünür.
 */
describe('kalıcı e-posta outbox ve belge gönderimi', async () => {
  const mailer = new OutboxMailer();
  const { app } = await makeApp({ mailer });

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { name: `${name} Ltd.` });
    const c = client(app, s.token, company.id);
    const party = (await c.post('/api/parties', { name: 'Alıcı A.Ş.', kind: 'customer', email: 'muhasebe@alici.example' })).json().party;
    const created = await c.post('/api/invoices', { post: true, type: 'sales', partyId: party.id, invoiceDate: day(3, 5), currency: 'TRY', lines: [{ description: 'Danışmanlık', quantity: '2', unitPrice: '150', vatCode: 'KDV-0' }] });
    expect([200, 201], created.body).toContain(created.statusCode);
    const send = (id: string, key: string, body: Record<string, unknown> = { to: 'muhasebe@alici.example', note: 'Faturanız ektedir.' }) =>
      app.inject({ method: 'POST', url: `/api/invoices/${id}/deliveries`, payload: body, headers: { authorization: `Bearer ${s.token}`, 'x-company-id': company.id, 'idempotency-key': key } });
    return { c, company, send, invoice: created.json().invoice as { id: string; invoiceNo: string } };
  }
  const rows = (companyId: string) => execAsOwner('select * from outbox_messages where company_id = $1 order by created_at', [companyId]).then((r) => r.rows);
  const due = (companyId: string) => execAsOwner(`update outbox_messages set next_attempt_at = now() - interval '1 second' where company_id = $1 and status = 'pending'`, [companyId]);

  it('gönderim kuyruğa alınır, tekrarlanan istek tek ileti üretir, gönderici teslim eder ve geçmişte sürüm görünür', async () => {
    const w = await world('Gonderim');
    const first = await w.send(w.invoice.id, 'gonderim-anahtari-0001');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().delivery).toMatchObject({ status: 'pending', recipient: 'muhasebe@alici.example', document: { type: 'invoice', no: w.invoice.invoiceNo } });
    // Cevabı kaybolan istek aynı anahtarla tekrarlanınca ikinci ileti doğmaz
    const replay = await w.send(w.invoice.id, 'gonderim-anahtari-0001');
    expect(replay.json().delivery.id).toBe(first.json().delivery.id);
    expect(await rows(w.company.id)).toHaveLength(1);

    const before = mailer.sent.length;
    const result = await dispatchEmailOutbox(app.db, mailer);
    expect(result.delivered).toBeGreaterThanOrEqual(1);
    const sent = mailer.sent.slice(before).find((m) => m.to === 'muhasebe@alici.example')!;
    expect(sent.subject).toContain(w.invoice.invoiceNo);
    expect(sent.text).toContain('Faturanız ektedir.');
    expect(sent.text).toContain('Danışmanlık');
    expect(sent.messageId).toBe(`<${first.json().delivery.id}@outbox.ada-erp>`);

    const history = (await w.c.get(`/api/invoices/${w.invoice.id}/deliveries`)).json();
    expect(history.partyEmail).toBe('muhasebe@alici.example');
    expect(history.deliveries[0]).toMatchObject({ status: 'delivered', attempts: 1, lastError: null });
    expect(history.deliveries[0].document.version).toBe(history.currentVersion);
    // Teslim edilen ileti bir daha gönderilmez
    const again = mailer.sent.length;
    await dispatchEmailOutbox(app.db, mailer);
    expect(mailer.sent.length).toBe(again);

    // Gönderimden sonra iptal edilen belgenin güncel sürümü gönderilenden farklıdır
    expect((await w.c.post(`/api/invoices/${w.invoice.id}/cancel`, { reason: 'Hatalı fatura', date: day(3, 6) })).statusCode).toBe(200);
    const afterCancel = (await w.c.get(`/api/invoices/${w.invoice.id}/deliveries`)).json();
    expect(afterCancel.currentVersion).not.toBe(afterCancel.deliveries[0].document.version);
    // İptal edilmiş belge gönderilmez
    expect((await w.send(w.invoice.id, 'gonderim-anahtari-0002')).json().error.code).toBe('INVOICE_NOT_POSTED');
  });

  it('hata yeniden denenir, sınır dolunca teslim edilemedi olur, elle yeniden deneme teslim eder; kira dolan ileti yeniden alınır', async () => {
    const w = await world('Deneme');
    const id = (await w.send(w.invoice.id, 'deneme-anahtari-00001')).json().delivery.id as string;
    mailer.failing = true;
    try {
      await dispatchEmailOutbox(app.db, mailer);
      let [row] = await rows(w.company.id);
      expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'SMTP bağlantı hatası', lease_token: null });
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      // Zamanı gelmeden yeniden denenmez
      await dispatchEmailOutbox(app.db, mailer);
      expect((await rows(w.company.id))[0].attempts).toBe(1);
      for (let i = 0; i < 5; i++) { await due(w.company.id); await dispatchEmailOutbox(app.db, mailer); }
      [row] = await rows(w.company.id);
      expect(row).toMatchObject({ status: 'dead_letter', attempts: 6 });
      await due(w.company.id);
      await dispatchEmailOutbox(app.db, mailer);
      expect((await rows(w.company.id))[0].attempts).toBe(6);
    } finally {
      mailer.failing = false;
    }
    const retried = await w.c.post(`/api/invoices/${w.invoice.id}/deliveries/${id}/retry`, {});
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().delivery.status).toBe('pending');
    await dispatchEmailOutbox(app.db, mailer);
    expect((await rows(w.company.id))[0]).toMatchObject({ status: 'delivered', attempts: 7, max_attempts: 9 });
    expect((await w.c.post(`/api/invoices/${w.invoice.id}/deliveries/${id}/retry`, {})).json().error.code).toBe('OUTBOX_NOT_RETRYABLE');

    // Gönderim sırasında çöken süreç: ileti "sending" ve kirası dolmuş kalır; sonraki tur yeniden alır
    const crashed = (await w.send(w.invoice.id, 'deneme-anahtari-00002')).json().delivery.id as string;
    await execAsOwner(`update outbox_messages set status = 'sending', attempts = 1, lease_token = gen_random_uuid(), lease_until = now() - interval '1 second' where id = $1`, [crashed]);
    await dispatchEmailOutbox(app.db, mailer);
    expect((await execAsOwner('select status, attempts from outbox_messages where id = $1', [crashed])).rows[0]).toEqual({ status: 'delivered', attempts: 2 });
  });

  it('içerik ve teslim edilen durum değiştirilemez; başka şirket göremez; satış dışı belge ve posta kapalıyken gönderim reddedilir', async () => {
    const w = await world('Koruma');
    const id = (await w.send(w.invoice.id, 'koruma-anahtari-00001')).json().delivery.id as string;
    await expect(execAsOwner(`update outbox_messages set recipient = 'baska@example.com' where id = $1`, [id])).rejects.toThrow(/değiştirilemez/);
    await dispatchEmailOutbox(app.db, mailer);
    await expect(execAsOwner(`update outbox_messages set status = 'pending' where id = $1`, [id])).rejects.toThrow(/yeniden açılamaz/);

    const other = await world('Yabanci');
    expect((await other.c.get(`/api/invoices/${w.invoice.id}/deliveries`)).statusCode).toBe(404);
    expect((await other.c.post(`/api/invoices/${w.invoice.id}/deliveries/${id}/retry`, {})).statusCode).toBe(404);

    const supplier = (await w.c.post('/api/parties', { name: 'Tedarikçi', kind: 'supplier' })).json().party;
    const item = (await w.c.post('/api/items', { name: 'Malzeme', vatCode: 'KDV-16' })).json().item;
    const draft = await w.c.post('/api/invoices', { type: 'purchase', partyId: supplier.id, invoiceDate: day(3, 5), externalNo: 'T-1', lines: [{ itemId: item.id, description: 'Malzeme', quantity: '1', unitPrice: '10', vatCode: 'KDV-16' }] });
    expect([200, 201], draft.body).toContain(draft.statusCode);
    const purchase = draft.json().invoice;
    expect((await w.send(purchase.id, 'koruma-anahtari-00002')).json().error.code).toBe('INVOICE_NOT_SENDABLE');
    expect((await w.send(w.invoice.id, 'koruma-anahtari-00003', { to: 'gecersiz' })).statusCode).toBe(400);

    const { app: noMail } = await makeApp();
    const s = await registerUser(noMail, 'PostaYok');
    const company = await createCompany(noMail, s.token, { name: 'Posta Yok Ltd.' });
    const c = client(noMail, s.token, company.id);
    const party = (await c.post('/api/parties', { name: 'Alıcı', kind: 'customer' })).json().party;
    const inv = (await c.post('/api/invoices', { post: true, type: 'sales', partyId: party.id, invoiceDate: day(3, 5), currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '10', vatCode: 'KDV-0' }] })).json().invoice;
    const blocked = await noMail.inject({ method: 'POST', url: `/api/invoices/${inv.id}/deliveries`, payload: { to: 'a@b.example' }, headers: { authorization: `Bearer ${s.token}`, 'x-company-id': company.id } });
    expect(blocked.json().error.code).toBe('MAIL_DISABLED');
  });

  it('ortak sözleşme: bekleme takvimi ve sonuç', () => {
    const now = new Date('2026-10-11T10:00:00Z');
    expect(outboxRetryAt(1, now).getTime() - now.getTime()).toBe(30_000);
    expect(outboxRetryAt(9, now).getTime() - now.getTime()).toBe(21_600_000);
    expect(outboxOutcome(2, 6, null, now)).toMatchObject({ status: 'delivered', deliveredAt: now, lastError: null });
    expect(outboxOutcome(6, 6, 'x'.repeat(900), now)).toMatchObject({ status: 'dead_letter', deliveredAt: null });
    expect(outboxOutcome(6, 6, 'x'.repeat(900), now).lastError).toHaveLength(500);
  });
});
