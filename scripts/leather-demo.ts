/** Creates a new, isolated demo company through the real API; never edits an existing company's data. */
import { randomUUID } from 'node:crypto';
import { todayIso } from '@erp/shared';

const base = process.env.LEATHER_DEMO_BASE_URL ?? 'http://localhost:3000';
const email = process.env.LEATHER_DEMO_EMAIL;
const password = process.env.LEATHER_DEMO_PASSWORD;
if (!email || !password) throw new Error('LEATHER_DEMO_EMAIL ve LEATHER_DEMO_PASSWORD ile mevcut yönetici hesabını belirtin.');
const date = todayIso();
const suffix = Date.now().toString();
let token = '';
let companyId = '';
async function request<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(new URL(path, base), {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(companyId ? { 'x-company-id': companyId } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
type Entity = { id: string };
const dated = (fields: Record<string, unknown> = {}) => ({ date, requestKey: randomUUID(), note: 'Deri kabul demosu', ...fields });
token = (await request<{ accessToken: string }>('/api/auth/login', { email, password })).accessToken;
const company = await request<{ company: Entity }>('/api/companies', { name: `Deri atölyesi demo ${suffix}`, sector: 'LEATHER_FASHION' });
companyId = company.company.id;
console.log(`Yeni demo şirketi: ${companyId}`);
const warehouseId = (await request<{ warehouses: Entity[] }>('/api/warehouses')).warehouses[0]!.id;
const party = async (name: string, kind: 'supplier' | 'customer') => (await request<{ party: Entity }>('/api/parties', { name, kind })).party.id;
const supplierId = await party('İtalyan tabakhane demo', 'supplier');
const customerId = await party('Deri aksesuar müşterisi demo', 'customer');
const rawId = (await request<{ item: Entity }>('/api/items', { name: 'Bitkisel tabaklanmış dana derisi', unit: 'm2', inventoryRole: 'raw_material' })).item.id;
const itemId = (await request<{ item: Entity }>('/api/items', { name: 'Taba deri cüzdan', unit: 'adet', inventoryRole: 'finished_goods', barcode: `DEMO-${suffix}`, salePrice: '400', saleCurrency: 'TRY' })).item.id;
const model = (await request<{ model: Entity }>('/api/leather/catalog/models', { code: 'CZD-01', name: 'Klasik cüzdan', family: 'wallet' })).model;
const revision = (await request<{ revision: Entity }>(`/api/leather/catalog/models/${model.id}/revisions`, {
  name: 'Numune onaylı ilk üretim', sampleApproved: true,
  materials: [{ itemId: rawId, quantity: '0.5' }],
  operations: [{ key: 'cutting', name: 'Kesim', station: 'Kesim masası', plannedMinutes: '4' }, { key: 'stitching', name: 'Dikiş', station: 'Dikiş masası', plannedMinutes: '10' }],
  specifications: { dimensions: '11 × 9 cm', leather: 'İtalyan kök deri, 1.2–1.4 mm' },
})).revision;
await request(`/api/leather/catalog/revisions/${revision.id}/approve`, {});
const variant = (await request<{ variant: Entity }>('/api/leather/catalog/variants', { modelId: model.id, revisionId: revision.id, itemId, color: 'Taba', allowsPersonalization: true })).variant;
const lot = (await request<{ lot: Entity & { deliveryLineId: string } }>('/api/leather/materials/receipts', {
  partyId: supplierId, itemId: rawId, warehouseId, date, externalNo: `DEMO-${suffix}`, provisionalUnitCost: '100',
  tanning: 'vegetable', country: 'İtalya', tannery: 'Demo tabakhane', pieces: [{ code: 'DERI-01', area: '10', thicknessMin: '1.2', thicknessMax: '1.4' }],
})).lot;
const pieces = (await request<{ pieces: (Entity & { lotId: string; parentId: string | null })[] }>('/api/leather/materials/pieces')).pieces;
const piece = pieces.find(p => p.lotId === lot.id)!;
await request(`/api/leather/materials/pieces/${piece.id}/accept`, { decision: 'accept', note: 'Ton ve yüzey kontrolü uygun' });
const order = (await request<{ order: Entity }>('/api/leather/production/orders', { variantId: variant.id, revisionId: revision.id, warehouseId, outputWarehouseId: warehouseId, quantity: '16', dueDate: date })).order;
await request(`/api/leather/production/orders/${order.id}/release`, dated());
await request('/api/leather/materials/cuts', dated({ orderId: order.id, pieceId: piece.id, usedArea: '8', wasteArea: '0', setsProduced: 16, remnants: [{ code: 'KALAN-01', area: '2' }] }));
async function complete(quantity: string, final = false) {
  const check = (await request<{ check: Entity }>('/api/leather/quality/checks', { scope: 'production', sourceId: order.id, stage: 'final', inspectedQty: quantity, passedQty: quantity, checks: [{ label: 'Dikiş, kenar ve son ölçü', passed: true }] })).check;
  await request(`/api/leather/quality/checks/${check.id}/decision`, { decision: 'approve', note: 'Son kalite serbest bırakma' });
  await request(`/api/leather/production/orders/${order.id}/completions`, dated({ quantity, qualityCheckId: check.id, final }));
}
await complete('10');
const sale = await request<{ invoice: Entity; lines: Entity[] }>('/api/invoices', { type: 'sales', partyId: customerId, warehouseId, invoiceDate: date, post: true, lines: [{ itemId, description: 'Taba deri cüzdan', quantity: '5', unitPrice: '400' }] });
const cash = (await request<{ account: Entity }>('/api/treasury/accounts', { name: 'Demo mağaza nakit', kind: 'cash', currency: 'TRY' })).account;
await request('/api/treasury/transactions', { type: 'receipt', accountId: cash.id, partyId: customerId, date, amount: '2000', description: 'Demo cüzdan satışı tahsilatı' });
await request('/api/invoices', { type: 'purchase', partyId: supplierId, warehouseId, invoiceDate: date, externalNo: `FAT-${suffix}`, post: true, lines: [{ itemId: rawId, description: 'Bitkisel tabaklanmış dana derisi', quantity: '10', unitPrice: '200', deliveryLineId: lot.deliveryLineId }] });
const corrections = await request<{ corrections: { amount: string; config: { destinations: { target: string; amount: string }[] } }[] }>('/api/leather/costs/corrections');
const split = corrections.corrections.find(c => Number(c.amount) === 1000)!.config.destinations;
console.table(split.map(d => ({ hedef: d.target, fark: d.amount })));
if (split.map(d => Number(d.amount)).sort((a, b) => a - b).join(',') !== '200,250,250,300') throw new Error('Geç maliyet dağılımı 200/300/250/250 ile uyuşmuyor.');
await complete('6', true);
const serviceCase = (await request<{ serviceCase: Entity }>('/api/leather/service/cases', { partyId: customerId, itemId, invoiceLineId: sale.lines[0]!.id, date, complaint: 'Dikiş kontrolü', warranty: true })).serviceCase;
const service = (action: string, fields: Record<string, unknown> = {}) => request(`/api/leather/service/cases/${serviceCase.id}/actions`, dated({ action, ...fields }));
await service('diagnose', { assessment: 'Garanti kapsamında dikiş bakımı', fee: '0' });
await service('approve_repair', { approvalReference: 'Demo müşteri imzalı servis kabulü' });
await service('repair');
await service('ready');
await service('deliver');
const status = await request<{ ledger: { unexplained: string; workInProgress: string } }>(`/api/reports/stock-status?asOf=${date}`);
if (Number(status.ledger.unexplained) !== 0 || Number(status.ledger.workInProgress) !== 0) throw new Error(`Mutabakat başarısız: ${JSON.stringify(status.ledger)}`);
console.log(`Kabul demosu tamamlandı. Şirket ${companyId}; üretim ${order.id}; satış ${sale.invoice.id}; servis ${serviceCase.id}.`);
