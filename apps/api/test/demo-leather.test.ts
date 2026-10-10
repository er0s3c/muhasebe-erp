import { describe, expect, it } from 'vitest';
import { makeApp, PASSWORD, asOwner } from './helpers';
import { seedLeatherDemo, LEATHER_DEMO_TAX_NO } from '../src/db/demo-leather';

describe('Deri demo verisi', async () => {
  const { app, handle } = await makeApp();
  it('gerçek servislerle tek işlemde kurulur, dengelidir ve tekrar çalıştırma kayıt çoğaltmaz', async () => {
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'demo@ornek.local', password: PASSWORD, fullName: 'Deri Demo Kullanıcısı', organizationName: 'Deri Demo Holding' } });
    expect(registered.statusCode, registered.body).toBe(201);
    await seedLeatherDemo(handle.db, () => {});
    await asOwner(async q => {
      const company = (await q('select id from companies where tax_number=$1', [LEATHER_DEMO_TAX_NO])).rows;
      expect(company).toHaveLength(1);
      const badEntries = await q('select entry_id from journal_lines where company_id=$1 group by entry_id having sum(debit_base)<>sum(credit_base)', [company[0].id]);
      expect(badEntries.rows).toEqual([]);
      expect((await q('select count(*)::int n from leather_production_orders where company_id=$1', [company[0].id])).rows[0].n).toBeGreaterThan(0);
    });
    expect(await seedLeatherDemo(handle.db, () => {})).toBe(false);
  }, 90_000);
});
