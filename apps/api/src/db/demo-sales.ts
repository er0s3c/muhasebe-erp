/**
 * Demo verisi: satış tarafı tamamlayıcıları (fiyat listeleri, cariye özel fiyat, teklif ve siparişler, siparişten irsaliye/fatura,
 * toplu faturalama). `seedDemo` sonunda çağrılır; "bu ay" göstergeleri dolsun diye son günlerin tarihlerini kullanır
 * (ay başından önceye taşmaz). Her şey gerçek servis akışlarıyla girilir; yevmiye/stok kayıtları otomatik oluşur.
 */
import { sql } from 'drizzle-orm';
import { todayIso, type CreateSalesDocInput } from '@erp/shared';
import type { Tx } from './client';
import { items } from './schema';
import { postDeliveryNote } from '../modules/deliveries/posting';
import type { DeliveryCtx } from '../modules/deliveries/service';
import { postInvoice } from '../modules/invoices/posting';
import type { InvoiceCtx } from '../modules/invoices/service';
import { runBatch } from '../modules/sales/batch';
import { orderToDelivery, orderToInvoice } from '../modules/sales/convert';
import { convertQuote, createSalesDoc, transitionSalesDoc, type SalesCtx } from '../modules/sales/orders';
import { addPartyPrice, addPriceListItem, copyPriceList, createPriceList, setPartyPricing } from '../modules/sales/pricelists';
import type { LedgerCtx } from '../modules/ledger/journal';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function seedSales(tx: Tx, ctx: LedgerCtx, partyId: Map<string, string>): Promise<string> {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  /** `n` gün önce; ay başından önceye taşmaz (bu ay göstergeleri dolu kalsın). */
  const recent = (n: number) => {
    const d = addDays(today, -n);
    return d < monthStart ? monthStart : d;
  };

  const itemRows = await tx.select({ id: items.id, name: items.name }).from(items);
  const byName = (part: string) => {
    const r = itemRows.find((i) => i.name.includes(part));
    if (!r) throw new Error(`Demo stok kartı yok: ${part}`);
    return r.id;
  };
  const demir = byName('demiri');
  const cimento = byName('Çimento');
  const kum = byName('kum');
  const beton = byName('beton');
  const boya = byName('boyası');
  const kablo = byName('kablo');
  const seramik = byName('seramik');
  const nakliye = byName('nakliye');

  // ---- Fiyat listeleri ----------------------------------------------------------------------
  const retail = await createPriceList(tx, ctx.companyId, { code: 'PER-2026', name: 'Perakende satış listesi', kind: 'sales', currency: 'TRY', isActive: true, isDefault: true, notes: 'Genel satış fiyatları (KDV hariç)' });
  for (const [itemId, price] of [
    [demir, '8200'], [cimento, '240'], [kum, '800'], [beton, '640'], [boya, '1100'], [kablo, '19'], [nakliye, '250'],
  ] as const) {
    await addPriceListItem(tx, ctx.companyId, retail.id, { itemId, minQty: '0', price });
  }
  // Miktar kademesi: 100+ çuval çimentoda daha düşük fiyat
  await addPriceListItem(tx, ctx.companyId, retail.id, { itemId: cimento, minQty: '100', price: '225' });
  const project = await copyPriceList(tx, ctx.companyId, retail.id, { code: 'PRJ-2026', name: 'Proje / toptan liste (−%5)', adjustPct: '-5', decimals: 2 });
  const purchaseList = await createPriceList(tx, ctx.companyId, { code: 'ALIS-2026', name: 'Tedarikçi alış fiyatları', kind: 'purchase', currency: 'TRY', isActive: true, isDefault: true, notes: null });
  for (const [itemId, price] of [[demir, '7000'], [cimento, '180'], [beton, '520'], [kablo, '14.5']] as const) {
    await addPriceListItem(tx, ctx.companyId, purchaseList.id, { itemId, minQty: '0', price });
  }

  // Cari ayarları ve cariye özel fiyatlar
  await setPartyPricing(tx, partyId.get('ali')!, { salesPriceListId: retail.id, salesDiscountPct: '2' });
  await setPartyPricing(tx, partyId.get('usta')!, { salesPriceListId: project.id });
  await setPartyPricing(tx, partyId.get('demir')!, { purchasePriceListId: purchaseList.id });
  await setPartyPricing(tx, partyId.get('beton')!, { purchasePriceListId: purchaseList.id, purchaseDiscountPct: '3' });
  await addPartyPrice(tx, ctx.companyId, { partyId: partyId.get('ali')!, itemId: boya, kind: 'sales', currency: 'TRY', price: '1050', discountPct: null, minQty: '20', validFrom: `${today.slice(0, 4)}-01-01`, validTo: null });
  await addPartyPrice(tx, ctx.companyId, { partyId: partyId.get('sarah')!, itemId: seramik, kind: 'sales', currency: 'GBP', price: '19', discountPct: null, minQty: '0', validFrom: null, validTo: null });
  await addPartyPrice(tx, ctx.companyId, { partyId: partyId.get('beton')!, itemId: beton, kind: 'purchase', currency: null, price: null, discountPct: '5', minQty: '100', validFrom: null, validTo: null });

  // ---- Teklifler ve siparişler -------------------------------------------------------------------
  const sctx: SalesCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency };
  const dctx: DeliveryCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency, reportingCurrency: ctx.reportingCurrency, allowNegativeStock: false };
  const ictx: InvoiceCtx = { ...dctx };
  const line = (itemId: string | null, quantity: string, unitPrice: string, extra: { description?: string; discountPct?: string } = {}) => ({ itemId, quantity, unitPrice, vatCode: 'KDV-16', ...extra });
  const doc = (input: Partial<CreateSalesDocInput> & Pick<CreateSalesDocInput, 'kind' | 'partyId' | 'docDate' | 'lines'>) => createSalesDoc(tx, sctx, { vatIncluded: false, ...input } as CreateSalesDocInput);

  // 1) Kabul edilip siparişe dönüşen teklif; sipariş onaylı, kısmen teslim edildi ve faturalandı (bu ay)
  const q1 = await doc({
    kind: 'quote', partyId: partyId.get('ali')!, docDate: addDays(today, -35), validUntil: addDays(today, 25), notes: 'Ödeme: teslimde havale. Fiyatlar KDV hariçtir.',
    lines: [line(boya, '20', '1050'), line(nakliye, '6', '250', { description: 'Boya nakliyesi' })],
  });
  await transitionSalesDoc(tx, sctx, q1, 'sent');
  await transitionSalesDoc(tx, sctx, q1, 'accepted');
  const o1 = await convertQuote(tx, sctx, q1);
  const order1 = typeof o1 === 'string' ? o1 : (o1 as { id?: string; orderId?: string }).id ?? (o1 as { orderId: string }).orderId;
  await transitionSalesDoc(tx, sctx, order1, 'confirmed');
  const d1 = await orderToDelivery(tx, dctx, order1, { noteDate: recent(3), lines: undefined });
  await postDeliveryNote(tx, dctx, (d1 as { id?: string }).id ?? String(d1));
  const inv1 = await orderToInvoice(tx, ictx, order1, { invoiceDate: recent(2), includeUndelivered: false });
  await postInvoice(tx, ictx, typeof inv1 === 'string' ? inv1 : (inv1 as { id: string }).id);

  // 2) Gönderilmiş, yanıt bekleyen teklif (GBP)
  const q2 = await doc({
    kind: 'quote', partyId: partyId.get('sarah')!, docDate: recent(6), validUntil: addDays(today, 20), currency: 'GBP',
    lines: [line(seramik, '250', '19', { discountPct: '3' })],
  });
  await transitionSalesDoc(tx, sctx, q2, 'sent');
  // 3) Reddedilmiş teklif, taslak teklif, süresi geçmiş (gönderilmiş) teklif
  const q3 = await doc({ kind: 'quote', partyId: partyId.get('usta')!, docDate: addDays(today, -50), validUntil: addDays(today, -20), lines: [line(demir, '10', '7800')] });
  await transitionSalesDoc(tx, sctx, q3, 'sent');
  await transitionSalesDoc(tx, sctx, q3, 'rejected');
  await doc({ kind: 'quote', partyId: partyId.get('ali')!, docDate: recent(1), validUntil: addDays(today, 30), lines: [line(cimento, '300', '225'), line(kum, '40', '800')] });

  // 4) Onaylı sipariş (henüz teslim yok) ve taslak sipariş
  const o2 = await doc({ kind: 'order', partyId: partyId.get('usta')!, docDate: recent(4), deliveryDate: addDays(today, 10), lines: [line(demir, '12', '7790'), line(kablo, '300', '18')], notes: 'Teslim: şantiye deposu' });
  await transitionSalesDoc(tx, sctx, o2, 'confirmed');
  await doc({ kind: 'order', partyId: partyId.get('ali')!, docDate: recent(0), deliveryDate: addDays(today, 20), lines: [line(boya, '25', '1050')] });
  const cancelled = await doc({ kind: 'order', partyId: partyId.get('sarah')!, docDate: addDays(today, -15), currency: 'GBP', lines: [line(seramik, '60', '19')] });
  await transitionSalesDoc(tx, sctx, cancelled, 'confirmed');
  await transitionSalesDoc(tx, sctx, cancelled, 'cancelled', 'Müşteri projeyi erteledi');

  // ---- Toplu faturalama: taşeronun (usta) bekleyen sevk irsaliyesi kesilir; diğer irsaliyeler "faturalanmamış" kalır ----
  const pending = (await tx.execute<{ id: string }>(sql`
    select n.id from delivery_notes n where n.type = 'sales' and n.status = 'posted' and n.party_id = ${partyId.get('usta')!}
      and not exists (select 1 from invoice_lines il join delivery_note_lines dl on dl.id = il.delivery_line_id where dl.note_id = n.id)`)).rows;
  let batchInfo = '';
  if (pending.length > 0) {
    const res = await runBatch(tx, ictx, { noteIds: pending.map((p) => p.id), invoiceDate: recent(1), grouping: 'party', post: true });
    batchInfo = `, toplu faturalama (${res.created.length} fatura)`;
  }
  // Onaylı ikinci sipariş teslim edilir ama faturalanmaz: "faturalanmamış irsaliye" olarak toplu faturalamada bekler
  const d2 = await orderToDelivery(tx, dctx, o2, { noteDate: recent(0), lines: undefined });
  await postDeliveryNote(tx, dctx, (d2 as { id?: string }).id ?? String(d2));
  return `satış: 3 fiyat listesi, cariye özel fiyatlar, 6 teklif/sipariş, siparişten irsaliye ve fatura${batchInfo}`;
}
