import { sql } from 'drizzle-orm';
import {
  bigint,
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
    /** E-posta adresinin doğrulandığı an; posta altyapısı kapalıyken kayıtta otomatik dolar. */
    emailVerifiedAt: timestamp({ withTimezone: true }),
    /** Yönetici ilk parolayı belirlediğinde true; kullanıcı değiştirene dek şirket uçları kapalıdır. */
    mustChangePassword: boolean().notNull().default(false),
    createdAt: createdAt(),
    lastLoginAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

/** Tek kullanımlık, süreli bağlantı jetonları (e-posta doğrulama, parola sıfırlama). Yalnızca sha256 özeti saklanır. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    purpose: text().notNull(),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    ip: text(),
  },
  (t) => [
    uniqueIndex('user_tokens_hash_uq').on(t.tokenHash),
    index('user_tokens_user_idx').on(t.userId, t.purpose),
    check('user_tokens_purpose_ck', sql`${t.purpose} in ('verify_email','reset_password')`),
  ],
);

/** Kimlik doğrulama ve yetki olayları (yalnızca eklenir). Kiracı tablosu değildir; destek/inceleme içindir. */
export const securityEvents = pgTable(
  'security_events',
  {
    id: id(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    organizationId: uuid(),
    userId: uuid(),
    email: text(),
    event: text().notNull(),
    ip: text(),
    userAgent: text(),
    meta: jsonb(),
  },
  (t) => [index('security_events_org_idx').on(t.organizationId, t.at), index('security_events_user_idx').on(t.userId, t.at)],
);

/**
 * Kayıtlı cihazlar (lisans cihaz koltukları; kiracı tablosu değildir, kuruluma özgüdür). Bir "cihaz" bir tarayıcı/bilgisayardır:
 * ilk girişte sunucu bir kimlik ve gizli değer üretir, gizli değerin özeti burada, değerin kendisi `erp_device` çerezindedir.
 * Koltuk sayılır: iptal edilmemiş ve son `deviceIdleDays` içinde görülmüş cihazlar. Silinmez; iptal edilir.
 */
export const devices = pgTable(
  'devices',
  {
    id: id(),
    secretHash: text().notNull(),
    name: text().notNull(),
    userAgent: text(),
    ip: text(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUserId: uuid().references(() => users.id),
    revokedAt: timestamp({ withTimezone: true }),
    revokedBy: text(),
  },
  (t) => [index('devices_last_seen_idx').on(t.lastSeenAt), index('devices_last_user_idx').on(t.lastUserId)],
);

/**
 * Lisans durumu: kuruluma özgü TEK satır (kiracı tablosu değildir). Kurulum kimliği ve anahtar çifti ilk çalışmada
 * üretilir; satıcı imzalı kira (`lease_token`) her okunuşta imzası yeniden doğrulanır, bu yüzden buradaki bir düzenleme
 * yetki kazandırmaz. Kurallar (silinemez, kimlik sabit, saat işareti geri gitmez) 0020 migration'ındaki tetikleyicidedir.
 */
export const licenseState = pgTable(
  'license_state',
  {
    id: integer().primaryKey().default(1),
    installationId: uuid().notNull(),
    /** Kurulum açık anahtarı (ham, base64url); etkinleştirmede satıcıya bildirilir ve sabitlenir. */
    publicKey: text().notNull(),
    privateKeyPem: text().notNull(),
    /** Satıcı imzalı kira belirteci (erp1.…); yoksa kurulum lisanssızdır. */
    leaseToken: text(),
    /** Bu kurulumda görülen en yüksek zaman (ms, epoch): saat geri alma tespiti. */
    highWater: bigint({ mode: 'number' }).notNull().default(0),
    lastCheckAt: timestamp({ withTimezone: true }),
    lastSuccessAt: timestamp({ withTimezone: true }),
    lastErrorCode: text(),
    lastError: text(),
    /** Çevrimdışı etkinleştirme isteğinin kimliği; dönen kira bu kimlikle eşleşmelidir. */
    pendingRequestId: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('license_state_single_ck', sql`${t.id} = 1`)],
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
    /** Döndürme (rotasyon) ile iptal edildiyse zamanı; kısa tolerans penceresinde çakışan istekleri ayırt eder. */
    rotatedAt: timestamp({ withTimezone: true }),
    /** Oturumun açıldığı cihaz (lisans cihaz koltuğu); cihaz kaldırılınca bu oturumlar da kapanır. Denetim kapalıyken boştur. */
    deviceId: uuid(),
    /** Aynı oturumun art arda döndürülen token'ları; oturumun mutlak ömrü ilk girişten sayılır. */
    familyId: uuid().notNull().default(sql`gen_random_uuid()`),
    familyStartedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    userAgent: text(),
    ip: text(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
    index('refresh_tokens_expires_idx').on(t.expiresAt),
    index('refresh_tokens_device_idx').on(t.deviceId),
  ],
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

/**
 * İnşaat parametreleri (teminat, stopaj, avans mahsup yüzdesi): tarih aralıklı, kaynak notlu, doğrulama alanlı.
 * Hukuki değerler kod sabiti değildir (LEGAL-NOTES §12); belgeler değeri kayıt anında kopyalar.
 */
export const constructionParams = pgTable(
  'construction_params',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** retention_pct | withholding_pct | advance_recoup_pct */
    kind: text().notNull(),
    /** Yüzde, örn. 5.0000 */
    value: numeric({ precision: 7, scale: 4 }).notNull(),
    validFrom: date({ mode: 'string' }).notNull(),
    validTo: date({ mode: 'string' }),
    sourceNote: text(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('construction_params_uq').on(t.companyId, t.kind, t.validFrom),
    check('construction_params_kind_ck', sql`${t.kind} in ('retention_pct','withholding_pct','advance_recoup_pct')`),
    check('construction_params_value_ck', sql`${t.value} >= 0 and ${t.value} <= 100`),
    check('construction_params_range_ck', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

/** Onay kuralı: belge türü + (isteğe bağlı) proje + tutar aralığı → sıralı adımlar. */
export const approvalRules = pgTable(
  'approval_rules',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    docType: text().notNull(),
    projectId: uuid(),
    /** Defter para biriminde, alt sınır dahil. */
    minAmount: money().notNull().default('0'),
    /** Üst sınır hariç; null = sınırsız. */
    maxAmount: money(),
    /** true: belgeyi gönderen kendi belgesini onaylayamaz. */
    separateRequester: boolean().notNull().default(true),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('approval_rules_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'approval_rules_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    check('approval_rules_doc_type_ck', sql`${t.docType} in ('progress_payment')`),
    check('approval_rules_range_ck', sql`${t.minAmount} >= 0 and (${t.maxAmount} is null or ${t.maxAmount} > ${t.minAmount})`),
  ],
);

export const approvalRuleSteps = pgTable(
  'approval_rule_steps',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    ruleId: uuid().notNull(),
    stepNo: integer().notNull(),
    /** Rol VEYA kullanıcı (ikisinden tam biri). */
    approverRole: text(),
    approverUserId: uuid().references(() => users.id),
    label: text(),
  },
  (t) => [
    unique('approval_rule_steps_uq').on(t.ruleId, t.stepNo),
    foreignKey({
      name: 'approval_rule_steps_rule_fk',
      columns: [t.ruleId, t.companyId],
      foreignColumns: [approvalRules.id, approvalRules.companyId],
    }).onDelete('cascade'),
    check('approval_rule_steps_no_ck', sql`${t.stepNo} >= 1`),
    check(
      'approval_rule_steps_approver_ck',
      sql`(${t.approverRole} is not null) <> (${t.approverUserId} is not null)`,
    ),
  ],
);

/** Bir belgenin onay talebi; gönderildiği anda kural adımları `approval_steps`e kopyalanır. */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    docType: text().notNull(),
    docId: uuid().notNull(),
    projectId: uuid(),
    amount: money().notNull(),
    /** pending | approved | rejected | cancelled */
    status: text().notNull().default('pending'),
    separateRequester: boolean().notNull().default(true),
    requestedBy: uuid()
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('approval_requests_id_company_uq').on(t.id, t.companyId),
    // Bir belgenin aynı anda tek bekleyen talebi olur
    uniqueIndex('approval_requests_pending_uq')
      .on(t.companyId, t.docType, t.docId)
      .where(sql`${t.status} = 'pending'`),
    index('approval_requests_status_idx').on(t.companyId, t.status),
    check('approval_requests_status_ck', sql`${t.status} in ('pending','approved','rejected','cancelled')`),
  ],
);

export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    requestId: uuid().notNull(),
    stepNo: integer().notNull(),
    /** İkisi de boşsa varsayılan adım: `subcontracts.approve` izni olan herkes. */
    approverRole: text(),
    approverUserId: uuid().references(() => users.id),
    label: text(),
    /** pending | approved | rejected */
    status: text().notNull().default('pending'),
    decidedBy: uuid().references(() => users.id),
    decidedAt: timestamp({ withTimezone: true }),
    note: text(),
  },
  (t) => [
    unique('approval_steps_uq').on(t.requestId, t.stepNo),
    foreignKey({
      name: 'approval_steps_request_fk',
      columns: [t.requestId, t.companyId],
      foreignColumns: [approvalRequests.id, approvalRequests.companyId],
    }),
    check('approval_steps_status_ck', sql`${t.status} in ('pending','approved','rejected')`),
    check('approval_steps_approver_ck', sql`not (${t.approverRole} is not null and ${t.approverUserId} is not null)`),
  ],
);

/** Maliyet kodu (maliyet türü): iş kaleminden (WBS) bağımsız üçüncü boyut; malzeme, işçilik, taşeron vb. */
export const costCodes = pgTable(
  'cost_codes',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    /** material | labor | subcontract | equipment | transport | overhead | other */
    kind: text().notNull().default('other'),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('cost_codes_company_code_uq').on(t.companyId, t.code),
    unique('cost_codes_id_company_uq').on(t.id, t.companyId),
    check(
      'cost_codes_kind_ck',
      sql`${t.kind} in ('material','labor','subcontract','equipment','transport','overhead','other')`,
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
    /** Otomatik kaydı üreten belge: 'invoice' (fatura), 'stock_document' (stok belgesi)… Ters kayıtlar da kaynağını taşır. */
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
    // Raporlar yalnızca kaydedilmiş fişleri tarih aralığıyla okur
    index('journal_entries_posted_date_idx').on(t.companyId, t.entryDate).where(sql`${t.status} = 'posted'`),
    // Ters kayıt eşleşmeleri (açık kalem nötrlüğü, ters çevrilmiş fiş denetimleri)
    index('journal_entries_reversal_of_idx').on(t.reversalOfId).where(sql`${t.reversalOfId} is not null`),
    index('journal_entries_reversed_by_idx').on(t.reversedById).where(sql`${t.reversedById} is not null`),
    // Bir kaynak (fatura, stok belgesi) için tek asıl yevmiye; ters kayıtlar (reversal_of_id dolu) hariç
    uniqueIndex('journal_entries_source_uq')
      .on(t.companyId, t.sourceType, t.sourceId)
      .where(sql`${t.sourceId} is not null and ${t.reversalOfId} is null`),
    check('journal_entries_status_ck', sql`${t.status} in ('draft','posted')`),
    check(
      'journal_entries_posted_ck',
      sql`${t.status} = 'draft' or (${t.entryNo} is not null and ${t.postedAt} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Şantiye / proje (Faz B1): proje, iş kırılımı (WBS), bütçe revizyonları, ilerleme.
// Gerçekleşen maliyet ayrı tutulmaz: yevmiye satırlarındaki proje/iş kalemi boyutundan türer.
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    /** 'own': kendi projesi; 'contract': işverene yapılan iş (işveren carisi zorunlu). */
    kind: text().notNull().default('own'),
    status: text().notNull().default('planned'),
    clientPartyId: uuid(),
    startDate: date({ mode: 'string' }),
    endDate: date({ mode: 'string' }),
    location: text(),
    description: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('projects_company_code_uq').on(t.companyId, t.code),
    unique('projects_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'projects_client_fk',
      columns: [t.clientPartyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    index('projects_status_idx').on(t.companyId, t.status),
    check('projects_kind_ck', sql`${t.kind} in ('own','contract')`),
    check('projects_status_ck', sql`${t.status} in ('planned','active','on_hold','completed','cancelled')`),
    check(
      'projects_client_ck',
      sql`(${t.kind} = 'contract' and ${t.clientPartyId} is not null) or (${t.kind} = 'own' and ${t.clientPartyId} is null)`,
    ),
    check('projects_dates_ck', sql`${t.startDate} is null or ${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
  ],
);

/** İş kırılımı ağacı; maliyet yalnızca yaprak düğümlere yazılır (tetikleyici denetler). */
export const projectWbs = pgTable(
  'project_wbs',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    projectId: uuid().notNull(),
    parentId: uuid(),
    code: text().notNull(),
    name: text().notNull(),
    sortOrder: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('project_wbs_project_code_uq').on(t.projectId, t.code),
    unique('project_wbs_id_company_uq').on(t.id, t.companyId),
    // Satırlar (iş kalemi, proje) çiftiyle bağlanır: iş kalemi etiketlenen projeye ait olmak zorundadır
    unique('project_wbs_id_project_uq').on(t.id, t.projectId),
    foreignKey({
      name: 'project_wbs_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'project_wbs_parent_fk',
      columns: [t.parentId, t.projectId],
      foreignColumns: [t.id, t.projectId],
    }),
    index('project_wbs_parent_idx').on(t.projectId, t.parentId),
    check('project_wbs_parent_ck', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);

/** Bütçe revizyonu: taslak → onaylı (değiştirilemez) → yenisi onaylanınca 'superseded'. Yürürlükteki = en yüksek numaralı onaylı. */
export const projectBudgets = pgTable(
  'project_budgets',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    projectId: uuid().notNull(),
    revisionNo: integer().notNull(),
    status: text().notNull().default('draft'),
    title: text(),
    approvedAt: timestamp({ withTimezone: true }),
    approvedBy: uuid().references(() => users.id),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('project_budgets_revision_uq').on(t.projectId, t.revisionNo),
    unique('project_budgets_id_company_uq').on(t.id, t.companyId),
    unique('project_budgets_id_project_uq').on(t.id, t.projectId),
    // Projede en çok bir taslak revizyon
    uniqueIndex('project_budgets_draft_uq')
      .on(t.projectId)
      .where(sql`${t.status} = 'draft'`),
    foreignKey({
      name: 'project_budgets_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    check('project_budgets_status_ck', sql`${t.status} in ('draft','approved','superseded')`),
    check(
      'project_budgets_approved_ck',
      sql`(${t.status} = 'draft' and ${t.approvedAt} is null) or (${t.status} <> 'draft' and ${t.approvedAt} is not null)`,
    ),
    check('project_budgets_rev_ck', sql`${t.revisionNo} >= 1`),
  ],
);

export const projectBudgetLines = pgTable(
  'project_budget_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    budgetId: uuid().notNull(),
    projectId: uuid().notNull(),
    wbsId: uuid().notNull(),
    /** Şirket defter para biriminde, 2 ondalık. */
    amount: numeric({ precision: 19, scale: 2 }).notNull(),
  },
  (t) => [
    unique('project_budget_lines_uq').on(t.budgetId, t.wbsId),
    foreignKey({
      name: 'project_budget_lines_budget_fk',
      columns: [t.budgetId, t.projectId],
      foreignColumns: [projectBudgets.id, projectBudgets.projectId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'project_budget_lines_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    foreignKey({
      name: 'project_budget_lines_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    index('project_budget_lines_wbs_idx').on(t.wbsId),
    check('project_budget_lines_amount_ck', sql`${t.amount} >= 0`),
  ],
);

/** İş kalemi ilerleme kayıtları: yalnızca eklenir; asOf tarihine kadarki en son kayıt geçerlidir. */
export const projectProgress = pgTable(
  'project_progress',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    projectId: uuid().notNull(),
    wbsId: uuid().notNull(),
    asOfDate: date({ mode: 'string' }).notNull(),
    percent: numeric({ precision: 5, scale: 2 }).notNull(),
    /** Elle tamamlanmaya kalan maliyet tahmini (defter para birimi); boşsa formülle hesaplanır. */
    etcOverride: numeric({ precision: 19, scale: 2 }),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'project_progress_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    foreignKey({
      name: 'project_progress_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    index('project_progress_wbs_idx').on(t.wbsId, t.asOfDate, t.createdAt),
    check('project_progress_percent_ck', sql`${t.percent} between 0 and 100`),
    check('project_progress_etc_ck', sql`${t.etcOverride} is null or ${t.etcOverride} >= 0`),
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
    /** Proje boyutu (yalnızca gelir/gider/maliyet hesaplarında; tetikleyici denetler). Kayıttan sonra değişmez. */
    projectId: uuid(),
    /** Projenin yaprak iş kalemi. */
    wbsId: uuid(),
    /** Maliyet kodu (üçüncü boyut); yalnızca proje etiketli satırda. */
    costCodeId: uuid(),
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
    foreignKey({
      name: 'journal_lines_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'journal_lines_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    index('journal_lines_project_idx')
      .on(t.companyId, t.projectId, t.wbsId)
      .where(sql`${t.projectId} is not null`),
    index('journal_lines_wbs_idx')
      .on(t.wbsId)
      .where(sql`${t.wbsId} is not null`),
    check('journal_lines_wbs_ck', sql`${t.wbsId} is null or ${t.projectId} is not null`),
    foreignKey({
      name: 'journal_lines_cost_code_fk',
      columns: [t.costCodeId, t.companyId],
      foreignColumns: [costCodes.id, costCodes.companyId],
    }),
    check('journal_lines_cost_code_ck', sql`${t.costCodeId} is null or ${t.projectId} is not null`),
    unique('journal_lines_entry_line_uq').on(t.entryId, t.lineNo),
    // Cari eşleştirmesi (party_allocations) satıra bileşik anahtarla bağlanır
    unique('journal_lines_id_company_uq').on(t.id, t.companyId),
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
    /** Proje boyutu: yalnızca sarf/fire hareketlerinde (tetikleyici denetler). */
    projectId: uuid(),
    wbsId: uuid(),
  },
  (t) => [
    unique('stock_movements_seq_uq').on(t.seq),
    foreignKey({
      name: 'stock_movements_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'stock_movements_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    index('stock_movements_project_idx')
      .on(t.projectId, t.wbsId)
      .where(sql`${t.projectId} is not null`),
    index('stock_movements_wbs_idx')
      .on(t.wbsId)
      .where(sql`${t.wbsId} is not null`),
    check('stock_movements_wbs_ck', sql`${t.wbsId} is null or ${t.projectId} is not null`),
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

// ---------------------------------------------------------------------------
// Hesap eşlemesi ve fatura
// ---------------------------------------------------------------------------

/** Otomatik yevmiyede kullanılan hesaplar (anahtarlar: shared ACCOUNT_MAPPING_KEYS). */
export const accountMappings = pgTable(
  'account_mappings',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    key: text().notNull(),
    accountId: uuid().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('account_mappings_uq').on(t.companyId, t.key),
    foreignKey({
      name: 'account_mappings_account_fk',
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
    }),
    check(
      'account_mappings_key_ck',
      sql`${t.key} in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss')`,
    ),
  ],
);

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** sales | purchase | expense | sales_return | purchase_return */
    type: text().notNull(),
    status: text().notNull().default('draft'),
    /** Kaydedilene kadar null; boşluksuz seri (türe göre önek) kaydetme anında atanır. */
    invoiceNo: text(),
    /** Tedarikçinin fatura numarası (alış/gider/alış iadesi). */
    externalNo: text(),
    invoiceDate: date({ mode: 'string' }).notNull(),
    dueDate: date({ mode: 'string' }),
    partyId: uuid().notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    /** Fatura para biriminden defter para birimine; kaydetme anında kesinleşir (defter para biriminde 1). */
    fxRate: rate(),
    vatIncluded: boolean().notNull().default(false),
    warehouseId: uuid(),
    /** İade faturasında bağlı orijinal fatura. */
    returnOfId: uuid(),
    description: text(),
    /** Fatura para biriminde toplamlar (satır toplamlarının toplamı). */
    netTotal: money().notNull().default('0'),
    vatTotal: money().notNull().default('0'),
    grossTotal: money().notNull().default('0'),
    /** Defter para birimi karşılıkları; kaydetme anında yazılır. */
    netTotalBase: money(),
    vatTotalBase: money(),
    grossTotalBase: money(),
    journalEntryId: uuid(),
    /** Stoklu satır varsa faturadan doğan stok belgesi. */
    stockDocumentId: uuid(),
    postedAt: timestamp({ withTimezone: true }),
    postedBy: uuid().references(() => users.id),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
    cancelJournalEntryId: uuid(),
    cancelStockDocumentId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoices_id_company_uq').on(t.id, t.companyId),
    unique('invoices_no_uq').on(t.companyId, t.invoiceNo),
    // Aynı tedarikçiden aynı fatura numarası iki kez kaydedilemez. İptal edilen kayıt numarayı tutmaz:
    // düzeltme iptal + yeniden girişle yapıldığından aynı tedarikçi numarası tekrar girilebilmelidir.
    uniqueIndex('invoices_external_no_uq')
      .on(t.companyId, t.partyId, t.externalNo)
      .where(sql`${t.externalNo} is not null and ${t.status} = 'posted'`),
    index('invoices_date_idx').on(t.companyId, t.type, t.invoiceDate),
    index('invoices_party_idx').on(t.companyId, t.partyId),
    foreignKey({
      name: 'invoices_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    foreignKey({
      name: 'invoices_warehouse_fk',
      columns: [t.warehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }),
    foreignKey({
      name: 'invoices_return_of_fk',
      columns: [t.returnOfId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    foreignKey({
      name: 'invoices_journal_fk',
      columns: [t.journalEntryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    foreignKey({
      name: 'invoices_stock_document_fk',
      columns: [t.stockDocumentId, t.companyId],
      foreignColumns: [stockDocuments.id, stockDocuments.companyId],
    }),
    foreignKey({
      name: 'invoices_cancel_journal_fk',
      columns: [t.cancelJournalEntryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    foreignKey({
      name: 'invoices_cancel_stock_document_fk',
      columns: [t.cancelStockDocumentId, t.companyId],
      foreignColumns: [stockDocuments.id, stockDocuments.companyId],
    }),
    check(
      'invoices_type_ck',
      sql`${t.type} in ('sales','purchase','expense','sales_return','purchase_return')`,
    ),
    check('invoices_status_ck', sql`${t.status} in ('draft','posted','cancelled')`),
    check(
      'invoices_posted_ck',
      sql`${t.status} = 'draft' or (${t.invoiceNo} is not null and ${t.postedAt} is not null and ${t.journalEntryId} is not null and ${t.fxRate} is not null and ${t.grossTotalBase} is not null)`,
    ),
    check(
      'invoices_cancelled_ck',
      sql`${t.status} <> 'cancelled' or (${t.cancelledAt} is not null and ${t.cancelReason} is not null and ${t.cancelJournalEntryId} is not null)`,
    ),
    check(
      'invoices_totals_ck',
      sql`${t.netTotal} >= 0 and ${t.vatTotal} >= 0 and ${t.grossTotal} >= 0 and ${t.grossTotal} = ${t.netTotal} + ${t.vatTotal}`,
    ),
    check('invoices_due_ck', sql`${t.dueDate} is null or ${t.dueDate} >= ${t.invoiceDate}`),
  ],
);

/**
 * İrsaliye başlığı: satış (sevk, stoktan çıkış) ve alış (mal kabul, stoğa giriş). Kaydedilince stok defterini
 * hareket ettirir (stok belgesi kaynağı 'delivery_note'); yevmiye üretmez, muhasebe faturada oluşur.
 */
export const deliveryNotes = pgTable(
  'delivery_notes',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** sales | purchase */
    type: text().notNull(),
    status: text().notNull().default('draft'),
    /** Kaydedilene kadar null; boşluksuz seri (SIR/AIR) kaydetme anında atanır. */
    noteNo: text(),
    /** Tedarikçinin irsaliye numarası (alış). */
    externalNo: text(),
    noteDate: date({ mode: 'string' }).notNull(),
    partyId: uuid().notNull(),
    warehouseId: uuid().notNull(),
    vehiclePlate: text(),
    driverName: text(),
    description: text(),
    stockDocumentId: uuid(),
    postedAt: timestamp({ withTimezone: true }),
    postedBy: uuid().references(() => users.id),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
    cancelStockDocumentId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('delivery_notes_id_company_uq').on(t.id, t.companyId),
    unique('delivery_notes_no_uq').on(t.companyId, t.noteNo),
    // Aynı tedarikçinin aynı irsaliyesi iki kez kaydedilemez (iptal edilen numarayı tutmaz)
    uniqueIndex('delivery_notes_external_no_uq')
      .on(t.companyId, t.partyId, t.externalNo)
      .where(sql`${t.externalNo} is not null and ${t.status} = 'posted'`),
    index('delivery_notes_date_idx').on(t.companyId, t.type, t.noteDate),
    index('delivery_notes_party_idx').on(t.companyId, t.partyId),
    foreignKey({
      name: 'delivery_notes_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    foreignKey({
      name: 'delivery_notes_warehouse_fk',
      columns: [t.warehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }),
    foreignKey({
      name: 'delivery_notes_stock_document_fk',
      columns: [t.stockDocumentId, t.companyId],
      foreignColumns: [stockDocuments.id, stockDocuments.companyId],
    }),
    foreignKey({
      name: 'delivery_notes_cancel_stock_document_fk',
      columns: [t.cancelStockDocumentId, t.companyId],
      foreignColumns: [stockDocuments.id, stockDocuments.companyId],
    }),
    check('delivery_notes_type_ck', sql`${t.type} in ('sales','purchase')`),
    check('delivery_notes_status_ck', sql`${t.status} in ('draft','posted','cancelled')`),
    check(
      'delivery_notes_posted_ck',
      sql`${t.status} = 'draft' or (${t.noteNo} is not null and ${t.postedAt} is not null and ${t.stockDocumentId} is not null)`,
    ),
    check(
      'delivery_notes_cancelled_ck',
      sql`${t.status} <> 'cancelled' or (${t.cancelledAt} is not null and ${t.cancelReason} is not null and ${t.cancelStockDocumentId} is not null)`,
    ),
  ],
);

export const deliveryNoteLines = pgTable(
  'delivery_note_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    noteId: uuid().notNull(),
    lineNo: integer().notNull(),
    /** İrsaliye yalnızca stoklu (mal) kartlarla düzenlenir. */
    itemId: uuid().notNull(),
    description: text().notNull(),
    quantity: qty().notNull(),
    unit: text(),
    /** Yalnızca alışta, isteğe bağlı: `currency` cinsinden birim maliyet (yoksa değer 0 girer). */
    unitCost: unitCost(),
    currencyCode: text().references(() => currencies.code),
    fxRate: rate(),
    /** Kaydedilirken yazılır: stok defterindeki miktar satırının mutlak değeri (defter para birimi). */
    stockValue: money(),
    /** Kaydedilirken yazılır: bu satırın eksi bakiye kapanışından doğan maliyet düzeltmesi (işaretli). */
    adjustValue: money(),
  },
  (t) => [
    unique('delivery_note_lines_uq').on(t.noteId, t.lineNo),
    unique('delivery_note_lines_id_company_uq').on(t.id, t.companyId),
    index('delivery_note_lines_item_idx').on(t.companyId, t.itemId),
    foreignKey({
      name: 'delivery_note_lines_note_fk',
      columns: [t.noteId, t.companyId],
      foreignColumns: [deliveryNotes.id, deliveryNotes.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'delivery_note_lines_item_fk',
      columns: [t.itemId, t.companyId],
      foreignColumns: [items.id, items.companyId],
    }),
    check(
      'delivery_note_lines_amounts_ck',
      sql`${t.quantity} > 0 and (${t.unitCost} is null or ${t.unitCost} >= 0) and (${t.stockValue} is null or ${t.stockValue} >= 0)`,
    ),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    invoiceId: uuid().notNull(),
    lineNo: integer().notNull(),
    /** Boşsa serbest satır (hizmet/gider). */
    itemId: uuid(),
    description: text().notNull(),
    quantity: qty().notNull(),
    unit: text(),
    /** Fatura para biriminde; KDV dahil faturada KDV dahil birim fiyat. */
    unitPrice: unitCost().notNull(),
    discountPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    vatCode: text(),
    /** Fatura tarihinde geçerli oranın anlık görüntüsü (yüzde). */
    vatRate: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    /** Fatura para biriminde satır tutarları. */
    net: money().notNull(),
    vat: money().notNull(),
    gross: money().notNull(),
    /** Serbest satırda gelir/gider hesabı (boşsa eşlemedeki varsayılan). */
    accountId: uuid(),
    /** İade satırında, iade edilen orijinal fatura satırı. */
    sourceLineId: uuid(),
    /** Kaydetme anında yazılan defter para birimi tutarları ve stokta hareket eden maliyet. */
    netBase: money(),
    vatBase: money(),
    costValue: money(),
    /** Satış/alış faturasında, faturalanan irsaliye satırı (stok hareketi irsaliyede yapılmıştır). */
    deliveryLineId: uuid(),
    /** Kaydetme anında yazılır: irsaliye satırının bu satıra düşen değer ve maliyet düzeltmesi payı. */
    deliveryValue: money(),
    deliveryAdjust: money(),
    /** Proje boyutu: yalnızca stoksuz alış/gider/alış iadesi satırında (net tarafa yazılır). */
    projectId: uuid(),
    wbsId: uuid(),
  },
  (t) => [
    unique('invoice_lines_uq').on(t.invoiceId, t.lineNo),
    foreignKey({
      name: 'invoice_lines_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'invoice_lines_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    index('invoice_lines_project_idx')
      .on(t.projectId, t.wbsId)
      .where(sql`${t.projectId} is not null`),
    index('invoice_lines_wbs_idx')
      .on(t.wbsId)
      .where(sql`${t.wbsId} is not null`),
    check('invoice_lines_wbs_ck', sql`${t.wbsId} is null or ${t.projectId} is not null`),
    unique('invoice_lines_id_company_uq').on(t.id, t.companyId),
    index('invoice_lines_item_idx').on(t.companyId, t.itemId),
    foreignKey({
      name: 'invoice_lines_invoice_fk',
      columns: [t.invoiceId, t.companyId],
      foreignColumns: [invoices.id, invoices.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invoice_lines_item_fk',
      columns: [t.itemId, t.companyId],
      foreignColumns: [items.id, items.companyId],
    }),
    foreignKey({
      name: 'invoice_lines_account_fk',
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
    }),
    foreignKey({
      name: 'invoice_lines_source_fk',
      columns: [t.sourceLineId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    foreignKey({
      name: 'invoice_lines_delivery_fk',
      columns: [t.deliveryLineId, t.companyId],
      foreignColumns: [deliveryNoteLines.id, deliveryNoteLines.companyId],
    }),
    index('invoice_lines_delivery_idx')
      .on(t.deliveryLineId)
      .where(sql`${t.deliveryLineId} is not null`),
    check('invoice_lines_link_ck', sql`${t.deliveryLineId} is null or ${t.sourceLineId} is null`),
    check(
      'invoice_lines_amounts_ck',
      sql`${t.quantity} > 0 and ${t.unitPrice} >= 0 and ${t.discountPct} between 0 and 100 and ${t.vatRate} between 0 and 100 and ${t.net} >= 0 and ${t.vat} >= 0 and ${t.gross} = ${t.net} + ${t.vat}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Kasa ve banka
// ---------------------------------------------------------------------------

/**
 * Kasa/banka hesabı: bir muhasebe yaprak hesabına (100.x / 102.x) bağlı, tek para birimli hesap.
 * Bakiye ayrı tutulmaz, bağlı muhasebe hesabının hareketlerinden türetilir.
 */
export const treasuryAccounts = pgTable(
  'treasury_accounts',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** cash | bank */
    kind: text().notNull(),
    name: text().notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    accountId: uuid().notNull(),
    bankName: text(),
    branch: text(),
    iban: text(),
    accountNo: text(),
    isActive: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('treasury_accounts_id_company_uq').on(t.id, t.companyId),
    unique('treasury_accounts_gl_uq').on(t.companyId, t.accountId),
    unique('treasury_accounts_name_uq').on(t.companyId, t.name),
    foreignKey({
      name: 'treasury_accounts_gl_fk',
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
    }),
    check('treasury_accounts_kind_ck', sql`${t.kind} in ('cash','bank')`),
  ],
);

/**
 * Kasa/banka hareketi: doğrudan kaydedilir (taslak yok), yevmiyesi aynı işlemde yazılır.
 * Değiştirilemez; düzeltme iptal (yevmiyenin ters kaydı) ile yapılır.
 */
export const treasuryTransactions = pgTable(
  'treasury_transactions',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** receipt | payment | transfer | exchange | other_receipt | other_payment */
    type: text().notNull(),
    status: text().notNull().default('posted'),
    txnNo: text().notNull(),
    txnDate: date({ mode: 'string' }).notNull(),
    /** Kasa/banka hesabı: tahsilatta giren, diğerlerinde çıkan taraf. */
    accountId: uuid().notNull(),
    /** Virman/döviz: hedef hesap. */
    toAccountId: uuid(),
    partyId: uuid(),
    /** Diğer tahsilat/ödeme: karşı muhasebe hesabı. */
    glAccountId: uuid(),
    /** Kasa/banka hesabının para birimi ve bu para biriminde tutar. */
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    amount: money().notNull(),
    /** Döviz: hedef hesap para biriminde tutar. */
    counterAmount: money(),
    /** Kasa/banka para biriminin defter para birimine kuru (yalnızca bilgi; defter tutarları yevmiyededir). */
    fxRate: rate(),
    description: text(),
    journalEntryId: uuid().notNull(),
    postedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    postedBy: uuid().references(() => users.id),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
    cancelJournalEntryId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('treasury_transactions_id_company_uq').on(t.id, t.companyId),
    unique('treasury_transactions_no_uq').on(t.companyId, t.txnNo),
    index('treasury_transactions_date_idx').on(t.companyId, t.txnDate),
    index('treasury_transactions_journal_idx').on(t.journalEntryId),
    index('treasury_transactions_cancel_journal_idx').on(t.cancelJournalEntryId).where(sql`${t.cancelJournalEntryId} is not null`),
    index('treasury_transactions_account_idx').on(t.companyId, t.accountId),
    index('treasury_transactions_party_idx').on(t.companyId, t.partyId),
    foreignKey({
      name: 'treasury_transactions_account_fk',
      columns: [t.accountId, t.companyId],
      foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId],
    }),
    foreignKey({
      name: 'treasury_transactions_to_account_fk',
      columns: [t.toAccountId, t.companyId],
      foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId],
    }),
    foreignKey({
      name: 'treasury_transactions_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    foreignKey({
      name: 'treasury_transactions_gl_fk',
      columns: [t.glAccountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
    }),
    foreignKey({
      name: 'treasury_transactions_journal_fk',
      columns: [t.journalEntryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    foreignKey({
      name: 'treasury_transactions_cancel_journal_fk',
      columns: [t.cancelJournalEntryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    check(
      'treasury_transactions_type_ck',
      sql`${t.type} in ('receipt','payment','transfer','exchange','other_receipt','other_payment')`,
    ),
    check('treasury_transactions_status_ck', sql`${t.status} in ('posted','cancelled')`),
    check(
      'treasury_transactions_amount_ck',
      sql`${t.amount} > 0 and (${t.counterAmount} is null or ${t.counterAmount} > 0)`,
    ),
    check(
      'treasury_transactions_cancelled_ck',
      sql`${t.status} <> 'cancelled' or (${t.cancelledAt} is not null and ${t.cancelReason} is not null and ${t.cancelJournalEntryId} is not null)`,
    ),
  ],
);

/**
 * Tahsilat/ödemenin kapattığı açık kalem (cari kontrol hesabı satırı). Değişmez; işlem iptal edilince
 * kayıt silinmez, `status = 'cancelled'` olan işlemin eşleştirmeleri hesaba katılmaz.
 */
export const partyAllocations = pgTable(
  'party_allocations',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    partyId: uuid().notNull(),
    /** receivable | payable */
    control: text().notNull(),
    transactionId: uuid().notNull(),
    /** Kapatılan kalem (fatura vb. cari satırı) ve kapatan satır (tahsilat/ödemenin cari satırı). */
    chargeLineId: uuid().notNull(),
    settleLineId: uuid().notNull(),
    /** Kalemin para biriminde kapatılan tutar ve kalemin taşıdığı defter tutarı payı. */
    amount: money().notNull(),
    amountBase: money().notNull(),
    /** Kasa/banka para biriminde karşılığı. */
    settleAmount: money().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('party_allocations_settle_uq').on(t.settleLineId),
    index('party_allocations_charge_idx').on(t.chargeLineId),
    index('party_allocations_txn_idx').on(t.transactionId),
    index('party_allocations_party_idx').on(t.companyId, t.partyId),
    foreignKey({
      name: 'party_allocations_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    foreignKey({
      name: 'party_allocations_transaction_fk',
      columns: [t.transactionId, t.companyId],
      foreignColumns: [treasuryTransactions.id, treasuryTransactions.companyId],
    }),
    foreignKey({
      name: 'party_allocations_charge_fk',
      columns: [t.chargeLineId, t.companyId],
      foreignColumns: [journalLines.id, journalLines.companyId],
    }),
    foreignKey({
      name: 'party_allocations_settle_fk',
      columns: [t.settleLineId, t.companyId],
      foreignColumns: [journalLines.id, journalLines.companyId],
    }),
    check('party_allocations_control_ck', sql`${t.control} in ('receivable','payable')`),
    check(
      'party_allocations_amount_ck',
      sql`${t.amount} > 0 and ${t.amountBase} > 0 and ${t.settleAmount} > 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Banka ekstresi ve mutabakat (M8c)
// ---------------------------------------------------------------------------

/**
 * İçe aktarılmış banka ekstresi (bir dosya). Değişmez; yalnızca hiç eşleşmemiş ekstre "geri alma" ile silinebilir.
 * `fileHash`: eşlenmiş satırların içeriğinden (dosya baytlarından değil) türetilir; aynı ekstre iki kez alınamaz.
 */
export const bankStatements = pgTable(
  'bank_statements',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    accountId: uuid().notNull(),
    fileName: text().notNull(),
    fileHash: text().notNull(),
    fromDate: date({ mode: 'string' }).notNull(),
    toDate: date({ mode: 'string' }).notNull(),
    /** Ekstredeki açılış/kapanış bakiyesi (hesap para biriminde); bakiye sütunu yoksa ve girilmediyse boş. */
    openingBalance: money(),
    closingBalance: money(),
    lineCount: integer().notNull(),
    /** Kullanılan sütun eşlemesi (alan → sütun başlığı): sonraki içe aktarmada hazır gelir. */
    mapping: jsonb().notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('bank_statements_id_company_uq').on(t.id, t.companyId),
    unique('bank_statements_hash_uq').on(t.companyId, t.accountId, t.fileHash),
    index('bank_statements_account_idx').on(t.companyId, t.accountId, t.toDate),
    foreignKey({
      name: 'bank_statements_account_fk',
      columns: [t.accountId, t.companyId],
      foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId],
    }),
    check('bank_statements_range_ck', sql`${t.fromDate} <= ${t.toDate}`),
  ],
);

/**
 * Ekstre satırı: `amount` işaretlidir (+ hesaba giren, − çıkan; hesap para biriminde). Eşleşme ayrı tabloda
 * değil bu satırdadır çünkü `journal_lines` ve `treasury_transactions` değiştirilemez. Bir defter satırı
 * yalnızca bir ekstre satırıyla eşleşir (`bank_statement_lines_gl_uq`).
 */
export const bankStatementLines = pgTable(
  'bank_statement_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    statementId: uuid().notNull(),
    accountId: uuid().notNull(),
    /** Kaynak dosyadaki satır numarası. */
    lineNo: integer().notNull(),
    txnDate: date({ mode: 'string' }).notNull(),
    valueDate: date({ mode: 'string' }),
    description: text().notNull().default(''),
    reference: text(),
    amount: money().notNull(),
    /** Ekstredeki satır sonrası bakiye (varsa). */
    balance: money(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    /** tarih|tutar|açıklama|referans|sıra: çakışan dönemli ekstrelerde aynı satır ikinci kez alınmaz. */
    dedupeKey: text().notNull(),
    /** open | matched | ignored */
    status: text().notNull().default('open'),
    journalLineId: uuid(),
    transactionId: uuid(),
    matchedAt: timestamp({ withTimezone: true }),
    matchedBy: uuid().references(() => users.id),
    ignoreReason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('bank_statement_lines_id_company_uq').on(t.id, t.companyId),
    unique('bank_statement_lines_dedupe_uq').on(t.companyId, t.accountId, t.dedupeKey),
    unique('bank_statement_lines_gl_uq').on(t.companyId, t.journalLineId),
    index('bank_statement_lines_statement_idx').on(t.companyId, t.statementId, t.lineNo),
    index('bank_statement_lines_account_idx').on(t.companyId, t.accountId, t.txnDate),
    foreignKey({
      name: 'bank_statement_lines_statement_fk',
      columns: [t.statementId, t.companyId],
      foreignColumns: [bankStatements.id, bankStatements.companyId],
    }),
    foreignKey({
      name: 'bank_statement_lines_account_fk',
      columns: [t.accountId, t.companyId],
      foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId],
    }),
    foreignKey({
      name: 'bank_statement_lines_journal_line_fk',
      columns: [t.journalLineId, t.companyId],
      foreignColumns: [journalLines.id, journalLines.companyId],
    }),
    foreignKey({
      name: 'bank_statement_lines_transaction_fk',
      columns: [t.transactionId, t.companyId],
      foreignColumns: [treasuryTransactions.id, treasuryTransactions.companyId],
    }),
    check('bank_statement_lines_status_ck', sql`${t.status} in ('open','matched','ignored')`),
    check('bank_statement_lines_amount_ck', sql`${t.amount} <> 0`),
    check(
      'bank_statement_lines_match_ck',
      sql`(${t.status} = 'matched') = (${t.journalLineId} is not null and ${t.matchedAt} is not null)`,
    ),
  ],
);
