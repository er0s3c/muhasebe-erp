/**
 * Demo verisi: örnek bir inşaat şirketi, kurlar, bir yıllık yevmiye/fatura/stok/kasa-banka hareketi.
 * `seedDemo(db)` bir kitaplık işlevidir (testler ve operatör aracı `demo-cli.ts` çağırır); modül yüklenirken
 * hiçbir şey çalıştırmaz. Uygulama gibi ÇALIŞMA ZAMANI rolüyle (erp_app, RLS'e tabi) yazar; şema sahibi gerekmez.
 * Demo kullanıcı zaten varsa hiçbir şey yapmaz.
 *
 *   npm run db:seed      giriş: demo@ornek.local / Demo-Sifre-123
 */
import { hash } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';
import {
  applyRate,
  createDeliveryNoteSchema,
  createInvoiceSchema,
  createProgressSchema,
  createProjectSchema,
  createTreasuryAccountSchema,
  createTreasuryTransactionSchema,
  isoYear,
  todayIso,
  toDbRate,
  type CreateDeliveryNoteInput,
  type CreateInvoiceInput,
  type CreateItemInput,
  type CreateJournalInput,
  type CreatePartyInput,
  type CreateStockDocumentInput,
  type Sector,
} from '@erp/shared';
import type { CompanyInfo } from '../http/context';
import { withContext, type Db, type Tx } from './client';
import { customCodes, exchangeRates, items as itemsTable, memberships, organizations, subcontractRevisions, users, warehouses } from './schema';
import { createParty } from '../modules/parties/service';
import { createAccount, listAccounts } from '../modules/ledger/accounts';
import {
  createJournalEntry,
  reverseJournalEntry,
  type LedgerCtx,
} from '../modules/ledger/journal';
import { createCategory } from '../modules/inventory/categories';
import { createStockCount, postStockCount, updateStockCount } from '../modules/inventory/counts';
import { postStockDocument, reverseStockDocument, type StockCtx } from '../modules/inventory/documents';
import { createItem } from '../modules/inventory/items';
import { postDeliveryNote } from '../modules/deliveries/posting';
import { createDeliveryDraft } from '../modules/deliveries/service';
import { openItemsFor } from '../modules/parties/service';
import { autoMatch, ledgerCandidates } from '../modules/bank-statements/service';
import { bankStatementHandler } from '../modules/imports/handlers/bank-statement';
import { createTreasuryAccount, getTreasuryAccountRow } from '../modules/treasury/accounts';
import { cancelTreasuryTransaction, postTreasuryTransaction } from '../modules/treasury/posting';
import { cancelInvoice, postInvoice } from '../modules/invoices/posting';
import { createInvoiceDraft, getInvoice, type InvoiceCtx } from '../modules/invoices/service';
import { createWarehouse } from '../modules/inventory/warehouses';
import { closePeriod, findPeriodForDate } from '../modules/settings/periods';
import { createCompany } from '../modules/tenancy/service';
import { approveBudget, createBudget, putBudgetLines } from '../modules/projects/budgets';
import { recordProgress } from '../modules/projects/progress';
import { createProject, setProjectStatus } from '../modules/projects/service';
import { createWbs } from '../modules/projects/wbs';
import { activateContract, createContract, getContract, handoverContract, loadSalesCtx } from '../modules/realestate/contracts';
import { terminateContract } from '../modules/realestate/termination';
import { createFeeSchedule, verifyFeeSchedule } from '../modules/realestate/fees';
import { bulkCreateUnits } from '../modules/realestate/units';
import { createForecastItem } from '../modules/cash/forecast';
import { getOrder, issueOrder } from '../modules/procurement/orders';
import { createReceipt } from '../modules/procurement/receipts';
import { createRequest, submitRequest } from '../modules/procurement/requests';
import { awardRfq, createRfq, getRfq, upsertOffer } from '../modules/procurement/rfq';
import { createParam } from '../modules/subcontracts/params';
import { createProgress, giveAdvance, submitProgress, type ProgressCtx } from '../modules/subcontracts/progress';
import { approveRevision, createSubcontract, getRevision, putBoqLines } from '../modules/subcontracts/service';
import { createVariation, submitVariation } from '../modules/subcontracts/variations';
import { decide } from '../modules/approvals/service';

export const DEMO_EMAIL = 'demo@ornek.local';
export const DEMO_PASSWORD = 'Demo-Sifre-123';

const today = todayIso();
const year = isoYear(today);
const pad = (n: number) => String(n).padStart(2, '0');
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const idOfRow = (o: unknown) => (o as { id: string }).id;
const date = (m: number, d: number) => `${year}-${pad(m)}-${pad(d)}`;

/**
 * Yıl başından bugüne doğrusal seyreden kurlar (yalnızca demo). Bitiş değerleri, Merkez Bankası'nın
 * 29/09/2026 tarihli XML dosyasındaki Döviz Alış kurlarıdır; başlangıç değerleri uydurmadır.
 */
const RATE_TREND = {
  GBP: { start: 57.0, end: 64.7268 },
  EUR: { start: 49.0, end: 55.6307 },
  USD: { start: 43.0, end: 48.9008 },
} as const;
type Foreign = keyof typeof RATE_TREND;

function rateAt(cur: Foreign, iso: string): number {
  const t0 = Date.parse(`${year}-01-01T00:00:00Z`);
  const t1 = Date.parse(`${today}T00:00:00Z`);
  const t = t1 === t0 ? 1 : Math.min(1, Math.max(0, (Date.parse(`${iso}T00:00:00Z`) - t0) / (t1 - t0)));
  const { start, end } = RATE_TREND[cur];
  return Math.round((start + (end - start) * t) * 10000) / 10000;
}

async function seedRates(tx: Tx, companyId: string, userId: string) {
  const dates = new Set<string>();
  for (let m = 1; m <= 12; m++) for (const d of [1, 8, 15, 22, 28]) if (date(m, d) <= today) dates.add(date(m, d));
  for (let i = 0; i < 12; i++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    dates.add(d.toISOString().slice(0, 10));
  }
  const rows = [...dates].flatMap((d) =>
    (Object.keys(RATE_TREND) as Foreign[]).map((cur) => {
      const buy = rateAt(cur, d);
      return {
        companyId,
        rateDate: d,
        currencyCode: cur,
        quoteCode: 'TRY',
        buy: toDbRate(buy),
        sell: toDbRate(buy * 1.005),
        source: 'demo',
        createdBy: userId,
      };
    }),
  );
  await tx.insert(exchangeRates).values(rows).onConflictDoNothing();
}

type Side = 'debit' | 'credit';
interface Spec {
  on: string;
  text: string;
  lines: [code: string, side: Side, amount: string, opts?: { cur?: Foreign; desc?: string; party?: string; dueDays?: number }][];
  post?: boolean;
  reverseOn?: string;
}

/**
 * Stok ve fatura demo verisi. Alışlar ve satışlar faturayla girilir (stok, cari ve yevmiye otomatik);
 * sarf, fire, transfer ve sayım elle girilen stok belgeleridir (yevmiyeleri de otomatik oluşur).
 * Böylece "stok değeri ↔ 150–157 hesap bakiyesi" mutabakatı elle yevmiye girmeden tutar.
 */
