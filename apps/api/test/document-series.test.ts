import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withContext } from '../src/db/client';
import { nextDocumentNumber, nextNumber } from '../src/modules/settings/numbering';
import { client, createCompany, makeApp, orgOf, registerUser } from './helpers';

const { app, handle } = await makeApp();
async function setup(name: string) {
  const owner = await registerUser(app, name);
  const company = await createCompany(app, owner.token, { jurisdiction: 'TR', sector: 'COMMERCE' });
  const c = client(app, owner.token, company.id);
  const ctx = { companyId: company.id, orgId: await orgOf(app, owner.token), userId: owner.userId };
  return { owner, company, c, ctx };
}
describe('Şirket belge numara serileri', () => {
  it('eski sayaç devam eder; önek/basamak değişikliği numara, yıl ve şirket izolasyonunu korur', async () => {
    const { owner, c, ctx } = await setup('SeriDevam');
    expect(await withContext(handle.db, ctx, tx => nextNumber(tx, ctx.companyId, 'INV:sales', 2026))).toBe(1);
    const saved = await c.put('/api/settings/operations', { version: 0, settings: { documentSeries: { 'INV:sales': { prefix: 'sat', padding: 3 } }, invoicePrintTemplate: 'simple' } });
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().settings.documentSeries['INV:sales']).toEqual({ prefix: 'SAT', padding: 3 });
    expect(await withContext(handle.db, ctx, tx => nextDocumentNumber(tx, ctx.companyId, 'INV:sales', 2026, 'SF'))).toBe('SAT-2026-002');
    expect(await withContext(handle.db, ctx, tx => nextDocumentNumber(tx, ctx.companyId, 'INV:sales', 2027, 'SF'))).toBe('SAT-2027-001');
    expect(await withContext(handle.db, ctx, tx => nextDocumentNumber(tx, ctx.companyId, 'INV:purchase', 2026, 'AF'))).toBe('AF-2026-000001');
    const other = await createCompany(app, owner.token, { jurisdiction: 'TR', sector: 'COMMERCE' });
    expect(await withContext(handle.db, { ...ctx, companyId: other.id }, tx => nextDocumentNumber(tx, other.id, 'INV:sales', 2026, 'SF'))).toBe('SF-2026-000001');
    expect((await client(app, owner.token, other.id).get('/api/settings/document-format')).json()).toEqual({ invoicePrintTemplate: 'detailed' });
  });
  it('aynı şirket/tür/yıl eşzamanlı numaraları kilitler; rollback numarayı tüketmez', async () => {
    const { c, ctx } = await setup('SeriKilit');
    const saved = await c.put('/api/settings/operations', { version: 0, settings: { documentSeries: { 'INV:sales': { prefix: 'SAT', padding: 3 } } } });
    expect(saved.statusCode, saved.body).toBe(200);
    const numbers = await Promise.all(Array.from({ length: 6 }, () => withContext(handle.db, ctx, tx => nextDocumentNumber(tx, ctx.companyId, 'INV:sales', 2026, 'SF'))));
    expect(numbers.sort()).toEqual(['SAT-2026-001', 'SAT-2026-002', 'SAT-2026-003', 'SAT-2026-004', 'SAT-2026-005', 'SAT-2026-006']);
    await expect(withContext(handle.db, ctx, async tx => { expect(await nextDocumentNumber(tx, ctx.companyId, 'INV:sales', 2026, 'SF')).toBe('SAT-2026-007'); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await withContext(handle.db, ctx, tx => nextDocumentNumber(tx, ctx.companyId, 'INV:sales', 2026, 'SF'))).toBe('SAT-2026-007');
  });
  it('çakışan önek, sahte anahtar, geçersiz basamak ve stale sürüm reddedilir', async () => {
    const { c } = await setup('SeriDogrula');
    for (const documentSeries of [
      { 'INV:sales': { prefix: 'AF', padding: 3 } },
      { 'NOT_A_DOCUMENT': { prefix: 'ABC', padding: 3 } },
      { 'INV:sales': { prefix: 'ABC', padding: 0 } },
    ]) expect((await c.put('/api/settings/operations', { version: 0, settings: { documentSeries } })).statusCode).toBe(400);
    const saved = await c.put('/api/settings/operations', { version: 0, settings: { invoicePrintTemplate: 'simple' } }); expect(saved.statusCode, saved.body).toBe(200);
    expect((await c.put('/api/settings/operations', { version: 0, settings: {} })).statusCode).toBe(409);
    const format = await c.get('/api/settings/document-format'); expect(format.statusCode, format.body).toBe(200); expect(format.json()).toEqual({ invoicePrintTemplate: 'simple' });
    expect(format.body).not.toMatch(/requireMfa|documentSeries|automaticBackup/);
  });
  it('gerçek fatura eski numarayı korur; yeni numara tarihsel başka türle çakışınca güvenli409 ve rollback olur', async () => {
    const { c, ctx } = await setup('SeriFatura');
    const customer = (await c.post('/api/parties', { name: 'Seri müşterisi', kind: 'customer' })).json().party;
    const supplier = (await c.post('/api/parties', { name: 'Seri tedarikçisi', kind: 'supplier' })).json().party;
    const serviceResponse = await c.post('/api/items', { name: 'Seri hizmeti', kind: 'service' }); expect(serviceResponse.statusCode, serviceResponse.body).toBe(201);
    const line = { itemId: serviceResponse.json().item.id, description: 'Seri hizmeti', quantity: '1', unitPrice: '100' };
    const body = { type: 'sales', partyId: customer.id, currency: 'TRY', invoiceDate: '2026-06-15', lines: [line], post: true };
    const first = await c.post('/api/invoices', body); expect(first.statusCode, first.body).toBe(201); expect(first.json().invoice.invoiceNo).toBe('SF-2026-000001');
    const changed = await c.put('/api/settings/operations', { version: 0, settings: { documentSeries: { 'INV:sales': { prefix: 'SAT', padding: 3 }, 'INV:purchase': { prefix: 'SF', padding: 6 } } } }); expect(changed.statusCode, changed.body).toBe(200);
    const second = await c.post('/api/invoices', body); expect(second.statusCode, second.body).toBe(201); expect(second.json().invoice.invoiceNo).toBe('SAT-2026-002');
    expect((await c.get(`/api/invoices/${first.json().invoice.id}`)).json().invoice.invoiceNo).toBe('SF-2026-000001');
    const collision = await c.post('/api/invoices', { ...body, type: 'purchase', partyId: supplier.id, externalNo: 'FATURA-TARIHSEL-1' });
    expect(collision.statusCode, collision.body).toBe(409); expect(collision.json().error.code).toBe('DUPLICATE');
    const sequence = await withContext(handle.db, ctx, async tx => (await tx.execute(sql`select next_value from document_sequences where key='INV:purchase' and year=2026`)).rows);
    expect(sequence).toHaveLength(0);
  });
});
