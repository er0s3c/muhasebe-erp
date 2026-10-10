/**
 * Yük ölçümü için büyük örnek veri üretir: gerçek servisleri (RLS, tetikleyiciler, numaralama dahil) süreç içinde
 * `app.inject` ile çağırır; bu yüzden üretilen veri gerçek kullanımla aynı kurallardan geçer.
 *
 * Hazırlık (tek seferlik, ayrı bir veritabanı):
 *   su postgres -c "psql -c 'CREATE DATABASE erp_load OWNER erp'"
 *   MIGRATION_DATABASE_URL=postgres://erp:erp@localhost:5432/erp_load npm run db:migrate
 * Çalıştırma:
 *   DATABASE_URL=postgres://erp_app:erp_app@localhost:5432/erp_load JWT_SECRET=... npm run load:gen
 * Ölçüt (ortam değişkenleriyle): LOAD_PARTIES=1500 LOAD_ITEMS=400 LOAD_INVOICES=2500 LOAD_ENTRIES=4000 LOAD_CONCURRENCY=6
 */
import { buildApp } from '../apps/api/src/app';
import { loadConfig } from '../apps/api/src/config';
import { createDb } from '../apps/api/src/db/client';

const N = {
  parties: Number(process.env.LOAD_PARTIES ?? 1500),
  items: Number(process.env.LOAD_ITEMS ?? 400),
  invoices: Number(process.env.LOAD_INVOICES ?? 2500),
  entries: Number(process.env.LOAD_ENTRIES ?? 4000),
  treasury: Number(process.env.LOAD_TREASURY ?? 800),
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 6),
};
const EMAIL = process.env.LOAD_EMAIL ?? 'load@example.com';
const PASSWORD = process.env.LOAD_PASSWORD ?? 'Yuk-Testi-Sifre-8842';

const config = loadConfig({ ...process.env, NODE_ENV: 'development', RATE_LIMIT_ENABLED: 'false' });
const handle = createDb(config.DATABASE_URL, { max: N.concurrency + 2 });
const app = await buildApp({ db: handle.db, config, logger: false });
await app.ready();

// Yeniden üretilebilir sözde rastgelelik
let seed = 20260930;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const pad = (n: number) => String(n).padStart(2, '0');
const year = new Date().getUTCFullYear();
const randomDate = () => `${year}-${pad(1 + Math.floor(rnd() * 9))}-${pad(1 + Math.floor(rnd() * 28))}`;

async function call(method: 'GET' | 'POST' | 'PUT', url: string, token: string, companyId: string | null, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(companyId ? { 'x-company-id': companyId } : {}) },
    payload: payload as object | undefined,
  });
  return res;
}

async function pool<T>(count: number, work: (i: number) => Promise<T>, label: string): Promise<T[]> {
  const out: T[] = new Array(count);
  let next = 0;
  let done = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: N.concurrency }, async () => {
      while (next < count) {
        const i = next++;
        out[i] = await work(i);
        if (++done % 500 === 0) console.log(`  ${label}: ${done}/${count} (${Math.round((Date.now() - started) / 1000)} sn)`);
      }
    }),
  );
  return out;
}

// --- Kullanıcı ve şirket ---
let login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } });
if (login.statusCode !== 200) {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: EMAIL, password: PASSWORD, fullName: 'Yük Testi', organizationName: 'Yük Holding' },
  });
  if (reg.statusCode !== 201) throw new Error(`kayıt başarısız: ${reg.body}`);
  login = reg;
}
const token = login.json().accessToken as string;
const me = (await call('GET', '/api/me', token, null)).json();
let company = (me.companies as { id: string; name: string }[]).find((c) => c.name === 'Yük İnşaat Ltd.');
if (!company) {
  const res = await call('POST', '/api/companies', token, null, { name: 'Yük İnşaat Ltd.', sector: 'CONSTRUCTION', jurisdiction: 'KKTC' });
  if (res.statusCode !== 201) throw new Error(`şirket başarısız: ${res.body}`);
  company = res.json().company;
}
const cid = company!.id;
const get = async (url: string) => (await call('GET', url, token, cid)).json();
const post = (url: string, body: unknown) => call('POST', url, token, cid, body);

const existing = (await get('/api/parties?limit=1')).total as number;
if (existing > 0) {
  console.log(`Veri zaten var (${existing} cari); yeniden üretilmiyor. Sıfırdan için erp_load veritabanını yeniden oluşturun.`);
  console.log(JSON.stringify({ email: EMAIL, password: PASSWORD, companyId: cid }));
  await app.close();
  await handle.close();
  process.exit(0);
}

