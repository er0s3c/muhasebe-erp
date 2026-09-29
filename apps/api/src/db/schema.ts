import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const money = () => numeric({ precision: 19, scale: 4 });
const rate = () => numeric({ precision: 19, scale: 8 });
const qty = () => numeric({ precision: 19, scale: 4 });
const unitCost = () => numeric({ precision: 19, scale: 6 });

// ---------------------------------------------------------------------------
// Kiracılık ve güvenlik
// ---------------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: id(),
  name: text().notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    email: text().notNull(),
    passwordHash: text().notNull(),
    fullName: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    lastLoginAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    userAgent: text(),
    ip: text(),
  },
  (t) => [uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash), index('refresh_tokens_user_idx').on(t.userId)],
);

export const companies = pgTable(
  'companies',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    name: text().notNull(),
    sector: text().notNull(),
    baseCurrency: text().notNull().default('TRY'),
    reportingCurrency: text(),
    taxNumber: text(),
    taxOffice: text(),
    /** Stokta olmayan malın çıkışına izin (perakende). Kapalıyken çıkış depo bakiyesini aşamaz. */
    allowNegativeStock: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('companies_org_idx').on(t.organizationId),
    check('companies_sector_ck', sql`${t.sector} in ('CONSTRUCTION','RETAIL_MARKET','COMMERCE')`),
  ],
);

export const companyModules = pgTable(
  'company_modules',
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    module: text().notNull(),
    enabled: boolean().notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.module] })],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    role: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('memberships_company_user_uq').on(t.companyId, t.userId),
    index('memberships_user_idx').on(t.userId),
    check(
      'memberships_role_ck',
      sql`${t.role} in ('owner','admin','accountant','sales','site_manager','viewer')`,
    ),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    companyId: uuid(),
    userId: uuid(),
    ip: text(),
    tableName: text().notNull(),
    rowId: text(),
    action: text().notNull(),
    oldData: jsonb(),
    newData: jsonb(),
  },
  (t) => [index('audit_log_company_at_idx').on(t.companyId, t.at)],
);

// ---------------------------------------------------------------------------
// Ayarlar
// ---------------------------------------------------------------------------

export const currencies = pgTable('currencies', {
  code: text().primaryKey(),
  name: text().notNull(),
  symbol: text().notNull(),
  minorUnits: integer().notNull().default(2),
});

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    rateDate: date({ mode: 'string' }).notNull(),
    /** 1 birim currencyCode = buy/sell birim quoteCode */
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    quoteCode: text()
      .notNull()
      .references(() => currencies.code),
    buy: rate().notNull(),
    sell: rate().notNull(),
    source: text().notNull().default('manual'),
    createdAt: createdAt(),
    createdBy: uuid().references(() => users.id),
  },
  (t) => [
    unique('exchange_rates_uq').on(t.companyId, t.rateDate, t.currencyCode, t.quoteCode),
    check('exchange_rates_positive_ck', sql`${t.buy} > 0 and ${t.sell} > 0`),
    check('exchange_rates_distinct_ck', sql`${t.currencyCode} <> ${t.quoteCode}`),
  ],
);

export const taxRates = pgTable(
  'tax_rates',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    /** Yüzde, örn. 16.0000 */
    rate: numeric({ precision: 7, scale: 4 }).notNull(),
    validFrom: date({ mode: 'string' }).notNull(),
    validTo: date({ mode: 'string' }),
    sourceNote: text(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('tax_rates_uq').on(t.companyId, t.code, t.validFrom),
    check('tax_rates_range_ck', sql`${t.rate} >= 0 and ${t.rate} <= 100`),
  ],
);

export const customCodes = pgTable(
  'custom_codes',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    scope: text().notNull(),
    code: text().notNull(),
    name: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('custom_codes_uq').on(t.companyId, t.scope, t.code)],
);

export const documentSequences = pgTable(
  'document_sequences',
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    key: text().notNull(),
    year: integer().notNull(),
    nextValue: integer().notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.key, t.year] })],
);

export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    year: integer().notNull(),
    month: integer().notNull(),
    startDate: date({ mode: 'string' }).notNull(),
    endDate: date({ mode: 'string' }).notNull(),
    status: text().notNull().default('open'),
    closedAt: timestamp({ withTimezone: true }),
    closedBy: uuid().references(() => users.id),
  },
  (t) => [
    unique('fiscal_periods_uq').on(t.companyId, t.year, t.month),
    unique('fiscal_periods_id_company_uq').on(t.id, t.companyId),
    check('fiscal_periods_month_ck', sql`${t.month} between 1 and 12`),
    check('fiscal_periods_status_ck', sql`${t.status} in ('open','closed')`),
  ],
);

