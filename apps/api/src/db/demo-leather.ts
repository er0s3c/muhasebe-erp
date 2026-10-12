import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import {
  todayIso,
  toDbRate,
  createItemSchema,
  createStockDocumentSchema,
  leatherRevisionSchema,
  leatherVariantSchema,
  leatherReceiptSchema,
  createPartySchema,
  createInvoiceSchema,
  createTreasuryAccountSchema,
  createTreasuryTransactionSchema,
  leatherProductionSchema,
  createPriceListSchema,
  createSalesDocSchema,
  createExpenseCardSchema,
  createExpenseEntrySchema,
  createChequeSchema,
  createEmployeeSchema,
  createOrganizationSchema,
  createContactSchema,
  createAgendaSchema,
  createDeliveryNoteSchema,
  leatherDatedActionSchema,
  leatherIssueSchema,
  leatherQualitySchema,
  leatherQualityDecisionSchema,
  leatherCompletionSchema,
  manufacturingBatchSchema,
  manufacturingMaterialHandoffSchema,
  manufacturingSupplierSchema,
  manufacturingDemandPolicySchema,
  manufacturingCalendarTemplateSchema,
  manufacturingScheduleSchema,
  campaignSchema,
  fixedAssetSchema,
  companyBudgetSchema,
  insightConfigSchema,
  leatherCustomOrderSchema,
  manufacturingReworkSchema,
} from '@erp/shared';
import {
  users,
  memberships,
  warehouses,
  posTills,
  exchangeRates,
  accounts,
  invoiceLines,
  bankGuarantees,
  salesCampaigns,
  fiscalYears,
  consolidationGroups,
  consolidationMembers,
  portalLinks,
  approvalRules,
  approvalRuleSteps,
  workItems,
  operationEntries,
  foreignDocTypes,
  foreignWorkerDocs,
} from './schema';
import { posSessions } from './pos-schema';
import { setContext, type Db, type Tx } from './client';
import { createCompany } from '../modules/tenancy/service';
import { createItem } from '../modules/inventory/items';
import { postStockDocument } from '../modules/inventory/documents';
import { createStockCount } from '../modules/inventory/counts';
import {
  createModel,
  createRevision,
  approveRevision,
  createVariant,
} from '../modules/leather/catalog';
import { receiveMaterial, acceptPiece, cutMaterial } from '../modules/leather/materials';
import {
  createProduction,
  releaseProduction,
  completeProduction,
  recordOperation,
  issueProduction,
} from '../modules/leather/production';
import {
  createQuality,
  decideQuality,
  createCustomOrder,
  createServiceCase,
} from '../modules/leather/workflows';
import {
  createSubcontract,
  serviceAction,
  customAction,
} from '../modules/leather/advanced';
import { allocateCost } from '../modules/leather/costs';
import { newId, all, type LeatherCtx } from '../modules/leather/common';
import { createParty } from '../modules/parties/service';
import { createInvoiceDraft } from '../modules/invoices/service';
import { postInvoice } from '../modules/invoices/posting';
import { createTreasuryAccount } from '../modules/treasury/accounts';
import { postTreasuryTransaction } from '../modules/treasury/posting';
import { createWarehouse } from '../modules/inventory/warehouses';
import { createDeliveryDraft } from '../modules/deliveries/service';
import { postDeliveryNote } from '../modules/deliveries/posting';
import { createPriceList, addPriceListItem, addPartyPrice } from '../modules/sales/pricelists';
import { createSalesDoc, transitionSalesDoc } from '../modules/sales/orders';
import { createExpenseCard, createExpenseEntry } from '../modules/expenses/service';
import { createCheque } from '../modules/cheques/service';
import { createEmployee } from '../modules/hr/employees';
import { saveAttendance } from '../modules/hr/attendance';
import { createOrganization, createContact } from '../modules/directory/service';
import { createAgendaItem } from '../modules/directory/agenda';
import { createRequest } from '../modules/procurement/requests';
import { createRfq, upsertOffer } from '../modules/procurement/rfq';
import { createOrder, issueOrder } from '../modules/procurement/orders';
import { saveImportFile, allocateImportFile } from '../modules/landed/service';
import { createRecord, schedule, maintenance } from '../modules/manufacturing/service';
import { createBatch, createRework } from '../modules/manufacturing/execution';
import { materialHandoff } from '../modules/manufacturing/handoff';
import { createPattern } from '../modules/manufacturing/control';
import { calendarTemplate } from '../modules/manufacturing/scenarios';

