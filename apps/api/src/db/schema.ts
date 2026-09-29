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
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('accounts_company_code_uq').on(t.companyId, t.code),
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
    /** Cari kartı bağı: M4'te FK eklenecek. */
    partyId: uuid(),
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
    unique('journal_lines_entry_line_uq').on(t.entryId, t.lineNo),
    index('journal_lines_account_idx').on(t.companyId, t.accountId),
    check(
      'journal_lines_side_ck',
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and ((${t.debit} > 0) <> (${t.credit} > 0))`,
    ),
    check('journal_lines_base_ck', sql`${t.debitBase} >= 0 and ${t.creditBase} >= 0`),
    check('journal_lines_fx_ck', sql`${t.fxRate} > 0`),
  ],
);