// ---------------------------------------------------------------------------
// Cari (müşteri / tedarikçi)
// ---------------------------------------------------------------------------

export const parties = pgTable(
  'parties',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    kind: text().notNull().default('customer'),
    taxNumber: text(),
    taxOffice: text(),
    phone: text(),
    email: text(),
    address: text(),
    currencyCode: text()
      .notNull()
      .default('TRY')
      .references(() => currencies.code),
    creditLimit: money(),
    paymentTermDays: integer().notNull().default(0),
    notes: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('parties_company_code_uq').on(t.companyId, t.code),
    unique('parties_id_company_uq').on(t.id, t.companyId),
    index('parties_name_idx').on(t.companyId, t.name),
    check('parties_kind_ck', sql`${t.kind} in ('customer','supplier','both')`),
    check('parties_term_ck', sql`${t.paymentTermDays} between 0 and 365`),
  ],
);


// ---------------------------------------------------------------------------
// Genel muhasebe
// ---------------------------------------------------------------------------

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    type: text().notNull(),
    parentId: uuid(),
    isPostable: boolean().notNull().default(true),
    currencyCode: text().references(() => currencies.code),
    /** Cari kontrol hesabı: 'receivable' (müşteri, 120) / 'payable' (tedarikçi, 320). Alt hesaplar devralır. */
    partyControl: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('accounts_company_code_uq').on(t.companyId, t.code),
    check('accounts_party_control_ck', sql`${t.partyControl} in ('receivable','payable')`),
    unique('accounts_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'accounts_parent_fk',
      columns: [t.parentId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    check(
      'accounts_type_ck',
      sql`${t.type} in ('asset','liability','equity','income','expense','cost','memo')`,
    ),
  ],
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** Kaydedilene kadar null; boşluksuz seri kaydetme anında atanır. */
    entryNo: text(),
    entryDate: date({ mode: 'string' }).notNull(),
    periodId: uuid().notNull(),
    description: text().notNull(),
    status: text().notNull().default('draft'),
    /** Otomatik kaydı üreten belge (fatura, tahsilat...) — ileride doldurulur. */
    sourceType: text(),
    sourceId: uuid(),
    reversalOfId: uuid(),
    reversedById: uuid(),
    postedAt: timestamp({ withTimezone: true }),
    postedBy: uuid().references(() => users.id),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('journal_entries_id_company_uq').on(t.id, t.companyId),
    unique('journal_entries_no_uq').on(t.companyId, t.entryNo),
    foreignKey({
      name: 'journal_entries_period_fk',
      columns: [t.periodId, t.companyId],
      foreignColumns: [fiscalPeriods.id, fiscalPeriods.companyId],
    }),
    foreignKey({
      name: 'journal_entries_reversal_of_fk',
      columns: [t.reversalOfId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    foreignKey({
      name: 'journal_entries_reversed_by_fk',
      columns: [t.reversedById, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    index('journal_entries_date_idx').on(t.companyId, t.entryDate),
    check('journal_entries_status_ck', sql`${t.status} in ('draft','posted')`),
    check(
      'journal_entries_posted_ck',
      sql`${t.status} = 'draft' or (${t.entryNo} is not null and ${t.postedAt} is not null)`,
    ),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    entryId: uuid().notNull(),
    lineNo: integer().notNull(),
    accountId: uuid().notNull(),
    description: text(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    /** 1 birim currencyCode = fxRate birim şirket defter para birimi */
    fxRate: rate().notNull().default('1'),
    debit: money().notNull().default('0'),
    credit: money().notNull().default('0'),
    debitBase: money().notNull().default('0'),
    creditBase: money().notNull().default('0'),
    /** Yönetim raporlama para birimi karşılığı; şirkette tanımlı değilse null. */
    debitReporting: money(),
    creditReporting: money(),
    /** Cari kontrol hesabı satırlarında zorunlu, diğerlerinde yasak (DB tetikleyicisi denetler). */
    partyId: uuid(),
    /** Yaşlandırma vadeye göre yapılır; yoksa fiş tarihi kullanılır. */
    dueDate: date({ mode: 'string' }),
  },
  (t) => [
    foreignKey({
      name: 'journal_lines_entry_fk',
      columns: [t.entryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'journal_lines_account_fk',
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
    }),
    foreignKey({
      name: 'journal_lines_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    unique('journal_lines_entry_line_uq').on(t.entryId, t.lineNo),
    index('journal_lines_account_idx').on(t.companyId, t.accountId),
    index('journal_lines_party_idx').on(t.companyId, t.partyId),
    check(
      'journal_lines_side_ck',
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and ((${t.debit} > 0) <> (${t.credit} > 0))`,
    ),
    check('journal_lines_base_ck', sql`${t.debitBase} >= 0 and ${t.creditBase} >= 0`),
    check('journal_lines_fx_ck', sql`${t.fxRate} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Stok
// ---------------------------------------------------------------------------

export const itemCategories = pgTable(
  'item_categories',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    name: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('item_categories_company_name_uq').on(t.companyId, t.name),
    unique('item_categories_id_company_uq').on(t.id, t.companyId),
  ],
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('warehouses_company_code_uq').on(t.companyId, t.code),
    unique('warehouses_id_company_uq').on(t.id, t.companyId),
    // Şirket başına en çok bir varsayılan depo
    uniqueIndex('warehouses_default_uq')
      .on(t.companyId)
      .where(sql`${t.isDefault}`),
  ],
);

export const items = pgTable(
  'items',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    /** 'goods' stok tutar; 'service' (işçilik, nakliye…) hareket görmez. */
    kind: text().notNull().default('goods'),
    unit: text().notNull().default('adet'),
    categoryId: uuid(),
    barcode: text(),
    /** Şirketin tax_rates.code değeri (uygulamada doğrulanır). */
    vatCode: text(),
    /** Alış ve satış fiyatı ayrı para birimlerinde tutulabilir (EUR ile al, GBP/TL ile sat). */
    purchasePrice: unitCost(),
    purchaseCurrency: text()
      .notNull()
      .default('TRY')
      .references(() => currencies.code),
    salePrice: unitCost(),
    saleCurrency: text()
      .notNull()
      .default('TRY')
      .references(() => currencies.code),
    minLevel: qty(),
    notes: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('items_company_code_uq').on(t.companyId, t.code),
    unique('items_id_company_uq').on(t.id, t.companyId),
    uniqueIndex('items_company_barcode_uq')
      .on(t.companyId, t.barcode)
      .where(sql`${t.barcode} is not null`),
    index('items_name_idx').on(t.companyId, t.name),
    foreignKey({
      name: 'items_category_fk',
      columns: [t.categoryId, t.companyId],
      foreignColumns: [itemCategories.id, itemCategories.companyId],
    }),
    check('items_kind_ck', sql`${t.kind} in ('goods','service')`),
    check(
      'items_amounts_ck',
      sql`(${t.purchasePrice} is null or ${t.purchasePrice} >= 0) and (${t.salePrice} is null or ${t.salePrice} >= 0) and (${t.minLevel} is null or ${t.minLevel} >= 0)`,
    ),
  ],
);

/** Stok belgesi başlığı. Doğrudan "kaydedildi" oluşur; değiştirilemez, düzeltme ters belgeyle. */
export const stockDocuments = pgTable(
  'stock_documents',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    docNo: text().notNull(),
    docDate: date({ mode: 'string' }).notNull(),
    periodId: uuid().notNull(),
    type: text().notNull(),
    warehouseId: uuid().notNull(),
    /** Yalnızca transferde: hedef depo. */
    toWarehouseId: uuid(),
    description: text(),
    /** Belgeyi üreten kaynak (fatura, irsaliye…) — M6'da doldurulur. */
    sourceType: text(),
    sourceId: uuid(),
    reversalOfId: uuid(),
    reversedById: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('stock_documents_id_company_uq').on(t.id, t.companyId),
    unique('stock_documents_no_uq').on(t.companyId, t.docNo),
    foreignKey({
      name: 'stock_documents_period_fk',
      columns: [t.periodId, t.companyId],
      foreignColumns: [fiscalPeriods.id, fiscalPeriods.companyId],
    }),
    foreignKey({
      name: 'stock_documents_warehouse_fk',
      columns: [t.warehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }),
    foreignKey({
      name: 'stock_documents_to_warehouse_fk',
      columns: [t.toWarehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }),
    foreignKey({
      name: 'stock_documents_reversal_of_fk',
      columns: [t.reversalOfId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    foreignKey({
      name: 'stock_documents_reversed_by_fk',
      columns: [t.reversedById, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    index('stock_documents_date_idx').on(t.companyId, t.docDate),
    check(
      'stock_documents_type_ck',
      sql`${t.type} in ('opening','receipt','issue','waste','transfer','count')`,
    ),
    check('stock_documents_transfer_ck', sql`(${t.type} = 'transfer') = (${t.toWarehouseId} is not null)`),
  ],
);

/**
 * Stok defteri: belge başına etki satırları (işaretli miktar ve şirket para birimi değeri).
 * Eldeki miktar/değer her zaman bu tablonun toplamından türetilir; ayrı bakiye tablosu yoktur.
 * 'cost_adjust' satırı (miktar 0): eksi bakiye sonradan gelen alışla kapanırken oluşan maliyet farkı.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** İşleme sırası (geriye dönük tarihli hareketlerde de artar). */
    seq: bigserial({ mode: 'number' }).notNull(),
    documentId: uuid().notNull(),
    lineNo: integer().notNull(),
    kind: text().notNull().default('qty'),
    itemId: uuid().notNull(),
    warehouseId: uuid().notNull(),
    movementDate: date({ mode: 'string' }).notNull(),
    qty: qty().notNull(),
    /** Şirket para biriminde işaretli değer (2 ondalık). */
    value: money().notNull(),
    /** Alış/devirde orijinal para birimi, o para biriminde birim maliyet ve uygulanan kur. */
    currencyCode: text().references(() => currencies.code),
    unitCost: unitCost(),
    fxRate: rate(),
  },
  (t) => [
    unique('stock_movements_seq_uq').on(t.seq),
    foreignKey({
      name: 'stock_movements_document_fk',
      columns: [t.documentId, t.companyId],
      foreignColumns: [stockDocuments.id, stockDocuments.companyId],
    }),
    foreignKey({
      name: 'stock_movements_item_fk',
      columns: [t.itemId, t.companyId],
      foreignColumns: [items.id, items.companyId],
    }),
    foreignKey({
      name: 'stock_movements_warehouse_fk',
      columns: [t.warehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }),
    index('stock_movements_item_idx').on(t.companyId, t.itemId, t.seq),
    index('stock_movements_wh_item_idx').on(t.companyId, t.warehouseId, t.itemId),
    index('stock_movements_date_idx').on(t.companyId, t.movementDate),
    index('stock_movements_doc_idx').on(t.documentId),
    check('stock_movements_kind_ck', sql`${t.kind} in ('qty','cost_adjust')`),
    check(
      'stock_movements_shape_ck',
      sql`(${t.kind} = 'qty' and ${t.qty} <> 0 and (${t.value} = 0 or sign(${t.qty}) = sign(${t.value}))) or (${t.kind} = 'cost_adjust' and ${t.qty} = 0 and ${t.value} <> 0)`,
    ),
  ],
);

export const stockCounts = pgTable(
  'stock_counts',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** Kaydedilene kadar null; boşluksuz seri işleme anında atanır. */
    countNo: text(),
    countDate: date({ mode: 'string' }).notNull(),
    warehouseId: uuid().notNull(),
    description: text(),
    status: text().notNull().default('draft'),
    /** Fark varsa işleme anında üretilen 'count' türü stok belgesi. */
    documentId: uuid(),
    postedAt: timestamp({ withTimezone: true }),
    postedBy: uuid().references(() => users.id),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('stock_counts_id_company_uq').on(t.id, t.companyId),
    unique('stock_counts_no_uq').on(t.companyId, t.countNo),
    foreignKey({
      name: 'stock_counts_warehouse_fk',
      columns: [t.warehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }),
    foreignKey({
      name: 'stock_counts_document_fk',
      columns: [t.documentId, t.companyId],
      foreignColumns: [stockDocuments.id, stockDocuments.companyId],
    }),
    check('stock_counts_status_ck', sql`${t.status} in ('draft','posted')`),
    check(
      'stock_counts_posted_ck',
      sql`${t.status} = 'draft' or (${t.countNo} is not null and ${t.postedAt} is not null)`,
    ),
  ],
);

export const stockCountLines = pgTable(
  'stock_count_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    countId: uuid().notNull(),
    itemId: uuid().notNull(),
    /** null = henüz sayılmadı; işleme sırasında dikkate alınmaz. */
    countedQty: qty(),
    /** İşleme anında doldurulur: depodaki sistem miktarı ve fark (sayılan − sistem). */
    systemQty: qty(),
    diffQty: qty(),
  },
  (t) => [
    unique('stock_count_lines_uq').on(t.countId, t.itemId),
    foreignKey({
      name: 'stock_count_lines_count_fk',
      columns: [t.countId, t.companyId],
      foreignColumns: [stockCounts.id, stockCounts.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'stock_count_lines_item_fk',
      columns: [t.itemId, t.companyId],
      foreignColumns: [items.id, items.companyId],
    }),
    check('stock_count_lines_qty_ck', sql`${t.countedQty} is null or ${t.countedQty} >= 0`),
  ],
);