export const LEATHER_DEMO_NAME = 'Ada Deri Sanayi ve Dış Ticaret Ltd. Şti.';
export const LEATHER_DEMO_TAX_NO = '3849201847';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function seedLeatherDemo(
  db: Db,
  log: (s: string, ...args: unknown[]) => void = console.log,
): Promise<boolean> {
  const [owner] = await db.select().from(users).where(eq(users.email, 'demo@ornek.local'));
  if (!owner) throw new Error('Önce mevcut demo hesabı kurulmalı: npm run db:seed');

  return db.transaction(async (tx) => {
    await setContext(tx, { userId: owner.id, orgId: owner.organizationId });
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'leather-demo:' + owner.organizationId}, 0))`,
    );

    // Şirket zaten var mı kontrol et
    const existing = await all(
      tx,
      sql`select c.id from companies c where c.organization_id=${owner.organizationId} and c.tax_number=${LEATHER_DEMO_TAX_NO}`,
    );

    if (existing.length) {
      const companyId = existing[0]!.id;
      // Sahip üyeliği var mı kontrol et, yoksa ekle
      const [m] = await tx
        .select()
        .from(memberships)
        .where(sql`company_id=${companyId} and user_id=${owner.id}`);
      if (!m) {
        await tx.insert(memberships).values({ companyId, userId: owner.id, role: 'owner' });
        log('Ada Deri şirketine demo@ornek.local sahiplik üyeliği bağlandı.');
      } else {
        log('Ada Deri demo şirketi zaten mevcut ve üyeliği güncel.');
      }
      return !m;
    }

    // Yeni Ada Deri şirketi oluştur (Sektör: LEATHER_FASHION, Türkiye - TR, Beyoğlu VD)
    const company = await createCompany(
      tx,
      { id: owner.id, orgId: owner.organizationId },
      {
        name: LEATHER_DEMO_NAME,
        sector: 'LEATHER_FASHION',
        jurisdiction: 'TR',
        legalEntityType: 'company',
        vatRegistered: true,
        baseCurrency: 'TRY',
        reportingCurrency: 'EUR',
        taxNumber: LEATHER_DEMO_TAX_NO,
        taxOffice: 'Beyoğlu',
      },
    );

    const ctx: LeatherCtx = {
      companyId: company.id,
      userId: owner.id,
      baseCurrency: 'TRY',
      reportingCurrency: 'EUR',
      allowNegativeStock: false,
    };

    await setContext(tx, {
      userId: owner.id,
      orgId: owner.organizationId,
      companyId: company.id,
    });

    const warehouse = (
      await tx.select().from(warehouses).where(eq(warehouses.companyId, company.id))
    )[0]!;

    await populateComprehensiveLeather(tx, ctx, warehouse.id, log);

    log('Deri demo şirketi başarıyla eklendi: ' + LEATHER_DEMO_NAME);
    log(`${owner.fullName} (${owner.email}) Ada Deri şirketinin sahibi olarak yetkilendirildi.`);
    return true;
  });
}

async function populateComprehensiveLeather(
  tx: Tx,
  ctx: LeatherCtx,
  mainWarehouseId: string,
  log: (s: string, ...args: unknown[]) => void,
) {
  const date = todayIso();

  log('Ada Deri: Depolar, cariler ve stok kartları kuruluyor...');

  // 1. Depolar
  const workshop = await createWarehouse(tx, ctx.companyId, {
    code: 'DEP-ATOLYE',
    name: 'Atölye ve Kesim Deposu',
    isDefault: false,
  });
  const boutique = await createWarehouse(tx, ctx.companyId, {
    code: 'DEP-BUTIK',
    name: 'Butik Mağaza Deposu (Nişantaşı)',
    isDefault: false,
  });
  const fasonWh = await createWarehouse(tx, ctx.companyId, {
    code: 'DEP-FASON',
    name: 'Dış Fason Deposu (Usta Atölye)',
    isDefault: false,
  });

  // Döviz Kurları (Son 30 Gün)
  const rateDates: string[] = [];
  for (let i = 0; i <= 30; i++) {
    rateDates.push(addDays(date, -i));
  }
  const rateRows = rateDates.flatMap((d) => [
    {
      companyId: ctx.companyId,
      rateDate: d,
      currencyCode: 'EUR',
      quoteCode: 'TRY',
      buy: toDbRate(37.5),
      sell: toDbRate(37.8),
      source: 'demo',
      createdBy: ctx.userId,
    },
    {
      companyId: ctx.companyId,
      rateDate: d,
      currencyCode: 'USD',
      quoteCode: 'TRY',
      buy: toDbRate(34.2),
      sell: toDbRate(34.5),
      source: 'demo',
      createdBy: ctx.userId,
    },
    {
      companyId: ctx.companyId,
      rateDate: d,
      currencyCode: 'GBP',
      quoteCode: 'TRY',
      buy: toDbRate(44.8),
      sell: toDbRate(45.2),
      source: 'demo',
      createdBy: ctx.userId,
    },
  ]);
  await tx.insert(exchangeRates).values(rateRows).onConflictDoNothing();

  // 2. Cariler (Tedarikçiler, Müşteriler, Fasoncular)
  const supplierToscana = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-TED-01',
      name: 'Toscana Tabakhane & Deri (İtalya)',
      kind: 'supplier',
      taxNumber: 'IT987654321',
      city: 'Floransa',
    }),
  );

  const supplierMetal = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-TED-02',
      name: 'İstanbul Metal Aksesuar & Toka Ltd.',
      kind: 'supplier',
      taxNumber: '2849102948',
      city: 'İstanbul',
    }),
  );

  await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-TED-03',
      name: 'Bursa İpek & Süet Astar Tekstil A.Ş.',
      kind: 'supplier',
      taxNumber: '1948201947',
      city: 'Bursa',
    }),
  );

  await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-TED-04',
      name: 'YKK Metal Fermuar Sanayi A.Ş.',
      kind: 'supplier',
      taxNumber: '9284710294',
      city: 'İstanbul',
    }),
  );

  const customerVakko = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-MUS-01',
      name: 'Vakko Tekstil ve Hazır Giyim A.Ş.',
      kind: 'customer',
      taxNumber: '9220038841',
      city: 'İstanbul',
    }),
  );

  const customerBeymen = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-MUS-02',
      name: 'Beymen Mağazacılık A.Ş.',
      kind: 'customer',
      taxNumber: '1660029918',
      city: 'İstanbul',
    }),
  );

  const customerNisantasi = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-MUS-03',
      name: 'Nişantaşı Premium Butik & Çanta Dünyası',
      kind: 'customer',
      taxNumber: '3819204918',
      city: 'İstanbul',
    }),
  );

  const customerVipAhmet = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-MUS-04',
      name: 'Ahmet Yılmaz (VIP / Özel Müşteri)',
      kind: 'customer',
      city: 'İstanbul',
    }),
  );

  const customerVipLeyla = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-MUS-05',
      name: 'Leyla Kaya (Özel Koleksiyon)',
      kind: 'customer',
      city: 'Bursa',
    }),
  );

  const partyFason = await createParty(
    tx,
    ctx.companyId,
    createPartySchema.parse({
      code: 'CAR-FAS-01',
      name: 'Usta Deri Kenar Boya & Toka Atölyesi',
      kind: 'supplier',
      taxNumber: '4829103948',
      city: 'İstanbul',
    }),
  );

  // 3. Stok Kartları (Hammaddeler ve Mamuller)
  // Hammaddeler
  const rawDeriDana = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-DERI-01',
      name: 'Bitkisel Tabaklanmış Dana Derisi (Taba)',
      unit: 'm2',
      inventoryRole: 'raw_material',
      purchasePrice: '350',
      purchaseCurrency: 'TRY',
      minLevel: '20',
    }),
  );

  const rawDeriKuzu = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-DERI-02',
      name: 'Napa Kuzu Derisi (Siyah)',
      unit: 'm2',
      inventoryRole: 'raw_material',
      purchasePrice: '400',
      purchaseCurrency: 'TRY',
      minLevel: '15',
    }),
  );

  await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-DERI-03',
      name: 'Süet Dana Derisi (Haki)',
      unit: 'm2',
      inventoryRole: 'raw_material',
      purchasePrice: '320',
      purchaseCurrency: 'TRY',
    }),
  );

  const rawAstar = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-AST-01',
      name: 'Hakiki Süet İç Astar Kumaşı',
      unit: 'm2',
      inventoryRole: 'raw_material',
      purchasePrice: '60',
      purchaseCurrency: 'TRY',
      minLevel: '10',
    }),
  );

  const rawToka = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-AKS-01',
      name: 'Antik Pirinç Kemer Tokası 35mm',
      unit: 'adet',
      inventoryRole: 'raw_material',
      purchasePrice: '45',
      purchaseCurrency: 'TRY',
    }),
  );

  const rawKilit = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-AKS-02',
      name: 'Pirinç Çıtçıt ve Kilit Seti',
      unit: 'adet',
      inventoryRole: 'raw_material',
      purchasePrice: '25',
      purchaseCurrency: 'TRY',
      minLevel: '50',
    }),
  );

  const rawFermuar = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-FER-01',
      name: 'YKK Deri Fermuar No:5 Antik Pirinç',
      unit: 'adet',
      inventoryRole: 'raw_material',
      purchasePrice: '35',
      purchaseCurrency: 'TRY',
      minLevel: '30',
    }),
  );

  await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'HAM-IPL-01',
      name: 'Mumlu Saraç Dikiş İpi 0.8mm',
      unit: 'rulo',
      inventoryRole: 'raw_material',
      purchasePrice: '80',
      purchaseCurrency: 'TRY',
    }),
  );

  // Mamuller
  const fgCuzdan = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'MAM-CZD-01',
      name: 'Ada El Yapımı Klasik Deri Cüzdan (Taba)',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: '869000100101',
      salePrice: '1250',
      saleCurrency: 'TRY',
    }),
  );

  const fgKartlik = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'MAM-KRT-01',
      name: 'Ada Minimalist Deri Kartlık (Siyah)',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: '869000100102',
      salePrice: '650',
      saleCurrency: 'TRY',
    }),
  );

  const fgKemer = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'MAM-KMR-01',
      name: 'Ada Klasik Bitkisel Deri Kemer (Kahverengi)',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: '869000100103',
      salePrice: '950',
      saleCurrency: 'TRY',
    }),
  );

  const fgCanta = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'MAM-CNT-01',
      name: 'Ada Lüks Deri Laptop & Evrak Çantası (Bordo)',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: '869000100104',
      salePrice: '4500',
      saleCurrency: 'TRY',
    }),
  );

  await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'MAM-DUF-01',
      name: 'Ada Vintage Deri Seyahat Çantası (Taba)',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: '869000100105',
      salePrice: '6800',
      saleCurrency: 'TRY',
    }),
  );

  // Seri No Takipli Özel Koleksiyon Ürün
  const fgLuksCanta = await createItem(
    tx,
    ctx.companyId,
    createItemSchema.parse({
      code: 'MAM-LUK-01',
      name: 'Ada Koleksiyon Lüks Timsah Baskı Deri Çanta (Seri No Takipli)',
      unit: 'adet',
      inventoryRole: 'finished_goods',
      barcode: '869000100109',
      salePrice: '18500',
      saleCurrency: 'TRY',
      tracksSerial: true,
    }),
  );

  // 4. Stok Açılış Belgesi (Merkez Depo İlk Stoklar)
  log('Ada Deri: Depo stok açılışları ve transferler oluşturuluyor...');
  await postStockDocument(
    tx,
    ctx,
    createStockDocumentSchema.parse({
      type: 'opening',
      docDate: date,
      warehouseId: mainWarehouseId,
      description: 'Ada Deri açılış hammadde ve mamul stok devir fişi',
      lines: [
        { itemId: rawDeriDana.id, quantity: '120', unitCost: '350' },
        { itemId: rawDeriKuzu.id, quantity: '80', unitCost: '400' },
        { itemId: rawAstar.id, quantity: '90', unitCost: '60' },
        { itemId: rawToka.id, quantity: '150', unitCost: '45' },
        { itemId: rawKilit.id, quantity: '400', unitCost: '25' },
        { itemId: rawFermuar.id, quantity: '200', unitCost: '35' },
        { itemId: fgCuzdan.id, quantity: '35', unitCost: '450' },
        { itemId: fgKartlik.id, quantity: '40', unitCost: '220' },
        { itemId: fgKemer.id, quantity: '25', unitCost: '350' },
        { itemId: fgCanta.id, quantity: '12', unitCost: '1800' },
      ],
    }),
  );

  // Atölye Deposu Açılış Stoğu
  await postStockDocument(
    tx,
    ctx,
    createStockDocumentSchema.parse({
      type: 'opening',
      docDate: date,
      warehouseId: workshop.id,
      description: 'Ada Deri atölye hammadde ve sarf malzeme açılış devir fişi',
      lines: [
        { itemId: rawDeriDana.id, quantity: '100', unitCost: '350' },
        { itemId: rawDeriKuzu.id, quantity: '60', unitCost: '400' },
        { itemId: rawAstar.id, quantity: '80', unitCost: '60' },
        { itemId: rawToka.id, quantity: '120', unitCost: '45' },
        { itemId: rawKilit.id, quantity: '300', unitCost: '25' },
        { itemId: rawFermuar.id, quantity: '150', unitCost: '35' },
      ],
    }),
  );

  // Butik Depoya Seri Numaralı Özel Çantaların Girişi (İrsaliye ve Seri Takibi)
  try {
    const delivSerialId = await createDeliveryDraft(
      tx,
      { ...ctx, allowNegativeStock: false },
      createDeliveryNoteSchema.parse({
        type: 'purchase',
        partyId: supplierToscana.id,
        noteDate: date,
        warehouseId: boutique.id,
        externalNo: 'IRS-LUX-2026-01',
        lines: [
          {
            itemId: fgLuksCanta.id,
            description: 'Ada Koleksiyon Lüks Timsah Baskı Deri Çanta (Seri No Takipli)',
            quantity: '5',
            unitCost: '8500',
            serials: [
              'ADA-LUX-2026-0001',
              'ADA-LUX-2026-0002',
              'ADA-LUX-2026-0003',
              'ADA-LUX-2026-0004',
              'ADA-LUX-2026-0005',
            ],
          },
        ],
      }),
    );
    await postDeliveryNote(tx, { ...ctx, allowNegativeStock: false }, delivSerialId);
  } catch (err) {
    throw new Error('Seri no girişi hatası', { cause: err });
  }

  // 5. Ürün Modelleri, Revizyonları (Reçeteleri) ve Varyantları
  log('Ada Deri: Üretim modelleri, reçeteler ve operasyon rotaları tanımlanıyor...');

  // Model 1: Klasik Cüzdan
  const modelCuzdan = await createModel(tx, ctx, {
    code: 'MOD-CZD-01',
    name: 'Klasik Katlanır Deri Cüzdan',
    family: 'Cüzdan & Küçük Aksesuar',
    description: '6 kart bölmeli, kağıt para gözlü geleneksel saraç dikişli deri cüzdan',
  });

  const revCuzdan = await createRevision(
    tx,
    ctx,
    modelCuzdan.id,
    leatherRevisionSchema.parse({
      name: 'R1 - Standart El Dikişli Üretim Reçetesi',
      sampleApproved: true,
      leatherYieldRate: '88',
      operations: [
        { key: 'cut', name: 'Deri Kalıp Kesimi', plannedMinutes: '15', plannedCost: '45' },
        { key: 'skive', name: 'Kenar Tıraşlama (Bıçkı)', plannedMinutes: '10', plannedCost: '30' },
        { key: 'assembly', name: 'Bölme Yapıştırma & Montaj', plannedMinutes: '30', plannedCost: '75' },
        { key: 'sewing', name: 'Saraç El Dikişi', plannedMinutes: '45', plannedCost: '120' },
        { key: 'edge_paint', name: 'Kenar Boyama ve Zımpara', plannedMinutes: '20', plannedCost: '50' },
      ],
      materials: [
        { itemId: rawDeriDana.id, quantity: '0.12' },
        { itemId: rawAstar.id, quantity: '0.08' },
        { itemId: rawKilit.id, quantity: '1' },
      ],
    }),
  );
  await approveRevision(tx, ctx, revCuzdan.id);

  const varCuzdan = await createVariant(
    tx,
    ctx,
    leatherVariantSchema.parse({
      modelId: modelCuzdan.id,
      revisionId: revCuzdan.id,
      itemId: fgCuzdan.id,
      color: 'Taba',
      leatherType: 'Dana',
    }),
  );

  // Model 2: Kartlık
  const modelKartlik = await createModel(tx, ctx, {
    code: 'MOD-KRT-01',
    name: 'Minimalist Deri Kartlık',
    family: 'Cüzdan & Küçük Aksesuar',
    description: '4 kart kapasiteli ultra ince cep kartlığı',
  });

  const revKartlik = await createRevision(
    tx,
    ctx,
    modelKartlik.id,
    leatherRevisionSchema.parse({
      name: 'R1 - Lazer Kesim & Makine Dikiş',
      sampleApproved: true,
      leatherYieldRate: '92',
      operations: [
        { key: 'cut', name: 'Hassas Kesim', plannedMinutes: '8', plannedCost: '25' },
        { key: 'assembly', name: 'Kat Montajı', plannedMinutes: '15', plannedCost: '40' },
        { key: 'sewing', name: 'Makine Dikişi', plannedMinutes: '12', plannedCost: '35' },
      ],
      materials: [
        { itemId: rawDeriKuzu.id, quantity: '0.06' },
        { itemId: rawAstar.id, quantity: '0.04' },
      ],
    }),
  );
  await approveRevision(tx, ctx, revKartlik.id);

  const varKartlik = await createVariant(
    tx,
    ctx,
    leatherVariantSchema.parse({
      modelId: modelKartlik.id,
      revisionId: revKartlik.id,
      itemId: fgKartlik.id,
      color: 'Siyah',
      leatherType: 'Kuzu',
    }),
  );

  // Model 3: Kemer
  const modelKemer = await createModel(tx, ctx, {
    code: 'MOD-KMR-01',
    name: 'Klasik Bitkisel Deri Kemer',
    family: 'Kemer & Kayış',
    description: '3.5cm antik toka montajlı kalın vaketa deri kemer',
  });

  const revKemer = await createRevision(
    tx,
    ctx,
    modelKemer.id,
    leatherRevisionSchema.parse({
      name: 'R1 - Vaketa Bant Kesim',
      sampleApproved: true,
      leatherYieldRate: '95',
      operations: [
        { key: 'cut', name: 'Bant Şerit Kesim', plannedMinutes: '10', plannedCost: '30' },
        { key: 'assembly', name: 'Toka & Perçin Montajı', plannedMinutes: '15', plannedCost: '45' },
      ],
      materials: [
        { itemId: rawDeriDana.id, quantity: '0.15' },
        { itemId: rawToka.id, quantity: '1' },
      ],
    }),
  );
  await approveRevision(tx, ctx, revKemer.id);

  const varKemer = await createVariant(
    tx,
    ctx,
    leatherVariantSchema.parse({
      modelId: modelKemer.id,
      revisionId: revKemer.id,
      itemId: fgKemer.id,
      color: 'Kahverengi',
      leatherType: 'Dana',
    }),
  );

  // Model 4: Laptop Çantası
  const modelCanta = await createModel(tx, ctx, {
    code: 'MOD-CNT-01',
    name: 'Ada Lüks Laptop & Evrak Çantası',
    family: 'Çanta & Valiz',
    description: '15.6 inç korumalı iç bölmeli, pirinç fermuarlı el ve omuz çantası',
  });

  const revCanta = await createRevision(
    tx,
    ctx,
    modelCanta.id,
    leatherRevisionSchema.parse({
      name: 'R1 - Çok Bölmeli Çanta Üretimi',
      sampleApproved: true,
      leatherYieldRate: '85',
      operations: [
        { key: 'cut', name: 'Kalıp Kesim', plannedMinutes: '40', plannedCost: '120' },
        { key: 'skive', name: 'Kenar İnceltme', plannedMinutes: '25', plannedCost: '75' },
        { key: 'assembly', name: 'Gövde & Sap Montajı', plannedMinutes: '90', plannedCost: '250', outsourced: true },
        { key: 'sewing', name: 'Ağır Hizmet Dikiş', plannedMinutes: '60', plannedCost: '180' },
      ],
      materials: [
        { itemId: rawDeriDana.id, quantity: '1.40' },
        { itemId: rawAstar.id, quantity: '0.90' },
        { itemId: rawFermuar.id, quantity: '2' },
        { itemId: rawKilit.id, quantity: '2' },
      ],
    }),
  );
  await approveRevision(tx, ctx, revCanta.id);

  const varCanta = await createVariant(
    tx,
    ctx,
    leatherVariantSchema.parse({
      modelId: modelCanta.id,
      revisionId: revCanta.id,
      itemId: fgCanta.id,
      color: 'Bordo',
      leatherType: 'Dana',
      allowsPersonalization: true,
    }),
  );

  // 6. Kalıplar (Patterns)
  try {
    await createPattern(tx, ctx, {
      requestKey: newId(),
      modelId: modelCuzdan.id,
      code: 'KAL-CZD-01',
      name: 'Cüzdan Dış Gövde Kalıbı',
      area: '0.0450',
      direction: 'any',
    });
    await createPattern(tx, ctx, {
      requestKey: newId(),
      modelId: modelKartlik.id,
      code: 'KAL-KRT-01',
      name: 'Kartlık Dış Kapak Kalıbı',
      area: '0.0250',
      direction: 'any',
    });
  } catch (err) {
    throw new Error('Kalıp oluşturma hatası', { cause: err });
  }

  // 7. Deri Malzeme Kabulü ve Fiziksel Parça Barkodları (Leather Pieces)
  log('Ada Deri: Fiziksel deri kabulü, parça kalite kontrolü ve ilk kesim...');
  let lotPieces: { id: string }[];
  try {
    const receiptDana = await receiveMaterial(
      tx,
      ctx,
      leatherReceiptSchema.parse({
        partyId: supplierToscana.id,
        itemId: rawDeriDana.id,
        warehouseId: workshop.id,
        date: addDays(date, -10),
        externalNo: 'FAT-TOSC-2026-88',
        provisionalUnitCost: '350',
        tanning: 'vegetable',
        tannery: 'Toscana Tannery S.p.A.',
        country: 'İtalya',
        pieces: [
          { code: 'PARCA-001', area: '2.45', usableArea: '2.40', thicknessMin: '1.8', thicknessMax: '2.0', grade: 'A' },
          { code: 'PARCA-002', area: '2.10', usableArea: '2.05', thicknessMin: '1.8', thicknessMax: '2.0', grade: 'A' },
          { code: 'PARCA-003', area: '1.95', usableArea: '1.85', thicknessMin: '1.8', thicknessMax: '2.0', grade: 'B' },
        ],
      }),
    );

    const pieceRes = await tx.execute<{ id: string }>(sql`select id from leather_pieces where lot_id=${receiptDana.id}::uuid`);
    lotPieces = pieceRes.rows;
    for (const p of lotPieces) {
      await acceptPiece(tx, ctx, p.id, {
        decision: 'accept',
        note: 'İtalyan bitkisel tabaklama homojen, damar yapısı kusursuz.',
      });
    }
  } catch (err) {
    throw new Error('Deri kabulü hatası', { cause: err });
  }

  // 8. Üretim Emirleri (MES / Üretim Yönetimi)
  log('Ada Deri: Üretim emirleri, parti takibi ve operasyon kayıtları oluşturuluyor...');

  // Üretim Emri 1: Cüzdan (Tamamlanmış)
  const order1 = await createProduction(
    tx,
    ctx,
    leatherProductionSchema.parse({
      variantId: varCuzdan.id,
      revisionId: revCuzdan.id,
      quantity: '25',
      warehouseId: workshop.id,
      outputWarehouseId: mainWarehouseId,
      assignedUserId: ctx.userId,
      dueDate: addDays(date, -3),
      note: 'Vakko A.Ş. Sonbahar vitrin siparişi teslimatı için özel parti',
    }),
  );

  await releaseProduction(tx, ctx, order1.id, leatherDatedActionSchema.parse({ date: addDays(date, -6), requestKey: newId() }));

  // İlk deriden kesim işlemi gerçekleştir
  if (lotPieces[0]) {
    try {
      await cutMaterial(tx, ctx, {
        date: addDays(date, -5),
        requestKey: newId(),
        note: 'Cüzdan kalıp kesimi yapıldı',
        orderId: order1.id,
        pieceId: lotPieces[0].id,
        usedArea: '2.40',
        wasteArea: '0.05',
        setsProduced: 25,
        remnants: [],
      });
    } catch (err) {
      throw new Error('Kesim hatası', { cause: err });
    }
  }

  await issueProduction(
    tx,
    ctx,
    order1.id,
    leatherIssueSchema.parse({
      date: addDays(date, -5),
      requestKey: newId(),
      lines: [
        { itemId: rawAstar.id, quantity: '2.00' },
        { itemId: rawKilit.id, quantity: '25' },
      ],
    }),
  );

  // Operasyonları kaydet
  await recordOperation(tx, ctx, order1.id, {
    date: addDays(date, -5),
    requestKey: newId(),
    key: 'cut',
    status: 'completed',
    quantity: '25',
    goodQty: '25',
    scrapQty: '0',
    reworkQty: '0',
    minutes: '375',
  });

  await recordOperation(tx, ctx, order1.id, {
    date: addDays(date, -4),
    requestKey: newId(),
    key: 'assembly',
    status: 'completed',
    quantity: '25',
    goodQty: '25',
    scrapQty: '0',
    reworkQty: '0',
    minutes: '750',
  });

  const qc1 = await createQuality(
    tx,
    ctx,
    leatherQualitySchema.parse({
      scope: 'production',
      sourceId: order1.id,
      stage: 'final',
      inspectedQty: '25',
      passedQty: '25',
      checks: [
        { label: 'Dikiş sıklığı ve mumlu ip gerginliği', passed: true },
        { label: 'Kenar boya homojenliği', passed: true },
        { label: 'Kilit & çıtçıt kapanma testi', passed: true },
      ],
      note: 'Birinci sınıf kalite standardı teyit edildi.',
    }),
  );
  await decideQuality(tx, ctx, qc1.id, leatherQualityDecisionSchema.parse({ decision: 'approve' }));

  await completeProduction(
    tx,
    ctx,
    order1.id,
    leatherCompletionSchema.parse({
      date: addDays(date, -3),
      requestKey: newId(),
      quantity: '25',
      qualityCheckId: qc1.id,
    }),
  );

  // Üretim Emri 2: Kartlık (Devam Eden / Üretimde)
  const order2 = await createProduction(
    tx,
    ctx,
    leatherProductionSchema.parse({
      variantId: varKartlik.id,
      revisionId: revKartlik.id,
      quantity: '30',
      warehouseId: workshop.id,
      outputWarehouseId: mainWarehouseId,
      assignedUserId: ctx.userId,
      dueDate: addDays(date, 5),
      note: 'Butik mağaza ve online siparişler için minimalist kartlık',
      reservations: [
        { itemId: rawDeriKuzu.id, quantity: '10.00' },
        { itemId: rawAstar.id, quantity: '5.00' },
      ],
    }),
  );

  await releaseProduction(tx, ctx, order2.id, leatherDatedActionSchema.parse({ date: addDays(date, -1), requestKey: newId() }));

  await issueProduction(
    tx,
    ctx,
    order2.id,
    leatherIssueSchema.parse({
      date: addDays(date, -1),
      requestKey: newId(),
      lines: [
        { itemId: rawDeriKuzu.id, quantity: '1.80' },
        { itemId: rawAstar.id, quantity: '1.20' },
      ],
    }),
  );

  // Üretim Emri 3: Kemer (Gecikmiş / Müdahale Bekleyen)
  const order3 = await createProduction(
    tx,
    ctx,
    leatherProductionSchema.parse({
      variantId: varKemer.id,
      revisionId: revKemer.id,
      quantity: '20',
      warehouseId: workshop.id,
      outputWarehouseId: mainWarehouseId,
      assignedUserId: ctx.userId,
      dueDate: addDays(date, -1), // Dün teslim edilmeliydi -> late_order exception
      note: 'Beymen kış siparişi vaketa kemer partisi',
    }),
  );
  await releaseProduction(tx, ctx, order3.id, leatherDatedActionSchema.parse({ date: addDays(date, -3), requestKey: newId() }));

  // Üretim Emri 3 için Bekleyen Kalite Kontrolü (quality_hold exception)
  await createQuality(
    tx,
    ctx,
    leatherQualitySchema.parse({
      scope: 'production',
      sourceId: order3.id,
      stage: 'intermediate',
      inspectedQty: '20',
      passedQty: '18',
      reworkQty: '2',
      checks: [
        { label: 'Toka delik ekseni ve perçin sağlamlığı', passed: true },
      ],
      note: '2 adet toka yuvasında milimetrik sapma tespit edildi; karar bekleniyor.',
    }),
  );

  // Üretim Emri 4: Çanta (Fason İşleme Verilen)
  const order4 = await createProduction(
    tx,
    ctx,
    leatherProductionSchema.parse({
      variantId: varCanta.id,
      revisionId: revCanta.id,
      quantity: '10',
      warehouseId: workshop.id,
      outputWarehouseId: mainWarehouseId,
      assignedUserId: ctx.userId,
      dueDate: addDays(date, 12),
      note: 'VIP müşteri ve özel siparişler için el yapımı deri laptop çantası',
    }),
  );
  await releaseProduction(tx, ctx, order4.id, leatherDatedActionSchema.parse({ date: addDays(date, -2), requestKey: newId() }));

  // 9. Kapasite, Makineler ve Çizelgeleme (Planning & Scheduling)
  log('Ada Deri: Kapasite planlama kaynakları, vardiyalar ve çizelgeleme kuruluyor...');
  const machinePres = await createRecord(
    tx,
    ctx,
    'resource',
    { code: 'MAK-PRES', name: 'Atom Hidrolik Kalıp Kesim Presi', type: 'machine', capacity: 1 },
    'active',
  );

  const machineDikis = await createRecord(
    tx,
    ctx,
    'resource',
    { code: 'MAK-DIKIS', name: 'Durkopp Adler Çift İğne Dikiş Makinesi', type: 'machine', capacity: 1 },
    'active',
  );

  const stationSarac = await createRecord(
    tx,
    ctx,
    'resource',
    { code: 'IST-SARAC', name: 'Baş Saraç El Montaj ve Dikiş İstasyonu', type: 'workstation', capacity: 2 },
    'active',
  );

  // 7 Günlük Çalışma Vardiyaları (Calendar Templates)
  const shiftEnd = addDays(date, 14);
  try {
    await calendarTemplate(
      tx,
      ctx,
      manufacturingCalendarTemplateSchema.parse({
        requestKey: newId(),
        resourceId: machinePres.id,
        from: date,
        to: shiftEnd,
        weekdays: [1, 2, 3, 4, 5, 6],
        startTime: '08:30',
        endTime: '18:00',
        reason: 'Haftalık standart atölye çalışma vardiyası',
      }),
    );
    await calendarTemplate(
      tx,
      ctx,
      manufacturingCalendarTemplateSchema.parse({
        requestKey: newId(),
        resourceId: machineDikis.id,
        from: date,
        to: shiftEnd,
        weekdays: [1, 2, 3, 4, 5, 6],
        startTime: '08:30',
        endTime: '18:00',
        reason: 'Haftalık standart atölye çalışma vardiyası',
      }),
    );
    await calendarTemplate(
      tx,
      ctx,
      manufacturingCalendarTemplateSchema.parse({
        requestKey: newId(),
        resourceId: stationSarac.id,
        from: date,
        to: shiftEnd,
        weekdays: [1, 2, 3, 4, 5, 6],
        startTime: '08:30',
        endTime: '18:00',
        reason: 'Haftalık standart atölye çalışma vardiyası',
      }),
    );
  } catch (err) {
    throw new Error('Vardiya şablonu hatası', { cause: err });
  }

  // Çizelgeleme (Schedule)
  try {
    const planningScenario = manufacturingScheduleSchema.parse({
      anchor: `${date}T08:30:00+03:00`,
      direction: 'forward',
      jobs: [
        {
          orderId: order2.id,
          operationKey: 'cut',
          resourceId: machinePres.id,
          minutes: 240,
          priority: 80,
        },
        {
          orderId: order2.id,
          operationKey: 'sewing',
          resourceId: machineDikis.id,
          minutes: 360,
          priority: 80,
        },
      ],
    });
    await createRecord(
      tx,
      ctx,
      'schedule',
      {
        ...planningScenario,
        operations: await schedule(tx, planningScenario),
        version: 1,
        reason: 'Haftalık atölye üretim ve termin planı',
      },
      'active',
    );
  } catch (err) {
    throw new Error('Çizelgeleme hatası', { cause: err });
  }

  // Makine Arızası (Müdahale Bekleyen İşler / machine_failure Exception)
  try {
    await maintenance(tx, ctx, {
      resourceId: machinePres.id,
      start: `${date}T09:00:00+03:00`,
      end: `${date}T13:00:00+03:00`,
      kind: 'breakdown',
      description: 'Pres kesim tablası hidrolik basınç kaçağı ve bıçak bileme arızası',
      spareParts: [],
    });
  } catch (err) {
    throw new Error('Bakım/Arıza kaydı hatası', { cause: err });
  }

  // 10. Atölyeye Malzeme Teslim Et (Handoff), Parti ve Rework
  try {
    await materialHandoff(
      tx,
      ctx,
      order2.id,
      manufacturingMaterialHandoffSchema.parse({
        action: 'deliver',
        itemId: rawDeriKuzu.id,
        quantity: '1.80',
        receiverId: ctx.userId,
        date,
        requestKey: newId(),
        reason: 'Kartlık üretimi için napa kuzu derisinin kesim masasına fiziki teslimi',
      }),
    );

    await createBatch(
      tx,
      ctx,
      manufacturingBatchSchema.parse({
        requestKey: newId(),
        orderId: order2.id,
        quantity: '15',
        reason: 'Hızlı parti üretimi',
      }),
    );

    const qcOrder2 = await createQuality(
      tx,
      ctx,
      leatherQualitySchema.parse({
        scope: 'production',
        sourceId: order2.id,
        stage: 'intermediate',
        inspectedQty: '10',
        passedQty: '8',
        reworkQty: '2',
        checks: [
          { label: 'Kart bölmesi kat hizalaması', passed: true },
        ],
        note: '2 adet kartlık katında milimetrik kayma tespit edildi, yeniden işlenecek.',
      }),
    );
    await decideQuality(tx, ctx, qcOrder2.id, leatherQualityDecisionSchema.parse({ decision: 'approve' }));

    await createRework(
      tx,
      ctx,
      manufacturingReworkSchema.parse({
        requestKey: newId(),
        orderId: order2.id,
        operationKey: 'assembly',
        quantity: '2',
        defectCode: 'DIKIS_HATASI',
        qualityCheckId: qcOrder2.id,
        reason: 'Dikiş ve kat hizalama düzeltmesi',
      }),
    );
  } catch (err) {
    throw new Error('Handoff / Batch / Rework hatası', { cause: err });
  }

  // 11. Tedarik ve Stok Politikaları (Minimum Stok & Stok Yenileme & MRP)
  log('Ada Deri: Tedarikçi planlama profilleri ve minimum stok politikaları kaydediliyor...');
  try {
    await createRecord(
      tx,
      ctx,
      'supplier_profile',
      manufacturingSupplierSchema.parse({
        requestKey: newId(),
        itemId: rawDeriDana.id,
        partyId: supplierToscana.id,
        supplierCode: 'TOSC-DANA-VAK',
        leadDays: 7,
        minOrderQty: '50',
        packQty: '10',
        unitPrice: '350',
        currency: 'TRY',
        preferred: true,
        reason: 'Tercih edilen ana hammadde tedarikçi profili',
      }),
      'active',
    );

    await createRecord(
      tx,
      ctx,
      'supplier_profile',
      manufacturingSupplierSchema.parse({
        requestKey: newId(),
        itemId: rawToka.id,
        partyId: supplierMetal.id,
        supplierCode: 'MTL-TOKA-35',
        leadDays: 3,
        minOrderQty: '100',
        packQty: '25',
        unitPrice: '45',
        currency: 'TRY',
        preferred: true,
        reason: 'Metal toka ve aksesuar yerel tedarik profili',
      }),
      'active',
    );

    // Stok (120) < Minimum (200) -> Stok Yenileme Önerisi (Replenishment) tetiklenir!
    await createRecord(
      tx,
      ctx,
      'demand_policy',
      manufacturingDemandPolicySchema.parse({
        requestKey: newId(),
        itemId: rawDeriDana.id,
        warehouseId: mainWarehouseId,
        minimum: '200',
        target: '350',
        reason: 'Emniyet stoğu ve ikmal politikası',
      }),
      'active',
    );

    await createRecord(
      tx,
      ctx,
      'demand_policy',
      manufacturingDemandPolicySchema.parse({
        requestKey: newId(),
        itemId: rawToka.id,
        warehouseId: mainWarehouseId,
        minimum: '300',
        target: '500',
        reason: 'Kemer tokası minimum emniyet seviyesi',
      }),
      'active',
    );
  } catch (err) {
    throw new Error('Tedarik ve stok politikaları hatası', { cause: err });
  }

  // 12. Fason ve Servis İşlemleri
  try {
    await createSubcontract(
      tx,
      ctx,
      {
        orderId: order4.id,
        partyId: partyFason.id,
        externalWarehouseId: fasonWh.id,
        dueDate: addDays(date, 7),
        operationKey: 'assembly',
        quantity: '10',
        note: 'Lüks laptop çantası kenar cila boyama ve kilit çakım fason işçiliği',
      },
    );
  } catch (err) {
    throw new Error('Fason işi oluşturma hatası', { cause: err });
  }

  // Özel Sipariş (Custom Order)
  try {
    const custOrder = await createCustomOrder(
      tx,
      ctx,
      leatherCustomOrderSchema.parse({
        partyId: customerVipLeyla.id,
        variantId: varCanta.id,
        dueDate: addDays(date, 20),
        quantity: '1',
        unitPrice: '8500',
        currency: 'TRY',
        monogram: 'LK',
        placement: 'Ön kapak alt köşe',
        customerNotes: 'Özel bordo süet astar, altın kaplama toka ve isim baş harfleri sıcak baskı',
      }),
    );
    await customAction(tx, ctx, custOrder.id, {
      action: 'confirm',
      date,
      requestKey: newId(),
      note: 'Kişiye özel sipariş detayları müşteriyle teyit edildi',
    });
  } catch (err) {
    throw new Error('Özel sipariş hatası', { cause: err });
  }

  // 13. Finans: Kasa ve Banka Hesapları
  log('Ada Deri: Kasa, banka ve finansal işlemler kuruluyor...');
  const cashAccount = await createTreasuryAccount(
    tx,
    ctx,
    createTreasuryAccountSchema.parse({
      name: 'Ada Deri Merkez Kasa (TL)',
      kind: 'cash',
      currency: 'TRY',
    }),
  );

  const boutiqueCash = await createTreasuryAccount(
    tx,
    ctx,
    createTreasuryAccountSchema.parse({
      name: 'Nişantaşı Butik Kasa (Nakit)',
      kind: 'cash',
      currency: 'TRY',
    }),
  );

  const bankAccount = await createTreasuryAccount(
    tx,
    ctx,
    createTreasuryAccountSchema.parse({
      name: 'İş Bankası Beyoğlu Ticari Hesap (TL)',
      kind: 'bank',
      currency: 'TRY',
      bankName: 'Türkiye İş Bankası',
      iban: 'TR120006400000123456789012',
    }),
  );

  const posAccount = await createTreasuryAccount(
    tx,
    ctx,
    createTreasuryAccountSchema.parse({
      name: 'Garanti BBVA POS Tahsilat Hesabı (TL)',
      kind: 'bank',
      currency: 'TRY',
      bankName: 'Garanti BBVA',
      iban: 'TR990006200000887766554433',
    }),
  );

  const eurBankAccount = await createTreasuryAccount(
    tx,
    ctx,
    createTreasuryAccountSchema.parse({
      name: 'İş Bankası EUR Dövizli Ticari Hesap',
      kind: 'bank',
      currency: 'EUR',
      bankName: 'Türkiye İş Bankası',
      iban: 'TR550006400000998877665544',
    }),
  );

  // Kasa ve Banka Fonlama Tahsilatları
  try {
    await postTreasuryTransaction(
      tx,
      ctx,
      createTreasuryTransactionSchema.parse({
        type: 'receipt',
        accountId: cashAccount.id,
        partyId: customerVipLeyla.id,
        date: addDays(date, -20),
        amount: '35000',
        description: 'Vip müşteri nakit avans ve tahsilat girişi',
      }),
    );
    await postTreasuryTransaction(
      tx,
      ctx,
      createTreasuryTransactionSchema.parse({
        type: 'receipt',
        accountId: bankAccount.id,
        partyId: customerVakko.id,
        date: addDays(date, -25),
        amount: '120000',
        description: 'Vakko A.Ş. toptan sipariş avans havalesi',
      }),
    );
    await postTreasuryTransaction(
      tx,
      ctx,
      createTreasuryTransactionSchema.parse({
        type: 'receipt',
        accountId: eurBankAccount.id,
        partyId: customerVakko.id,
        date: addDays(date, -10),
        amount: '8500',
        description: 'Vakko A.Ş. ihracat koleksiyonu EUR döviz transferi',
      }),
    );
  } catch (err) {
    throw new Error('Kasa/Banka fonlama hatası', { cause: err });
  }

  // 14. Faturalar & Tahsilatlar (TR KDV Oranları: KDV-10 ve KDV-20)
  log('Ada Deri: Faturalar, siparişler ve tahsilatlar kaydediliyor...');
  let purInv1Id: string;
  let purInv1LineId: string | null = null;

  // Alış Faturası: Toscana Tabakhane
  try {
    purInv1Id = await createInvoiceDraft(
      tx,
      ctx,
      createInvoiceSchema.parse({
        type: 'purchase',
        partyId: supplierToscana.id,
        invoiceDate: addDays(date, -15),
        warehouseId: mainWarehouseId,
        externalNo: 'FAT-TOSC-2026-99',
        lines: [
          {
            itemId: rawDeriDana.id,
            description: 'İtalyan Bitkisel Dana Derisi (Taba) 100 m2',
            quantity: '100',
            unitPrice: '350',
            taxCode: 'KDV-10',
          },
        ],
      }),
    );
    await postInvoice(tx, ctx, purInv1Id);

    const [pLine] = await tx
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, purInv1Id));
    if (pLine) purInv1LineId = pLine.id;

    // Kısmi ödeme yap
    await postTreasuryTransaction(
      tx,
      ctx,
      createTreasuryTransactionSchema.parse({
        type: 'payment',
        accountId: bankAccount.id,
        partyId: supplierToscana.id,
        date: addDays(date, -10),
        amount: '20000',
        description: 'Toscana tabakhane hammadde alışı kısmi banka transferi',
      }),
    );
  } catch (err) {
    throw new Error('Toscana alış faturası hatası', { cause: err });
  }

  // Alış Faturası: İstanbul Metal Aksesuar
  try {
    const purInv2Id = await createInvoiceDraft(
      tx,
      ctx,
      createInvoiceSchema.parse({
        type: 'purchase',
        partyId: supplierMetal.id,
        invoiceDate: addDays(date, -12),
        warehouseId: mainWarehouseId,
        externalNo: 'FAT-MTL-2026-104',
        lines: [
          {
            itemId: rawToka.id,
            description: 'Antik Pirinç Kemer Tokası 35mm (100 adet)',
            quantity: '100',
            unitPrice: '45',
            taxCode: 'KDV-20',
          },
          {
            itemId: rawKilit.id,
            description: 'Pirinç Çıtçıt ve Kilit Seti (80 adet)',
            quantity: '80',
            unitPrice: '25',
            taxCode: 'KDV-20',
          },
        ],
      }),
    );
    await postInvoice(tx, ctx, purInv2Id);
  } catch (err) {
    throw new Error('Metal alış faturası hatası', { cause: err });
  }

  // Satış Faturası 1: Vakko (Kayıtlı & Tahsil Edilmiş)
  try {
    const invDraft1Id = await createInvoiceDraft(
      tx,
      ctx,
      createInvoiceSchema.parse({
        type: 'sales',
        partyId: customerVakko.id,
        invoiceDate: addDays(date, -5),
        warehouseId: mainWarehouseId,
        lines: [
          {
            itemId: fgCuzdan.id,
            description: 'Ada El Yapımı Klasik Deri Cüzdan (Taba) - Özel Seri',
            quantity: '8',
            unitPrice: '1250',
            taxCode: 'KDV-10',
          },
        ],
      }),
    );
    await postInvoice(tx, ctx, invDraft1Id);

    const inv1Line = (await tx.execute<{ id: string }>(sql`select id from invoice_lines where invoice_id=${invDraft1Id}::uuid limit 1`)).rows[0];
    if (inv1Line) {
      try {
        const sc = await createServiceCase(
          tx,
          ctx,
          {
            partyId: customerVakko.id,
            itemId: fgCuzdan.id,
            invoiceLineId: inv1Line.id,
            date: addDays(date, -2),
            complaint: 'Cüzdan kilit çıtçıt gevşemesi ve genel deri besleme bakımı',
            warranty: true,
          },
        );
        await serviceAction(tx, ctx, sc.id, {
          action: 'diagnose',
          date,
          requestKey: newId(),
          assessment: 'Dikiş ve çıtçıt kontrolü yapıldı, mekanizma yenilenecek',
          fee: '0',
        });
      } catch (scErr) {
        throw new Error('Servis vakası hatası', { cause: scErr });
      }
    }

    await postTreasuryTransaction(
      tx,
      ctx,
      createTreasuryTransactionSchema.parse({
        type: 'receipt',
        accountId: bankAccount.id,
        partyId: customerVakko.id,
        date: addDays(date, -2),
        amount: '10000',
        description: 'Vakko cüzdan teslimatı İş Bankası havalesi',
      }),
    );
  } catch (err) {
    throw new Error('Vakko satış faturası hatası', { cause: err });
  }

  // Satış Faturası 2: Beymen (Kayıtlı, Açık Alacak)
  try {
    const invDraft2Id = await createInvoiceDraft(
      tx,
      ctx,
      createInvoiceSchema.parse({
        type: 'sales',
        partyId: customerBeymen.id,
        invoiceDate: date,
        warehouseId: mainWarehouseId,
        lines: [
          {
            itemId: fgCanta.id,
            description: 'Ada Lüks Deri Laptop & Evrak Çantası (Bordo)',
            quantity: '5',
            unitPrice: '4500',
            taxCode: 'KDV-10',
          },
          {
            itemId: fgKartlik.id,
            description: 'Ada Minimalist Deri Kartlık (Siyah)',
            quantity: '10',
            unitPrice: '650',
            taxCode: 'KDV-10',
          },
        ],
      }),
    );
    await postInvoice(tx, ctx, invDraft2Id);
  } catch (err) {
    throw new Error('Beymen satış faturası hatası', { cause: err });
  }

  // Satış Faturası 3: Nişantaşı Butik (Taslak Fatura)
  try {
    await createInvoiceDraft(
      tx,
      ctx,
      createInvoiceSchema.parse({
        type: 'sales',
        partyId: customerNisantasi.id,
        invoiceDate: date,
        warehouseId: boutique.id,
        lines: [
          {
            itemId: fgCuzdan.id,
            description: 'Ada Klasik Deri Cüzdan (Taba)',
            quantity: '4',
            unitPrice: '1250',
            taxCode: 'KDV-10',
          },
        ],
      }),
    );
  } catch (err) {
    throw new Error('Taslak satış faturası hatası', { cause: err });
  }

  // 15. Satış Teklif ve Siparişleri (Orders & Quotes)
  try {
    const quoteId = await createSalesDoc(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
      createSalesDocSchema.parse({
        kind: 'quote',
        partyId: customerBeymen.id,
        docDate: date,
        lines: [
          {
            itemId: fgKemer.id,
            quantity: '50',
            unitPrice: '850',
            description: 'Beymen Kış Koleksiyonu Özel Seri Kemer Teklifi',
          },
        ],
      }),
    );
    await transitionSalesDoc(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
      quoteId,
      'sent',
      'Müşteri satın alma yetkilisine PDF olarak iletildi',
    );

    const orderId = await createSalesDoc(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
      createSalesDocSchema.parse({
        kind: 'order',
        partyId: customerNisantasi.id,
        docDate: date,
        lines: [
          {
            itemId: fgKartlik.id,
            quantity: '20',
            unitPrice: '580',
            description: 'Nişantaşı Butik Mağaza Kartlık Siparişi',
          },
        ],
      }),
    );
    await transitionSalesDoc(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
      orderId,
      'confirmed',
      'Sipariş teyit edildi, üretimden sevk bekleniyor',
    );
  } catch (err) {
    throw new Error('Teklif/Sipariş hatası', { cause: err });
  }

  // 16. Fiyat Listeleri ve Cariye Özel Fiyatlar
  try {
    const plWholesale = await createPriceList(
      tx,
      ctx.companyId,
      createPriceListSchema.parse({
        code: 'FIST-TOPTAN-2026',
        name: '2026 İlkbahar / Yaz Toptan Fiyat Listesi (%15 İskonto)',
        kind: 'sales',
        currency: 'TRY',
        isActive: true,
        isDefault: true,
      }),
    );
    await addPriceListItem(tx, ctx.companyId, plWholesale.id, {
      itemId: fgCuzdan.id,
      minQty: '10',
      price: '1060',
    });
    await addPriceListItem(tx, ctx.companyId, plWholesale.id, {
      itemId: fgKartlik.id,
      minQty: '20',
      price: '520',
    });
    await addPriceListItem(tx, ctx.companyId, plWholesale.id, {
      itemId: fgKemer.id,
      minQty: '10',
      price: '800',
    });

    await createPriceList(
      tx,
      ctx.companyId,
      createPriceListSchema.parse({
        code: 'FIST-PERAKENDE-2026',
        name: '2026 Butik Mağaza Perakende Satış Listesi',
        kind: 'sales',
        currency: 'TRY',
        isActive: true,
        isDefault: false,
      }),
    );

    // Cariye Özel Fiyatlar
    await addPartyPrice(tx, ctx.companyId, {
      partyId: customerVakko.id,
      itemId: fgCuzdan.id,
      kind: 'sales',
      currency: 'TRY',
      price: '980',
      discountPct: null,
      minQty: '10',
      validFrom: `${date.slice(0, 4)}-01-01`,
      validTo: null,
    });

    await addPartyPrice(tx, ctx.companyId, {
      partyId: customerBeymen.id,
      itemId: fgCanta.id,
      kind: 'sales',
      currency: 'TRY',
      price: '3900',
      discountPct: null,
      minQty: '5',
      validFrom: null,
      validTo: null,
    });
  } catch (err) {
    throw new Error('Fiyat listesi ve özel fiyat hatası', { cause: err });
  }

  // 17. Satış Kampanyası ve Promosyon
  try {
    const campConfig = campaignSchema.parse({
      code: 'KMP-YAZ-2026',
      title: 'Yaz Sezonu Deri Aksesuar %10 İndirim Kampanyası',
      description: '10 adet ve üzeri cüzdan ve kartlık alımlarında toptan promosyon indirimi',
      from: `${date.slice(0, 4)}-05-01`,
      to: `${date.slice(0, 4)}-12-31`,
      currency: 'TRY',
      discountPct: '10',
      minimumAmount: '5000',
      minimumQuantity: '5',
      active: true,
    });
    await tx.insert(salesCampaigns).values({
      id: newId(),
      companyId: ctx.companyId,
      code: campConfig.code,
      config: campConfig,
      createdBy: ctx.userId,
    });
  } catch (err) {
    throw new Error('Kampanya hatası', { cause: err });
  }

  // 18. Gider Kartları ve Gider Fişleri
  log('Ada Deri: Gider kartları, fişleri ve çek portföyü kuruluyor...');
  let acc770Id: string | null = null;
  try {
    const [acc770] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`company_id=${ctx.companyId} and (code like '770%' or type='expense')`)
      .limit(1);

    if (acc770) {
      acc770Id = acc770.id;
      const cardElk = await createExpenseCard(
        tx,
        ctx.companyId,
        createExpenseCardSchema.parse({
          code: 'GDR-ELK',
          name: 'Atölye Elektrik ve Enerji Gideri',
          accountId: acc770.id,
          taxCode: 'KDV-20',
        }),
      );

      await createExpenseCard(
        tx,
        ctx.companyId,
        createExpenseCardSchema.parse({
          code: 'GDR-KIRA',
          name: 'Atölye ve Showroom Kira Gideri',
          accountId: acc770.id,
        }),
      );

      const cardKargo = await createExpenseCard(
        tx,
        ctx.companyId,
        createExpenseCardSchema.parse({
          code: 'GDR-KRGO',
          name: 'Kargo, Kurye ve Nakliye Masrafları',
          accountId: acc770.id,
          taxCode: 'KDV-20',
        }),
      );

      const cardSarf = await createExpenseCard(
        tx,
        ctx.companyId,
        createExpenseCardSchema.parse({
          code: 'GDR-SARF',
          name: 'Atölye Sarf Boya, Cila ve Yapıştırıcı',
          accountId: acc770.id,
          taxCode: 'KDV-20',
        }),
      );

      // Fiş girişleri
      await createExpenseEntry(
        tx,
        { ...ctx, baseCurrency: 'TRY', reportingCurrency: 'EUR' },
        createExpenseEntrySchema.parse({
          cardId: cardElk.id,
          entryDate: addDays(date, -5),
          net: '2850',
          taxCode: 'KDV-20',
          paymentKind: 'treasury',
          treasuryAccountId: cashAccount.id,
          description: 'Eylül ayı atölye elektrik faturası nakit ödemesi',
          post: true,
        }),
      );

      await createExpenseEntry(
        tx,
        { ...ctx, baseCurrency: 'TRY', reportingCurrency: 'EUR' },
        createExpenseEntrySchema.parse({
          cardId: cardKargo.id,
          entryDate: addDays(date, -3),
          net: '940',
          taxCode: 'KDV-20',
          paymentKind: 'treasury',
          treasuryAccountId: cashAccount.id,
          description: 'Vakko sevkiyatı sigortalı kargo bedeli',
          post: true,
        }),
      );

      await createExpenseEntry(
        tx,
        { ...ctx, baseCurrency: 'TRY', reportingCurrency: 'EUR' },
        createExpenseEntrySchema.parse({
          cardId: cardSarf.id,
          entryDate: date,
          net: '620',
          taxCode: 'KDV-20',
          paymentKind: 'treasury',
          treasuryAccountId: cashAccount.id,
          description: 'Saraç dikiş mumu ve kenar cila boyaları alımı',
          post: true,
        }),
      );
    }
  } catch (err) {
    throw new Error('Gider hatası', { cause: err });
  }

  // 19. Maliyet Dağıtımı (Cost Allocation to Production Order)
  try {
    const expRes = await tx.execute<{ id: string; debit_base: string }>(sql`
      select l.id, l.debit_base from journal_lines l
      join journal_entries e on e.id=l.entry_id
      join accounts a on a.id=l.account_id
      where e.company_id=${ctx.companyId} and e.status='posted' and l.debit_base > 0 and (a.type='expense' or a.code like '7%') and l.party_id is null
      order by e.created_at desc limit 1
    `);
    const expDebit = expRes.rows[0];
    if (expDebit) {
      await allocateCost(tx, ctx, {
        orderId: order1.id,
        sourceJournalLineId: expDebit.id,
        amount: expDebit.debit_base,
        kind: 'overhead',
        date,
        requestKey: newId(),
        note: 'Atölye enerji ve sarf malzeme giderlerinin cüzdan üretimine dağıtımı',
      });
    }
  } catch (err) {
    throw new Error('Maliyet dağıtımı hatası', { cause: err });
  }

  // 20. İrsaliyeler (Satış, Satış İade, Alış İade, Faturalaşmamış İrsaliyeler)
  log('Ada Deri: İrsaliyeler ve lojistik hareketler oluşturuluyor...');
  try {
    // 1. Satış İrsaliyesi (Vakko - Kayıtlı)
    const deliv1Id = await createDeliveryDraft(
      tx,
      { ...ctx, allowNegativeStock: false },
      createDeliveryNoteSchema.parse({
        type: 'sales',
        partyId: customerVakko.id,
        noteDate: addDays(date, -2),
        warehouseId: mainWarehouseId,
        lines: [
          {
            itemId: fgCuzdan.id,
            description: 'Ada El Yapımı Klasik Deri Cüzdan (Taba)',
            quantity: '5',
          },
        ],
      }),
    );
    await postDeliveryNote(tx, { ...ctx, allowNegativeStock: false }, deliv1Id);

    // 2. Faturalaşmamış Satış İrsaliyesi (Beymen - Kayıtlı, faturası henüz kesilmedi)
    const deliv2Id = await createDeliveryDraft(
      tx,
      { ...ctx, allowNegativeStock: false },
      createDeliveryNoteSchema.parse({
        type: 'sales',
        partyId: customerBeymen.id,
        noteDate: date,
        warehouseId: mainWarehouseId,
        lines: [
          {
            itemId: fgKemer.id,
            description: 'Ada Klasik Bitkisel Deri Kemer (Kahverengi)',
            quantity: '10',
          },
        ],
      }),
    );
    await postDeliveryNote(tx, { ...ctx, allowNegativeStock: false }, deliv2Id);

    // 3. Satış İade İrsaliyesi (Vakko'dan 1 adet numune iadesi)
    const delivReturnId = await createDeliveryDraft(
      tx,
      { ...ctx, allowNegativeStock: false },
      createDeliveryNoteSchema.parse({
        type: 'sales_return',
        partyId: customerVakko.id,
        noteDate: date,
        warehouseId: mainWarehouseId,
        lines: [
          {
            itemId: fgCuzdan.id,
            description: 'Ada El Yapımı Klasik Deri Cüzdan İade',
            quantity: '1',
          },
        ],
      }),
    );
    await postDeliveryNote(tx, { ...ctx, allowNegativeStock: false }, delivReturnId);

    // 4. Alış İade İrsaliyesi (İstanbul Metal'e 5 adet hatalı toka iadesi)
    const purReturnId = await createDeliveryDraft(
      tx,
      { ...ctx, allowNegativeStock: false },
      createDeliveryNoteSchema.parse({
        type: 'purchase_return',
        partyId: supplierMetal.id,
        noteDate: date,
        warehouseId: mainWarehouseId,
        externalNo: 'IADE-MTL-2026-01',
        lines: [
          {
            itemId: rawToka.id,
            description: 'Kusurlu kaplama toka iadesi',
            quantity: '5',
          },
        ],
      }),
    );
    await postDeliveryNote(tx, { ...ctx, allowNegativeStock: false }, purReturnId);
  } catch (err) {
    throw new Error('İrsaliye oluşturma hatası', { cause: err });
  }

  // 21. Çek / Senet Portföyü
  try {
    await createCheque(
      tx,
      { ...ctx, baseCurrency: 'TRY', reportingCurrency: 'EUR' },
      createChequeSchema.parse({
        direction: 'received',
        docType: 'cheque',
        docNo: 'CK-2026-8841',
        bankName: 'Türkiye İş Bankası',
        branch: 'Levent Şubesi',
        partyId: customerVakko.id,
        amount: '15000',
        issueDate: addDays(date, -10),
        dueDate: addDays(date, 45),
        description: 'Vakko cüzdan teslimatı 60 gün vadeli müşteri çeki',
        items: [],
      }),
    );
  } catch (err) {
    throw new Error('Çek hatası', { cause: err });
  }

  // 22. Teminat Mektupları (Bank Guarantees)
  try {
    await tx.insert(bankGuarantees).values({
      id: newId(),
      companyId: ctx.companyId,
      direction: 'given',
      letterNo: 'TM-2026-0042',
      bankName: 'Türkiye İş Bankası',
      branch: 'Beyoğlu Şubesi',
      partyId: customerVakko.id,
      counterpartyName: 'Vakko Tekstil ve Hazır Giyim A.Ş.',
      purpose: '2026 Yıllık Deri Aksesuar Tedarik Sözleşmesi Kesin Teminat Mektubu',
      amount: '150000.00',
      currencyCode: 'TRY',
      issueDate: addDays(date, -30),
      expiryDate: addDays(date, 335),
      commissionRate: '1.5000',
      commissionAmount: '2250.00',
      status: 'active',
      createdBy: ctx.userId,
    });
  } catch (err) {
    throw new Error('Teminat mektubu hatası', { cause: err });
  }

  // 23. İthalat Dosyası (Import Dossier / Landed Cost)
  if (purInv1Id && purInv1LineId && acc770Id) {
    try {
      const impCtx = {
        companyId: ctx.companyId,
        userId: ctx.userId,
        baseCurrency: 'TRY',
        reportingCurrency: 'EUR',
        allowNegativeStock: false,
      };
      const impFile = await saveImportFile(
        tx,
        impCtx,
        null,
        {
          name: 'İtalya Toscana Deri İthalat Dosyası (Floransa)',
          method: 'value',
          fileDate: date,
          lines: [
            { sourceKind: 'invoice', sourceLineId: purInv1LineId },
          ],
          costLines: [
            {
              kind: 'freight',
              description: 'Uluslararası Navlun ve Nakliye Gideri',
              amount: '3500.00',
              currencyCode: 'TRY',
              creditAccountId: acc770Id,
            },
          ],
        },
      );
      await allocateImportFile(
        tx,
        impCtx,
        impFile.file.id,
        {},
      );
    } catch (err) {
      throw new Error('İthalat dosyası hatası', { cause: err });
    }
  }

  // 24. Depo Sayımları (Stock Counts)
  try {
    await createStockCount(
      tx,
      ctx,
      {
        warehouseId: mainWarehouseId,
        countDate: date,
        description: '2026 Yıllık Merkez Depo Fiziki Sayımı ve Stok Mutabakatı',
        prefill: 'in_stock',
      },
    );

    await createStockCount(
      tx,
      ctx,
      {
        warehouseId: boutique.id,
        countDate: date,
        description: 'Nişantaşı Butik Mağaza Ay Sonu Reyon Sayımı',
        prefill: 'in_stock',
      },
    );
  } catch (err) {
    throw new Error('Depo sayımı hatası', { cause: err });
  }

  // 25. Satın Alma Modülü (Talepler, RFQ/Teklifler, Siparişler)
  log('Ada Deri: Satın alma talepleri, teklif karşılaştırma ve siparişler kuruluyor...');
  try {
    const purReq = await createRequest(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
      {
        title: 'İtalyan Bitkisel Dana Derisi ve Metal Aksesuar Hammadde Tedariği',
        needDate: addDays(date, 14),
        lines: [
          {
            itemId: rawDeriDana.id,
            description: 'Bitkisel Tabaklanmış Dana Derisi (Taba) 50 m2',
            unit: 'm2',
            quantity: '50',
            estUnitPrice: '350',
          },
        ],
      },
    );

    const reqId = (purReq.request as unknown as { id: string }).id;
    await tx.execute(sql`update purchase_requests set status='submitted', submitted_at=now() where id=${reqId}`);
    await tx.execute(sql`update purchase_requests set status='approved' where id=${reqId}`);
    const reqLineId = ((purReq.lines as unknown as { id: string }[])[0])?.id;

    const rfq = await createRfq(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
      {
        requestId: reqId,
        dueDate: addDays(date, 7),
        note: 'Toscana tabakhane birim fiyat ve termin karşılaştırması',
      },
    );

    if (reqLineId) {
      await upsertOffer(
        tx,
        { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
        (rfq.rfq as unknown as { id: string }).id,
        {
          partyId: supplierToscana.id,
          currencyCode: 'TRY',
          deliveryDays: 10,
          paymentDays: 30,
          lines: [
            { requestLineId: reqLineId, unitPrice: '340' },
          ],
        },
      );
    }

    const purOrder = await createOrder(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: 'TRY' },
      {
        partyId: supplierMetal.id,
        currencyCode: 'TRY',
        vatCode: 'KDV-20',
        paymentDays: 30,
        lines: [
          {
            itemId: rawToka.id,
            description: 'Antik Pirinç Kemer Tokası 35mm (100 adet)',
            unit: 'adet',
            quantity: '100',
            unitPrice: '45',
          },
        ],
      },
    );
    await issueOrder(tx, (purOrder.order as unknown as { id: string }).id);
  } catch (err) {
    throw new Error('Satın alma süreci hatası', { cause: err });
  }

  // 26. İnsan Kaynakları, Puantaj, Bordro, Sosyal Güvenlik ve Yabancı İşçi
  log('Ada Deri: Personel kartları, puantaj, bordro ve yabancı işçi belgeleri oluşturuluyor...');
  try {
    const hrSecret = 'demo-leather-secret-key-1234567890';
    const emp1 = await createEmployee(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, secret: hrSecret },
      createEmployeeSchema.parse({
        fullName: 'Mustafa Keskin',
        nationality: 'TC',
        department: 'Üretim ve Atölye',
        jobTitle: 'Baş Saraç & Kesim Ustası',
        hireDate: '2024-01-15',
        phone: '0533 111 22 33',
        email: 'mustafa.keskin@adaderi.local',
      }),
    );

    const emp2 = await createEmployee(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, secret: hrSecret },
      createEmployeeSchema.parse({
        fullName: 'Zeynep Yılmaz',
        nationality: 'TC',
        department: 'Tasarım ve AR-GE',
        jobTitle: 'Modelist & Kalıp Tasarımcısı',
        hireDate: '2024-03-01',
        phone: '0542 222 33 44',
        email: 'zeynep.yilmaz@adaderi.local',
      }),
    );

    const emp3 = await createEmployee(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, secret: hrSecret },
      createEmployeeSchema.parse({
        fullName: 'Ahmet Çelik',
        nationality: 'TC',
        department: 'Üretim ve Atölye',
        jobTitle: 'Dikiş & Montaj Operatörü',
        hireDate: '2024-06-10',
        phone: '0533 333 44 55',
        email: 'ahmet.celik@adaderi.local',
      }),
    );

    const emp4 = await createEmployee(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, secret: hrSecret },
      createEmployeeSchema.parse({
        fullName: 'Selin Demir',
        nationality: 'TC',
        department: 'Satış ve Mağaza',
        jobTitle: 'Nişantaşı Butik Satış Sorumlusu',
        hireDate: '2025-01-02',
        phone: '0548 444 55 66',
        email: 'selin.demir@adaderi.local',
      }),
    );

    // Yabancı Uyruklu Tasarımcı (İtalyan Usta)
    const empForeign = await createEmployee(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, secret: hrSecret },
      createEmployeeSchema.parse({
        fullName: 'Marco Bellini',
        nationality: 'IT',
        department: 'Tasarım ve Kalite',
        jobTitle: 'Kıdemli Deri Tasarım Danışmanı (Floransa)',
        hireDate: '2024-02-01',
        phone: '0532 888 77 66',
        email: 'marco.bellini@adaderi.local',
      }),
    );

    // Yabancı İşçi Belge Türü ve Belgesi
    const docTypeId = newId();
    await tx.insert(foreignDocTypes).values({
      id: docTypeId,
      companyId: ctx.companyId,
      code: 'CALISMA_IZNI',
      name: 'Yabancı Süreli Çalışma İzni',
      active: true,
    });

    await tx.insert(foreignWorkerDocs).values({
      id: newId(),
      companyId: ctx.companyId,
      employeeId: empForeign.employee.id,
      typeId: docTypeId,
      numberLast4: '9841',
      issuingAuthority: 'T.C. Çalışma ve Sosyal Güvenlik Bakanlığı',
      issueDate: '2025-01-01',
      expiryDate: '2027-01-01',
    });

    // Puantaj Girişi
    const currentMonth = date.slice(0, 7);
    const daysInMonth = 25;
    const empIds = [emp1.employee.id, emp2.employee.id, emp3.employee.id, emp4.employee.id, empForeign.employee.id];
    const entries = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayStr = `${currentMonth}-${String(d).padStart(2, '0')}`;
      const dayOfWeek = new Date(dayStr).getDay();
      for (const empId of empIds) {
        if (dayOfWeek === 0) {
          entries.push({
            employeeId: empId,
            workDate: dayStr,
            dayType: 'weekly_rest' as const,
            normalHours: '0',
            overtimeHours: '0',
          });
        } else {
          entries.push({
            employeeId: empId,
            workDate: dayStr,
            dayType: 'worked' as const,
            normalHours: '8',
            overtimeHours: dayOfWeek === 6 ? '3' : '0',
          });
        }
      }
    }
    await saveAttendance(tx, { companyId: ctx.companyId, userId: ctx.userId }, { entries, clear: [] });

    // Bordro: Ülke bordrosu için gerçek prim rejimi ve doğrulanmış tarihli paket gerekir; örnek bordro/bildirim üretilmedi.
  } catch (err) {
    throw new Error('HR / Bordro hatası', { cause: err });
  }

  // 27. Demirbaş ve Amortisman (Fixed Assets)
  if (acc770Id) {
    try {
      const [acc257] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(sql`company_id=${ctx.companyId} and (code like '257%' or type='asset')`)
        .limit(1);

      const assetInput1 = fixedAssetSchema.parse({
        code: 'DMR-MAK-01',
        name: 'Atom Hidrolik Kalıp Kesim Presi (İtalyan)',
        category: 'equipment',
        acquisitionDate: `${date.slice(0, 4)}-01-10`,
        startMonth: `${date.slice(0, 4)}-01`,
        cost: '450000.00',
        salvage: '45000.00',
        usefulMonths: 60,
        expenseAccountId: acc770Id,
        accumulatedAccountId: acc257?.id ?? acc770Id,
        department: 'Üretim ve Atölye',
        location: 'Merkez Atölye Kesim Bölümü',
        serialNo: 'ATM-2024-8891',
      });
      await tx.execute(
        sql`insert into fixed_assets(id, company_id, code, config, created_by) values(${newId()}, ${ctx.companyId}, ${assetInput1.code}, ${JSON.stringify(assetInput1)}::jsonb, ${ctx.userId})`,
      );

      const assetInput2 = fixedAssetSchema.parse({
        code: 'DMR-MAK-02',
        name: 'Dürkopp Adler Çift İğne Deri Dikiş Makinesi',
        category: 'equipment',
        acquisitionDate: `${date.slice(0, 4)}-02-15`,
        startMonth: `${date.slice(0, 4)}-02`,
        cost: '180000.00',
        salvage: '18000.00',
        usefulMonths: 48,
        expenseAccountId: acc770Id,
        accumulatedAccountId: acc257?.id ?? acc770Id,
        department: 'Üretim ve Atölye',
        location: 'Merkez Atölye Dikiş Hattı',
        serialNo: 'DA-2024-5512',
      });
      await tx.execute(
        sql`insert into fixed_assets(id, company_id, code, config, created_by) values(${newId()}, ${ctx.companyId}, ${assetInput2.code}, ${JSON.stringify(assetInput2)}::jsonb, ${ctx.userId})`,
      );
    } catch (err) {
      throw new Error('Demirbaş kaydı hatası', { cause: err });
    }
  }

  // 28. Bütçe ve Sapma (Company Budgets)
  if (acc770Id) {
    try {
      const budgetId = newId();
      const budgetConfig = companyBudgetSchema.parse({
        title: '2026 Yılı Ada Deri Yıllık İşletme Bütçesi',
        year: 2026,
        scope: 'company',
        notes: '2026 mali yılı gelir ve genel gider tahmin bütçesi',
        lines: [
          {
            accountId: acc770Id,
            kind: 'expense',
            amounts: Array(12).fill('35000.00'),
          },
        ],
      });
      await tx.execute(
        sql`insert into company_budgets(id, company_id, series_id, revision, version, config, status, created_by) values(${budgetId}, ${ctx.companyId}, ${budgetId}, 1, 1, ${JSON.stringify(budgetConfig)}::jsonb, 'draft', ${ctx.userId})`,
      );
      await tx.execute(
        sql`update company_budgets set status='approved', version=2, approved_by=${ctx.userId}, approved_at=now() where id=${budgetId}`,
      );
    } catch (err) {
      throw new Error('Bütçe kaydı hatası', { cause: err });
    }
  }

  // 29. Mali Dönemler & Yıl Sonu (Fiscal Years)
  try {
    await tx.insert(fiscalYears).values({
      id: newId(),
      companyId: ctx.companyId,
      name: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      status: 'open',
      createdBy: ctx.userId,
    }).onConflictDoNothing();
  } catch (err) {
    throw new Error('Mali dönem hatası', { cause: err });
  }

  // 30. Konsolidasyon (Consolidation Groups)
  try {
    const [ownerUser] = await tx.select().from(users).where(eq(users.id, ctx.userId));
    if (ownerUser) {
      const [consolGroup] = await tx
        .insert(consolidationGroups)
        .values({
          id: newId(),
          organizationId: ownerUser.organizationId,
          ownerUserId: ownerUser.id,
          name: 'Ada Deri & Lüks Tekstil Grubu',
          reportingCurrency: 'TRY',
          isArchived: false,
        })
        .onConflictDoNothing()
        .returning();

      if (consolGroup) {
        await tx.insert(consolidationMembers).values({
          id: newId(),
          groupId: consolGroup.id,
          memberCompanyId: ctx.companyId,
        }).onConflictDoNothing();
      }
    }
  } catch (err) {
    throw new Error('Konsolidasyon hatası', { cause: err });
  }

  // 31. Rapor Panom (Saved Insights)
  try {
    const insight1 = insightConfigSchema.parse({
      title: 'Aylık Satış & Ciro Grafiği',
      reportKey: 'sales-report',
      range: 'year',
      from: `${date.slice(0, 4)}-01-01`,
      to: `${date.slice(0, 4)}-12-31`,
      options: { groupBy: 'month' },
      chart: { tableKey: 'sales', labelKey: 'month', valueKey: 'netTotal' },
      shared: true,
      position: 1,
    });
    await tx.execute(
      sql`insert into saved_insights(id, company_id, created_by, config) values(${newId()}, ${ctx.companyId}, ${ctx.userId}, ${JSON.stringify(insight1)}::jsonb)`,
    );

    const insight2 = insightConfigSchema.parse({
      title: 'Depo Bazlı Stok Durumu',
      reportKey: 'stock-status',
      range: 'month',
      from: date,
      to: date,
      options: {},
      shared: true,
      position: 2,
    });
    await tx.execute(
      sql`insert into saved_insights(id, company_id, created_by, config) values(${newId()}, ${ctx.companyId}, ${ctx.userId}, ${JSON.stringify(insight2)}::jsonb)`,
    );
  } catch (err) {
    throw new Error('Rapor panom hatası', { cause: err });
  }

  // 32. Portal Erişimi (Portal Links)
  try {
    const [ownerUser] = await tx.select().from(users).where(eq(users.id, ctx.userId));
    if (ownerUser) {
      const portalPasswordHash = await hash('VakkoPortal2026!');
      await tx.insert(portalLinks).values({
        id: newId(),
        companyId: ctx.companyId,
        orgId: ownerUser.organizationId,
        partyId: customerVakko.id,
        label: 'Vakko Satın Alma ve Finans Portalı',
        tokenHash: createHash('sha256').update('vakko-token-2026').digest('hex'),
        passwordHash: portalPasswordHash,
        expiresAt: new Date(Date.now() + 180 * 86400000),
        scopes: { invoices: true, quotes: true, orders: true },
        createdBy: ctx.userId,
      });
    }
  } catch (err) {
    throw new Error('Portal erişim hatası', { cause: err });
  }

  // 33. Belge Onayları & Onay Kutusu (Approval Rules)
  try {
    const ruleId = newId();
    await tx.insert(approvalRules).values({
      id: ruleId,
      companyId: ctx.companyId,
      docType: 'invoice',
      minAmount: '10000.00',
      maxAmount: null,
      separateRequester: false,
      isActive: true,
    });
    await tx.insert(approvalRuleSteps).values({
      id: newId(),
      companyId: ctx.companyId,
      ruleId,
      stepNo: 1,
      approverRole: 'owner',
      label: 'Genel Müdür / Şirket Sahibi Onayı',
    });
  } catch (err) {
    throw new Error('Onay kuralı hatası', { cause: err });
  }

  // 34. Tekrarlayan İşler (Recurring Templates)
  try {
    await tx.execute(sql`
      insert into recurring_templates(id, company_id, kind, title, recurrence, payload, next_date, created_by)
      values(
        ${newId()},
        ${ctx.companyId},
        'agenda',
        'Haftalık Atölye ve Üretim Koordinasyon Toplantısı',
        '{"frequency":"weekly","interval":1,"startDate":"2026-10-12"}'::jsonb,
        '{"title":"Haftalık Atölye ve Üretim Koordinasyon Toplantısı","kind":"appointment","allDay":false,"startTime":"09:00","endTime":"10:00"}'::jsonb,
        '2026-10-12',
        ${ctx.userId}
      )
    `);
  } catch (err) {
    throw new Error('Tekrarlayan iş hatası', { cause: err });
  }

  // Rehber: Kurum, Kişi ve Ajanda
  try {
    const org1 = await createOrganization(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId },
      createOrganizationSchema.parse({
        name: 'Vakko Holding Genel Merkez',
        category: 'Müşteri',
        address: 'Altunizade, Üsküdar, İstanbul',
        phone: '0216 554 00 00',
        email: 'info@vakko.com.tr',
        web: 'https://www.vakko.com',
        partyId: customerVakko.id,
        note: 'Yıllık ana satış ve vitrin siparişleri kurumsal muhatabı',
      }),
    );

    const contact1 = await createContact(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId },
      createContactSchema.parse({
        fullName: 'Ahmet Yılmaz',
        title: 'Koleksiyon Danışmanı & VIP Müşteri',
        partyId: customerVipAhmet.id,
        phone: '0533 123 45 67',
        email: 'ahmet.yilmaz@ornek.local',
        address: 'Etiler, Beşiktaş, İstanbul',
        note: 'Özel dikim cüzdan ve çanta siparişleri daimi müşterisi',
      }),
    );

    await createContact(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId },
      createContactSchema.parse({
        fullName: 'Canan Erdem',
        title: 'Kategori Satın Alma Yöneticisi',
        organizationId: (org1.organization as { id: string }).id,
        partyId: customerVakko.id,
        phone: '0532 999 88 77',
        email: 'canan.erdem@vakko.com.tr',
        note: 'Deri aksesuarları satın alma yetkilisi',
      }),
    );

    await createAgendaItem(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, canManage: true },
      createAgendaSchema.parse({
        kind: 'appointment',
        title: 'Vakko Kış Sezonu Sipariş Kabul Görüşmesi',
        description: 'Vakko satın alma heyeti ile Nişantaşı butiğimizde toplantı',
        dueDate: addDays(date, 3),
        allDay: false,
        startTime: '14:00',
        endTime: '15:30',
        contactId: (contact1.contact as { id: string }).id,
        partyId: customerVakko.id,
      }),
    );

    await createAgendaItem(
      tx,
      { companyId: ctx.companyId, userId: ctx.userId, canManage: true },
      createAgendaSchema.parse({
        kind: 'task',
        title: 'Toscana Tabakhane Yeni Numune Kartelasının İncelemesi',
        description: 'İtalya Floransa sevkiyatı bitkisel derilerin renk ve finisaj onayları',
        dueDate: addDays(date, 1),
        allDay: true,
      }),
    );
  } catch (err) {
    throw new Error('Rehber / Ajanda hatası', { cause: err });
  }

  // 35. Bugünkü İşlerim (Work Items)
  try {
    await tx.insert(workItems).values([
      {
        id: newId(),
        companyId: ctx.companyId,
        title: 'Lineapelle Deri Fuarı Sipariş Listesi Kontrolü',
        description: 'İtalya Floransa tabakhane numuneleri için sipariş onay listesinin hazırlanması',
        dueDate: date,
        ownerId: ctx.userId,
        createdBy: ctx.userId,
        priority: 'high',
        status: 'open',
      },
      {
        id: newId(),
        companyId: ctx.companyId,
        title: 'Beymen Özel Koleksiyon Numune Teslimatı',
        description: 'Yeni sezon numunelerinin Beymen satın alma sorumlusuna teslim edilmesi',
        dueDate: addDays(date, 2),
        ownerId: ctx.userId,
        createdBy: ctx.userId,
        priority: 'normal',
        status: 'open',
      },
      {
        id: newId(),
        companyId: ctx.companyId,
        title: 'Atölye Kesim Presi Periyodik Yağlama ve Bıçak Değişimi',
        description: 'Atom hidrolik presinin haftalık mekanik bakımı ve hidrolik seviye kontrolü',
        dueDate: addDays(date, -1),
        ownerId: ctx.userId,
        createdBy: ctx.userId,
        priority: 'high',
        status: 'done',
      },
      {
        id: newId(),
        companyId: ctx.companyId,
        title: 'Vakko Kış Sezonu Sipariş Avans Mutabakatı',
        description: 'Ticari banka hesabına gelen avans havalesinin sipariş kalemiyle eşleştirilmesi',
        dueDate: addDays(date, 5),
        ownerId: ctx.userId,
        createdBy: ctx.userId,
        priority: 'normal',
        status: 'open',
      },
    ]);
  } catch (err) {
    throw new Error('Bugünkü işlerim hatası', { cause: err });
  }

  // 36. Tahsilat Takibi (Operation Entries)
  try {
    await tx.insert(operationEntries).values([
      {
        id: newId(),
        companyId: ctx.companyId,
        kind: 'collection',
        title: 'Beymen Mağazacılık Açık Bakiye Tahsilatı',
        partyId: customerBeymen.id,
        ownerId: ctx.userId,
        eventDate: date,
        dueDate: addDays(date, 7),
        payload: {
          promiseAmount: '45000',
          currency: 'TRY',
          promiseDate: addDays(date, 7),
          notes: 'Finans yetkilisi ile görüşüldü; fatura vadesinde tam ödeme sözü alındı.',
          outcome: 'promised',
        },
        status: 'open',
        createdBy: ctx.userId,
      },
      {
        id: newId(),
        companyId: ctx.companyId,
        kind: 'collection',
        title: 'Vakko A.Ş. Çek Karşılığı Tahsilat Mutabakatı',
        partyId: customerVakko.id,
        ownerId: ctx.userId,
        eventDate: addDays(date, -5),
        dueDate: addDays(date, -1),
        payload: {
          promiseAmount: '15000',
          currency: 'TRY',
          notes: 'Müşteri çeki tahsil edildi, ticari hesaba geçti.',
          outcome: 'received',
        },
        status: 'done',
        createdBy: ctx.userId,
      },
    ]);
  } catch (err) {
    throw new Error('Tahsilat takibi hatası', { cause: err });
  }

  // 37. Butik Mağaza POS Kasası ve Kasa Oturumları
  try {
    const tillId = newId();
    await tx.insert(posTills).values({
      id: tillId,
      companyId: ctx.companyId,
      name: 'Ada Deri Nişantaşı Butik Kasası',
      warehouseId: boutique.id,
      cashAccountId: boutiqueCash.id,
      cardAccountId: posAccount.id,
      walkInPartyId: customerNisantasi.id,
      currencyCode: 'TRY',
      maxDiscountPct: '15',
      assignedUserIds: [ctx.userId],
      createdBy: ctx.userId,
    });

    // Kasa Oturumları (1 Kapalı + 1 Açık Oturum)
    await tx.insert(posSessions).values({
      id: newId(),
      companyId: ctx.companyId,
      tillId,
      userId: ctx.userId,
      status: 'closed',
      openingCash: '1000.00',
      expectedCash: '2500.00',
      countedCash: '2500.00',
      variance: '0.00',
      closeReason: 'Dünkü gün sonu kasa kapama',
      openedAt: new Date(Date.now() - 86400000),
      closedAt: new Date(Date.now() - 43200000),
    });

    await tx.insert(posSessions).values({
      id: newId(),
      companyId: ctx.companyId,
      tillId,
      userId: ctx.userId,
      status: 'open',
      openingCash: '1000.00',
      openedAt: new Date(),
    });
  } catch (err) {
    throw new Error('POS kasası hatası', { cause: err });
  }

  // 38. Rehber ve Ajanda (Directory & Agenda)
  log('Ada Deri: Rehber ve ajanda kayıtları oluşturuluyor...');
  try {
    const dirCtx = { companyId: ctx.companyId, userId: ctx.userId, canManage: true };

    const orgToscana = await createOrganization(
      tx,
      dirCtx,
      createOrganizationSchema.parse({
        name: 'Toscana Tannery S.p.A.',
        category: 'Tedarikçi',
        email: 'info@toscanatannery.demo',
        phone: '+39 055 1234567',
        address: 'Santa Croce sull’Arno, Floransa, İtalya',
        note: 'İtalya Santa Croce sull’Arno bitkisel tabaklanmış dana derisi ana tedarikçimiz',
      }),
    );

    const contactMarco = await createContact(
      tx,
      dirCtx,
      createContactSchema.parse({
        fullName: 'Marco Rossi',
        title: 'İhracat ve Satış Direktörü',
        email: 'm.rossi@toscanatannery.demo',
        phone: '+39 340 9876543',
        organizationId: (orgToscana.organization as { id: string }).id,
      }),
    );

    const contactPelin = await createContact(
      tx,
      dirCtx,
      createContactSchema.parse({
        fullName: 'Pelin Aksoy',
        title: 'Vakko Deri Aksesuar Kategori Yöneticisi',
        email: 'pelin.aksoy@vakko.demo',
        phone: '0532 999 88 77',
      }),
    );

    // Ajanda Kayıtları
    const agendaCtx = { companyId: ctx.companyId, userId: ctx.userId, canManage: true };
    await createAgendaItem(
      tx,
      agendaCtx,
      createAgendaSchema.parse({
        title: 'Lineapelle Floransa Deri Fuarı Katılımı ve Kartela Seçimi',
        description: '2026-2027 Sonbahar/Kış sezonu süet ve vaketa deri kartelalarının incelenmesi',
        dueDate: addDays(date, 7),
        allDay: true,
        kind: 'appointment',
        contactId: (contactMarco.contact as { id: string }).id,
      }),
    );

    await createAgendaItem(
      tx,
      agendaCtx,
      createAgendaSchema.parse({
        title: 'Vakko Kış Koleksiyonu Numune Teslimatı ve Onay Toplantısı',
        description: 'Özel seri 5 adet cüzdan ve kartlık numunelerinin sunumu',
        dueDate: addDays(date, 3),
        allDay: false,
        startTime: '14:00',
        endTime: '15:30',
        kind: 'appointment',
        contactId: (contactPelin.contact as { id: string }).id,
      }),
    );

    await createAgendaItem(
      tx,
      agendaCtx,
      createAgendaSchema.parse({
        title: 'Atölye Makine Periyodik Yağlama ve Bıçak Bileme Bakımı',
        description: 'Kalıp kesim presi hidrolik yağı değişimi ve kenar tıraş bıçaklarının bilenmesi',
        dueDate: addDays(date, 2),
        allDay: true,
        kind: 'task',
      }),
    );
  } catch (err) {
    throw new Error('Rehber ve ajanda hatası', { cause: err });
  }

  // 39. Güncel Döviz Kurları (EUR, USD, GBP)
  try {
    const dates = [date, addDays(date, -1), addDays(date, -2), addDays(date, -5)];
    const ratesData = [
      { code: 'EUR', buy: 55.6307, sell: 55.9088 },
      { code: 'USD', buy: 48.9008, sell: 49.1453 },
      { code: 'GBP', buy: 64.7268, sell: 65.0504 },
    ];
    const rows = dates.flatMap((d) =>
      ratesData.map((r) => ({
        companyId: ctx.companyId,
        rateDate: d,
        currencyCode: r.code,
        quoteCode: 'TRY',
        buy: toDbRate(r.buy),
        sell: toDbRate(r.sell),
        source: 'demo',
        createdBy: ctx.userId,
      })),
    );
    await tx.insert(exchangeRates).values(rows).onConflictDoNothing();
  } catch {
    // Kurlar hatası
  }

  log('Ada Deri: Tüm modüllere ait zengin örnek veriler başarıyla yüklendi!');
}
