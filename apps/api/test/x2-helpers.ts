import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PASSWORD, accountIds, client, createCompany, day, orgOf, registerUser } from './helpers';

/** X2 testleri ortak kurulum ve kısayolları: şirket, cari, stok kartı, irsaliye, fatura, yevmiye okuma. */
export function x2Kit(app: FastifyInstance) {
  async function setup(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const warehouses = (await c.get('/api/warehouses')).json().warehouses as { id: string; isDefault: boolean }[];
    const main = warehouses.find((w) => w.isDefault)!;
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, main, ids, orgId: await orgOf(app, s.token) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];

  const mkParty = async (c: C, name: string, kind = 'customer', extra: Record<string, unknown> = {}) => {
    const res = await c.post('/api/parties', { name, kind, ...extra });
    if (res.statusCode !== 201) throw new Error(`party failed: ${res.body}`);
    return res.json().party as { id: string; code: string };
  };
  const mkItem = async (c: C, name: string, extra: Record<string, unknown> = {}) => {
    const res = await c.post('/api/items', { name, vatCode: 'KDV-16', ...extra });
    if (res.statusCode !== 201) throw new Error(`item failed: ${res.body}`);
    return res.json().item as { id: string; code: string };
  };
  const receipt = async (c: C, date: string, wh: string, itemId: string, qty: string, unitCost: string) => {
    const res = await c.post('/api/stock-documents', { type: 'receipt', docDate: date, warehouseId: wh, lines: [{ itemId, quantity: qty, unitCost }] });
    if (res.statusCode !== 201) throw new Error(`receipt failed: ${res.body}`);
  };
  const dline = (itemId: string, quantity: string, extra: Record<string, unknown> = {}) => ({ itemId, quantity, ...extra });
  const note = (c: C, body: Record<string, unknown>) => c.post('/api/delivery-notes', body);
  const posted = async (c: C, body: Record<string, unknown>) => {
    const res = await note(c, { post: true, ...body });
    if (res.statusCode !== 201) throw new Error(`delivery note failed: ${res.body}`);
    return res.json() as { note: any; lines: any[]; invoices: any[]; returns: any[] };
  };
  const getNote = async (c: C, id: string) => (await c.get(`/api/delivery-notes/${id}`)).json() as { note: any; lines: any[]; invoices: any[]; returns: any[] };
  const invLine = (itemId: string | null, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) => ({
    itemId,
    description: 'Kalem',
    quantity,
    unitPrice,
    vatCode: 'KDV-16',
    ...extra,
  });
  const invPosted = async (c: C, body: Record<string, unknown>) => {
    const res = await c.post('/api/invoices', { post: true, ...body });
    if (res.statusCode !== 201) throw new Error(`invoice failed: ${res.body}`);
    return res.json() as { invoice: any; lines: any[] };
  };
  const journalOf = async (c: C, id: string) => {
    const e = (await c.get(`/api/journal-entries/${id}`)).json().entry;
    const lines = e.lines.map((l: any) => [l.accountCode, Number(l.debitBase), Number(l.creditBase)] as const);
    return { entry: e, lines, byCode: (code: string) => lines.filter((l: readonly [string, number, number]) => l[0] === code) };
  };
  const stockInfo = async (c: C, id: string) => (await c.get(`/api/items/${id}`)).json().stock as { qty: string; value: string };
  const recon = async (c: C, asOf = day(12, 31)) => (await c.get(`/api/reports/stock-status?asOf=${asOf}`)).json().ledger;

  async function memberClient(owner: C, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Kişi`, role, password: PASSWORD, mustChangePassword: false });
    if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return client(app, login.json().accessToken as string, companyId);
  }

  return { setup, mkParty, mkItem, receipt, dline, note, posted, getNote, invLine, invPosted, journalOf, stockInfo, recon, memberClient };
}
