import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asOwner, client, day, expectDbError, makeApp, PASSWORD, TODAY_LOCAL } from './helpers';
import { x2Kit } from './x2-helpers';

/**
 * F6 ilk kapsamı: teklif/sipariş ticari görüntüsü ve kontrolleri (33, 35, 38), müzakere/taviz geçmişi (34),
 * satış sorumlusu ve hedef raporu (13), ticari itiraz dosyası (39).
 */
describe('satış ticari kararları (F6)', async () => {
  const { app } = await makeApp();
  const k = x2Kit(app);
  const line = (itemId: string, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) => ({ itemId, quantity, unitPrice, ...extra });

  async function member(owner: ReturnType<typeof client>, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Temsilci`, role, password: PASSWORD, mustChangePassword: false });
    expect(add.statusCode, add.body).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return { userId: add.json().member.userId as string, c: client(app, login.json().accessToken as string, companyId) };
  }

  it('katkı ve kredi kontrolü, gerekçeli geçiş, ticari görüntü ve taviz geçmişi', async () => {
    const { c, main, company } = await k.setup('TicariKontrol');
    const cust = await k.mkParty(c, 'Riskli Müşteri', 'customer', { creditLimit: '1000' });
    const item = await k.mkItem(c, 'Ticari Kart');
    await k.receipt(c, day(1, 2), main.id, item.id, '100', '80');

    // Politika: asgari katkı %25 engeller, kredi limiti engeller
    const pol = await c.put('/api/sales-policy', { minMarginPct: '25', marginMode: 'block', creditMode: 'block' });
    expect(pol.statusCode, pol.body).toBe(200);
    expect(pol.json()).toMatchObject({ minMarginPct: '25.00', marginMode: 'block', creditMode: 'block' });

    // Teklif: 10 × 100 = 1000 net, maliyet 800 → katkı %20 < %25
    const q = (await c.post('/api/sales-docs', { kind: 'quote', partyId: cust.id, docDate: TODAY_LOCAL, validUntil: TODAY_LOCAL, lines: [line(item.id, '10', '100', { vatCode: 'KDV-0' })] })).json();
    const blocked = await c.post(`/api/sales-docs/${q.doc.id}/send`, {});
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toMatchObject({ code: 'SO_COMMERCIAL_BLOCK', details: { blocking: ['MARGIN_BELOW_MIN'], marginPct: '20.00', minMarginPct: '25.00' } });

    // Satış rolü (fatura kaydetme yetkisi yok) gerekçeyle geçemez; sahip geçer
    const rep = await member(c, company.id, 'sales');
    const forbidden = await rep.c.post(`/api/sales-docs/${q.doc.id}/send`, { overrideReason: 'Stratejik müşteri' });
    expect(forbidden.json().error.code).toBe('SO_OVERRIDE_FORBIDDEN');
    expect((await c.post(`/api/sales-docs/${q.doc.id}/send`, { overrideReason: 'Stratejik müşteri' })).statusCode).toBe(200);

    // Ticari görüntü: maliyet 800, katkı %20, gerekçe saklı; geçerlilik bugün biter
    let view = (await c.get(`/api/sales-docs/${q.doc.id}/commercial`)).json();
    expect(view.snapshot).toMatchObject({ event: 'sent', revisionNo: 1, netBase: '1000.0000', costBase: '800.0000', marginPct: '20.00', overrideReason: 'Stratejik müşteri', warnings: ['MARGIN_BELOW_MIN'] });
    expect(view.validity).toMatchObject({ validUntil: TODAY_LOCAL, daysLeft: 0, expired: false });
    // Maliyet yükselir (100 adet 120'den giriş → ortalama 100): güncel fark görünür
    await k.receipt(c, day(1, 3), main.id, item.id, '100', '120');
    view = (await c.get(`/api/sales-docs/${q.doc.id}/commercial`)).json();
    expect(view.current).toMatchObject({ costBase: '1000.0000', marginPct: '0.00' });
    expect(view.changes).toMatchObject({ costBase: '200.0000', marginPts: '-20.00' });
    expect(view.current.lines[0]).toMatchObject({ snapshotUnitCostBase: '80.000000', costDiffBase: '200.0000' });

    // Müzakere: taslağa al, fiyat 140 → %5 iskonto; yeniden gönder (katkı yine düşük: gerekçeyle)
    expect((await c.post(`/api/sales-docs/${q.doc.id}/reopen`, { reason: 'Müşteri fiyat istedi' })).statusCode).toBe(200);
    await c.put('/api/sales-policy', { minMarginPct: null, marginMode: 'warn', creditMode: 'block' });
    expect((await c.put(`/api/sales-docs/${q.doc.id}`, { partyId: cust.id, docDate: TODAY_LOCAL, validUntil: TODAY_LOCAL, lines: [line(item.id, '10', '140', { vatCode: 'KDV-0', discountPct: '5' })] })).statusCode).toBe(200);
    // Kredi: 1330 > limit 1000 → engel
    const credit = await c.post(`/api/sales-docs/${q.doc.id}/send`, {});
    expect(credit.json().error).toMatchObject({ code: 'SO_COMMERCIAL_BLOCK', details: { blocking: ['CREDIT_LIMIT_EXCEEDED'], creditLimit: '1000.0000', exposure: '1330.0000' } });
    expect((await c.post(`/api/sales-docs/${q.doc.id}/send`, { overrideReason: 'Teminat mektubu alındı' })).statusCode).toBe(200);

    const neg = (await c.get(`/api/sales-docs/${q.doc.id}/negotiation`)).json();
    expect(neg.revisions.map((r: { revisionNo: number; docNet: string; concession: string | null }) => [r.revisionNo, r.docNet, r.concession])).toEqual([
      [1, '1000.0000', null],
      [2, '1330.0000', '-330.0000'],
    ]);
    expect(neg.revisions[1].lineChanges).toEqual([
      expect.objectContaining({ lineNo: 1, change: 'changed', unitPrice: { from: '100.000000', to: '140.000000' }, discountPct: { from: '0.0000', to: '5.0000' } }),
    ]);
    expect(neg.reopens).toEqual([expect.objectContaining({ reason: 'Müşteri fiyat istedi' })]);

    // Görüntü değişmez
    await asOwner(async (q2) => {
      const e = await expectDbError(q2, `update sales_doc_snapshots set override_reason = 'x' where order_id = $1`, [q.doc.id]);
      expect(e.code).toBe('ERP15');
    });
  });

  it('satış sorumlusu: cariden belgeye, değişiklik geçmişi, hedef ve kârlılık raporu', async () => {
    const { c, main, company } = await k.setup('SatisSorumlu');
    const rep = await member(c, company.id, 'sales');
    const cust = await k.mkParty(c, 'Sorumlu Müşteri');
    const item = await k.mkItem(c, 'Sorumlu Kart');
    await k.receipt(c, day(1, 2), main.id, item.id, '20', '40');

    const set = await c.put(`/api/parties/${cust.id}/sales-rep`, { userId: rep.userId, reason: 'Bölge ataması' });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ salesRepId: rep.userId, history: [expect.objectContaining({ fromName: null, toName: 'sales Temsilci', reason: 'Bölge ataması' })] });
    expect((await c.put(`/api/parties/${cust.id}/sales-rep`, { userId: randomUUID() })).json().error.code).toBe('SALES_REP_NOT_MEMBER');

    // Sipariş carinin sorumlusunu alır; onay ve faturalama
    const o = (await c.post('/api/sales-docs', { kind: 'order', partyId: cust.id, docDate: TODAY_LOCAL, warehouseId: main.id, lines: [line(item.id, '5', '100')] })).json();
    expect(o.doc).toMatchObject({ salesRepId: rep.userId, salesRepName: 'sales Temsilci' });
    expect((await c.post(`/api/sales-docs/${o.doc.id}/confirm`, {})).statusCode).toBe(200);
    const inv = await c.post(`/api/sales-docs/${o.doc.id}/invoice`, { includeUndelivered: true });
    expect(inv.statusCode, inv.body).toBe(201);
    const posted = await c.post(`/api/invoices/${inv.json().invoiceId}/post`);
    expect(posted.statusCode, posted.body).toBe(200);

    const year = Number(TODAY_LOCAL.slice(0, 4));
    const month = Number(TODAY_LOCAL.slice(5, 7));
    const tg = await c.put('/api/sales-rep-targets', { year, targets: [{ userId: rep.userId, month, amount: '1000' }] });
    expect(tg.statusCode, tg.body).toBe(200);

    const report = (await c.get(`/api/reports/sales-reps?from=${TODAY_LOCAL.slice(0, 8)}01&to=${TODAY_LOCAL}`)).json();
    expect(report.rows).toEqual([
      expect.objectContaining({ repId: rep.userId, ordersConfirmed: 1, ordersNetBase: '500.0000', sales: '500.0000', cost: '200.0000', profit: '300.0000', marginPct: '60.00', target: '1000.0000', achievementPct: '50.00' }),
    ]);
  });

  it('ticari itiraz dosyası: belgeye bağlı açılır, atanır, çözülür; kapanınca değişmez', async () => {
    const { c, main, company } = await k.setup('TicariItiraz');
    const owner = await member(c, company.id, 'sales');
    const cust = await k.mkParty(c, 'İtirazcı');
    const other = await k.mkParty(c, 'Başka');
    const item = await k.mkItem(c, 'İtiraz Kartı');
    await k.receipt(c, day(1, 2), main.id, item.id, '5', '10');
    const note = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(1, 3), warehouseId: main.id, lines: [k.dline(item.id, '2')] });

    expect((await c.post('/api/disputes', { partyId: other.id, sourceType: 'delivery_note', sourceId: note.note.id, category: 'quantity', subject: 'Eksik teslim' })).json().error.code).toBe('DISPUTE_SOURCE_PARTY');
    const created = await c.post('/api/disputes', { partyId: cust.id, sourceType: 'delivery_note', sourceId: note.note.id, category: 'quantity', subject: 'Eksik teslim', amount: '150', note: 'Müşteri 1 adet eksik dedi' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().dispute.id as string;
    expect(created.json().dispute).toMatchObject({ status: 'open', sourceNo: note.note.noteNo, amount: '150.0000', currencyCode: 'TRY' });

    const act = (body: Record<string, unknown>) => c.post(`/api/disputes/${id}/actions`, body);
    expect((await act({ action: 'assign', ownerId: owner.userId })).json().dispute.ownerName).toBe('sales Temsilci');
    expect((await act({ action: 'review', note: 'Depo kaydı inceleniyor' })).json().dispute.status).toBe('in_review');
    expect((await act({ action: 'review' })).json().error.code).toBe('DISPUTE_INVALID_TRANSITION');
    const resolved = (await act({ action: 'resolve', resolution: 'Eksik adet için iade faturası kesilecek' })).json();
    expect(resolved.dispute).toMatchObject({ status: 'resolved', resolution: 'Eksik adet için iade faturası kesilecek' });
    expect(resolved.events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'assign', 'status', 'status']);
    expect((await act({ action: 'note', note: 'geç not' })).json().error.code).toBe('DISPUTE_CLOSED');

    expect((await c.get(`/api/disputes?partyId=${cust.id}`)).json().disputes).toEqual([]);
    expect((await c.get(`/api/disputes?partyId=${cust.id}&status=closed`)).json().disputes).toHaveLength(1);
    await asOwner(async (q) => {
      const e = await expectDbError(q, `update commercial_disputes set subject = 'x' where id = $1`, [id]);
      expect(e.code).toBe('ERP15');
    });
  });
});
