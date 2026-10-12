import { describe, expect, it } from 'vitest';
import { accountIds, client, createCompany, day, makeApp, registerUser, thisYear } from './helpers';

/**
 * Öneri 6: önizlemeli toplu işlem. Önizleme aynı iş kurallarıyla dener ve geri alır (numara harcanmaz, kayıt oluşmaz);
 * uygulamada her kayıt ayrı savepoint'tedir, hatalı kayıt nedeniyle raporlanır ve diğerlerini durdurmaz.
 */
describe('önizlemeli toplu muhasebeleştirme', async () => {
  const { app } = await makeApp();

  it('önizleme iz bırakmaz; uygulama hazır olanları kaydeder, diğerlerini nedeniyle bildirir; numara boşluksuz', async () => {
    const s = await registerUser(app, 'TopluKayit');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const cust = (await c.post('/api/parties', { name: 'Toplu Müşteri' })).json().party;
    const line = { description: 'Hizmet', accountId: ids['600'], quantity: '1', unitPrice: '100', vatCode: null };
    const draft = async (body: Record<string, unknown>) => {
      const r = await c.post('/api/invoices', body);
      expect([200, 201], r.body).toContain(r.statusCode);
      return r.json().invoice as { id: string };
    };
    const a = await draft({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 10), lines: [line] });
    const b = await draft({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 11), lines: [line] });
    // Zaten kaydedilmiş fatura yeniden kaydedilemez (ilk numarayı o alır)
    const posted = await draft({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 9), post: true, lines: [line] });
    const batch = (dryRun: boolean, list: string[], key?: string) => app.inject({
      method: 'POST', url: '/api/invoices/batch-post', payload: { ids: list, dryRun },
      headers: { authorization: `Bearer ${s.token}`, 'x-company-id': company.id, ...(key ? { 'idempotency-key': key } : {}) },
    });

    const preview = await batch(true, [a.id, b.id, posted.id]);
    expect(preview.statusCode, preview.body).toBe(200);
    const p = preview.json();
    expect(p.summary).toEqual({ ok: 2, failed: 1 });
    expect(p.results.find((r: { id: string }) => r.id === posted.id).error.code).toBe('INVOICE_NOT_DRAFT');
    // Önizleme kayıt yapmaz ve numara harcamaz
    expect((await c.get(`/api/invoices/${a.id}`)).json().invoice).toMatchObject({ status: 'draft', invoiceNo: null });

    const run = await batch(false, [a.id, b.id, posted.id], 'toplu-kayit-anahtari-01');
    expect(run.statusCode, run.body).toBe(200);
    const r = run.json();
    expect(r.summary).toEqual({ ok: 2, failed: 1 });
    expect(r.results.filter((x: { ok: boolean }) => x.ok).map((x: { value: { invoiceNo: string } }) => x.value.invoiceNo).sort())
      .toEqual([`SF-${thisYear}-000002`, `SF-${thisYear}-000003`]);
    // Aynı istek tekrarlanınca ikinci kez kaydedilmez (önceki cevap döner)
    const replay = await batch(false, [a.id, b.id, posted.id], 'toplu-kayit-anahtari-01');
    expect(replay.headers['idempotent-replay']).toBe('true');
    // Önizleme numara harcamadığı için sıradaki fatura boşluksuz devam eder
    const next = await draft({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 12), post: true, lines: [line] });
    expect((await c.get(`/api/invoices/${next.id}`)).json().invoice.invoiceNo).toBe(`SF-${thisYear}-000004`);
    // Liste sınırı ve yetki
    expect((await batch(true, [])).statusCode).toBe(400);
  });
});
