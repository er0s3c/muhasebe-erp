import { describe, expect, it } from 'vitest';
import { TODAY_LOCAL, addMember, asOwner, client, createCompany, expectDbError, makeApp, registerUser } from './helpers';

const iso = (offset: number) => new Date(Date.parse(`${TODAY_LOCAL}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

/** Düzenli mali yükümlülük takvimi (öneri 57): dönemler, ödendi/atla/geri al, nakit projeksiyonu ve izinler. */
describe('düzenli mali yükümlülük takvimi', async () => {
  const { app } = await makeApp();

  it('dönemler gecikmiş/yaklaşan/planlı ayrılır; işaretleme değişmez; açık dönemler projeksiyona çıkış olarak girer', async () => {
    const s = await registerUser(app, 'Yukumluluk');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const input = {
      title: 'SGK primi',
      category: 'social_security',
      recurrence: { startDate: iso(-14), frequency: 'weekly' },
      weekendRule: 'none',
      amount: '500',
      currency: 'TRY',
      amountKind: 'fixed',
      leadDays: 5,
    };
    expect((await c.post('/api/obligations', { ...input, category: 'bilinmeyen' })).statusCode).toBe(400);
    const created = await c.post('/api/obligations', input);
    expect(created.statusCode, created.body).toBe(201);
    const ob = created.json().obligation;

    const range = `from=${iso(-3)}&to=${iso(20)}`;
    let cal = (await c.get(`/api/obligations/calendar?${range}`)).json();
    expect(cal.today).toBe(TODAY_LOCAL);
    expect(cal.periods.map((p: { dueDate: string; state: string }) => [p.dueDate, p.state])).toEqual([
      [iso(-14), 'overdue'],
      [iso(-7), 'overdue'],
      [iso(0), 'due_soon'],
      [iso(7), 'upcoming'],
      [iso(14), 'upcoming'],
    ]);
    expect(cal.summary.overdue).toEqual({ count: 2, byCurrency: { TRY: '1000.00' } });

    const done = await c.post(`/api/obligations/${ob.id}/complete`, { periodDate: iso(-14), paidAmount: '500', note: 'Banka' });
    expect(done.statusCode, done.body).toBe(201);
    expect((await c.post(`/api/obligations/${ob.id}/complete`, { periodDate: iso(-14) })).statusCode).toBe(409);
    expect((await c.post(`/api/obligations/${ob.id}/complete`, { periodDate: iso(-13) })).statusCode).toBe(400);
    expect((await c.post(`/api/obligations/${ob.id}/complete`, { periodDate: iso(-7), status: 'skipped', note: 'Tecil' })).statusCode).toBe(201);
    cal = (await c.get(`/api/obligations/calendar?${range}`)).json();
    expect(cal.summary.overdue.count).toBe(0);
    expect(cal.periods.find((p: { dueDate: string }) => p.dueDate === iso(-14))).toBeUndefined();

    // Geri alınan dönem yeniden gecikmiş görünür
    expect((await c.delete(`/api/obligations/${ob.id}/completions/${iso(-7)}`)).statusCode).toBe(200);
    expect((await c.delete(`/api/obligations/${ob.id}/completions/${iso(-7)}`)).statusCode).toBe(404);
    cal = (await c.get(`/api/obligations/calendar?${range}`)).json();
    expect(cal.summary.overdue).toEqual({ count: 1, byCurrency: { TRY: '500.00' } });

    // Gecikmiş (−7) ve bugünkü dönem 1. haftada, +7 günlük dönem 2. haftada çıkış
    const f = (await c.get('/api/cash-forecast')).json();
    expect(f.buckets[0].obligations).toBe('1000.00');
    expect(f.buckets[1].obligations).toBe('500.00');
    expect(f.items.filter((i: { source: string }) => i.source === 'obligation').length).toBeGreaterThanOrEqual(3);

    await asOwner(async (q) => {
      expect((await expectDbError(q, 'delete from financial_obligations where id=$1', [ob.id])).code).toBe('ERP19');
      expect((await expectDbError(q, "update obligation_completions set note='x' where obligation_id=$1", [ob.id])).code).toBe('ERP19');
    });

    expect((await c.put(`/api/obligations/${ob.id}`, { config: input, version: 9 })).statusCode).toBe(409);
    const off = await c.patch(`/api/obligations/${ob.id}/active`, { active: false, version: 1 });
    expect(off.statusCode, off.body).toBe(200);
    expect((await c.get(`/api/obligations/calendar?${range}`)).json().periods).toEqual([]);
    expect((await c.get('/api/cash-forecast')).json().buckets[0].obligations).toBe('0.00');

    const viewer = await addMember(app, c, company.id, 'viewer');
    expect((await viewer.client.get(`/api/obligations/calendar?${range}`)).statusCode).toBe(200);
    expect((await viewer.client.post('/api/obligations', input)).statusCode).toBe(403);
  });
});