async function seedInventory(tx: Tx, ctx: LedgerCtx, partyId: Map<string, string>, acc: (code: string) => string): Promise<string> {
  const stockCtx: StockCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY', reportingCurrency: ctx.reportingCurrency, allowNegativeStock: false };
  const invCtx: InvoiceCtx = { ...stockCtx };
  const [main] = await tx.select().from(warehouses).where(eq(warehouses.isDefault, true));
  if (!main) throw new Error('Varsayılan depo yok');
  const site = await createWarehouse(tx, ctx.companyId, { code: 'SNT', name: 'Şantiye deposu', isDefault: false });

  const cat: Record<string, string> = {};
  for (const name of ['İnşaat malzemesi', 'Elektrik', 'Boya ve kimyasal', 'Tesisat', 'Kaplama']) {
    cat[name] = (await createCategory(tx, ctx.companyId, { name })).id;
  }
  const mk = async (
    name: string,
    unit: CreateItemInput['unit'],
    category: string,
    extra: Partial<CreateItemInput> = {},
  ) => (await createItem(tx, ctx.companyId, { kind: 'goods', purchaseCurrency: 'TRY', saleCurrency: 'TRY', unit, name, categoryId: cat[category]!, vatCode: 'KDV-16', ...extra })).id;

  const item = {
    demir: await mk('Nervürlü inşaat demiri 12 mm', 'ton', 'İnşaat malzemesi', { minLevel: '20', purchasePrice: '7000', barcode: '8690000000012' }),
    cimento: await mk('Çimento 50 kg', 'cuval', 'İnşaat malzemesi', { minLevel: '200', purchasePrice: '180', barcode: '8690000000029' }),
    kum: await mk('Yıkanmış kum', 'm3', 'İnşaat malzemesi', { minLevel: '30', purchasePrice: '650' }),
    beton: await mk('Hazır beton C25', 'm3', 'İnşaat malzemesi', { purchasePrice: '520' }),
    boya: await mk('Dış cephe boyası 15 lt', 'adet', 'Boya ve kimyasal', { minLevel: '20', purchasePrice: '850', salePrice: '1100' }),
    kablo: await mk('NYY kablo 3x2,5 mm²', 'm', 'Elektrik', { minLevel: '500', purchasePrice: '14.5' }),
    seramik: await mk('İthal seramik 60x60', 'm2', 'Kaplama', { minLevel: '100', purchasePrice: '12', purchaseCurrency: 'EUR', salePrice: '20', saleCurrency: 'GBP' }),
  };
  const nakliye = (await createItem(tx, ctx.companyId, { kind: 'service', unit: 'saat', name: 'Şantiye nakliye hizmeti', purchaseCurrency: 'TRY', saleCurrency: 'TRY', vatCode: 'KDV-16' })).id;
  const names: Record<string, string> = {
    [item.demir]: 'Nervürlü inşaat demiri 12 mm', [item.cimento]: 'Çimento 50 kg', [item.kum]: 'Yıkanmış kum', [item.beton]: 'Hazır beton C25',
    [item.boya]: 'Dış cephe boyası 15 lt', [item.kablo]: 'NYY kablo 3x2,5 mm²', [item.seramik]: 'İthal seramik 60x60', [nakliye]: 'Şantiye nakliye hizmeti',
  };

  const post = (input: CreateStockDocumentInput) => postStockDocument(tx, stockCtx, input);
  const L = (itemId: string, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) => ({
    itemId, description: names[itemId]!, quantity, unitPrice, vatCode: 'KDV-16', ...extra,
  });
  type LineIn = ReturnType<typeof L>;
  const invoice = async (
    type: CreateInvoiceInput['type'],
    on: string,
    party: string,
    lines: LineIn[],
    extra: { externalNo?: string; currency?: 'EUR' | 'GBP'; description?: string; returnOfId?: string; post?: boolean } = {},
  ) => {
    const { post: doPost = true, ...rest } = extra;
    const input = createInvoiceSchema.parse({ type, partyId: partyId.get(party)!, invoiceDate: on, lines, ...rest });
    const id = await createInvoiceDraft(tx, invCtx, input);
    return doPost ? postInvoice(tx, invCtx, id) : getInvoice(tx, id);
  };
  /** Alış faturası: stok girişi + KDV + tedarikçi carisi (yevmiyesi otomatik). */
  const purchase = (on: string, key: keyof typeof item, qty: string, unitPrice: string, party: string, externalNo: string, currency?: 'EUR') =>
    invoice('purchase', on, party, [L(item[key], qty, unitPrice)], { externalNo, ...(currency ? { currency } : {}) });
  /** Sarf/fire: elle stok belgesi (yevmiyesi otomatik). */
  const consume = (on: string, type: 'issue' | 'waste', wh: string, key: keyof typeof item, qty: string, text: string) =>
    post({ type, docDate: on, warehouseId: wh, description: text, lines: [{ itemId: item[key], quantity: qty }] });

  await purchase(date(1, 20), 'demir', '60', '7000', 'demir', 'DC-2026-0142');
  await purchase(date(2, 10), 'cimento', '1000', '180', 'beton', 'HB-2201');
  await consume(date(3, 5), 'issue', main.id, 'demir', '25', 'A Blok kolon demiri sarfı');
  await post({ type: 'transfer', docDate: date(3, 22), warehouseId: main.id, toWarehouseId: site.id, description: 'Şantiyeye sevk', lines: [{ itemId: item.cimento, quantity: '600' }] });
  await consume(date(3, 25), 'issue', site.id, 'cimento', '400', 'A Blok döşeme betonu çimento sarfı');
  const boya = await purchase(date(4, 15), 'boya', '100', '850', 'oto', 'LO-311');
  await consume(date(4, 30), 'waste', main.id, 'boya', '4', 'Depoda bozulan boya (fire)');
  await consume(date(5, 6), 'issue', site.id, 'cimento', '150', 'B Blok temel çimento sarfı');
  await consume(date(6, 12), 'issue', main.id, 'demir', '20', 'B Blok kolon demiri sarfı');
  await purchase(date(6, 20), 'seramik', '800', '12', 'oto', 'LO-388', 'EUR');
  await purchase(date(7, 8), 'kablo', '2000', '14.5', 'beton', 'HB-2310');
  await purchase(date(7, 20), 'kum', '120', '650', 'beton', 'HB-2334');
  await purchase(date(8, 20), 'beton', '500', '520', 'beton', 'HB-2377');
  await consume(date(8, 22), 'issue', main.id, 'beton', '500', 'B Blok döşeme betonu dökümü');

  // Satışlar: TL (boya + nakliye hizmeti), GBP (seramik), kısmi iade, iptal, alış iadesi, gider, taslak
  await invoice('sales', date(7, 25), 'ali', [L(item.boya, '20', '1100'), L(nakliye, '4', '250', { description: 'Boya nakliyesi' })], { description: 'A Blok daire boyası' });
  const gbpSale = await invoice('sales', date(8, 10), 'sarah', [L(item.seramik, '100', '20')], { currency: 'GBP', description: 'B Blok 1. kat seramik (GBP)' });
  await invoice('sales_return', date(8, 18), 'sarah', [L(item.seramik, '10', '20', { sourceLineId: gbpSale.lines[0]!.id })], { currency: 'GBP', returnOfId: gbpSale.invoice.id, description: 'Kırık seramik iadesi' });
  const wrongSale = await invoice('sales', date(9, 5), 'ali', [L(item.boya, '2', '1100')], { description: 'Hatalı kesilen fatura' });
  await cancelInvoice(tx, invCtx, wrongSale.invoice.id, { date: date(9, 6), reason: 'Müşteri vazgeçti' });
  await invoice('purchase_return', date(9, 15), 'oto', [L(item.boya, '5', '850', { sourceLineId: boya.lines[0]!.id })], { externalNo: 'LO-311-İ', returnOfId: boya.invoice.id, description: 'Fazla gelen boya iadesi' });
  await invoice('expense', date(9, 3), 'oto', [{ description: 'Şantiye geçici elektrik bağlantısı', quantity: '1', unitPrice: '6500', vatCode: 'KDV-16', accountId: acc('770') } as unknown as LineIn], { externalNo: 'LO-402' });

  // İrsaliyeler: yevmiye yazmaz, stoğu hemen hareket ettirir; yevmiye fatura kesilince oluşur.
  const delivery = async (
    type: CreateDeliveryNoteInput['type'],
    on: string,
    party: string,
    lines: { itemId: string; quantity: string; unitCost?: string }[],
    extra: { externalNo?: string; vehiclePlate?: string; driverName?: string; description?: string } = {},
  ) => {
    const input = createDeliveryNoteSchema.parse({ type, partyId: partyId.get(party)!, noteDate: on, warehouseId: main.id, lines, ...extra });
    return postDeliveryNote(tx, invCtx, await createDeliveryDraft(tx, invCtx, input));
  };
  // Alış irsaliyesi (fiyatlı) ve fiyat farklı fatura: elde kalan miktar payı stok maliyetine gider
  const demirIn = await delivery('purchase', date(9, 5), 'demir', [{ itemId: item.demir, quantity: '30', unitCost: '7000' }], { externalNo: 'DC-İRS-8812', vehiclePlate: '05 DC 118', description: 'Demir mal kabul' });
  await invoice('purchase', date(9, 12), 'demir', [L(item.demir, '30', '7200', { deliveryLineId: demirIn.lines[0]!.id })], { externalNo: 'DC-2026-0311', description: 'Mal kabul irsaliyesine bağlı fatura (fiyat farklı)' });
  // Satış irsaliyesi, kısmen faturalandı (kalan 5 adet bekliyor)
  const boyaOut = await delivery('sales', date(9, 10), 'ali', [{ itemId: item.boya, quantity: '15' }], { vehiclePlate: '05 ABC 123', driverName: 'Hasan Çelik', description: 'A Blok ek boya sevki' });
  await invoice('sales', date(9, 16), 'ali', [L(item.boya, '10', '1100', { deliveryLineId: boyaOut.lines[0]!.id })], { description: 'Sevk irsaliyesinin ilk kısmı' });
  // Faturalanmamış: taşerona demir sevki ve tedarikçiden gelen kablo (fatura bekleniyor)
  await delivery('sales', date(9, 8), 'usta', [{ itemId: item.demir, quantity: '8' }], { description: 'Kalıp taşeronuna demir sevki' });
  await delivery('purchase', date(9, 18), 'beton', [{ itemId: item.kablo, quantity: '500', unitCost: '15' }], { externalNo: 'HB-İRS-4471', description: 'Kablo mal kabul (fatura bekleniyor)' });

  // Eylül sayımı: kum 8 m³ eksik çıkar → sayım noksanlığı otomatik yevmiyeyle yazılır
  const count = await createStockCount(tx, stockCtx, { warehouseId: main.id, countDate: date(9, 20), description: 'Eylül depo sayımı', prefill: 'in_stock' });
  await updateStockCount(tx, stockCtx, count.count.id, {
    description: undefined,
    lines: count.lines.map((l) => ({ itemId: l.itemId, countedQty: l.itemId === item.kum ? '112' : l.systemQty })),
  });
  await postStockCount(tx, stockCtx, count.count.id);

  // Yanlış girilmiş bir çıkış ve ters kaydı (ters belge demosu; net etkisi sıfır)
  const wrong = await post({ type: 'issue', docDate: date(9, 22), warehouseId: main.id, description: 'Yanlış girilen çıkış', lines: [{ itemId: item.boya, quantity: '10' }] });
  await reverseStockDocument(tx, stockCtx, wrong.document.id, { docDate: date(9, 23) });

  // Bekleyen taslak fatura
  await invoice('sales', date(9, 28), 'ali', [L(item.boya, '5', '1100')], { description: 'Ek boya siparişi (taslak)', post: false });

  return 'stok: 7 kart, 2 depo, fatura ve irsaliyeler, 1 sayım';
}

