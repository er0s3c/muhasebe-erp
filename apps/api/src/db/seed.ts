/**
 * Geliştirme/demo verisi: örnek bir inşaat şirketi, kurlar, bir yıllık yevmiye kaydı.
 * Yalnızca geliştirme içindir; üretimde çalışmayı reddeder. Tekrar çalıştırılırsa
 * demo kullanıcı varsa hiçbir şey yapmaz.
 *
 *   npm run db:seed
 *   Giriş: demo@ornek.local / Demo-Sifre-123
 */
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import {
  applyRate,
  createDeliveryNoteSchema,
  createInvoiceSchema,
  isoYear,
  todayIso,
  toDbRate,
  type CreateDeliveryNoteInput,
  type CreateInvoiceInput,
  type CreateItemInput,
  type CreateJournalInput,
  type CreatePartyInput,
  type CreateStockDocumentInput,
} from '@erp/shared';
import { loadConfig } from '../config';
import { createDb, withContext, type Tx } from './client';
import { customCodes, exchangeRates, memberships, organizations, users, warehouses } from './schema';
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
import { cancelInvoice, postInvoice } from '../modules/invoices/posting';
import { createInvoiceDraft, getInvoice, type InvoiceCtx } from '../modules/invoices/service';
import { createWarehouse } from '../modules/inventory/warehouses';
import { closePeriod, findPeriodForDate } from '../modules/settings/periods';
import { createCompany } from '../modules/tenancy/service';

const DEMO_EMAIL = 'demo@ornek.local';
const DEMO_PASSWORD = 'Demo-Sifre-123';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  throw new Error('Demo verisi üretimde yüklenemez.');
}

const handle = createDb(config.DATABASE_URL);
const { db } = handle;

const today = todayIso();
const year = isoYear(today);
const pad = (n: number) => String(n).padStart(2, '0');
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
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

async function main() {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_EMAIL));
  if (existing) {
    console.log(`Demo verisi zaten var (${DEMO_EMAIL}). Sıfırdan yüklemek için veritabanını sıfırlayın.`);
    return;
  }

  const passwordHash = await hash(DEMO_PASSWORD);
  const { orgId, userId } = await db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: 'Örnek Holding' }).returning({ id: organizations.id });
    const [u] = await tx
      .insert(users)
      .values({ organizationId: org!.id, email: DEMO_EMAIL, passwordHash, fullName: 'Ayşe Demir' })
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
        .values({ organizationId: orgId, email, passwordHash, fullName })
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

    // Geçmiş aylar kapansın (yılın ilk yarısı)
    for (let m = 1; m <= 6; m++) {
      const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
      const p = await findPeriodForDate(tx, date(m, last));
      if (p && date(m, last) < today) await closePeriod(tx, p.id, userId);
    }

    console.log(`Demo verisi yüklendi: ${company.name} (${created} yevmiye, ${stockSummary})`);
    console.log(`  Giriş:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    console.log('  Ekip:   muhasebe@ornek.local (muhasebeci), izleyici@ornek.local (izleyici) — aynı şifre');
  });
}

try {
  await main();
} finally {
  await handle.close();
}

