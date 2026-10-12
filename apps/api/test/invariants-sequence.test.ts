import { describe, expect, it } from 'vitest';
import { client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';
import { expectCompanyInvariants } from './invariants';

/** Tekrarlanabilir sözde rastgele üreteç (mulberry32): başarısız tohum aynı diziyi yeniden üretir. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SaleDoc { id: string; lineId: string; qty: number; price: string; returned: number; cancelled: boolean }

/**
 * Öneri 120: geçerli işlem dizileri (alış, satış, kısmi iade, kısmi tahsilat, tahsilat ve fatura iptali) karışık sırayla
 * uygulanır; her adımdan sonra borç–alacak dengesi, stok, cari kapatma ve tahsis değişmezleri denetlenir. İş kuralının
 * reddetmesi gereken adımlar (ör. iadesi veya tahsilatı olan faturanın iptali) da denenir. Tutarlar test değeridir.
 */
describe('değişmez kurallar: karışık işlem dizileri', async () => {
  const { app } = await makeApp();

  for (const seed of [11, 29, 47]) {
    it(`tohum ${seed}: her adımdan sonra mali ve fiziksel tutarlılık korunur`, async () => {
      const random = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
      const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

      const s = await registerUser(app, `Degismez${seed}`);
      const company = await createCompany(app, s.token, { name: `Değişmez ${seed} Ltd.` });
      const c = client(app, s.token, company.id);
      const json = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, label: string) => {
        const r = await p;
        if (r.statusCode !== 200 && r.statusCode !== 201) throw new Error(`${label}: HTTP ${r.statusCode} ${r.body}`);
        return r.json();
      };
      const customer = (await json(c.post('/api/parties', { name: 'Müşteri', kind: 'customer' }), 'cari')).party.id as string;
      const supplier = (await json(c.post('/api/parties', { name: 'Tedarikçi', kind: 'supplier' }), 'cari')).party.id as string;
      const item = (await json(c.post('/api/items', { name: 'Kalem', vatCode: 'KDV-16' }), 'stok kartı')).item.id as string;
      const bank = (await json(c.post('/api/treasury/accounts', { kind: 'bank', name: 'Banka', currency: 'TRY' }), 'banka')).account.id as string;

      let onHand = 0;
      const sales: SaleDoc[] = [];
      const receipts: string[] = [];
      const log: string[] = [];
      for (let step = 0; step < 30; step++) {
        const date = day(3, 1 + Math.floor(step / 2));
        const live = sales.filter((x) => !x.cancelled);
        const op = pick(['purchase', 'purchase', 'sale', 'sale', 'return', 'receipt', 'cancelReceipt', 'cancelSale'] as const);
        if (op === 'purchase') {
          const qty = int(1, 8);
          await json(c.post('/api/invoices', { post: true, type: 'purchase', partyId: supplier, invoiceDate: date, externalNo: `A-${seed}-${step}`, lines: [{ itemId: item, description: 'Alış', quantity: String(qty), unitPrice: `${int(40, 60)}.25`, vatCode: 'KDV-16' }] }), `adım ${step} alış`);
          onHand += qty;
          log.push(`alış ${qty}`);
        } else if (op === 'sale') {
          if (onHand === 0) continue;
          const qty = int(1, onHand);
          const price = String(int(70, 90));
          const res = await json(c.post('/api/invoices', { post: true, type: 'sales', partyId: customer, invoiceDate: date, lines: [{ itemId: item, description: 'Satış', quantity: String(qty), unitPrice: price, vatCode: 'KDV-16' }] }), `adım ${step} satış`);
          sales.push({ id: res.invoice.id, lineId: res.lines[0].id, qty, price, returned: 0, cancelled: false });
          onHand -= qty;
          log.push(`satış ${qty}`);
        } else if (op === 'return') {
          const returnable = live.filter((x) => x.returned < x.qty);
          if (!returnable.length) continue;
          const sale = pick(returnable);
          const qty = int(1, sale.qty - sale.returned);
          await json(c.post('/api/invoices', { post: true, type: 'sales_return', partyId: customer, returnOfId: sale.id, invoiceDate: date, lines: [{ itemId: item, description: 'İade', quantity: String(qty), unitPrice: sale.price, vatCode: 'KDV-16', sourceLineId: sale.lineId }] }), `adım ${step} iade`);
          sale.returned += qty;
          onHand += qty;
          log.push(`iade ${qty}`);
        } else if (op === 'receipt') {
          const open = (await json(c.get(`/api/parties/${customer}/open-items?type=receivable&asOf=${date}`), 'açık kalem')).receivable.items as { lineId: string; remaining: string }[];
          const target = open.filter((x) => Number(x.remaining) >= 1);
          if (!target.length) continue;
          const line = pick(target);
          const amount = Math.max(0.01, Math.floor(Number(line.remaining) * (0.3 + random() * 0.7) * 100) / 100).toFixed(2);
          const res = await json(c.post('/api/treasury/transactions', { type: 'receipt', date, accountId: bank, amount, partyId: customer, items: [{ lineId: line.lineId, amount, settleAmount: amount }] }), `adım ${step} tahsilat`);
          receipts.push(res.transaction.id);
          log.push(`tahsilat ${amount}`);
        } else if (op === 'cancelReceipt') {
          if (!receipts.length) continue;
          const id = receipts.splice(Math.floor(random() * receipts.length), 1)[0]!;
          await json(c.post(`/api/treasury/transactions/${id}/cancel`, { reason: 'Değişmez testi', date }), `adım ${step} tahsilat iptali`);
          log.push('tahsilat iptali');
        } else {
          if (!live.length) continue;
          const sale = pick(live);
          const r = await c.post(`/api/invoices/${sale.id}/cancel`, { reason: 'Değişmez testi', date });
          if (r.statusCode === 200) {
            // İadesi olan satış iptal edilemez (önce iade iptal edilir)
            expect(sale.returned, `adım ${step}: iadesi olan satış iptal edildi`).toBe(0);
            sale.cancelled = true;
            onHand += sale.qty;
          } else {
            expect(r.statusCode, `adım ${step} fatura iptali: ${r.body}`).toBe(422);
            expect(['INVOICE_HAS_PAYMENTS', 'INVOICE_HAS_RETURNS'], `adım ${step} beklenmeyen iptal reddi: ${r.body}`).toContain(r.json().error.code);
          }
          log.push(`fatura iptali ${r.statusCode}`);
        }
        await expectCompanyInvariants(company.id, `tohum ${seed}, adım ${step}: ${log.join(' → ')}`);
      }
      // Model ile sistem aynı eldeki miktarı göstermeli (stok miktarı hareket toplamından türetilir)
      const stock = await execAsOwner('select coalesce(sum(qty), 0)::text as qty from stock_movements where company_id = $1 and item_id = $2', [company.id, item]);
      expect(Number(stock.rows[0].qty), log.join(' → ')).toBe(onHand);
    });
  }
});
