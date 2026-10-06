import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { activations, auditLog, customers, licenses } from '../src/db/schema';
import { CSRF_HEADER, CSRF_VALUE } from '../src/modules/admin-auth';
import { deleteCustomer } from '../src/modules/licenses';
import { activate, adminClient, heartbeat, issueLicense, makeInstallation, makeServer } from './helpers';

const s = await makeServer();
const licenseInput = (customerId: string) => ({ customerId, sectors: ['COMMERCE'], deviceLimit: 1, validUntil: '2030-12-31' });

describe('müşteri silme', () => {
  it('oturum, CSRF ve köken doğrulaması olmadan müşteri silinmez', async () => {
    const c = await adminClient(s);
    const customer = (await c.post('/admin/api/customers', { name: 'Korumalı müşteri' })).json().customer;
    const url = `/admin/api/customers/${customer.id}`;
    expect((await s.app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'DELETE', url, cookies: { lic_admin: c.cookie } })).statusCode).toBe(403);
    expect((await s.app.inject({ method: 'DELETE', url, cookies: { lic_admin: c.cookie }, headers: { [CSRF_HEADER]: CSRF_VALUE, origin: 'https://other.example' } })).statusCode).toBe(403);
    expect((await c.get(url)).statusCode).toBe(200);
  });

  it('lisansı olmayan müşteri silinir; özet güncellenir ve yönetici denetim kaydı korunur', async () => {
    const c = await adminClient(s);
    const customer = (await c.post('/admin/api/customers', { name: `Silinecek ${randomUUID()}` })).json().customer;
    const before = (await c.get('/admin/api/dashboard')).json().customers;
    expect((await c.del(`/admin/api/customers/${customer.id}`)).json()).toEqual({ ok: true, deleted: { name: customer.name, licenseCount: 0, activationCount: 0 } });
    expect((await c.get(`/admin/api/customers/${customer.id}`)).statusCode).toBe(404);
    expect((await c.get('/admin/api/customers')).json().customers.map((row: { id: string }) => row.id)).not.toContain(customer.id);
    expect((await c.get('/admin/api/dashboard')).json().customers).toBe(before - 1);
    const entries = await s.handle.db.select().from(auditLog).where(eq(auditLog.targetId, customer.id));
    expect(entries.map((row) => row.action)).toEqual(['customer.create', 'customer.delete']);
    expect(entries[1]).toMatchObject({ actor: 'admin', meta: { name: customer.name, licenseCount: 0, activationCount: 0 } });
    expect(entries[1]!.adminId).toBeTruthy();
    expect((await c.del(`/admin/api/customers/${customer.id}`)).statusCode).toBe(404);
    expect((await c.del('/admin/api/customers/invalid-id')).statusCode).toBe(400);
  });

  it('etkin veya iptal edilmiş lisans ve etkinleştirmeler tamamen silinir; diğer müşteriler korunur', async () => {
    const c = await adminClient(s);
    const unrelated = await issueLicense(s);
    const untouched = (await c.get(`/admin/api/licenses/${unrelated.license.id}`)).json();
    for (const revoked of [false, true]) {
      const customer = (await c.post('/admin/api/customers', { name: 'Lisans geçmişli müşteri' })).json().customer;
      const { license, activationCode } = (await c.post('/admin/api/licenses', licenseInput(customer.id))).json();
      const installation = makeInstallation();
      expect((await activate(s, installation, activationCode)).res.statusCode).toBe(200);
      if (revoked) expect((await c.post(`/admin/api/licenses/${license.id}/revoke`)).statusCode).toBe(200);
      const details = (await c.get(`/admin/api/customers/${customer.id}`)).json();
      expect(details.activationCount).toBe(1);
      expect(details.licenses).toHaveLength(1);
      const response = await c.del(`/admin/api/customers/${customer.id}`);
      expect(response.statusCode).toBe(200);
      expect(response.json().deleted).toMatchObject({ licenseCount: 1, activationCount: 1 });
      expect((await c.get(`/admin/api/customers/${customer.id}`)).statusCode).toBe(404);
      expect((await c.get(`/admin/api/licenses/${license.id}`)).statusCode).toBe(404);
      expect(await s.handle.db.select().from(activations).where(eq(activations.licenseId, license.id))).toHaveLength(0);
      expect((await heartbeat(s, installation)).res.statusCode).toBe(404);
      expect((await activate(s, installation, activationCode)).res.statusCode).toBeGreaterThanOrEqual(400);
      expect(await s.handle.db.select().from(auditLog).where(and(eq(auditLog.targetId, customer.id), eq(auditLog.action, 'customer.delete')))).toHaveLength(1);
    }
    expect((await c.get(`/admin/api/licenses/${unrelated.license.id}`)).json()).toEqual(untouched);
  });

  it('eşzamanlı lisans verme ve silme yetim lisans veya beklenmeyen hata üretmez', async () => {
    const c = await adminClient(s);
    const customer = (await c.post('/admin/api/customers', { name: 'Eşzamanlı müşteri' })).json().customer;
    const [removed, issued] = await Promise.all([
      c.del(`/admin/api/customers/${customer.id}`),
      c.post('/admin/api/licenses', licenseInput(customer.id)),
    ]);
    expect([[200, 404], [200, 201]]).toContainEqual([removed.statusCode, issued.statusCode]);
    const rows = await s.handle.db.select().from(licenses).where(eq(licenses.customerId, customer.id));
    const owners = await s.handle.db.select().from(customers).where(eq(customers.id, customer.id));
    expect(rows).toHaveLength(0);
    expect(owners).toHaveLength(0);
  });

  it('işlem tamamlanamazsa müşteri, lisans, etkinleştirme ve denetim kaydı birlikte geri döner', async () => {
    const c = await adminClient(s);
    const issued = await issueLicense(s);
    expect((await activate(s, makeInstallation(), issued.code)).res.statusCode).toBe(200);
    const before = (await c.get(`/admin/api/licenses/${issued.license.id}`)).json();
    await expect(s.handle.db.transaction(async (tx) => {
      await deleteCustomer(tx, issued.customer.id, { actor: 'cli' });
      throw new Error('test-only-rollback');
    })).rejects.toThrow('test-only-rollback');
    expect((await c.get(`/admin/api/customers/${issued.customer.id}`)).statusCode).toBe(200);
    expect((await c.get(`/admin/api/licenses/${issued.license.id}`)).json()).toEqual(before);
    expect(await s.handle.db.select().from(auditLog).where(and(eq(auditLog.targetId, issued.customer.id), eq(auditLog.action, 'customer.delete')))).toHaveLength(0);
  });
});