/**
 * Kasa ve banka demo verisi: mevcut 102.001/102.002 hesapları kasa/banka hesabına bağlanır, kasa ve bir EUR
 * hesabı açılır. Hareketler gerçek akışlarla girilir: seçilen kalemi kapatan tahsilat, GBP faturasının
 * yüksek kurlu tahsilatı (kur kârı), tedarikçi ödemesi, EUR faturasının ödemesi (kur zararı), virman,
 * döviz alım-satım, banka masrafı, faiz geliri ve iptal edilmiş bir hareket. Hepsi otomatik yevmiye üretir.
 */
async function seedTreasury(tx: Tx, ctx: LedgerCtx, partyId: Map<string, string>, acc: (code: string) => string): Promise<{ summary: string; bankTlId: string; cashId: string }> {
  const account = (input: Record<string, unknown>) => createTreasuryAccount(tx, ctx, createTreasuryAccountSchema.parse(input));
  const bankTl = await account({ kind: 'bank', name: 'KTB TL Vadesiz', currency: 'TRY', bankName: 'Örnek Banka', branch: 'Lefkoşa', linkAccountId: acc('102.001') });
  const bankGbp = await account({ kind: 'bank', name: 'KTB GBP Hesabı', currency: 'GBP', bankName: 'Örnek Banka', branch: 'Lefkoşa', linkAccountId: acc('102.002') });
  const cash = await account({ kind: 'cash', name: 'Ana kasa', currency: 'TRY' });
  const bankEur = await account({ kind: 'bank', name: 'KTB EUR Hesabı', currency: 'EUR', bankName: 'Örnek Banka', branch: 'Lefkoşa' });

  const txn = (input: Record<string, unknown>) => postTreasuryTransaction(tx, ctx, createTreasuryTransactionSchema.parse(input));
  const open = async (party: string, control: 'receivable' | 'payable', asOf: string) => (await openItemsFor(tx, partyId.get(party)!, control, asOf)).items;

  // Kasa: bankadan nakit çekimi, sonra kasadan küçük gider (kasa eksiye düşmez)
  await txn({ type: 'transfer', date: date(8, 30), accountId: bankTl.id, toAccountId: cash.id, amount: '60000', description: 'Kasaya nakit çekildi' });
  await txn({ type: 'other_payment', date: date(9, 24), accountId: cash.id, amount: '3500', glAccountId: acc('770'), description: 'Şantiye küçük giderleri (nakit)' });

  // Ali Yılmaz: en eski kalem açık dururken yalnızca Temmuz faturası tahsil edilir (seçilen kalem)
  const aliItems = await open('ali', 'receivable', date(8, 26));
  const julyInvoice = aliItems.find((i) => i.description.includes('A Blok daire boyası')) ?? aliItems[aliItems.length - 1]!;
  await txn({
    type: 'receipt', date: date(8, 26), accountId: bankTl.id, amount: julyInvoice.remaining, partyId: partyId.get('ali')!,
    items: [{ lineId: julyInvoice.lineId, amount: julyInvoice.remaining, settleAmount: julyInvoice.remaining }], description: 'Boya faturası havale ile tahsil edildi',
  });
  // Yanlış girilen avans tahsilatı: aynı gün iptal edilir (numara serinin parçası kalır)
  const wrong = await txn({ type: 'receipt', date: date(9, 2), accountId: cash.id, amount: '5000', partyId: partyId.get('ali')!, description: 'Peşinat (yanlış hesaba girildi)' });
  await cancelTreasuryTransaction(tx, ctx, wrong.transaction.id as string, { date: date(9, 3), reason: 'Yanlış hesaba girildi' });

  // Sarah Thompson: GBP faturası GBP hesabına tahsil edilir; fatura günündeki kurdan yüksek kur → kambiyo kârı
  const sarahGbp = (await open('sarah', 'receivable', date(9, 15))).find((i) => i.currencyCode === 'GBP');
  if (sarahGbp) {
    await txn({
      type: 'receipt', date: date(9, 15), accountId: bankGbp.id, amount: sarahGbp.remaining, partyId: partyId.get('sarah')!,
      items: [{ lineId: sarahGbp.lineId, amount: sarahGbp.remaining, settleAmount: sarahGbp.remaining }], description: 'Seramik faturası (GBP) tahsilatı',
    });
  }

  // Tedarikçi ödemesi: Hazır Beton'un en eski faturası bankadan ödenir
  const betonFirst = (await open('beton', 'payable', date(9, 10)))[0];
  if (betonFirst) {
    await txn({
      type: 'payment', date: date(9, 10), accountId: bankTl.id, amount: betonFirst.remaining, partyId: partyId.get('beton')!,
      items: [{ lineId: betonFirst.lineId, amount: betonFirst.remaining, settleAmount: betonFirst.remaining }], description: 'Çimento faturası ödemesi',
    });
  }

  // EUR: TL ile döviz alınır, ardından EUR faturası kısmen ödenir (kur zararı)
  await txn({ type: 'exchange', date: date(9, 5), accountId: bankTl.id, toAccountId: bankEur.id, amount: '300000', counterAmount: '5400', description: 'Seramik ödemesi için EUR alımı' });
  const eurItem = (await open('oto', 'payable', date(9, 18))).find((i) => i.currencyCode === 'EUR');
  if (eurItem) {
    await txn({
      type: 'payment', date: date(9, 18), accountId: bankEur.id, amount: '5000', partyId: partyId.get('oto')!,
      items: [{ lineId: eurItem.lineId, amount: '5000', settleAmount: '5000' }], description: 'Seramik faturası (EUR) kısmi ödemesi',
    });
  }

  // GBP satışı: ortalama maliyetin üzerinde satış → kambiyo kârı; banka masrafı ve faiz geliri
  await txn({ type: 'exchange', date: date(9, 22), accountId: bankGbp.id, toAccountId: bankTl.id, amount: '20000', counterAmount: '1290000', description: 'GBP satışı' });
  await txn({ type: 'other_payment', date: date(9, 1), accountId: bankTl.id, amount: '125', glAccountId: acc('770'), description: 'Havale masrafı' });
  await txn({ type: 'other_receipt', date: date(9, 26), accountId: bankTl.id, amount: '2150', glAccountId: acc('642'), description: 'Vadesiz hesap faiz geliri' });

  return { summary: 'kasa/banka: 4 hesap, 11 hareket', bankTlId: bankTl.id, cashId: cash.id };
}