const ids: Record<string, string> = {};
for (const a of (await get('/api/accounts')).accounts as { code: string; id: string }[]) ids[a.code] = a.id;
const warehouse = ((await get('/api/warehouses')).warehouses as { id: string; isDefault: boolean }[]).find((w) => w.isDefault)!;

console.log(`Cariler (${N.parties})…`);
const parties = await pool(
  N.parties,
  async (i) => {
    const kind = i % 3 === 0 ? 'supplier' : 'customer';
    const r = await post('/api/parties', { name: `${kind === 'supplier' ? 'Tedarikçi' : 'Müşteri'} ${String(i).padStart(5, '0')} ${pick(['İnşaat', 'Ticaret', 'Yapı', 'Nakliyat', 'Metal'])} Ltd.`, kind, paymentTermDays: 30 });
    if (r.statusCode !== 201) throw new Error(`cari: ${r.body}`);
    return { id: r.json().party.id as string, kind };
  },
  'cari',
);
const customers = parties.filter((p) => p.kind === 'customer');
const suppliers = parties.filter((p) => p.kind === 'supplier');

console.log(`Stok kartları (${N.items}) ve devir girişleri…`);
const items = await pool(
  N.items,
  async (i) => {
    const r = await post('/api/items', { name: `Malzeme ${String(i).padStart(4, '0')} ${pick(['Çimento', 'Demir', 'Tuğla', 'Boya', 'Kablo', 'Boru'])}`, vatCode: 'KDV-16', unit: 'adet' });
    if (r.statusCode !== 201) throw new Error(`stok kartı: ${r.body}`);
    return r.json().item.id as string;
  },
  'stok kartı',
);
for (let i = 0; i < items.length; i += 100) {
  const r = await post('/api/stock-documents', {
    type: 'receipt',
    docDate: `${year}-01-05`,
    warehouseId: warehouse.id,
    lines: items.slice(i, i + 100).map((itemId) => ({ itemId, quantity: '100000', unitCost: String(5 + Math.floor(rnd() * 90)) })),
  });
  if (r.statusCode !== 201) throw new Error(`stok girişi: ${r.body}`);
}

console.log(`Faturalar (${N.invoices})…`);
await pool(
  N.invoices,
  async () => {
    const sales = rnd() < 0.6;
    const party = pick(sales ? customers : suppliers);
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
      itemId: pick(items),
      description: 'Kalem',
      quantity: String(1 + Math.floor(rnd() * 20)),
      unitPrice: String(10 + Math.floor(rnd() * 200)),
      vatCode: 'KDV-16',
    }));
    const r = await post('/api/invoices', {
      post: true,
      type: sales ? 'sales' : 'purchase',
      partyId: party.id,
      invoiceDate: randomDate(),
      ...(sales ? {} : { externalNo: `T-${Math.floor(rnd() * 1e9)}` }),
      lines,
    });
    if (r.statusCode !== 201) throw new Error(`fatura: ${r.body}`);
  },
  'fatura',
);

console.log(`Elle yevmiye kayıtları (${N.entries})…`);
const expense = [ids['632']!, ids['710']!, ids['770']!].filter(Boolean);
await pool(
  N.entries,
  async (i) => {
    const amount = String(50 + Math.floor(rnd() * 5000));
    const r = await post('/api/journal-entries', {
      entryDate: randomDate(),
      description: `Yük testi gideri ${i}`,
      post: true,
      lines: [
        { accountId: pick(expense), currency: 'TRY', debit: amount },
        { accountId: ids['100']!, currency: 'TRY', credit: amount },
      ],
    });
    if (r.statusCode !== 201) throw new Error(`yevmiye: ${r.body}`);
  },
  'yevmiye',
);

console.log(`Kasa/banka hareketleri (${N.treasury})…`);
const bank = await post('/api/treasury/accounts', { kind: 'bank', name: 'Yük bankası TL', currency: 'TRY' });
if (bank.statusCode === 201) {
  const bankId = bank.json().account.id as string;
  await pool(
    N.treasury,
    async () => {
      const r = await post('/api/treasury/transactions', {
        type: rnd() < 0.7 ? 'other_receipt' : 'other_payment',
        date: randomDate(),
        accountId: bankId,
        amount: String(100 + Math.floor(rnd() * 3000)),
        glAccountId: ids['500'],
      });
      if (r.statusCode !== 201 && r.statusCode !== 422) throw new Error(`hareket: ${r.body}`);
    },
    'hareket',
  );
}

console.log('Hazır. Ölçüm için:');
console.log(JSON.stringify({ email: EMAIL, password: PASSWORD, companyId: cid }));
await app.close();
await handle.close();