/**
 * Şantiye projeleri demo verisi (Faz B1): "Güneş Sitesi" (kendi projemiz; iş kırılımı ağacı, iki bütçe revizyonu,
 * tarihli ilerleme kayıtları) ve "Kuzey Villa" (işverene yapılan iş). Maliyetler gerçek akışlarla girilir ve
 * proje/iş kalemi etiketi taşır: elle yevmiye (taşeron işçiliği), gider faturası, stoktan proje sarfı (çıkış belgesi),
 * kasadan küçük gider; bir iş kalemi bütçeyi aşar, biri "iş kalemine atanmamış" düşer. Önceki demo hareketleri
 * (etiketsiz sarf, kira, personel) bilerek etiketsiz kalır: proje raporu "projesiz maliyet" ve defter mutabakatını gösterir.
 */
async function seedProjects(tx: Tx, ctx: LedgerCtx, partyId: Map<string, string>, acc: (code: string) => string, cashId: string, bankTlId: string): Promise<string> {
  const pctx = { companyId: ctx.companyId, userId: ctx.userId };
  const stockCtx: StockCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY', reportingCurrency: ctx.reportingCurrency, allowNegativeStock: false };
  const invCtx: InvoiceCtx = { ...stockCtx };
  const [main] = await tx.select().from(warehouses).where(eq(warehouses.isDefault, true));
  if (!main) throw new Error('Varsayılan depo yok');
  const itemId = async (name: string) => {
    const [row] = await tx.select({ id: itemsTable.id }).from(itemsTable).where(eq(itemsTable.name, name));
    if (!row) throw new Error(`Stok kartı yok: ${name}`);
    return row.id;
  };

  const employer = await createParty(tx, ctx.companyId, {
    name: 'Deniz Yatırım Ltd. (işveren)', kind: 'customer', currencyCode: 'TRY', paymentTermDays: 30, taxNumber: '1234890', taxOffice: 'Girne', notes: 'Kuzey Villa işvereni',
  });

  const wbs = async (projectId: string, code: string, name: string, parentId?: string) =>
    (await createWbs(tx, ctx.companyId, projectId, { code, name, ...(parentId ? { parentId } : {}) })).id;
  const budget = async (projectId: string, lines: [wbsId: string, amount: string][], copyFromCurrent = false) => {
    const b = await createBudget(tx, pctx, projectId, { copyFromCurrent });
    await putBudgetLines(tx, ctx.companyId, b.id, { lines: lines.map(([wbsId, amount]) => ({ wbsId, amount })) });
    await approveBudget(tx, pctx, b.id);
  };
  const progress = (projectId: string, asOfDate: string, rows: [wbsId: string, percent: string, etcOverride?: string][]) =>
    recordProgress(tx, pctx, projectId, createProgressSchema.parse({ asOfDate, items: rows.map(([wbsId, percent, etcOverride]) => ({ wbsId, percent, ...(etcOverride ? { etcOverride } : {}) })) }));
  const tag = (projectId: string, wbsId?: string) => ({ projectId, ...(wbsId ? { wbsId } : {}) });

  const entry = (on: string, text: string, lines: { code: string; side: Side; amount: string; party?: string; project?: string; wbs?: string }[]) =>
    createJournalEntry(tx, ctx, {
      entryDate: on,
      description: text,
      post: true,
      lines: lines.map((l) => ({
        accountId: acc(l.code),
        currency: 'TRY',
        debit: l.side === 'debit' ? l.amount : '0',
        credit: l.side === 'credit' ? l.amount : '0',
        ...(l.party ? { partyId: partyId.get(l.party)!, dueDate: addDays(on, 30) } : {}),
        ...(l.project ? tag(l.project, l.wbs) : {}),
      })) as CreateJournalInput['lines'],
    });
  const expense = async (on: string, party: string, externalNo: string, description: string, unitPrice: string, code: string, project: string, wbsId?: string) => {
    const input = createInvoiceSchema.parse({
      type: 'expense', partyId: partyId.get(party)!, invoiceDate: on, externalNo,
      lines: [{ description, quantity: '1', unitPrice, vatCode: 'KDV-16', accountId: acc(code), ...tag(project, wbsId) }],
    });
    return postInvoice(tx, invCtx, await createInvoiceDraft(tx, invCtx, input));
  };
  const issue = (on: string, name: string, quantity: string, text: string, project: string, wbsId: string) =>
    itemId(name).then((id) =>
      postStockDocument(tx, stockCtx, { type: 'issue', docDate: on, warehouseId: main.id, description: text, lines: [{ itemId: id, quantity, ...tag(project, wbsId) }] }),
    );

  // ---- Güneş Sitesi (kendi projemiz) -----------------------------------
  const gunes = (
    await createProject(tx, pctx, createProjectSchema.parse({ name: 'Güneş Sitesi', kind: 'own', startDate: date(7, 1), endDate: date(12, 31), location: 'Girne, 2 dönüm arsa', description: 'A ve B blok, toplam 24 daire; kendi arsamızda konut satışı.' }))
  ).id;
  const w = {
    hazirlik: await wbs(gunes, '01', 'Hazırlık ve şantiye kurulumu'),
    kaba: await wbs(gunes, '02', 'Kaba inşaat'),
    ince: await wbs(gunes, '03', 'İnce işler'),
    cevre: await wbs(gunes, '04', 'Çevre düzenleme'),
    kazi: '', temel: '', betonarme: '', siva: '', boya: '', elektrik: '',
  };
  w.kazi = await wbs(gunes, '02.01', 'Kazı ve hafriyat', w.kaba);
  w.temel = await wbs(gunes, '02.02', 'Temel', w.kaba);
  w.betonarme = await wbs(gunes, '02.03', 'Betonarme karkas', w.kaba);
  w.siva = await wbs(gunes, '03.01', 'Sıva', w.ince);
  w.boya = await wbs(gunes, '03.02', 'Boya', w.ince);
  w.elektrik = await wbs(gunes, '03.03', 'Elektrik tesisat', w.ince);

  // Bütçe rev. 1; sonra temel ve boya artırılarak rev. 2 (rev. 1 "yerine geçildi" olur)
  const rev1: [string, string][] = [
    [w.hazirlik, '150000'], [w.kazi, '120000'], [w.temel, '600000'], [w.betonarme, '1400000'],
    [w.siva, '350000'], [w.boya, '250000'], [w.elektrik, '180000'], [w.cevre, '300000'],
  ];
  await budget(gunes, rev1);
  await budget(gunes, rev1.map(([id, amount]) => [id, id === w.temel ? '650000' : id === w.boya ? '280000' : amount] as [string, string]), true);
  await setProjectStatus(tx, gunes, 'active');

  // Maliyetler: taşeron işçiliği (elle yevmiye, Mehmet Usta carisine), gider faturaları, malzeme sarfı, kasa gideri
  await entry(date(7, 8), 'Hazırlık işçiliği ve kazı taşeron hakedişi (Güneş Sitesi)', [
    { code: '720', side: 'debit', amount: '30000', project: gunes, wbs: w.hazirlik },
    { code: '740', side: 'debit', amount: '95000', project: gunes, wbs: w.kazi },
    { code: '320', side: 'credit', amount: '125000', party: 'usta' },
  ]);
  await entry(date(8, 6), 'Temel kalıp-demir işçiliği taşeron hakedişi', [
    { code: '740', side: 'debit', amount: '380000', project: gunes, wbs: w.temel },
    { code: '320', side: 'credit', amount: '380000', party: 'usta' },
  ]);
  await entry(date(8, 24), 'Betonarme karkas işçiliği taşeron hakedişi', [
    { code: '740', side: 'debit', amount: '520000', project: gunes, wbs: w.betonarme },
    { code: '320', side: 'credit', amount: '520000', party: 'usta' },
  ]);
  await expense(date(8, 12), 'oto', 'LO-431', 'İş makinesi kiralama (kazı)', '40000', '740', gunes, w.kazi); // kazı bütçeyi aşar
  await expense(date(9, 14), 'oto', 'LO-447', 'Şantiye çit ve güvenlik hizmeti', '18000', '730', gunes); // iş kalemi seçilmedi: "atanmamış"
  await issue(date(9, 24), 'Nervürlü inşaat demiri 12 mm', '12', 'Temel demiri (Güneş Sitesi)', gunes, w.temel);
  await issue(date(9, 25), 'Çimento 50 kg', '250', 'Karkas betonu çimentosu (Güneş Sitesi)', gunes, w.betonarme);
  await issue(date(9, 26), 'NYY kablo 3x2,5 mm²', '600', 'Kat elektrik tesisatı kablosu (Güneş Sitesi)', gunes, w.elektrik);
  await issue(date(9, 27), 'Dış cephe boyası 15 lt', '25', 'A Blok cephe boyası (Güneş Sitesi)', gunes, w.boya);
  await postTreasuryTransaction(tx, ctx, createTreasuryTransactionSchema.parse({
    type: 'other_payment', date: date(9, 27), accountId: cashId, amount: '2750', glAccountId: acc('770'), ...tag(gunes, w.hazirlik), description: 'Şantiye işçi yemek ve küçük giderler (nakit)',
  }));
  // Gelir tarafı: proje düzeyinde etiketli daire satışı (iş kalemine bağlanmaz)
  await entry(date(9, 16), 'Daire satışı — Güneş Sitesi C Blok', [
    { code: '120', side: 'debit', amount: '580000', party: 'ali' },
    { code: '600', side: 'credit', amount: '500000', project: gunes },
    { code: '391', side: 'credit', amount: '80000' },
  ]);

  // İlerleme: önce bir ara kayıt, sonra güncel durum (geçmiş durur, en son kayıt geçerli)
  await progress(gunes, date(8, 31), [[w.hazirlik, '100'], [w.kazi, '100'], [w.temel, '40'], [w.betonarme, '10']]);
  await progress(gunes, date(9, 28), [[w.temel, '70'], [w.betonarme, '35', '1000000'], [w.elektrik, '5'], [w.boya, '10']]);

  // ---- Kuzey Villa (işverene yapılan iş) --------------------------------
  const kuzey = (
    await createProject(tx, pctx, createProjectSchema.parse({ name: 'Kuzey Villa', kind: 'contract', clientPartyId: employer.id, startDate: date(8, 15), endDate: date(12, 15), location: 'Alsancak', description: 'İşveren arsasında anahtar teslim villa.' }))
  ).id;
  const k = { kaba: await wbs(kuzey, '01', 'Temel ve kaba inşaat'), ince: await wbs(kuzey, '02', 'İnce işler ve teslim') };
  await budget(kuzey, [[k.kaba, '900000'], [k.ince, '400000']]);
  await setProjectStatus(tx, kuzey, 'active');
  await entry(date(9, 9), 'Villa temel ve kaba inşaat işçiliği (Kuzey Villa)', [
    { code: '720', side: 'debit', amount: '210000', project: kuzey, wbs: k.kaba },
    { code: '320', side: 'credit', amount: '210000', party: 'usta' },
  ]);
  await progress(kuzey, date(9, 28), [[k.kaba, '20']]);

  // ---- Taşeron sözleşmesi ve hakediş (Faz B2): Güneş Sitesi elektrik tesisatı -------------------------
  // Teminat/avans yüzdeleri bu şirkete elle girilmiş, DOĞRULANMAMIŞ örnek parametrelerdir (yasal değer değildir).
  await createParam(tx, ctx.companyId, { kind: 'retention_pct', value: '5', validFrom: date(1, 1), sourceNote: 'Demo: sözleşme şartı (doğrulanmadı)' });
  await createParam(tx, ctx.companyId, { kind: 'advance_recoup_pct', value: '10', validFrom: date(1, 1), sourceNote: 'Demo: sözleşme şartı (doğrulanmadı)' });
  const pgctx: ProgressCtx = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency, reportingCurrency: ctx.reportingCurrency };
  const sub = await createSubcontract(tx, pgctx, {
    direction: 'payable', projectId: gunes, partyId: partyId.get('usta')!, title: 'Elektrik tesisatı', currencyCode: 'TRY', paymentDays: 30, startDate: date(9, 1), endDate: date(12, 15),
    penaltyNote: 'Gecikmede günlük %0,1 (demo notu).',
  });
  const [rev] = await tx.select({ id: subcontractRevisions.id }).from(subcontractRevisions).where(eq(subcontractRevisions.subcontractId, sub.id));
  const boq = await putBoqLines(tx, pgctx, rev!.id, {
    lines: [
      { itemNo: '1.1', description: 'Kat tesisatı kablo çekimi', unit: 'm', quantity: '20000', unitPrice: '4', wbsId: w.elektrik },
      { itemNo: '1.2', description: 'Pano kurulumu', unit: 'adet', quantity: '24', unitPrice: '1500', wbsId: w.elektrik },
      { itemNo: '1.3', description: 'Aydınlatma montajı', unit: 'adet', quantity: '480', unitPrice: '90', wbsId: w.elektrik },
    ],
  });
  await approveRevision(tx, pgctx, rev!.id);
  const keyOf = (no: string) => boq.lines.find((l) => l.itemNo === no)!.lineKey as string;
  await giveAdvance(tx, pgctx, sub.id, { accountId: bankTlId, date: date(9, 5), amount: '10000', note: 'Mobilizasyon avansı' });
  const hk1 = await createProgress(tx, pgctx, {
    subcontractId: sub.id, periodEnd: date(9, 28), vatCode: 'KDV-16', note: 'Eylül hakedişi',
    lines: [{ lineKey: keyOf('1.1'), cumulativeQty: '8000' }, { lineKey: keyOf('1.2'), cumulativeQty: '6' }, { lineKey: keyOf('1.3'), cumulativeQty: '100' }],
    deductions: [],
  });
  const submitted = await submitProgress(tx, pgctx, { companyId: ctx.companyId, userId: ctx.userId, role: 'owner' }, hk1.payment.id as string);
  await decide(tx, { companyId: ctx.companyId, userId: ctx.userId, role: 'owner' }, submitted.approvals[0]!.id, { decision: 'approve' });
  // İkinci hakediş taslak kalır (arayüzde düzenlenebilir ve onaya gönderilebilir)
  await createProgress(tx, pgctx, {
    subcontractId: sub.id, periodEnd: date(9, 30), vatCode: 'KDV-16',
    lines: [{ lineKey: keyOf('1.1'), cumulativeQty: '12000' }, { lineKey: keyOf('1.2'), cumulativeQty: '9' }, { lineKey: keyOf('1.3'), cumulativeQty: '180' }],
    deductions: [{ description: 'Gecikme cezası (demo)', amount: '500' }],
  });

  // ---- İşveren sözleşmesi ve alınan hakediş (Faz B2e): Kuzey Villa ------------------------------------
  const ctxOwner = { companyId: ctx.companyId, userId: ctx.userId, role: 'owner' as const };
  const emp = await createSubcontract(tx, pgctx, {
    direction: 'receivable', projectId: kuzey, partyId: employer.id, title: 'Anahtar teslim villa (işveren sözleşmesi)', currencyCode: 'TRY', paymentDays: 30, startDate: date(8, 15), endDate: date(12, 15),
  });
  const [empRev] = await tx.select({ id: subcontractRevisions.id }).from(subcontractRevisions).where(eq(subcontractRevisions.subcontractId, emp.id));
  const empBoq = await putBoqLines(tx, pgctx, empRev!.id, {
    lines: [
      { itemNo: '1', description: 'Temel ve kaba inşaat', unit: 'götürü', quantity: '1', unitPrice: '1200000', wbsId: k.kaba },
      { itemNo: '2', description: 'İnce işler ve teslim', unit: 'götürü', quantity: '1', unitPrice: '600000', wbsId: k.ince },
    ],
  });
  await approveRevision(tx, pgctx, empRev!.id);
  const ek = (no: string) => empBoq.lines.find((l) => l.itemNo === no)!.lineKey as string;
  await giveAdvance(tx, pgctx, emp.id, { accountId: bankTlId, date: date(8, 20), amount: '150000', note: 'Sözleşme avansı' });
  const ac1 = await createProgress(tx, pgctx, {
    subcontractId: emp.id, periodEnd: date(9, 28), vatCode: 'KDV-16', note: 'Eylül işveren hakedişi',
    lines: [{ lineKey: ek('1'), cumulativeQty: '0.25' }, { lineKey: ek('2'), cumulativeQty: '0' }], deductions: [],
  });
  const ac1s = await submitProgress(tx, pgctx, ctxOwner, ac1.payment.id as string);
  await decide(tx, ctxOwner, ac1s.approvals[0]!.id, { decision: 'approve' });
  await createProgress(tx, pgctx, {
    subcontractId: emp.id, periodEnd: date(9, 30), vatCode: 'KDV-16',
    lines: [{ lineKey: ek('1'), cumulativeQty: '0.5' }, { lineKey: ek('2'), cumulativeQty: '0' }], deductions: [],
  });

  // ---- Değişiklik emirleri: taşeronda uygulanmış ek iş + süre uzatımı; işverende işveren kabulü bekleyen ek iş ----------
  /** DE açar, yürürlükteki BOQ'ya kalem ekler, onaya gönderir ve (varsayılan tek adım) onaylar. */
  const variation = async (contractId: string, input: { title: string; reason: 'client_request' | 'design_change'; description: string; days: number }, extra: { itemNo: string; description: string; unit: string; quantity: string; unitPrice: string; wbsId: string }) => {
    const vo = await createVariation(tx, pgctx, contractId, { title: input.title, reason: input.reason, description: input.description, timeExtensionDays: input.days });
    const revisionId = vo.variation.revisionId as string;
    const cur = await getRevision(tx, revisionId);
    await putBoqLines(tx, pgctx, revisionId, {
      lines: [
        ...cur.lines.map((l) => ({ lineKey: l.lineKey as string, itemNo: l.itemNo as string, description: l.description as string, unit: l.unit as string, quantity: l.quantity as string, unitPrice: l.unitPrice as string, wbsId: l.wbsId as string, costCodeId: (l.costCodeId as string | null) ?? undefined })),
        extra,
      ],
    });
    const submittedVo = await submitVariation(tx, ctxOwner, vo.variation.id as string);
    await decide(tx, ctxOwner, submittedVo.approvals[0]!.id, { decision: 'approve' });
  };
  await variation(
    sub.id,
    { title: 'Bahçe aydınlatması ek işi', reason: 'client_request', description: 'Site bahçesine 60 adet direk tipi aydınlatma eklendi; işveren talebi.', days: 15 },
    { itemNo: '1.4', description: 'Bahçe aydınlatma direği montajı', unit: 'adet', quantity: '60', unitPrice: '250', wbsId: w.elektrik },
  );
  await variation(
    emp.id,
    { title: 'Havuz ve çevre düzenlemesi', reason: 'design_change', description: 'İşverenin proje değişikliğiyle 8×4 m havuz eklendi.', days: 20 },
    { itemNo: '3', description: 'Havuz ve çevre düzenlemesi', unit: 'götürü', quantity: '1', unitPrice: '180000', wbsId: k.ince },
  );

  // ---- Satın alma zinciri: Güneş Sitesi betonarme malzemesi ------------------------------------------
  const idOf = (o: unknown) => (o as { id: string }).id;
  const prc = { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency };
  const rq1 = await createRequest(tx, prc, {
    projectId: gunes, title: 'Karkas betonu ve kalıp malzemesi', needDate: date(10, 15), note: 'C Blok 3. kat döşeme için.',
    lines: [
      { description: 'C30 hazır beton', unit: 'm³', quantity: '120', estUnitPrice: '3200', wbsId: w.betonarme },
      { description: 'Kalıp tahtası 4 m', unit: 'adet', quantity: '400', estUnitPrice: '180', wbsId: w.betonarme },
    ],
  });
  const rq1s = await submitRequest(tx, prc, ctxOwner, idOf(rq1.request));
  await decide(tx, ctxOwner, rq1s.approvals[0]!.id, { decision: 'approve' });
  const rfq1 = await createRfq(tx, prc, { requestId: idOf(rq1.request), dueDate: date(9, 20) });
  const rfqId = rfq1.rfq.id as string;
  const lineIds = rq1.lines.map(idOf);
  await upsertOffer(tx, prc, rfqId, { partyId: partyId.get('beton')!, currencyCode: 'TRY', deliveryDays: 3, paymentDays: 30, lines: [{ requestLineId: lineIds[0]!, unitPrice: '3150' }, { requestLineId: lineIds[1]!, unitPrice: '190' }] });
  await upsertOffer(tx, prc, rfqId, { partyId: partyId.get('demir')!, currencyCode: 'TRY', deliveryDays: 7, paymentDays: 60, lines: [{ requestLineId: lineIds[0]!, unitPrice: '3250' }, { requestLineId: lineIds[1]!, unitPrice: '170' }] });
  const rfqView = await getRfq(tx, rfqId);
  const awarded = await awardRfq(tx, prc, rfqId, rfqView.offers.find((o) => o.partyName.startsWith('Hazır Beton'))!.id);
  const poId = idOf(awarded.order.order);
  await issueOrder(tx, poId);
  const po = await getOrder(tx, poId);
  // İlk parti beton geldi; kalan miktar taahhütte kalır
  await createReceipt(tx, prc, poId, { receiptDate: date(9, 29), note: 'İlk parti', lines: [{ orderLineId: idOf(po.lines[0]), quantity: '40' }] });
  // İkinci talep onayda bekler (arayüzde onay kutusunda görünür)
  const rq2 = await createRequest(tx, prc, {
    projectId: kuzey, title: 'Villa seramik ve fayans', needDate: date(11, 5),
    lines: [{ description: 'Porselen seramik 60x60', unit: 'm²', quantity: '320', estUnitPrice: '420', wbsId: k.ince }],
  });
  await submitRequest(tx, prc, ctxOwner, idOf(rq2.request));

  // ---- Gayrimenkul satışı (B3): Güneş Sitesi birimleri, GBP taksit planları -------------------------------------
  const sctx = await loadSalesCtx(tx, ctx.companyId, ctx.userId);
  await bulkCreateUnits(tx, sctx, { projectId: gunes, block: 'A', unitType: 'apartment', floorFrom: 1, floorTo: 4, perFloor: 3, grossM2: '110', rooms: '2+1', listPrice: '120000', listCurrency: 'GBP' });
  await bulkCreateUnits(tx, sctx, { projectId: gunes, block: 'B', unitType: 'apartment', floorFrom: 1, floorTo: 3, perFloor: 4, grossM2: '95', rooms: '1+1', listPrice: '90000', listCurrency: 'GBP' });
  const unitIdOf = async (block: string, no: string) => (await tx.execute<{ id: string }>(sql`select id from real_estate_units where project_id = ${gunes} and block = ${block} and unit_no = ${no}`)).rows[0]!.id;
  const monthly = (first: [number, number], n: number, amount: string) => Array.from({ length: n }, (_, i) => ({ kind: 'installment' as const, dueDate: date(first[0] + i > 12 ? 12 : first[0] + i, first[1]), amount }));
  const collect = async (contractId: string, seq: number, on: string, bankId: string) => {
    const det = await getContract(tx, contractId);
    const inst = det.installments.find((i) => i.seq === seq)!;
    const rate = rateAt('GBP', on);
    await postTreasuryTransaction(tx, ctx, createTreasuryTransactionSchema.parse({
      type: 'receipt', date: on, accountId: bankId, amount: (Number(inst.remaining) * rate).toFixed(2), partyId: det.contract.partyId as string,
      items: [{ lineId: inst.journalLineId!, amount: inst.remaining, settleAmount: (Number(inst.remaining) * rate).toFixed(2) }], description: `Taksit ${seq} tahsilatı (${det.contract.code})`,
    }));
  };
  // Fon/harç tarifeleri (tarihli, kaynak notlu; biri doğrulanmış örnek, hepsi demo değeridir)
  const elk = await createFeeSchedule(tx, ctx.companyId, { code: 'ELK', name: 'Elektrik altyapı fonu', side: 'buyer', basis: 'per_unit', amount: '1500', currencyCode: 'GBP', validFrom: date(1, 1), sourceNote: 'Demo değeri (doğrulanmadı)' });
  await createFeeSchedule(tx, ctx.companyId, { code: 'SU', name: 'Su ve kanalizasyon fonu', side: 'buyer', basis: 'per_m2', amount: '4', currencyCode: 'GBP', validFrom: date(1, 1), sourceNote: 'Demo değeri (doğrulanmadı)' });
  const bld = await createFeeSchedule(tx, ctx.companyId, { code: 'BLD', name: 'Belediye harcı', side: 'project', basis: 'per_unit', amount: '2500', currencyCode: 'TRY', validFrom: date(1, 1), sourceNote: 'Demo değeri (doğrulanmadı)' });
  await verifyFeeSchedule(tx, idOfRow(bld), 'Demo kullanıcı', 'Örnek doğrulama');
  void elk;
  // 1) A-101 Sarah Thompson: yürürlükte; peşinat ve ilk taksit tahsil edildi, Eylül taksidi gecikmiş
  const c1 = await createContract(tx, sctx, {
    unitId: await unitIdOf('A', '101'), partyId: partyId.get('sarah')!, currencyCode: 'GBP', contractDate: date(7, 1), plannedHandover: date(12, 30), price: '105000', downPayment: '30000',
    installments: [{ kind: 'down_payment', dueDate: date(7, 1), amount: '30000' }, ...monthly([8, 1], 5, '15000'), { kind: 'fee', dueDate: date(9, 1), amount: '1500', feeScheduleId: idOfRow(elk), label: 'Elektrik altyapı fonu' }],
  });
  await activateContract(tx, sctx, idOfRow(c1.contract), date(7, 1));
  await collect(idOfRow(c1.contract), 1, date(7, 1), bankTlId);
  await collect(idOfRow(c1.contract), 2, date(8, 1), bankTlId);
  // 2) A-102 Ali Yılmaz: teslim edilmiş (gelir tanınmış)
  const c2 = await createContract(tx, sctx, {
    unitId: await unitIdOf('A', '102'), partyId: partyId.get('ali')!, currencyCode: 'GBP', contractDate: date(3, 2), price: '90000', downPayment: '90000',
    installments: [{ kind: 'down_payment', dueDate: date(3, 2), amount: '90000' }],
  });
  await activateContract(tx, sctx, idOfRow(c2.contract), date(3, 2));
  await collect(idOfRow(c2.contract), 1, date(3, 2), bankTlId);
  await handoverContract(tx, sctx, idOfRow(c2.contract), date(9, 1));
  // 3) B-101 Sarah Thompson: feshedildi; tahsil edilen peşinattan kesinti, kalan iade
  const c3 = await createContract(tx, sctx, {
    unitId: await unitIdOf('B', '101'), partyId: partyId.get('sarah')!, currencyCode: 'GBP', contractDate: date(5, 2), price: '90000', downPayment: '20000',
    installments: [{ kind: 'down_payment', dueDate: date(5, 2), amount: '20000' }, ...monthly([6, 1], 4, '17500')],
  });
  await activateContract(tx, sctx, idOfRow(c3.contract), date(5, 2));
  await collect(idOfRow(c3.contract), 1, date(5, 2), bankTlId);
  await terminateContract(tx, sctx, idOfRow(c3.contract), { date: date(9, 22), reason: 'Alıcı vazgeçti', retained: '4000', refundAccountId: bankTlId });
  // Nakit projeksiyonu: elle girilen ek kalemler
  await createForecastItem(tx, { companyId: ctx.companyId, userId: ctx.userId }, { itemDate: date(10, 5), direction: 'out', description: 'Ofis kirası', amount: '45000', currencyCode: 'TRY' });
  await createForecastItem(tx, { companyId: ctx.companyId, userId: ctx.userId }, { itemDate: date(10, 20), direction: 'out', description: 'Maaş ve SGK ödemeleri', amount: '180000', currencyCode: 'TRY' });
  // 4) A-103: taslak sözleşme (arayüzde düzenlenip yürürlüğe alınabilir)
  await createContract(tx, sctx, {
    unitId: await unitIdOf('A', '103'), partyId: partyId.get('ali')!, currencyCode: 'GBP', contractDate: date(9, 25), price: '120000', downPayment: '24000',
    installments: [{ kind: 'down_payment', dueDate: date(9, 25), amount: '24000' }, ...monthly([10, 25], 3, '32000')],
  });

  return 'projeler: 2 (12 iş kalemi düğümü, 3 bütçe revizyonu, etiketli yevmiye/fatura/sarf/kasa); taşeron: 1 sözleşme, BOQ, 1 onaylı + 1 taslak hakediş, avans; işveren: 1 sözleşme, 1 onaylı + 1 taslak alınan hakediş, avans; satın alma: 2 talep, 1 RFQ (2 teklif), 1 sipariş (kısmi mal kabul); gayrimenkul: 24 birim, 4 sözleşme (yürürlükte/geciken + fon, teslim, fesih+iade, taslak), 3 fon tarifesi; 2 nakit projeksiyonu kalemi';
}

/**
 * TL banka hesabı için örnek ekstre: defterdeki (ters çevrilmemiş) banka satırlarından üretilir; bazı satırların tarihi
 * bir gün kayar (öneride "1 gün fark"), iki defter kaydı ekstrede yoktur ("eşleşmemiş defter kaydı") ve üç ekstre satırının
 * defterde karşılığı yoktur ("hareket oluştur" için). Kesin eşleşmeler uygulanır; olası ve öneri olmayan satırlar açık kalır.
 */
async function seedBankStatement(tx: Tx, ctx: LedgerCtx, company: CompanyInfo, bankTlId: string): Promise<string> {
  const ta = await getTreasuryAccountRow(tx, bankTlId);
  const candidates = await ledgerCandidates(tx, ta, `${year}-01-01`, date(12, 31));
  const skipped = (desc: string) => /havale masrafı|kira/i.test(desc);
  const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  const raw = candidates
    .filter((c) => !skipped(c.description))
    .map((c, i) => ({ date: i % 3 === 2 ? shift(c.entryDate, 1) : c.entryDate, description: c.description.slice(0, 70), amount: Number(c.amount), ref: `DKN-${1001 + i}` }));
  raw.push(
    { date: date(9, 27), description: 'Gelen EFT — açıklamasız', amount: 1000, ref: 'DKN-2001' },
    { date: date(9, 28), description: 'Hesap işletim ücreti', amount: -35, ref: 'DKN-2002' },
    { date: date(9, 29), description: 'Kart aidatı', amount: -250, ref: 'DKN-2003' },
  );
  raw.sort((a, b) => a.date.localeCompare(b.date));
  let balance = 0;
  const rows = raw.map((r, i) => {
    balance = Math.round((balance + r.amount) * 100) / 100;
    return { row: i + 2, cells: { date: r.date, description: r.description, reference: r.ref, amount: r.amount.toFixed(2), balance: balance.toFixed(2) } };
  });

  const plan = await bankStatementHandler.plan({ tx, company, userId: ctx.userId }, rows, {
    accountId: bankTlId,
    numberFormat: 'en',
    fileName: 'ktb-tl-ekstre-ornek.csv',
  });
  if (plan.rows.some((r) => r.status === 'error') || plan.general.some((m) => m.severity === 'error')) {
    throw new Error(`Örnek ekstre doğrulanamadı: ${JSON.stringify([...plan.general, ...plan.rows.filter((r) => r.status === 'error')])}`);
  }
  await plan.apply();
  const auto = await autoMatch(tx, ctx, bankTlId, { from: `${year}-01-01`, to: date(12, 31) });
  return `banka ekstresi: ${rows.length} satır, ${auto.matched} kesin eşleşme`;
}

/**
 * Demo verisini yükler. Demo kullanıcı zaten varsa hiçbir şey yapmaz ve `false` döner.
 * Tarih duyarlıdır: "bugün"e göre bir yıllık hareket üretir (modül yüklenme anı esas alınır).
 */
export async function seedDemo(db: Db, log: (message: string) => void = console.log): Promise<boolean> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL));
  if (existing) {
    log(`Demo verisi zaten var (${DEMO_EMAIL}). Sıfırdan yüklemek için veritabanını sıfırlayın (demo:reset).`);
    return false;
  }

  const passwordHash = await hash(DEMO_PASSWORD);
  const { orgId, userId } = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'Örnek Holding' }).returning({ id: organizations.id });
    const [u] = await tx
      .insert(users)
      .values({ organizationId: org!.id, email: DEMO_EMAIL, passwordHash, fullName: 'Ayşe Demir', emailVerifiedAt: new Date() })
      .returning({ id: users.id });
    return { orgId: org!.id, userId: u!.id };
  });

  await withContext(db, { userId, orgId }, async (tx) => {
    const company = await createCompany(
      tx,
      { id: userId, orgId },
      {
        name: 'Örnek İnşaat Ltd.',
        sector: 'CONSTRUCTION',
        baseCurrency: 'TRY',
        reportingCurrency: 'GBP',
        taxNumber: '1234567',
        taxOffice: 'Lefkoşa',
      },
    );
    const ctx: LedgerCtx = {
      companyId: company.id,
      userId,
      baseCurrency: 'TRY',
      reportingCurrency: 'GBP',
    };

    // Ekip: muhasebeci ve izleyici
    for (const [email, fullName, role] of [
      ['muhasebe@ornek.local', 'Mehmet Kaya', 'accountant'],
      ['izleyici@ornek.local', 'Elif Şahin', 'viewer'],
    ] as const) {
      const [m] = await tx
        .insert(users)
        .values({ organizationId: orgId, email, passwordHash, fullName, emailVerifiedAt: new Date() })
        .returning({ id: users.id });
      await tx.insert(memberships).values({ companyId: company.id, userId: m!.id, role });
    }

    await seedRates(tx, company.id, userId);

    // Alt hesaplar (cari hesapları 120/320 üzerinde cari kartlarıyla tutulur)
    await createAccount(tx, company.id, { code: '102.001', name: 'KTB TL Vadesiz' });
    await createAccount(tx, company.id, { code: '102.002', name: 'KTB GBP Hesabı', currencyCode: 'GBP' });

    const byCode = new Map((await listAccounts(tx)).map((a) => [a.code, a.id]));
    const acc = (code: string) => {
      const id = byCode.get(code);
      if (!id) throw new Error(`Hesap yok: ${code}`);
      return id;
    };

    const partyDefs: Record<string, Partial<CreatePartyInput> & Pick<CreatePartyInput, 'name' | 'kind'>> = {
      ali: { name: 'Ali Yılmaz', kind: 'customer', phone: '0533 111 22 33', paymentTermDays: 30, notes: 'A Blok 3. kat daire alıcısı' },
      sarah: { name: 'Sarah Thompson', kind: 'customer', phone: '+44 7700 900123', email: 'sarah@example.com', paymentTermDays: 30, notes: 'B Blok 1. kat daire alıcısı' },
      demir: { name: 'Demir Çelik A.Ş.', kind: 'supplier', taxNumber: '7654321', taxOffice: 'Lefkoşa', phone: '0392 222 33 44', paymentTermDays: 60 },
      beton: { name: 'Hazır Beton Ltd.', kind: 'supplier', taxNumber: '7654322', taxOffice: 'Girne', paymentTermDays: 30 },
      oto: { name: 'Lefkoşa Otomotiv Ltd.', kind: 'supplier', taxNumber: '7654323', taxOffice: 'Lefkoşa', paymentTermDays: 30 },
      usta: { name: 'Mehmet Usta (kalıp taşeronu)', kind: 'both', phone: '0542 333 44 55' },
    };
    const partyId = new Map<string, string>();
    for (const [key, def] of Object.entries(partyDefs)) {
      const p = await createParty(tx, company.id, { currencyCode: 'TRY', paymentTermDays: 0, ...def });
      partyId.set(key, p.id);
    }

    await tx.insert(customCodes).values([
      { companyId: company.id, scope: 'account', code: 'ŞNT', name: 'Şantiye giderleri' },
      { companyId: company.id, scope: 'account', code: 'MRK', name: 'Merkez ofis giderleri' },
      { companyId: company.id, scope: 'transaction', code: 'AVN', name: 'Müşteri avansı' },
      { companyId: company.id, scope: 'party', code: 'TAŞ', name: 'Taşeron' },
    ]);

    // ---- Bir yıllık örnek hareketler --------------------------------------
    const specs: Spec[] = [
      { on: date(1, 5), text: 'Sermaye girişi', lines: [['102.001', 'debit', '2500000'], ['500', 'credit', '2500000']] },
      { on: date(1, 12), text: 'Arsa alımı (Girne, 2 dönüm)', lines: [['250', 'debit', '1800000'], ['102.001', 'credit', '1800000']] },
      { on: date(2, 3), text: 'Satıcıya ödeme — Demir Çelik A.Ş.', lines: [['320', 'debit', '300000', { party: 'demir' }], ['102.001', 'credit', '300000']] },
      {
        on: date(2, 14), text: 'Yurt dışı yatırımcıdan GBP avans',
        lines: [['102.002', 'debit', '50000', { cur: 'GBP' }], ['340', 'credit', '__GBP50000__']],
      },
      {
        on: date(3, 8), text: 'Daire satışı — A Blok 3. kat',
        lines: [['120', 'debit', '1160000', { party: 'ali', dueDays: 30 }], ['600', 'credit', '1000000'], ['391', 'credit', '160000']],
      },
      { on: date(3, 25), text: 'Daire satışı tahsilatı (ilk taksit)', lines: [['102.001', 'debit', '500000'], ['120', 'credit', '500000', { party: 'ali' }]] },
      {
        on: date(4, 4), text: 'Şantiye ofisi kirası',
        lines: [['770', 'debit', '45000'], ['191', 'debit', '7200'], ['102.001', 'credit', '52200']],
      },
      {
        on: date(4, 18), text: 'Şantiye aracı alımı',
        lines: [['254', 'debit', '850000'], ['191', 'debit', '136000'], ['320', 'credit', '986000', { party: 'oto', dueDays: 30 }]],
      },
      { on: date(5, 2), text: 'Nisan personel ödemeleri', lines: [['770', 'debit', '180000'], ['102.001', 'credit', '180000']] },
      {
        on: date(6, 10), text: 'Yurt dışı yatırımcıdan ikinci GBP avans',
        lines: [['102.002', 'debit', '30000', { cur: 'GBP' }], ['340', 'credit', '__GBP30000__']],
      },
      {
        on: date(7, 15), text: 'Daire satışı — B Blok 1. kat',
        lines: [['120', 'debit', '2320000', { party: 'sarah', dueDays: 30 }], ['600', 'credit', '2000000'], ['391', 'credit', '320000']],
      },
      { on: date(8, 3), text: 'Daire satışı tahsilatı (B Blok)', lines: [['102.001', 'debit', '1000000'], ['120', 'credit', '1000000', { party: 'sarah' }]] },
      {
        on: date(9, 12), text: 'Hatalı gider kaydı (ters çevrilecek)',
        lines: [['770', 'debit', '12500'], ['102.001', 'credit', '12500']], reverseOn: date(9, 14),
      },
      { on: date(9, 26), text: 'Eylül şantiye ofisi kirası (taslak)', lines: [['770', 'debit', '45000'], ['102.001', 'credit', '45000']], post: false },
    ];

    let created = 0;
    for (const s of specs) {
      if (s.on > today) continue;
      const gbpFx = rateAt('GBP', s.on);
      const lines = s.lines.map(([code, side, amount, opts]) => {
        const cur = opts?.cur ?? 'TRY';
        let value = amount;
        if (amount.startsWith('__GBP')) {
          // TL karşılığı: GBP tutar × o günün kuru (hesaplamayı sunucuyla aynı yuvarlama ile yap)
          value = applyRate(amount.replace(/\D/g, ''), gbpFx).toFixed(2);
        }
        return {
          accountId: acc(code),
          currency: cur,
          description: opts?.desc,
          debit: side === 'debit' ? value : '0',
          credit: side === 'credit' ? value : '0',
          ...(cur !== 'TRY' ? { fxRate: String(gbpFx) } : {}),
          ...(opts?.party ? { partyId: partyId.get(opts.party)! } : {}),
          ...(opts?.party && opts.dueDays !== undefined ? { dueDate: addDays(s.on, opts.dueDays) } : {}),
        };
      }) as CreateJournalInput['lines'];

      const entry = await createJournalEntry(tx, ctx, {
        entryDate: s.on,
        description: s.text,
        lines,
        post: s.post ?? true,
      });
      created++;
      if (s.reverseOn && s.reverseOn <= today) {
        await reverseJournalEntry(tx, ctx, entry.id, { entryDate: s.reverseOn });
      }
    }

    const stockSummary = await seedInventory(tx, ctx, partyId, acc);
    const treasury = await seedTreasury(tx, ctx, partyId, acc);
    const treasurySummary = `${treasury.summary}; ${await seedBankStatement(tx, ctx, { ...company, sector: company.sector as Sector }, treasury.bankTlId)}`;
    const projectSummary = await seedProjects(tx, ctx, partyId, acc, treasury.cashId, treasury.bankTlId);

    // Geçmiş aylar kapansın (yılın ilk yarısı)
    for (let m = 1; m <= 6; m++) {
      const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
      const p = await findPeriodForDate(tx, date(m, last));
      if (p && date(m, last) < today) await closePeriod(tx, p.id, userId);
    }

    log(`Demo verisi yüklendi: ${company.name} (${created} yevmiye, ${stockSummary}, ${treasurySummary}, ${projectSummary})`);
    log(`  Giriş:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    log('  Ekip:   muhasebe@ornek.local (muhasebeci), izleyici@ornek.local (izleyici) — aynı şifre');
  });
  return true;
}

