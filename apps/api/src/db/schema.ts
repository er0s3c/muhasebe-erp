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
import type { LegalProfileSnapshot, DocumentTaxRuleConfig, DocumentTaxRuleSnapshot, InvoiceTaxTotalsSnapshot, DocumentTaxCalculation,FinancialFxSnapshot,ApiKeyScope,PlatformWebhookEventType,PlatformWebhookPayload,PortalDocumentScopes } from '@erp/shared';

const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const money = () => numeric({ precision: 19, scale: 4 });
const rate = () => numeric({ precision: 19, scale: 8 });
const qty = () => numeric({ precision: 19, scale: 4 });
// Product expansion tables are declared below with the existing schema so future
// drizzle generations preserve the same migration history.
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

/**
 * Uygulama kullanıcısı için TOTP ikinci adım. Sır AES-256-GCM ile şifreli saklanır; `enabled_at` boşken kurulum
 * bekliyordur (giriş zorlanmaz). `last_counter` aynı kodun yeniden kullanımını önler; kurtarma kodları yalnızca özet olarak durur.
 */
export const userMfa = pgTable('user_mfa', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id),
  secretEnc: text().notNull(),
  enabledAt: timestamp({ withTimezone: true }),
  lastCounter: bigint({ mode: 'number' }),
  recoveryHashes: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
});

/**
 * Uzaktan güncelleme teklifleri ve uygulama geçmişi (kurulum geneli; kiracı tablosu değildir). Satıcının imzalı manifestosu kalp
 * atışıyla gelir; kurulum sahibi onaylayınca ana makinedeki güncelleyici isteği alır ve durumu buraya yazar.
 */
export const appUpdates = pgTable(
  'app_updates',
  {
    id: id(),
    version: text().notNull(),
    notes: text().notNull().default(''),
    manifest: text().notNull(),
    files: jsonb().$type<{ target: string; name: string; sha256: string; size: number }[]>().notNull(),
    downloadToken: text().notNull(),
    offeredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** offered | requested | downloading | applying | done | failed | rolled_back | cancelled */
    status: text().notNull().default('offered'),
    requestedBy: uuid().references(() => users.id),
    requestedAt: timestamp({ withTimezone: true }),
    scheduledFor: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    fromVersion: text(),
    message: text(),
    log: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('app_updates_version_uq').on(t.version),
    check('app_updates_status_ck', sql`${t.status} in ('offered','requested','downloading','applying','done','failed','rolled_back','cancelled')`),
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
    /**
     * Kurulumun sahibi kuruluş: lisans/güncelleme/cihaz yönetimi yalnızca bu kuruluşun şirket sahiplerine (cihazlarda yöneticilerine)
     * açıktır. İlk şirket kurulurken ya da lisans etkinleştirilirken sabitlenir; boşsa en eski şirketin kuruluşu geçerlidir.
     */
    ownerOrgId: uuid().references(() => organizations.id),
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
    index('refresh_tokens_family_idx').on(t.familyId),
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
    /** Null ülke eski kayıtların otomatik olarak KKTC kabul edilmesini önler. */
    jurisdiction: text().$type<'TR' | 'KKTC'>(),
    profileMode: text().$type<'legacy_manual' | 'country'>().notNull().default('legacy_manual'),
    profileVersionId: uuid(),
    timeZone: text().notNull().default('Europe/Nicosia'),
    fxProvider: text().$type<'tcmb' | 'kktcmb'>(),
    taxSetupStatus: text().$type<'legacy_manual' | 'needs_review' | 'ready'>().notNull().default('legacy_manual'),
    legalEntityType: text().$type<'sole_proprietor' | 'company' | 'nonprofit' | 'other'>(),
    vatRegistered: boolean(),
    activityCode: text(),
    /** Stokta olmayan malın çıkışına izin (perakende). Kapalıyken çıkış depo bakiyesini aşamaz. */
    allowNegativeStock: boolean().notNull().default(false),
    /** Resmî kur bülteni (fxProvider) her iş günü yayın saatinden sonra otomatik çekilir; varsayılan kapalı. */
    fxAutoImport: boolean().notNull().default(false),
    /** Otomatik çekimi açan kullanıcı: zamanlayıcı yalnız onun bağlamında ve `rates.manage` izni sürdükçe yazar. */
    fxAutoEnabledBy: uuid().references(() => users.id),
    /** Son otomatik deneme (başarılı/başarısız) ve sonucu: ayar ekranı ve pano bunu gösterir. */
    fxAutoLastAttemptAt: timestamp({ withTimezone: true }),
    fxAutoLastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('companies_org_idx').on(t.organizationId),
    check('companies_jurisdiction_ck', sql`${t.jurisdiction} is null or ${t.jurisdiction} in ('TR','KKTC')`),
    check('companies_profile_mode_ck', sql`${t.profileMode} in ('legacy_manual','country')`),
    check('companies_tax_setup_ck', sql`${t.taxSetupStatus} in ('legacy_manual','needs_review','ready')`),
    check('companies_fx_provider_ck', sql`${t.fxProvider} is null or ${t.fxProvider} in ('tcmb','kktcmb')`),
    check('companies_sector_ck', sql`${t.sector} in ('CONSTRUCTION','RETAIL_MARKET','COMMERCE','LEATHER_FASHION','MANUFACTURING_WHOLESALE')`),
  ],
);

/** Ülke/vergi bağlamı tarihli ve değişmez; geçmiş belge güncel şirket ayarından yeniden hesaplanmaz. */
export const companyProfileVersions = pgTable('company_profile_versions', {
  id: id(),
  companyId: uuid().notNull().references(() => companies.id),
  jurisdiction: text().$type<'TR' | 'KKTC'>().notNull(),
  effectiveFrom: date({ mode: 'string' }).notNull(),
  effectiveTo: date({ mode: 'string' }),
  timeZone: text().notNull(),
  fxProvider: text().$type<'tcmb' | 'kktcmb'>().notNull(),
  rulePackVersion: text().notNull(),
  engineVersion: text().notNull(),
  legalEntityType: text().$type<'sole_proprietor' | 'company' | 'nonprofit' | 'other'>().notNull(),
  vatRegistered: boolean().notNull(),
  activityCode: text(),
  sourceRefs: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdBy: uuid().notNull().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  unique('company_profile_versions_date_uq').on(t.companyId, t.effectiveFrom),
  unique('company_profile_versions_company_id_uq').on(t.companyId, t.id),
  check('company_profile_versions_country_ck', sql`${t.jurisdiction} in ('TR','KKTC')`),
  check('company_profile_versions_range_ck', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
]);

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
    branchScopeMode:text().$type<'all'|'restricted'>().notNull().default('all'),
    branchAllowUnassigned:boolean().notNull().default(true),
    customRoleId:uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('memberships_company_user_uq').on(t.companyId, t.userId),
    index('memberships_user_idx').on(t.userId),
    check('memberships_branch_scope_ck',sql`${t.branchScopeMode} in ('all','restricted')`),
    foreignKey({name:'memberships_custom_role_fk',columns:[t.customRoleId,t.companyId],foreignColumns:[companyRoles.id,companyRoles.companyId]}),
    check(
      'memberships_role_ck',
      sql`${t.role} in ('owner','admin','accountant','sales','site_manager','viewer','operations_manager','operator')`,
    ),
  ],
);

export const companyBranches=pgTable('company_branches',{
  id:id(),companyId:uuid().notNull().references(()=>companies.id),code:text().notNull(),name:text().notNull(),address:text(),isActive:boolean().notNull().default(true),createdBy:uuid().references(()=>users.id),createdAt:createdAt(),
},(t)=>[unique('company_branches_code_uq').on(t.companyId,t.code),unique('company_branches_id_company_uq').on(t.id,t.companyId)]);
export const memberBranchAccess=pgTable('member_branch_access',{
  companyId:uuid().notNull().references(()=>companies.id),userId:uuid().notNull(),branchId:uuid().notNull(),
},(t)=>[primaryKey({columns:[t.companyId,t.userId,t.branchId]}),foreignKey({name:'member_branch_access_membership_fk',columns:[t.companyId,t.userId],foreignColumns:[memberships.companyId,memberships.userId]}).onDelete('cascade'),foreignKey({name:'member_branch_access_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]})]);

export const companyRoles=pgTable('company_roles',{
  id:id(),companyId:uuid().notNull().references(()=>companies.id),name:text().notNull(),baseRole:text().notNull(),access:jsonb().$type<Record<string,unknown>>().notNull(),version:integer().notNull().default(1),isActive:boolean().notNull().default(true),createdBy:uuid().references(()=>users.id),createdAt:createdAt(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},(t)=>[unique('company_roles_name_uq').on(t.companyId,t.name),unique('company_roles_id_company_uq').on(t.id,t.companyId),check('company_roles_base_ck',sql`${t.baseRole} in ('accountant','sales','site_manager','viewer','operations_manager','operator')`)]);
export const exportEvents=pgTable('export_events',{
  id:id(),companyId:uuid().notNull().references(()=>companies.id),userId:uuid().notNull().references(()=>users.id),reportKey:text().notNull(),format:text().notNull(),rowCount:integer().notNull(),occurredAt:timestamp({withTimezone:true}).notNull().defaultNow(),requestId:text().notNull(),ip:text(),
},(t)=>[check('export_events_count_ck',sql`${t.rowCount}>=0`)]);

/**
 * Kullanıcı bazlı modül erişimi (üye + erişim alanı): satır yoksa rol varsayılanı geçerlidir. `module_key` bir erişim alanıdır
 * (kayıt modülü anahtarı; bkz. packages/shared module-access). Yalnızca sahip/yönetici yazar; üye yalnızca kendi satırlarını okur.
 */
export const memberModuleAccess = pgTable(
  'member_module_access',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    moduleKey: text().notNull(),
    level: text().notNull(),
    setBy: uuid()
      .notNull()
      .references(() => users.id),
    setAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    note: text(),
  },
  (t) => [
    unique('member_module_access_uq').on(t.companyId, t.userId, t.moduleKey),
    index('member_module_access_user_idx').on(t.companyId, t.userId),
    check('member_module_access_level_ck', sql`${t.level} in ('none','read','write')`),
    check('member_module_access_key_ck', sql`${t.moduleKey} ~ '^[a-z][a-z0-9_.]{2,59}$'`),
    check('member_module_access_note_ck', sql`${t.note} is null or length(${t.note}) <= 300`),
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
    provider: text().$type<'manual' | 'xml' | 'tcmb' | 'kktcmb'>().notNull().default('manual'),
    effectiveBuy: rate(),
    effectiveSell: rate(),
    sourceUrl: text(),
    fetchedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    createdBy: uuid().references(() => users.id),
  },
  (t) => [
    unique('exchange_rates_uq').on(t.companyId, t.rateDate, t.currencyCode, t.quoteCode),
    check('exchange_rates_positive_ck', sql`${t.buy} > 0 and ${t.sell} > 0`),
    check('exchange_rates_provider_ck', sql`${t.provider} in ('manual','xml','tcmb','kktcmb')`),
    check('exchange_rates_effective_positive_ck', sql`(${t.effectiveBuy} is null or ${t.effectiveBuy} > 0) and (${t.effectiveSell} is null or ${t.effectiveSell} > 0)`),
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
    jurisdiction: text().$type<'TR' | 'KKTC'>(),
    rulePackVersion: text(),
    sourceUrl: text(),
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

export const documentTaxRules=pgTable('document_tax_rules',{
  id:id(),companyId:uuid().notNull().references(()=>companies.id),code:text().notNull(),name:text().notNull(),jurisdiction:text().$type<'TR'|'KKTC'>().notNull(),validFrom:date({mode:'string'}).notNull(),validTo:date({mode:'string'}),version:text().notNull(),productClass:text().notNull(),transactionType:text().notNull(),partyTaxStatus:text().notNull(),invoiceType:text().notNull(),config:jsonb().$type<DocumentTaxRuleConfig>().notNull(),sourceRefs:jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),sourceNote:text().notNull(),verifiedAt:timestamp({withTimezone:true}),verifiedBy:text(),enabled:boolean().notNull().default(false),createdAt:createdAt(),
},(t)=>[unique('document_tax_rules_code_date_uq').on(t.companyId,t.code,t.validFrom),unique('document_tax_rules_id_company_uq').on(t.id,t.companyId),check('document_tax_rules_country_ck',sql`${t.jurisdiction} in ('TR','KKTC')`),check('document_tax_rules_range_ck',sql`${t.validTo} is null or ${t.validTo}>=${t.validFrom}`)]);

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
    taxStatus:text().$type<'unknown'|'consumer'|'business'|'vat_registered'|'withholding_agent'|'nonresident'>().notNull().default('unknown'),
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
    /** Cariye atanan varsayılan satış/alış fiyat listesi ve genel iskonto yüzdesi (X3; fiyat çözümleyicisi kullanır). */
    salesPriceListId: uuid(),
    purchasePriceListId: uuid(),
    salesDiscountPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    purchaseDiscountPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('parties_company_code_uq').on(t.companyId, t.code),
    unique('parties_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'parties_sales_list_fk', columns: [t.salesPriceListId, t.companyId], foreignColumns: [priceLists.id, priceLists.companyId] }),
    foreignKey({ name: 'parties_purchase_list_fk', columns: [t.purchasePriceListId, t.companyId], foreignColumns: [priceLists.id, priceLists.companyId] }),
    check('parties_discount_ck', sql`${t.salesDiscountPct} between 0 and 100 and ${t.purchaseDiscountPct} between 0 and 100`),
    index('parties_name_idx').on(t.companyId, t.name),
    check('parties_kind_ck', sql`${t.kind} in ('customer','supplier','both','employee')`),
    check('parties_tax_status_ck',sql`${t.taxStatus} in ('unknown','consumer','business','vat_registered','withholding_agent','nonresident')`),
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
    /** retention_pct | withholding_pct | advance_recoup_pct | vat_withholding_pct (KDV'nin tevkif edilen yüzdesi) */
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
    check('construction_params_kind_ck', sql`${t.kind} in ('retention_pct','withholding_pct','advance_recoup_pct','vat_withholding_pct')`),
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
    check('approval_rules_doc_type_ck', sql`${t.docType} in ('progress_payment','employer_claim','purchase_request','variation_order','invoice','sales_quote','payment','expense')`),
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
    branchId:uuid(),
    payloadHash:text(),
    documentSnapshot:jsonb().$type<Record<string,unknown>>(),
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
    foreignKey({name:'approval_requests_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
    // Bir belgenin aynı anda tek bekleyen talebi olur
    uniqueIndex('approval_requests_pending_uq')
      .on(t.companyId, t.docType, t.docId)
      .where(sql`${t.status} = 'pending'`),
    index('approval_requests_status_idx').on(t.companyId, t.status),
    check('approval_requests_status_ck', sql`${t.status} in ('pending','approved','rejected','cancelled')`),
  ],
);

export const financialApprovalDrafts=pgTable('financial_approval_drafts',{
  id:id(),companyId:uuid().notNull().references(()=>companies.id),docType:text().$type<'payment'|'expense'>().notNull(),branchId:uuid(),
  payload:jsonb().$type<Record<string,unknown>>().notNull(),payloadHash:text().notNull(),amount:money().notNull(),currency:text().notNull().references(()=>currencies.code),documentDate:date({mode:'string'}).notNull(),
  status:text().$type<'draft'|'submitted'|'rejected'|'posted'|'cancelled'>().notNull().default('draft'),createdBy:uuid().notNull().references(()=>users.id),createdAt:createdAt(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),postedDocId:uuid(),postedAt:timestamp({withTimezone:true}),
},t=>[
  unique('financial_approval_drafts_id_company_uq').on(t.id,t.companyId),
  foreignKey({name:'financial_approval_drafts_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
  check('financial_approval_drafts_type_ck',sql`${t.docType} in ('payment','expense')`),
  check('financial_approval_drafts_status_ck',sql`${t.status} in ('draft','submitted','rejected','posted','cancelled')`),
  check('financial_approval_drafts_amount_ck',sql`${t.amount}>0`),
  check('financial_approval_drafts_hash_ck',sql`${t.payloadHash}~'^[0-9a-f]{64}$'`),
]);

export const companyApiKeys=pgTable('company_api_keys',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),organizationId:uuid().notNull().references(()=>organizations.id),name:text().notNull(),keyHash:text().notNull(),lastFour:text().notNull(),scopes:jsonb().$type<ApiKeyScope[]>().notNull(),branchId:uuid(),createdBy:uuid().notNull().references(()=>users.id),expiresAt:timestamp({withTimezone:true}).notNull(),revokedAt:timestamp({withTimezone:true}),lastUsedAt:timestamp({withTimezone:true}),createdAt:createdAt(),
},t=>[unique('company_api_keys_hash_uq').on(t.keyHash),unique('company_api_keys_id_company_uq').on(t.id,t.companyId),foreignKey({name:'company_api_keys_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),check('company_api_keys_hash_ck',sql`${t.keyHash}~'^[0-9a-f]{64}$'`)]);

export const integrationWriteRequests=pgTable('integration_write_requests',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),apiKeyId:uuid().notNull(),requestId:uuid().notNull(),requestHash:text().notNull(),response:jsonb().$type<Record<string,unknown>>().notNull(),createdAt:createdAt(),
},t=>[unique('integration_write_requests_key_request_uq').on(t.apiKeyId,t.requestId),foreignKey({name:'integration_write_requests_key_fk',columns:[t.apiKeyId,t.companyId],foreignColumns:[companyApiKeys.id,companyApiKeys.companyId]})]);

export const webhookSubscriptions=pgTable('webhook_subscriptions',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),name:text().notNull(),url:text().notNull(),branchId:uuid(),eventTypes:jsonb().$type<PlatformWebhookEventType[]>().notNull(),secretEncrypted:text().notNull(),secretVersion:integer().notNull().default(1),enabled:boolean().notNull().default(true),revokedAt:timestamp({withTimezone:true}),createdBy:uuid().notNull().references(()=>users.id),createdAt:createdAt(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[unique('webhook_subscriptions_id_company_uq').on(t.id,t.companyId),foreignKey({name:'webhook_subscriptions_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]})]);

export const webhookEvents=pgTable('webhook_events',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),subscriptionId:uuid().notNull(),invoiceId:uuid().notNull(),eventType:text().$type<PlatformWebhookEventType>().notNull(),branchId:uuid(),payload:jsonb().$type<PlatformWebhookPayload>().notNull(),body:text().notNull(),status:text().$type<'pending'|'sending'|'delivered'|'dead_letter'|'cancelled'>().notNull().default('pending'),attempts:integer().notNull().default(0),nextAttemptAt:timestamp({withTimezone:true}).notNull().defaultNow(),leaseToken:uuid(),leaseUntil:timestamp({withTimezone:true}),deliveredAt:timestamp({withTimezone:true}),lastHttpStatus:integer(),lastError:text(),createdAt:createdAt(),
},t=>[unique('webhook_events_source_uq').on(t.subscriptionId,t.eventType,t.invoiceId),foreignKey({name:'webhook_events_subscription_fk',columns:[t.subscriptionId,t.companyId],foreignColumns:[webhookSubscriptions.id,webhookSubscriptions.companyId]}),foreignKey({name:'webhook_events_invoice_fk',columns:[t.invoiceId,t.companyId],foreignColumns:[invoices.id,invoices.companyId]}),foreignKey({name:'webhook_events_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),check('webhook_events_status_ck',sql`${t.status} in ('pending','sending','delivered','dead_letter','cancelled')`),check('webhook_events_attempts_ck',sql`${t.attempts}>=0`),index('webhook_events_due_idx').on(t.companyId,t.status,t.nextAttemptAt)]);

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
      sql`${t.kind} in ('material','labor','subcontract','equipment','transport','overhead','fee','other')`,
    ),
  ],
);

/** Taşeron sözleşmesi (başlık). Tutar ve kalemler onaylı revizyonun BOQ satırlarındadır. */
export const subcontracts = pgTable(
  'subcontracts',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    projectId: uuid().notNull(),
    /** Taşeron (tedarikçi ya da hem müşteri hem tedarikçi türünde cari). */
    partyId: uuid().notNull(),
    title: text().notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    startDate: date({ mode: 'string' }),
    endDate: date({ mode: 'string' }),
    /** Hakediş vadesi (gün); yaşlandırmada cari satırının vadesi. */
    paymentDays: integer().notNull().default(30),
    /** Yüzde anlık görüntüleri: sözleşme açılırken parametreden kopyalanır, sonradan parametre değişse bu değişmez. */
    retentionPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    advanceRecoupPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    withholdingPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    /** KDV'nin tevkif edilen yüzdesi (anlık görüntü; 0 = tevkifat yok). */
    vatWithholdingPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    penaltyNote: text(),
    /** payable: taşeron sözleşmesi (tedarikçi cari, 320); receivable: işveren sözleşmesi (müşteri cari, 120). */
    direction: text().notNull().default('payable'),
    /** draft | active | completed | terminated */
    status: text().notNull().default('draft'),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('subcontracts_company_code_uq').on(t.companyId, t.code),
    unique('subcontracts_id_company_uq').on(t.id, t.companyId),
    unique('subcontracts_id_project_uq').on(t.id, t.projectId),
    foreignKey({
      name: 'subcontracts_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'subcontracts_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    index('subcontracts_project_idx').on(t.companyId, t.projectId),
    index('subcontracts_party_idx').on(t.companyId, t.partyId),
    check('subcontracts_status_ck', sql`${t.status} in ('draft','active','completed','terminated')`),
    check('subcontracts_direction_ck', sql`${t.direction} in ('payable','receivable')`),
    // Projede en çok bir (feshedilmemiş) işveren sözleşmesi
    uniqueIndex('subcontracts_employer_uq')
      .on(t.projectId)
      .where(sql`${t.direction} = 'receivable' and ${t.status} <> 'terminated'`),
    check('subcontracts_dates_ck', sql`${t.startDate} is null or ${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
    check('subcontracts_days_ck', sql`${t.paymentDays} between 0 and 365`),
    check(
      'subcontracts_pct_ck',
      sql`${t.retentionPct} between 0 and 100 and ${t.advanceRecoupPct} between 0 and 100 and ${t.withholdingPct} between 0 and 100`,
    ),
  ],
);

/** Sözleşme revizyonu (bütçe revizyonu düzeni): taslak → onaylı → yerine geçilmiş; onaylı revizyon değişmez. */
export const subcontractRevisions = pgTable(
  'subcontract_revisions',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    subcontractId: uuid().notNull(),
    revisionNo: integer().notNull(),
    status: text().notNull().default('draft'),
    title: text(),
    approvedAt: timestamp({ withTimezone: true }),
    approvedBy: uuid().references(() => users.id),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('subcontract_revisions_no_uq').on(t.subcontractId, t.revisionNo),
    unique('subcontract_revisions_id_company_uq').on(t.id, t.companyId),
    uniqueIndex('subcontract_revisions_draft_uq')
      .on(t.subcontractId)
      .where(sql`${t.status} = 'draft'`),
    foreignKey({
      name: 'subcontract_revisions_subcontract_fk',
      columns: [t.subcontractId, t.companyId],
      foreignColumns: [subcontracts.id, subcontracts.companyId],
    }),
    check('subcontract_revisions_status_ck', sql`${t.status} in ('draft','approved','superseded')`),
    check(
      'subcontract_revisions_approved_ck',
      sql`(${t.status} = 'draft' and ${t.approvedAt} is null) or (${t.status} <> 'draft' and ${t.approvedAt} is not null)`,
    ),
  ],
);

/**
 * BOQ satırı. `lineKey` revizyonlar arasında sabittir (kopyalanınca korunur): hakediş kümülatif miktarı
 * `lineKey` ile takip edilir.
 */
export const subcontractBoqLines = pgTable(
  'subcontract_boq_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    revisionId: uuid().notNull(),
    subcontractId: uuid().notNull(),
    projectId: uuid().notNull(),
    lineKey: uuid().notNull(),
    lineNo: integer().notNull(),
    itemNo: text(),
    description: text().notNull(),
    unit: text().notNull(),
    quantity: qty().notNull(),
    unitPrice: numeric({ precision: 19, scale: 4 }).notNull(),
    /** Maliyetin yazılacağı yaprak iş kalemi. */
    wbsId: uuid().notNull(),
    costCodeId: uuid(),
  },
  (t) => [
    unique('subcontract_boq_lines_rev_key_uq').on(t.revisionId, t.lineKey),
    unique('subcontract_boq_lines_rev_no_uq').on(t.revisionId, t.lineNo),
    index('subcontract_boq_lines_sub_idx').on(t.subcontractId, t.lineKey),
    index('subcontract_boq_lines_wbs_idx').on(t.wbsId),
    foreignKey({
      name: 'subcontract_boq_lines_revision_fk',
      columns: [t.revisionId, t.companyId],
      foreignColumns: [subcontractRevisions.id, subcontractRevisions.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'subcontract_boq_lines_subcontract_fk',
      columns: [t.subcontractId, t.projectId],
      foreignColumns: [subcontracts.id, subcontracts.projectId],
    }),
    foreignKey({
      name: 'subcontract_boq_lines_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    foreignKey({
      name: 'subcontract_boq_lines_cost_code_fk',
      columns: [t.costCodeId, t.companyId],
      foreignColumns: [costCodes.id, costCodes.companyId],
    }),
    check('subcontract_boq_lines_amount_ck', sql`${t.quantity} > 0 and ${t.unitPrice} >= 0`),
  ],
);

/**
 * Değişiklik emri (DE): yürürlükteki sözleşmenin BOQ/süre değişikliği. Kendi taslak revizyonunu taşır; onay motorundan geçer,
 * işveren sözleşmesinde ayrıca işveren kabulü kaydedilir. Uygulanınca revizyon yürürlüğe girer ve bitiş tarihi uzar.
 */
export const variationOrders = pgTable(
  'variation_orders',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    subcontractId: uuid().notNull(),
    projectId: uuid().notNull(),
    direction: text().notNull(),
    /** DE'nin taslak/uygulanan revizyonu; iptal ya da işveren reddinde taslak silinir ve bağ boşalır. */
    revisionId: uuid().references(() => subcontractRevisions.id, { onDelete: 'set null' }),
    baseRevisionId: uuid().notNull(),
    code: text().notNull(),
    title: text().notNull(),
    /** client_request | design_change | site_condition | omission_error | other */
    reason: text().notNull(),
    description: text(),
    timeExtensionDays: integer().notNull().default(0),
    previousEndDate: date({ mode: 'string' }),
    newEndDate: date({ mode: 'string' }),
    amountBefore: money(),
    amountAfter: money(),
    amountDelta: money(),
    /** draft | submitted | awaiting_client | applied | rejected | cancelled */
    status: text().notNull().default('draft'),
    submittedAt: timestamp({ withTimezone: true }),
    submittedBy: uuid().references(() => users.id),
    approvedAt: timestamp({ withTimezone: true }),
    clientAcceptedAt: date({ mode: 'string' }),
    clientReference: text(),
    appliedAt: timestamp({ withTimezone: true }),
    rejectionNote: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('variation_orders_code_uq').on(t.companyId, t.code),
    unique('variation_orders_id_company_uq').on(t.id, t.companyId),
    uniqueIndex('variation_orders_revision_uq').on(t.revisionId),
    index('variation_orders_subcontract_idx').on(t.subcontractId, t.status),
    index('variation_orders_project_idx').on(t.companyId, t.projectId),
    foreignKey({
      name: 'variation_orders_subcontract_fk',
      columns: [t.subcontractId, t.projectId],
      foreignColumns: [subcontracts.id, subcontracts.projectId],
    }),
    foreignKey({
      name: 'variation_orders_base_revision_fk',
      columns: [t.baseRevisionId, t.companyId],
      foreignColumns: [subcontractRevisions.id, subcontractRevisions.companyId],
    }),
    check('variation_orders_status_ck', sql`${t.status} in ('draft','submitted','awaiting_client','applied','rejected','cancelled')`),
    check('variation_orders_reason_ck', sql`${t.reason} in ('client_request','design_change','site_condition','omission_error','other')`),
    check('variation_orders_direction_ck', sql`${t.direction} in ('payable','receivable')`),
    check('variation_orders_days_ck', sql`${t.timeExtensionDays} between 0 and 3650`),
  ],
);

// --- İnsan kaynakları ve kişisel veri (Faz D1) ----------------------------------------------------

/**
 * Personel kartı. Kimlik/pasaport no, doğum tarihi ve IBAN **uygulama düzeyinde şifreli** saklanır (AES-256-GCM); ekranda
 * maskelidir (son 4 hane). Açık okuma `hr.sensitive` izni + gerekçe ister ve `personal_data_access_log`'a yazılır.
 */
export const employees = pgTable(
  'employees',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** PRS-0001 (boşluksuz, şirket geneli). */
    branchId:uuid(),
    code: text().notNull(),
    fullName: text().notNull(),
    nationality: text(),
    /** national_id | passport */
    idKind: text(),
    idEnc: text(),
    /** Aynı kimliğin ikinci kez girilmesini yakalamak için HMAC özeti (şifresiz kimlik aranamaz). */
    idHash: text(),
    idLast4: text(),
    birthDateEnc: text(),
    ibanEnc: text(),
    ibanLast4: text(),
    phone: text(),
    email: text(),
    address: text(),
    hireDate: date({ mode: 'string' }),
    leaveDate: date({ mode: 'string' }),
    /** active | left */
    status: text().notNull().default('active'),
    department: text(),
    jobTitle: text(),
    projectId: uuid(),
    /** Personel cari/avans (X5): isteğe bağlı cari bağlantısı (kind = 'employee'); kart başına tek cari, bağlandıktan sonra değişmez. */
    partyId: uuid(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employees_company_code_uq').on(t.companyId, t.code),
    unique('employees_id_company_uq').on(t.id, t.companyId),
    foreignKey({name:'employees_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
    unique('employees_id_hash_uq').on(t.companyId, t.idHash),
    foreignKey({ name: 'employees_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'employees_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    index('employees_status_idx').on(t.companyId, t.status),
    uniqueIndex('employees_party_uq').on(t.companyId, t.partyId).where(sql`${t.partyId} is not null`),
    check('employees_status_ck', sql`${t.status} in ('active','left')`),
    check('employees_id_kind_ck', sql`${t.idKind} is null or ${t.idKind} in ('national_id','passport')`),
    check('employees_dates_ck', sql`${t.leaveDate} is null or ${t.hireDate} is null or ${t.leaveDate} >= ${t.hireDate}`),
    check('employees_id_complete_ck', sql`(${t.idEnc} is null) = (${t.idKind} is null) and (${t.idEnc} is null) = (${t.idHash} is null)`),
  ],
);

/** Kişisel veri işleme envanteri: hangi alan hangi amaçla ve hangi dayanakla tutulur (89/2007; hiçbiri doğrulanmamıştır). */
export const personalDataInventory = pgTable(
  'personal_data_inventory',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** employees.id_number gibi kararlı anahtar; başlangıç kayıtları kodla tohumlanır. */
    key: text().notNull(),
    tableName: text().notNull(),
    fieldName: text().notNull(),
    /** identity | contact | financial | employment | other */
    category: text().notNull(),
    purpose: text().notNull(),
    legalBasis: text().notNull(),
    retention: text(),
    isSensitive: boolean().notNull().default(false),
    transferAbroad: boolean().notNull().default(false),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    note: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('personal_data_inventory_key_uq').on(t.companyId, t.key),
    check('personal_data_inventory_category_ck', sql`${t.category} in ('identity','contact','financial','employment','other')`),
  ],
);

/** İlgili kişi talebi (erişim, dışa aktarma, düzeltme, silme). Silme yalnızca kayda alınır; yasal saklama nedeniyle otomatik silinmez. */
export const dataSubjectRequests = pgTable(
  'data_subject_requests',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid(),
    /** Rehber kişisi (X6): talep ya personele ya rehber kişisine yöneliktir, ikisine birden değil. */
    contactId: uuid(),
    requesterName: text().notNull(),
    /** access | export | correction | erasure */
    kind: text().notNull(),
    /** open | completed | rejected */
    status: text().notNull().default('open'),
    description: text(),
    resolutionNote: text(),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id),
    resolvedBy: uuid().references(() => users.id),
  },
  (t) => [
    foreignKey({ name: 'data_subject_requests_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'data_subject_requests_contact_fk', columns: [t.contactId, t.companyId], foreignColumns: [directoryContacts.id, directoryContacts.companyId] }),
    check('data_subject_requests_subject_ck', sql`${t.employeeId} is null or ${t.contactId} is null`),
    index('data_subject_requests_status_idx').on(t.companyId, t.status),
    check('data_subject_requests_kind_ck', sql`${t.kind} in ('access','export','correction','erasure')`),
    check('data_subject_requests_status_ck', sql`${t.status} in ('open','completed','rejected')`),
    check('data_subject_requests_resolved_ck', sql`(${t.status} = 'open') = (${t.resolvedAt} is null)`),
  ],
);

/** Hassas kişisel verinin açık okunması / dışa aktarılması: salt-eklenir denetim günlüğü. */
export const personalDataAccessLog = pgTable(
  'personal_data_access_log',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid(),
    /** Rehber kişisi (X6): kayıt ya personele ya rehber kişisine aittir. */
    contactId: uuid(),
    /** id_number | birth_date | iban | export | payroll (bordro/ücret görüntüleme) | social_security_no (açık okuma) | social_security (bildirim/profil görüntüleme) | employee_ledger (personel cari/avans görüntüleme) | directory_export | directory_anonymize (rehber kişisi) */
    field: text().notNull(),
    reason: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'personal_data_access_log_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'personal_data_access_log_contact_fk', columns: [t.contactId, t.companyId], foreignColumns: [directoryContacts.id, directoryContacts.companyId] }),
    check('personal_data_access_log_subject_ck', sql`(${t.employeeId} is null) <> (${t.contactId} is null)`),
    index('personal_data_access_log_emp_idx').on(t.companyId, t.employeeId, t.createdAt),
    check('personal_data_access_log_field_ck', sql`${t.field} in ('id_number','birth_date','iban','export','payroll','social_security_no','social_security','foreign_doc_no','foreign_docs','employee_ledger','directory_export','directory_anonymize')`),
    check('personal_data_access_log_reason_ck', sql`length(btrim(${t.reason})) >= 3`),
  ],
);

// --- Puantaj (Faz D2) --------------------------------------------------------------------------------

/**
 * Günlük puantaj: personel + tarih tekil. Gün türü bir sınıflandırmadır (yasal gün sayısı/çarpan yok; bordro D3'tedir).
 * Saat yalnızca çalışılan gün ile tatil/hafta tatilinde çalışmada vardır. İşçilik maliyeti etiketi (proje, yaprak iş kalemi,
 * maliyet kodu) isteğe bağlıdır ve yalnızca saatli günlerde olur. Kapalı ayda kayıt eklenemez/değişmez/silinemez (ERP13).
 */
export const attendanceEntries = pgTable(
  'attendance_entries',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid().notNull(),
    workDate: date({ mode: 'string' }).notNull(),
    /** worked | absent | annual_leave | sick_leave | unpaid_leave | public_holiday | weekly_rest */
    dayType: text().notNull(),
    normalHours: numeric({ precision: 5, scale: 2 }).notNull().default('0'),
    overtimeHours: numeric({ precision: 5, scale: 2 }).notNull().default('0'),
    projectId: uuid(),
    wbsId: uuid(),
    costCodeId: uuid(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('attendance_entries_emp_date_uq').on(t.employeeId, t.workDate),
    foreignKey({ name: 'attendance_entries_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'attendance_entries_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'attendance_entries_wbs_fk', columns: [t.wbsId, t.projectId], foreignColumns: [projectWbs.id, projectWbs.projectId] }),
    foreignKey({ name: 'attendance_entries_cost_code_fk', columns: [t.costCodeId, t.companyId], foreignColumns: [costCodes.id, costCodes.companyId] }),
    index('attendance_entries_date_idx').on(t.companyId, t.workDate),
    index('attendance_entries_wbs_idx').on(t.wbsId).where(sql`${t.wbsId} is not null`),
    index('attendance_entries_cost_code_idx').on(t.costCodeId).where(sql`${t.costCodeId} is not null`),
    index('attendance_entries_project_idx')
      .on(t.companyId, t.projectId, t.workDate)
      .where(sql`${t.projectId} is not null`),
    check('attendance_entries_type_ck', sql`${t.dayType} in ('worked','absent','annual_leave','sick_leave','unpaid_leave','public_holiday','weekly_rest')`),
    check('attendance_entries_hours_ck', sql`${t.normalHours} >= 0 and ${t.overtimeHours} >= 0 and ${t.normalHours} + ${t.overtimeHours} <= 24`),
    check(
      'attendance_entries_hours_type_ck',
      sql`(${t.dayType} in ('worked','public_holiday','weekly_rest') or (${t.normalHours} = 0 and ${t.overtimeHours} = 0)) and (${t.dayType} <> 'worked' or ${t.normalHours} + ${t.overtimeHours} > 0)`,
    ),
    check('attendance_entries_tag_ck', sql`${t.projectId} is null or ${t.normalHours} + ${t.overtimeHours} > 0`),
    check('attendance_entries_wbs_ck', sql`${t.wbsId} is null or ${t.projectId} is not null`),
    check('attendance_entries_cost_code_ck', sql`${t.costCodeId} is null or ${t.projectId} is not null`),
  ],
);

/**
 * Aylık puantaj kapanışı (şirket + ay). Satır "bu ay en az bir kez kapatıldı" demektir; geçerli durum `status`tur.
 * Kapalı ay açılırken gerekçe zorunludur; her değişiklik ayrıca denetim izine yazılır. Satır silinmez.
 */
export const attendanceMonths = pgTable(
  'attendance_months',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** YYYY-AA */
    month: text().notNull(),
    /** closed | open */
    status: text().notNull().default('closed'),
    closedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closedBy: uuid().references(() => users.id),
    closeNote: text(),
    reopenedAt: timestamp({ withTimezone: true }),
    reopenedBy: uuid().references(() => users.id),
    reopenReason: text(),
    /** Kaç kez yeniden açıldı (kapanış/açılış geçmişi denetim izindedir). */
    reopenCount: integer().notNull().default(0),
  },
  (t) => [
    unique('attendance_months_company_month_uq').on(t.companyId, t.month),
    check('attendance_months_status_ck', sql`${t.status} in ('closed','open')`),
    check('attendance_months_month_ck', sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

// --- Bordro (Faz D3) -----------------------------------------------------------------------------------

/**
 * Bordro parametreleri: tarihli, kaynak notlu, doğrulama alanlı, varsayılan KAPALI (construction_params deseni).
 * Kodda hiçbir yasal oran yoktur; satır `enabled` değilse hiçbir hesap yapılmaz. Değer/anahtar/tarih oluştuktan sonra değişmez
 * (yeni tarihli satır ekleyip öncekinin yerine geçirilir: `supersedes_id`). Anahtar başına en yeni (başlangıcı hesap tarihinden
 * önce olan) satır geçerlidir; o satır kapalıysa parametre kapalıdır.
 */
export const payrollParams = pgTable(
  'payroll_params',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    key: text().notNull(),
    value: numeric({ precision: 19, scale: 6 }).notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    enabled: boolean().notNull().default(false),
    sourceNote: text(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    supersedesId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payroll_params_uq').on(t.companyId, t.key, t.effectiveFrom),
    unique('payroll_params_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'payroll_params_supersedes_fk', columns: [t.supersedesId, t.companyId], foreignColumns: [t.id, t.companyId] }),
    check(
      'payroll_params_key_ck',
      sql`${t.key} in ('days_per_month','hours_per_day','overtime_multiplier','sick_leave_pay_pct','annual_leave_pay_pct','employee_social_pct','income_tax_pct','tax_base_deducts_social','social_base_cap','employer_social_pct','employer_other_pct','minimum_wage_monthly')`,
    ),
    check('payroll_params_value_ck', sql`${t.value} >= 0`),
  ],
);

/** Ülke bordro motorunun tarihli, kaynaklı yapılandırması. Eski bordrolara uygulanmaz. */
export const payrollCountryConfigs = pgTable('payroll_country_configs', {
  id: id(), companyId: uuid().notNull().references(() => companies.id),
  jurisdiction: text().$type<'TR' | 'KKTC'>().notNull(),
  effectiveFrom: date({ mode: 'string' }).notNull(),
  config: jsonb().$type<Record<string, unknown>>().notNull(),
  sourceNote: text().notNull(), verifiedAt: timestamp({ withTimezone: true }), verifiedBy: text(),
  enabled: boolean().notNull().default(false), createdAt: createdAt(), createdBy: uuid().references(() => users.id),
}, (t) => [
  unique('payroll_country_configs_date_uq').on(t.companyId, t.effectiveFrom),
  unique('payroll_country_configs_id_company_uq').on(t.id, t.companyId),
  check('payroll_country_configs_country_ck', sql`${t.jurisdiction} in ('TR','KKTC')`),
]);

export const employeePayrollTaxProfiles = pgTable('employee_payroll_tax_profiles', {
  id: id(), companyId: uuid().notNull().references(() => companies.id), employeeId: uuid().notNull(),
  effectiveFrom: date({ mode: 'string' }).notNull(), profile: jsonb().$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(), createdBy: uuid().references(() => users.id),
}, (t) => [
  unique('employee_payroll_tax_profiles_date_uq').on(t.employeeId, t.effectiveFrom),
  foreignKey({ name: 'employee_payroll_tax_profiles_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
]);

/** Personel ücret şartı: tarihli (aylık / günlük / saatlik). Ücret verisi hassastır (hr.payroll izni, okuma erişim günlüğüne yazılır). */
export const employeePayTerms = pgTable(
  'employee_pay_terms',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid().notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    /** monthly | daily | hourly */
    payBasis: text().notNull(),
    amount: money().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('employee_pay_terms_uq').on(t.employeeId, t.effectiveFrom),
    foreignKey({ name: 'employee_pay_terms_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    check('employee_pay_terms_basis_ck', sql`${t.payBasis} in ('monthly','daily','hourly')`),
    check('employee_pay_terms_amount_ck', sql`${t.amount} > 0`),
  ],
);

/** Ek ödeme / kesinti kalemi kataloğu. Vergiye/prime esas bayrakları kullanıcı verisidir (yasal varsayılan yok). */
export const payrollItems = pgTable(
  'payroll_items',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    /** earning | deduction */
    kind: text().notNull(),
    affectsSocialBase: boolean().notNull().default(false),
    affectsTaxBase: boolean().notNull().default(false),
    /** Null eski kalemin ülke motorunda ayrıca sınıflandırılmasını gerektirir. */
    affectsStampBase: boolean(),
    /** Kesintinin yevmiyede yazılacağı yükümlülük: tax | social | other (ek ödemede 'other', kullanılmaz). */
    liability: text().notNull().default('other'),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('payroll_items_code_uq').on(t.companyId, t.code),
    unique('payroll_items_id_company_uq').on(t.id, t.companyId),
    check('payroll_items_kind_ck', sql`${t.kind} in ('earning','deduction')`),
    check('payroll_items_liability_ck', sql`${t.liability} in ('tax','social','other')`),
  ],
);

/**
 * Aylık bordro: ay başına en çok bir (iptal edilmemiş) çalıştırma. Taslak → onaylı (yevmiye yazılır) → ödendi; onaylı iptal edilince
 * yevmiye ters çevrilir. Onaylı/ödenmiş çalıştırmanın satırları değişmez (ERP13). "Resmî bordro değildir": iç belgedir.
 */
export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    number: text().notNull(),
    month: text().notNull(),
    description: text(),
    /** draft | approved | paid | cancelled */
    status: text().notNull().default('draft'),
    jurisdiction: text().$type<'TR' | 'KKTC'>(),
    engineVersion: text().notNull().default('legacy-v1'),
    legalProfileSnapshot: jsonb().$type<LegalProfileSnapshot>(),
    countryConfigSnapshot: jsonb().$type<Record<string, unknown>>(),
    employeeCount: integer().notNull().default(0),
    grossTotal: money().notNull().default('0'),
    deductionsTotal: money().notNull().default('0'),
    netTotal: money().notNull().default('0'),
    employerTotal: money().notNull().default('0'),
    /** Hesapta kullanılan parametrelerin kopyası (anahtar, değer, doğrulandı mı, satır kimliği). */
    paramsSnapshot: jsonb().$type<{ key: string; value: string; verified: boolean; paramId: string }[]>().notNull().default(sql`'[]'::jsonb`),
    hasUnverifiedParams: boolean().notNull().default(false),
    calculatedAt: timestamp({ withTimezone: true }),
    entryId: uuid(),
    reversalEntryId: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    approvedBy: uuid().references(() => users.id),
    paidAt: date({ mode: 'string' }),
    paidNote: text(),
    paidMarkedBy: uuid().references(() => users.id),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payroll_runs_number_uq').on(t.companyId, t.number),
    unique('payroll_runs_id_company_uq').on(t.id, t.companyId),
    uniqueIndex('payroll_runs_month_uq')
      .on(t.companyId, t.month)
      .where(sql`${t.status} <> 'cancelled'`),
    foreignKey({ name: 'payroll_runs_entry_fk', columns: [t.entryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    foreignKey({ name: 'payroll_runs_reversal_fk', columns: [t.reversalEntryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    check('payroll_runs_status_ck', sql`${t.status} in ('draft','approved','paid','cancelled')`),
    check('payroll_runs_month_ck', sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('payroll_runs_totals_ck', sql`${t.grossTotal} >= 0 and ${t.deductionsTotal} >= 0 and ${t.employerTotal} >= 0 and ${t.netTotal} = ${t.grossTotal} - ${t.deductionsTotal}`),
    // Onaylı/ödenmiş/iptal: onay ve yevmiye vardır; iptalde ters kayıt da
    check(
      'payroll_runs_posted_ck',
      sql`(${t.status} = 'draft') = (${t.approvedAt} is null) and (${t.status} <> 'draft') = (${t.entryId} is not null) and (${t.status} = 'cancelled') = (${t.reversalEntryId} is not null)`,
    ),
    check('payroll_runs_paid_ck', sql`(${t.status} = 'paid') = (${t.paidAt} is not null)`),
  ],
);

/** Çalıştırmanın personel satırı: hesabın tüm ara değerleri kaydedilir (sonradan parametre değişse de belge değişmez). */
export const payrollLines = pgTable(
  'payroll_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    runId: uuid().notNull(),
    employeeId: uuid().notNull(),
    legalCalculationSnapshot: jsonb().$type<Record<string, unknown>>(),
    payBasis: text().notNull(),
    rate: money().notNull(),
    normalHours: numeric({ precision: 9, scale: 2 }).notNull().default('0'),
    overtimeHours: numeric({ precision: 9, scale: 2 }).notNull().default('0'),
    hourDays: integer().notNull().default(0),
    annualLeaveDays: integer().notNull().default(0),
    sickLeaveDays: integer().notNull().default(0),
    unpaidLeaveDays: integer().notNull().default(0),
    absentDays: integer().notNull().default(0),
    scheduledPay: money().notNull().default('0'),
    absenceDeduction: money().notNull().default('0'),
    basePay: money().notNull().default('0'),
    overtimePay: money().notNull().default('0'),
    earningsTotal: money().notNull().default('0'),
    gross: money().notNull().default('0'),
    socialBase: money().notNull().default('0'),
    taxBase: money().notNull().default('0'),
    employeeSocial: money().notNull().default('0'),
    incomeTax: money().notNull().default('0'),
    otherDeductions: money().notNull().default('0'),
    deductionsTotal: money().notNull().default('0'),
    net: money().notNull().default('0'),
    employerSocial: money().notNull().default('0'),
    employerOther: money().notNull().default('0'),
    employerTotal: money().notNull().default('0'),
    warnings: jsonb().$type<{ code: string; keys?: string[] }[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    unique('payroll_lines_run_emp_uq').on(t.runId, t.employeeId),
    unique('payroll_lines_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'payroll_lines_run_fk', columns: [t.runId, t.companyId], foreignColumns: [payrollRuns.id, payrollRuns.companyId] }),
    foreignKey({ name: 'payroll_lines_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    index('payroll_lines_emp_idx').on(t.companyId, t.employeeId),
    check('payroll_lines_basis_ck', sql`${t.payBasis} in ('monthly','daily','hourly')`),
    check(
      'payroll_lines_amounts_ck',
      sql`${t.scheduledPay} >= 0 and ${t.absenceDeduction} >= 0 and ${t.basePay} >= 0 and ${t.overtimePay} >= 0 and ${t.earningsTotal} >= 0 and ${t.employeeSocial} >= 0 and ${t.incomeTax} >= 0 and ${t.otherDeductions} >= 0 and ${t.employerSocial} >= 0 and ${t.employerOther} >= 0`,
    ),
    // Tutarlılık: her satırda aritmetik veritabanında doğrulanır
    check(
      'payroll_lines_math_ck',
      sql`${t.basePay} = ${t.scheduledPay} - ${t.absenceDeduction} and ${t.gross} = ${t.basePay} + ${t.overtimePay} + ${t.earningsTotal} and ${t.deductionsTotal} = ${t.employeeSocial} + ${t.incomeTax} + ${t.otherDeductions} and ${t.net} = ${t.gross} - ${t.deductionsTotal} and ${t.employerTotal} = ${t.employerSocial} + ${t.employerOther}`,
    ),
  ],
);

/** Satırın kalemleri: elle ek ödeme/kesinti ve parametreden gelen kesinti/işveren yükü (slip ve yevmiye için). */
export const payrollLineItems = pgTable(
  'payroll_line_items',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    lineId: uuid().notNull(),
    /** earning | deduction | employer */
    kind: text().notNull(),
    /** manual | param */
    source: text().notNull(),
    code: text().notNull(),
    label: text().notNull(),
    amount: money().notNull(),
    liability: text(),
    itemId: uuid(),
    paramKey: text(),
    rate: numeric({ precision: 19, scale: 6 }),
  },
  (t) => [
    foreignKey({ name: 'payroll_line_items_line_fk', columns: [t.lineId, t.companyId], foreignColumns: [payrollLines.id, payrollLines.companyId] }),
    foreignKey({ name: 'payroll_line_items_item_fk', columns: [t.itemId, t.companyId], foreignColumns: [payrollItems.id, payrollItems.companyId] }),
    index('payroll_line_items_line_idx').on(t.lineId),
    check('payroll_line_items_kind_ck', sql`${t.kind} in ('earning','deduction','employer')`),
    check('payroll_line_items_source_ck', sql`${t.source} in ('manual','param','country')`),
    check('payroll_line_items_country_ref_ck', sql`${t.source}<>'country' or (${t.itemId} is null and ${t.paramKey} is null)`),
    check('payroll_line_items_liability_ck', sql`${t.liability} is null or ${t.liability} in ('tax','social','other')`),
    check('payroll_line_items_amount_ck', sql`${t.amount} >= 0`),
  ],
);

/** Taslak bordroya elle girilen ek ödeme/kesinti (yeniden hesaplamada korunur). */
export const payrollAdjustments = pgTable(
  'payroll_adjustments',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    runId: uuid().notNull(),
    employeeId: uuid().notNull(),
    itemId: uuid().notNull(),
    amount: money().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('payroll_adjustments_uq').on(t.runId, t.employeeId, t.itemId),
    foreignKey({ name: 'payroll_adjustments_run_fk', columns: [t.runId, t.companyId], foreignColumns: [payrollRuns.id, payrollRuns.companyId] }),
    foreignKey({ name: 'payroll_adjustments_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'payroll_adjustments_item_fk', columns: [t.itemId, t.companyId], foreignColumns: [payrollItems.id, payrollItems.companyId] }),
    check('payroll_adjustments_amount_ck', sql`${t.amount} > 0`),
  ],
);

/** Satır maliyetinin puantaj saat etiketine (proje/iş kalemi/maliyet kodu) dağılımı; yevmiye satırlarının kaynağı. */
export const payrollLineAllocations = pgTable(
  'payroll_line_allocations',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    lineId: uuid().notNull(),
    projectId: uuid(),
    wbsId: uuid(),
    costCodeId: uuid(),
    hours: numeric({ precision: 9, scale: 2 }).notNull().default('0'),
    grossAmount: money().notNull().default('0'),
    employerAmount: money().notNull().default('0'),
  },
  (t) => [
    foreignKey({ name: 'payroll_allocations_line_fk', columns: [t.lineId, t.companyId], foreignColumns: [payrollLines.id, payrollLines.companyId] }),
    foreignKey({ name: 'payroll_allocations_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'payroll_allocations_wbs_fk', columns: [t.wbsId, t.projectId], foreignColumns: [projectWbs.id, projectWbs.projectId] }),
    foreignKey({ name: 'payroll_allocations_cost_code_fk', columns: [t.costCodeId, t.companyId], foreignColumns: [costCodes.id, costCodes.companyId] }),
    index('payroll_allocations_line_idx').on(t.lineId),
    index('payroll_allocations_project_idx').on(t.companyId, t.projectId).where(sql`${t.projectId} is not null`),
    check('payroll_allocations_tag_ck', sql`(${t.wbsId} is null or ${t.projectId} is not null) and (${t.costCodeId} is null or ${t.projectId} is not null)`),
    check('payroll_allocations_amount_ck', sql`${t.hours} >= 0 and ${t.grossAmount} >= 0 and ${t.employerAmount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Sosyal güvenlik çıktıları (Faz D4): tarihli profil, prim desteği kuralları, aylık bildirim. Yasal değer ve resmî biçim YOKTUR.
// ---------------------------------------------------------------------------

/** Tarihli sosyal güvenlik profili. Bordro tipi kodu serbest veridir; numara şifreli saklanır (D1 kimlik numarası gibi). */
export const employeeSocialProfiles = pgTable(
  'employee_social_profiles',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid().notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    payrollTypeCode: text(),
    insuranceStart: date({ mode: 'string' }),
    insuranceEnd: date({ mode: 'string' }),
    ssnEnc: text(),
    ssnLast4: text(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('employee_social_profiles_uq').on(t.employeeId, t.effectiveFrom),
    foreignKey({ name: 'employee_social_profiles_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    check('employee_social_profiles_dates_ck', sql`${t.insuranceEnd} is null or ${t.insuranceStart} is null or ${t.insuranceEnd} >= ${t.insuranceStart}`),
  ],
);

/** Prim desteği kuralı: tarihli, kaynak notlu, doğrulama alanlı, varsayılan KAPALI. Oran/koşul kullanıcı verisidir. */
export const socialSupportRules = pgTable(
  'social_support_rules',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    effectiveTo: date({ mode: 'string' }),
    /** employer | employee */
    target: text().notNull(),
    /** percent_of_premium | fixed_amount */
    mode: text().notNull(),
    value: numeric({ precision: 19, scale: 6 }).notNull(),
    enabled: boolean().notNull().default(false),
    sourceNote: text(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('social_support_rules_uq').on(t.companyId, t.code, t.effectiveFrom),
    unique('social_support_rules_id_company_uq').on(t.id, t.companyId),
    check('social_support_rules_target_ck', sql`${t.target} in ('employer','employee')`),
    check('social_support_rules_mode_ck', sql`${t.mode} in ('percent_of_premium','fixed_amount')`),
    check('social_support_rules_value_ck', sql`${t.value} >= 0 and (${t.mode} <> 'percent_of_premium' or ${t.value} <= 100)`),
    check('social_support_rules_dates_ck', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** Personelin bir destek kuralına (kod) tarihli uygunluğu: kullanıcı beyanıdır, sistem koşulu denetlemez. */
export const employeeSupportEligibility = pgTable(
  'employee_support_eligibility',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid().notNull(),
    ruleCode: text().notNull(),
    validFrom: date({ mode: 'string' }).notNull(),
    validTo: date({ mode: 'string' }),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('employee_support_eligibility_uq').on(t.employeeId, t.ruleCode, t.validFrom),
    foreignKey({ name: 'employee_support_eligibility_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    check('employee_support_eligibility_dates_ck', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

/** Aylık sosyal güvenlik bildirimi (GENEL düzen; resmî biçim değildir). Onaylı/ödenmiş bordrodan üretilir. */
export const socialDeclarations = pgTable(
  'social_declarations',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    number: text().notNull(),
    month: text().notNull(),
    /** draft | finalized */
    status: text().notNull().default('draft'),
    jurisdiction: text().$type<'TR' | 'KKTC'>(),
    legalProfileSnapshot: jsonb().$type<LegalProfileSnapshot>(),
    countryConfigSnapshot: jsonb().$type<Record<string, unknown>>(),
    payrollRunId: uuid().notNull(),
    payrollRunNumber: text().notNull(),
    employeeCount: integer().notNull().default(0),
    premiumBaseTotal: money().notNull().default('0'),
    employeePremiumTotal: money().notNull().default('0'),
    employerPremiumTotal: money().notNull().default('0'),
    supportEmployeeTotal: money().notNull().default('0'),
    supportEmployerTotal: money().notNull().default('0'),
    /** Uygulanan destek kurallarının kopyası (kod, kural kimliği, hedef, kip, değer, doğrulandı mı). */
    supportSnapshot: jsonb().$type<{ code: string; ruleId: string; name: string; target: string; mode: string; value: string; verified: boolean }[]>().notNull().default(sql`'[]'::jsonb`),
    hasUnverifiedParams: boolean().notNull().default(false),
    builtAt: timestamp({ withTimezone: true }),
    finalizedAt: timestamp({ withTimezone: true }),
    finalizedBy: uuid().references(() => users.id),
    finalizeNote: text(),
    reopenedAt: timestamp({ withTimezone: true }),
    reopenedBy: uuid().references(() => users.id),
    reopenReason: text(),
    reopenCount: integer().notNull().default(0),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('social_declarations_number_uq').on(t.companyId, t.number),
    unique('social_declarations_month_uq').on(t.companyId, t.month),
    unique('social_declarations_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'social_declarations_run_fk', columns: [t.payrollRunId, t.companyId], foreignColumns: [payrollRuns.id, payrollRuns.companyId] }),
    check('social_declarations_status_ck', sql`${t.status} in ('draft','finalized')`),
    check('social_declarations_month_ck', sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('social_declarations_totals_ck', sql`${t.premiumBaseTotal} >= 0 and ${t.employeePremiumTotal} >= 0 and ${t.employerPremiumTotal} >= 0 and ${t.supportEmployeeTotal} >= 0 and ${t.supportEmployerTotal} >= 0 and ${t.supportEmployeeTotal} <= ${t.employeePremiumTotal} and ${t.supportEmployerTotal} <= ${t.employerPremiumTotal}`),
    check('social_declarations_final_ck', sql`(${t.status} = 'finalized') = (${t.finalizedAt} is not null)`),
  ],
);

export const socialDeclarationLines = pgTable(
  'social_declaration_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    declarationId: uuid().notNull(),
    employeeId: uuid().notNull(),
    employeeProvident: money().notNull().default('0'),
    employerProvident: money().notNull().default('0'),
    employerLocalEmployment: money().notNull().default('0'),
    legalCalculationSnapshot: jsonb().$type<Record<string, unknown>>(),
    payrollLineId: uuid().notNull(),
    payrollTypeCode: text(),
    insuranceStart: date({ mode: 'string' }),
    insuranceEnd: date({ mode: 'string' }),
    /** Numaranın yalnızca son 4 hanesi (açık numara bildirim satırına kopyalanmaz). */
    ssnLast4: text(),
    daysWorked: integer().notNull().default(0),
    annualLeaveDays: integer().notNull().default(0),
    sickLeaveDays: integer().notNull().default(0),
    unpaidLeaveDays: integer().notNull().default(0),
    absentDays: integer().notNull().default(0),
    premiumBase: money().notNull().default('0'),
    employeePremium: money().notNull().default('0'),
    employerPremium: money().notNull().default('0'),
    supportEmployee: money().notNull().default('0'),
    supportEmployer: money().notNull().default('0'),
    /** Uygulanan destek kuralı kodları, virgülle. */
    supportCodes: text(),
    warnings: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    unique('social_declaration_lines_uq').on(t.declarationId, t.employeeId),
    foreignKey({ name: 'social_declaration_lines_declaration_fk', columns: [t.declarationId, t.companyId], foreignColumns: [socialDeclarations.id, socialDeclarations.companyId] }),
    foreignKey({ name: 'social_declaration_lines_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'social_declaration_lines_payroll_line_fk', columns: [t.payrollLineId, t.companyId], foreignColumns: [payrollLines.id, payrollLines.companyId] }),
    check('social_declaration_lines_amounts_ck', sql`${t.premiumBase} >= 0 and ${t.employeePremium} >= 0 and ${t.employerPremium} >= 0 and ${t.supportEmployee} >= 0 and ${t.supportEmployer} >= 0 and ${t.supportEmployee} <= ${t.employeePremium} and ${t.supportEmployer} <= ${t.employerPremium}`),
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
    branchId:uuid(),
    legalProfileSnapshot: jsonb().$type<LegalProfileSnapshot>(),
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
    foreignKey({name:'journal_entries_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
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
    index('journal_lines_cost_code_idx')
      .on(t.costCodeId)
      .where(sql`${t.costCodeId} is not null`),
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
    branchId:uuid(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('warehouses_company_code_uq').on(t.companyId, t.code),
    unique('warehouses_id_company_uq').on(t.id, t.companyId),
    foreignKey({name:'warehouses_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
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
    /** Üretimde stok hesap sınıfı; mevcut kartlar ticari mal olarak kalır. */
    inventoryRole: text().notNull().default('merchandise'),
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
    targetLevel:qty(),
    notes: text(),
    isActive: boolean().notNull().default(true),
    /** Seri no takibi (X3): giriş/çıkış satırlarında miktar kadar seri no girilir. Hareketi olan kartta değiştirilemez (tetikleyici). */
    tracksSerial: boolean().notNull().default(false),
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
    check('items_inventory_role_ck', sql`${t.inventoryRole} in ('raw_material','semi_finished','finished_goods','merchandise')`),
    check('items_serial_goods_ck', sql`not ${t.tracksSerial} or ${t.kind} = 'goods'`),
    check(
      'items_amounts_ck',
      sql`(${t.purchasePrice} is null or ${t.purchasePrice} >= 0) and (${t.salePrice} is null or ${t.salePrice} >= 0) and (${t.minLevel} is null or ${t.minLevel} >= 0)`,
    ),
    check('items_target_level_ck',sql`${t.targetLevel} is null or (${t.targetLevel}>=0 and (${t.minLevel} is null or ${t.targetLevel}>=${t.minLevel}))`),
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
    branchId:uuid(),
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
    foreignKey({name:'stock_documents_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
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
      sql`${t.key} in ('receivable','payable','sales_revenue','sales_return','cogs','stock','vat_output','vat_input','default_expense','stock_gain','stock_loss','consumption','opening_offset','fx_gain','fx_loss','subcontract_cost','retention_payable','withholding_payable','subcontract_advance','claim_revenue','retention_receivable','advance_received','withholding_receivable','deferred_revenue','property_revenue','termination_income','fee_payable','vat_withholding_payable','vat_withholding_receivable','payroll_labor_cost','payroll_employer_cost','payroll_payable','payroll_social_payable','payroll_tax_payable','payroll_other_payable','cheque_portfolio','note_portfolio','docs_in_collection','cheque_issued','note_payable','import_cost_clearing','employee_advance','year_end_profit','year_end_loss','year_end_retained_profit','year_end_retained_loss','raw_material_stock','semi_finished_stock','finished_goods_stock','production_wip','produced_cogs','goods_receipt_accrual')`,
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
    legalProfileSnapshot: jsonb().$type<LegalProfileSnapshot>(),
    branchId:uuid(),
    taxTotalsSnapshot:jsonb().$type<InvoiceTaxTotalsSnapshot>(),
    fxRateType:text().$type<'forex_buy'|'forex_sell'|'effective_buy'|'effective_sell'>(),
    fxReason:text(),
    fxSnapshot:jsonb().$type<FinancialFxSnapshot>(),
    documentMetadata:jsonb().$type<Record<string,unknown>>(),
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
    /** Üçlü eşleştirme tolerans dışıysa kaydı geçiren yetkilinin gerekçesi (boşsa eşleşme sorunsuzdu ya da siparişe bağlı değildi). */
    matchOverrideReason: text(),
    matchOverrideBy: uuid().references(() => users.id),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoices_id_company_uq').on(t.id, t.companyId),
    foreignKey({name:'invoices_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
    unique('invoices_no_uq').on(t.companyId, t.invoiceNo),
    // Aynı tedarikçiden aynı fatura numarası iki kez kaydedilemez. İptal edilen kayıt numarayı tutmaz:
    // düzeltme iptal + yeniden girişle yapıldığından aynı tedarikçi numarası tekrar girilebilmelidir.
    uniqueIndex('invoices_external_no_uq')
      .on(t.companyId, t.partyId, t.externalNo)
      .where(sql`${t.externalNo} is not null and ${t.status} = 'posted'`),
    index('invoices_date_idx').on(t.companyId, t.type, t.invoiceDate),
    index('invoices_party_idx').on(t.companyId, t.partyId),
    index('invoices_journal_idx').on(t.journalEntryId).where(sql`${t.journalEntryId} is not null`),
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
    /** sales | purchase | sales_return | purchase_return */
    type: text().notNull(),
    status: text().notNull().default('draft'),
    /** Kaydedilene kadar null; boşluksuz seri (SIR/AIR/SIRI/AIRI) kaydetme anında atanır. */
    noteNo: text(),
    /** İade irsaliyesinde bağlı orijinal irsaliye (isteğe bağlı). */
    returnOfId: uuid(),
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
      name: 'delivery_notes_return_of_fk',
      columns: [t.returnOfId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
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
    check('delivery_notes_type_ck', sql`${t.type} in ('sales','purchase','sales_return','purchase_return')`),
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
    /** İade irsaliyesinde, iade edilen orijinal irsaliye satırı (isteğe bağlı). */
    sourceLineId: uuid(),
    /** Satış irsaliyesinde, karşılanan satış siparişi satırı. */
    salesOrderLineId: uuid(),
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
      name: 'delivery_note_lines_source_fk',
      columns: [t.sourceLineId, t.companyId],
      foreignColumns: [t.id, t.companyId],
    }),
    foreignKey({
      name: 'delivery_note_lines_so_line_fk',
      columns: [t.salesOrderLineId, t.companyId],
      foreignColumns: [salesOrderLines.id, salesOrderLines.companyId],
    }),
    index('delivery_note_lines_source_idx')
      .on(t.sourceLineId)
      .where(sql`${t.sourceLineId} is not null`),
    index('delivery_note_lines_so_line_idx')
      .on(t.salesOrderLineId)
      .where(sql`${t.salesOrderLineId} is not null`),
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
    taxRuleId:uuid(),taxRuleSnapshot:jsonb().$type<DocumentTaxRuleSnapshot>(),taxCalculation:jsonb().$type<DocumentTaxCalculation>(),
    productClass:text(),transactionType:text(),taxTreatment:text(),
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
    /** Alış faturasında, faturalanan sipariş satırı (üçlü eşleştirme: sipariş – mal kabul – fatura). */
    poLineId: uuid(),
    /** Satış faturasında, faturalanan satış siparişi satırı (X2). */
    salesOrderLineId: uuid(),
    /** Toplu faturalamayla oluşan satırın toplu işlem kalemi (aynı irsaliye satırı iki toplu faturada yer alamaz). */
    batchItemId: uuid(),
  },
  (t) => [
    foreignKey({name:'invoice_lines_tax_rule_fk',columns:[t.taxRuleId,t.companyId],foreignColumns:[documentTaxRules.id,documentTaxRules.companyId]}),
    unique('invoice_lines_uq').on(t.invoiceId, t.lineNo),
    index('invoice_lines_po_line_idx').on(t.poLineId),
    foreignKey({
      name: 'invoice_lines_so_line_fk',
      columns: [t.salesOrderLineId, t.companyId],
      foreignColumns: [salesOrderLines.id, salesOrderLines.companyId],
    }),
    index('invoice_lines_so_line_idx')
      .on(t.salesOrderLineId)
      .where(sql`${t.salesOrderLineId} is not null`),
    foreignKey({
      name: 'invoice_lines_batch_item_fk',
      columns: [t.batchItemId, t.companyId],
      foreignColumns: [invoiceBatchItems.id, invoiceBatchItems.companyId],
    }),
    index('invoice_lines_batch_item_idx')
      .on(t.batchItemId)
      .where(sql`${t.batchItemId} is not null`),
    foreignKey({
      name: 'invoice_lines_po_line_fk',
      columns: [t.poLineId, t.companyId],
      foreignColumns: [purchaseOrderLines.id, purchaseOrderLines.companyId],
    }),
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
    branchId:uuid(),
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
    foreignKey({name:'treasury_transactions_branch_fk',columns:[t.branchId,t.companyId],foreignColumns:[companyBranches.id,companyBranches.companyId]}),
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

// ---------------------------------------------------------------------------
// Taşeron hakedişi (Faz B2c)
// ---------------------------------------------------------------------------

/**
 * Taşeron hakedişi (kümülatif). Sözleşmede aynı anda en çok bir açık (taslak/onayda) hakediş olur; böylece
 * kümülatif miktar zinciri sırayla ilerler. Onay tamamlanınca aynı işlemde yevmiye yazılır ve belge değişmez olur.
 * Tutarlar sözleşme para birimindedir; defter karşılığı yevmiyededir.
 */
export const progressPayments = pgTable(
  'progress_payments',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    subcontractId: uuid().notNull(),
    projectId: uuid().notNull(),
    /** Sözleşme içindeki sıra (1, 2, 3…). */
    paymentNo: integer().notNull(),
    /** Kaydedilince boşluksuz belge numarası (HKD-2026-000001); taslakta yok. */
    number: text(),
    periodEnd: date({ mode: 'string' }).notNull(),
    /** Sözleşmenin yönü (payable: verilen hakediş, receivable: işverene alınan hakediş). */
    direction: text().notNull().default('payable'),
    /** draft | submitted | posted | cancelled */
    status: text().notNull().default('draft'),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    fxRate: rate(),
    vatCode: text(),
    vatRate: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    /** Yüzde anlık görüntüleri (sözleşmeden). */
    retentionPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    advancePct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    withholdingPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    vatWithholdingPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    gross: money().notNull().default('0'),
    vat: money().notNull().default('0'),
    /** Tevkif edilen KDV (KDV'nin bir yüzdesi): taşeronda idareye ödenecek, işverende işverence tevkif edilen. */
    vatWithholding: money().notNull().default('0'),
    retention: money().notNull().default('0'),
    advance: money().notNull().default('0'),
    withholding: money().notNull().default('0'),
    /** Taşerona verilen malzemenin bedeli mahsubu (yalnızca taşeron hakedişi). */
    material: money().notNull().default('0'),
    otherDeductions: money().notNull().default('0'),
    net: money().notNull().default('0'),
    note: text(),
    rejectionNote: text(),
    entryId: uuid(),
    submittedAt: timestamp({ withTimezone: true }),
    postedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('progress_payments_no_uq').on(t.subcontractId, t.paymentNo),
    unique('progress_payments_id_company_uq').on(t.id, t.companyId),
    uniqueIndex('progress_payments_number_uq')
      .on(t.companyId, t.number)
      .where(sql`${t.number} is not null`),
    // Sözleşmede en çok bir açık hakediş
    uniqueIndex('progress_payments_open_uq')
      .on(t.subcontractId)
      .where(sql`${t.status} in ('draft','submitted')`),
    foreignKey({
      name: 'progress_payments_subcontract_fk',
      columns: [t.subcontractId, t.projectId],
      foreignColumns: [subcontracts.id, subcontracts.projectId],
    }),
    foreignKey({
      name: 'progress_payments_entry_fk',
      columns: [t.entryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    index('progress_payments_project_idx').on(t.companyId, t.projectId, t.status),
    check('progress_payments_status_ck', sql`${t.status} in ('draft','submitted','posted','cancelled')`),
    check('progress_payments_direction_ck', sql`${t.direction} in ('payable','receivable')`),
    check(
      'progress_payments_amounts_ck',
      sql`${t.gross} >= 0 and ${t.vat} >= 0 and ${t.vatWithholding} >= 0 and ${t.vatWithholding} <= ${t.vat} and ${t.retention} >= 0 and ${t.advance} >= 0 and ${t.withholding} >= 0 and ${t.material} >= 0 and ${t.otherDeductions} >= 0 and ${t.net} >= 0`,
    ),
    // Net = brüt + KDV − KDV tevkifatı − teminat − avans − stopaj − malzeme − diğer kesinti (her satırda doğrulanır)
    check(
      'progress_payments_net_ck',
      sql`${t.net} = ${t.gross} + ${t.vat} - ${t.vatWithholding} - ${t.retention} - ${t.advance} - ${t.withholding} - ${t.material} - ${t.otherDeductions}`,
    ),
    // Malzeme mahsubu yalnızca taşeron (verilen) hakedişinde
    check('progress_payments_material_ck', sql`${t.direction} = 'payable' or ${t.material} = 0`),
    check(
      'progress_payments_posted_ck',
      sql`(${t.status} in ('posted','cancelled')) = (${t.number} is not null and ${t.entryId} is not null and ${t.fxRate} is not null and ${t.postedAt} is not null)`,
    ),
  ],
);

export const progressPaymentLines = pgTable(
  'progress_payment_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    paymentId: uuid().notNull(),
    subcontractId: uuid().notNull(),
    projectId: uuid().notNull(),
    lineKey: uuid().notNull(),
    lineNo: integer().notNull(),
    itemNo: text(),
    description: text().notNull(),
    unit: text().notNull(),
    unitPrice: numeric({ precision: 19, scale: 4 }).notNull(),
    /** Önceki hakedişlerin kümülatifi, bu hakedişin kümülatifi ve farkı (bu dönem). */
    prevQty: qty().notNull(),
    cumQty: qty().notNull(),
    thisQty: qty().notNull(),
    amount: money().notNull(),
    wbsId: uuid().notNull(),
    costCodeId: uuid(),
  },
  (t) => [
    unique('progress_payment_lines_key_uq').on(t.paymentId, t.lineKey),
    index('progress_payment_lines_sub_idx').on(t.subcontractId, t.lineKey),
    index('progress_payment_lines_wbs_idx').on(t.wbsId),
    foreignKey({
      name: 'progress_payment_lines_payment_fk',
      columns: [t.paymentId, t.companyId],
      foreignColumns: [progressPayments.id, progressPayments.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'progress_payment_lines_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    foreignKey({
      name: 'progress_payment_lines_cost_code_fk',
      columns: [t.costCodeId, t.companyId],
      foreignColumns: [costCodes.id, costCodes.companyId],
    }),
    check('progress_payment_lines_qty_ck', sql`${t.prevQty} >= 0 and ${t.cumQty} >= ${t.prevQty} and ${t.thisQty} = ${t.cumQty} - ${t.prevQty}`),
  ],
);

/** Hakedişteki diğer kesintiler (ceza, malzeme mahsubu vb.). */
export const progressPaymentDeductions = pgTable(
  'progress_payment_deductions',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    paymentId: uuid().notNull(),
    description: text().notNull(),
    amount: money().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'progress_payment_deductions_payment_fk',
      columns: [t.paymentId, t.companyId],
      foreignColumns: [progressPayments.id, progressPayments.companyId],
    }).onDelete('cascade'),
    check('progress_payment_deductions_amount_ck', sql`${t.amount} > 0`),
  ],
);

/** Taşerona verilen avans (sözleşme bazında izlenir; hakedişte `advance` ile mahsup edilir). */
export const subcontractAdvances = pgTable(
  'subcontract_advances',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    subcontractId: uuid().notNull(),
    advanceDate: date({ mode: 'string' }).notNull(),
    /** Sözleşme para biriminde. */
    amount: money().notNull(),
    /** Ödemeyi yapan kasa/banka hareketi. */
    transactionId: uuid().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('subcontract_advances_txn_uq').on(t.transactionId),
    foreignKey({
      name: 'subcontract_advances_subcontract_fk',
      columns: [t.subcontractId, t.companyId],
      foreignColumns: [subcontracts.id, subcontracts.companyId],
    }),
    foreignKey({
      name: 'subcontract_advances_txn_fk',
      columns: [t.transactionId, t.companyId],
      foreignColumns: [treasuryTransactions.id, treasuryTransactions.companyId],
    }),
    check('subcontract_advances_amount_ck', sql`${t.amount} > 0`),
  ],
);

/**
 * Taşerona verilen malzeme: stoktan proje + iş kalemi etiketli sarf (stok belgesi) olarak çıkar; bedel stok çıkış maliyetidir.
 * Hakedişte `material` ile bakiye kadar mahsup edilir. Kayıt değişmez; bağlı stok belgesi ters çevrilemez.
 */
export const subcontractMaterialIssues = pgTable(
  'subcontract_material_issues',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    subcontractId: uuid().notNull(),
    issueDate: date({ mode: 'string' }).notNull(),
    stockDocumentId: uuid().notNull(),
    /** Mahsup bedeli, sözleşme para biriminde (stok çıkış maliyetinin verildiği günkü kurla çevrilmiş hâli). */
    amount: money().notNull(),
    /** Stok çıkış maliyeti, defter para biriminde. */
    amountBase: money().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('subcontract_material_issues_doc_uq').on(t.stockDocumentId),
    foreignKey({
      name: 'subcontract_material_issues_subcontract_fk',
      columns: [t.subcontractId, t.companyId],
      foreignColumns: [subcontracts.id, subcontracts.companyId],
    }),
    foreignKey({
      name: 'subcontract_material_issues_doc_fk',
      columns: [t.stockDocumentId, t.companyId],
      foreignColumns: [stockDocuments.id, stockDocuments.companyId],
    }),
    index('subcontract_material_issues_sc_idx').on(t.companyId, t.subcontractId),
    check('subcontract_material_issues_amount_ck', sql`${t.amount} > 0 and ${t.amountBase} > 0`),
  ],
);

/** Tutulan teminatın serbest bırakılması (teminat borcu → taşeron carisi). */
export const retentionReleases = pgTable(
  'retention_releases',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    subcontractId: uuid().notNull(),
    releaseDate: date({ mode: 'string' }).notNull(),
    /** Sözleşme para biriminde. */
    amount: money().notNull(),
    entryId: uuid().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('retention_releases_entry_uq').on(t.entryId),
    foreignKey({
      name: 'retention_releases_subcontract_fk',
      columns: [t.subcontractId, t.companyId],
      foreignColumns: [subcontracts.id, subcontracts.companyId],
    }),
    foreignKey({
      name: 'retention_releases_entry_fk',
      columns: [t.entryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    check('retention_releases_amount_ck', sql`${t.amount} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Satın alma zinciri (Faz B3-P): talep → RFQ/teklif → sipariş → mal kabul
// ---------------------------------------------------------------------------

/** Şantiyeden satın alma talebi. Onay motorundan (`purchase_request`) geçer. */
export const purchaseRequests = pgTable(
  'purchase_requests',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    projectId: uuid(),
    title: text().notNull(),
    needDate: date({ mode: 'string' }),
    note: text(),
    /** draft | submitted | approved | rejected | ordered | cancelled */
    status: text().notNull().default('draft'),
    rejectionNote: text(),
    requestedBy: uuid().references(() => users.id),
    submittedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('purchase_requests_code_uq').on(t.companyId, t.code),
    unique('purchase_requests_id_company_uq').on(t.id, t.companyId),
    unique('purchase_requests_id_project_uq').on(t.id, t.projectId),
    foreignKey({
      name: 'purchase_requests_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    index('purchase_requests_project_idx').on(t.companyId, t.projectId, t.status),
    check('purchase_requests_status_ck', sql`${t.status} in ('draft','submitted','approved','rejected','ordered','cancelled')`),
  ],
);

export const purchaseRequestLines = pgTable(
  'purchase_request_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    requestId: uuid().notNull(),
    projectId: uuid(),
    lineNo: integer().notNull(),
    itemId: uuid(),
    description: text().notNull(),
    unit: text().notNull(),
    quantity: qty().notNull(),
    /** Tahmini birim fiyat (defter para birimi); onay tutarı için. */
    estUnitPrice: numeric({ precision: 19, scale: 4 }),
    wbsId: uuid(),
  },
  (t) => [
    unique('purchase_request_lines_no_uq').on(t.requestId, t.lineNo),
    unique('purchase_request_lines_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'purchase_request_lines_request_fk',
      columns: [t.requestId, t.projectId],
      foreignColumns: [purchaseRequests.id, purchaseRequests.projectId],
    }).onDelete('cascade'),
    foreignKey({ name: 'purchase_request_lines_request_company_fk', columns: [t.requestId, t.companyId], foreignColumns: [purchaseRequests.id, purchaseRequests.companyId] }).onDelete('cascade'),
    foreignKey({
      name: 'purchase_request_lines_item_fk',
      columns: [t.itemId, t.companyId],
      foreignColumns: [items.id, items.companyId],
    }),
    foreignKey({
      name: 'purchase_request_lines_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    check('purchase_request_lines_qty_ck', sql`${t.quantity} > 0 and (${t.estUnitPrice} is null or ${t.estUnitPrice} >= 0)`),
    check('purchase_request_lines_project_ck', sql`${t.wbsId} is null or ${t.projectId} is not null`),
  ],
);

/** Teklif isteği (talebe bağlı). */
export const rfqs = pgTable(
  'rfqs',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    requestId: uuid().notNull(),
    /** open | awarded | cancelled */
    status: text().notNull().default('open'),
    dueDate: date({ mode: 'string' }),
    note: text(),
    awardedOfferId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('rfqs_code_uq').on(t.companyId, t.code),
    unique('rfqs_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'rfqs_request_fk',
      columns: [t.requestId, t.companyId],
      foreignColumns: [purchaseRequests.id, purchaseRequests.companyId],
    }),
    // Talep başına en çok bir açık/verilmiş RFQ
    uniqueIndex('rfqs_request_open_uq')
      .on(t.requestId)
      .where(sql`${t.status} <> 'cancelled'`),
    check('rfqs_status_ck', sql`${t.status} in ('open','awarded','cancelled')`),
  ],
);

export const rfqOffers = pgTable(
  'rfq_offers',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    rfqId: uuid().notNull(),
    partyId: uuid().notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    deliveryDays: integer(),
    paymentDays: integer().notNull().default(0),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('rfq_offers_party_uq').on(t.rfqId, t.partyId),
    unique('rfq_offers_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'rfq_offers_rfq_fk',
      columns: [t.rfqId, t.companyId],
      foreignColumns: [rfqs.id, rfqs.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'rfq_offers_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    check('rfq_offers_terms_ck', sql`${t.paymentDays} between 0 and 365 and (${t.deliveryDays} is null or ${t.deliveryDays} >= 0)`),
  ],
);

export const rfqOfferLines = pgTable(
  'rfq_offer_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    offerId: uuid().notNull(),
    requestLineId: uuid().notNull(),
    unitPrice: numeric({ precision: 19, scale: 4 }).notNull(),
  },
  (t) => [
    unique('rfq_offer_lines_uq').on(t.offerId, t.requestLineId),
    foreignKey({
      name: 'rfq_offer_lines_offer_fk',
      columns: [t.offerId, t.companyId],
      foreignColumns: [rfqOffers.id, rfqOffers.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'rfq_offer_lines_line_fk',
      columns: [t.requestLineId, t.companyId],
      foreignColumns: [purchaseRequestLines.id, purchaseRequestLines.companyId],
    }),
    check('rfq_offer_lines_price_ck', sql`${t.unitPrice} >= 0`),
  ],
);

/** Satın alma siparişi. Verilmiş (issued) sipariş taahhüt yaratır; kabul edilen miktar taahhütten düşer. */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    projectId: uuid(),
    partyId: uuid().notNull(),
    requestId: uuid(),
    offerId: uuid(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    vatCode: text(),
    vatRate: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    paymentDays: integer().notNull().default(30),
    deliveryLocation: text(),
    note: text(),
    /** draft | issued | closed | cancelled */
    status: text().notNull().default('draft'),
    issuedAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('purchase_orders_code_uq').on(t.companyId, t.code),
    unique('purchase_orders_id_company_uq').on(t.id, t.companyId),
    unique('purchase_orders_id_project_uq').on(t.id, t.projectId),
    foreignKey({
      name: 'purchase_orders_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'purchase_orders_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    foreignKey({
      name: 'purchase_orders_request_fk',
      columns: [t.requestId, t.companyId],
      foreignColumns: [purchaseRequests.id, purchaseRequests.companyId],
    }),
    foreignKey({
      name: 'purchase_orders_offer_fk',
      columns: [t.offerId, t.companyId],
      foreignColumns: [rfqOffers.id, rfqOffers.companyId],
    }),
    index('purchase_orders_project_idx').on(t.companyId, t.projectId, t.status),
    index('purchase_orders_party_idx').on(t.companyId, t.partyId),
    check('purchase_orders_status_ck', sql`${t.status} in ('draft','issued','closed','cancelled')`),
    check('purchase_orders_terms_ck', sql`${t.paymentDays} between 0 and 365 and ${t.vatRate} between 0 and 100`),
    check('purchase_orders_issued_ck', sql`(${t.status} in ('issued','closed')) = (${t.issuedAt} is not null) or ${t.status} = 'cancelled'`),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    orderId: uuid().notNull(),
    projectId: uuid(),
    lineNo: integer().notNull(),
    requestLineId: uuid(),
    itemId: uuid(),
    description: text().notNull(),
    unit: text().notNull(),
    quantity: qty().notNull(),
    unitPrice: numeric({ precision: 19, scale: 4 }).notNull(),
    wbsId: uuid(),
  },
  (t) => [
    unique('purchase_order_lines_no_uq').on(t.orderId, t.lineNo),
    unique('purchase_order_lines_id_company_uq').on(t.id, t.companyId),
    index('purchase_order_lines_wbs_idx').on(t.wbsId),
    foreignKey({
      name: 'purchase_order_lines_order_fk',
      columns: [t.orderId, t.projectId],
      foreignColumns: [purchaseOrders.id, purchaseOrders.projectId],
    }).onDelete('cascade'),
    foreignKey({ name: 'purchase_order_lines_order_company_fk', columns: [t.orderId, t.companyId], foreignColumns: [purchaseOrders.id, purchaseOrders.companyId] }).onDelete('cascade'),
    foreignKey({
      name: 'purchase_order_lines_item_fk',
      columns: [t.itemId, t.companyId],
      foreignColumns: [items.id, items.companyId],
    }),
    foreignKey({
      name: 'purchase_order_lines_wbs_fk',
      columns: [t.wbsId, t.projectId],
      foreignColumns: [projectWbs.id, projectWbs.projectId],
    }),
    foreignKey({
      name: 'purchase_order_lines_request_line_fk',
      columns: [t.requestLineId, t.companyId],
      foreignColumns: [purchaseRequestLines.id, purchaseRequestLines.companyId],
    }),
    check('purchase_order_lines_amount_ck', sql`${t.quantity} > 0 and ${t.unitPrice} >= 0`),
    check('purchase_order_lines_project_ck', sql`${t.wbsId} is null or ${t.projectId} is not null`),
  ],
);

/** Mal kabul (siparişe karşı teslim alınan miktar); stoklu satır varsa bir alış irsaliyesi de üretir. */
export const poReceipts = pgTable(
  'po_receipts',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    orderId: uuid().notNull(),
    receiptNo: text().notNull(),
    receiptDate: date({ mode: 'string' }).notNull(),
    deliveryNoteId: uuid(),
    note: text(),
    /** posted | cancelled */
    status: text().notNull().default('posted'),
    cancelReason: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('po_receipts_no_uq').on(t.companyId, t.receiptNo),
    unique('po_receipts_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'po_receipts_order_fk',
      columns: [t.orderId, t.companyId],
      foreignColumns: [purchaseOrders.id, purchaseOrders.companyId],
    }),
    foreignKey({
      name: 'po_receipts_note_fk',
      columns: [t.deliveryNoteId, t.companyId],
      foreignColumns: [deliveryNotes.id, deliveryNotes.companyId],
    }),
    index('po_receipts_order_idx').on(t.orderId),
    check('po_receipts_status_ck', sql`${t.status} in ('posted','cancelled')`),
  ],
);

export const poReceiptLines = pgTable(
  'po_receipt_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    receiptId: uuid().notNull(),
    orderLineId: uuid().notNull(),
    quantity: qty().notNull(),
  },
  (t) => [
    unique('po_receipt_lines_uq').on(t.receiptId, t.orderLineId),
    index('po_receipt_lines_line_idx').on(t.orderLineId),
    foreignKey({
      name: 'po_receipt_lines_receipt_fk',
      columns: [t.receiptId, t.companyId],
      foreignColumns: [poReceipts.id, poReceipts.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'po_receipt_lines_line_fk',
      columns: [t.orderLineId, t.companyId],
      foreignColumns: [purchaseOrderLines.id, purchaseOrderLines.companyId],
    }),
    check('po_receipt_lines_qty_ck', sql`${t.quantity} > 0`),
  ],
);

/** Üçlü eşleştirme toleransları (şirket politikası; yasal parametre değildir). Satır yoksa varsayılanlar geçerlidir (miktar %0, fiyat %2). */
export const procurementSettings = pgTable(
  'procurement_settings',
  {
    companyId: uuid()
      .primaryKey()
      .references(() => companies.id),
    qtyTolerancePct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    priceTolerancePct: numeric({ precision: 7, scale: 4 }).notNull().default('2'),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('procurement_settings_ck', sql`${t.qtyTolerancePct} between 0 and 100 and ${t.priceTolerancePct} between 0 and 100`)],
);

// ---------------------------------------------------------------------------
// Gayrimenkul satışı (Faz B3): bağımsız bölüm envanteri, satış sözleşmesi, taksit planı, fesih
// ---------------------------------------------------------------------------

/** Kendi projesindeki satılabilir bağımsız bölüm. Durum yalnızca sözleşme akışıyla değişir (tetikleyici denetler). */
export const realEstateUnits = pgTable(
  'real_estate_units',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    projectId: uuid().notNull(),
    /** Blok/etap; yoksa boş metin (tekillik anahtarında yer alır). */
    block: text().notNull().default(''),
    floor: integer(),
    unitNo: text().notNull(),
    /** apartment | villa | shop | office | land | parking | storage | other */
    unitType: text().notNull().default('apartment'),
    grossM2: numeric({ precision: 12, scale: 2 }),
    netM2: numeric({ precision: 12, scale: 2 }),
    /** Oda düzeni, örn. "2+1". */
    rooms: text(),
    listPrice: money(),
    listCurrency: text().references(() => currencies.code),
    /** available | reserved | sold | handed_over */
    status: text().notNull().default('available'),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('real_estate_units_no_uq').on(t.companyId, t.projectId, t.block, t.unitNo),
    unique('real_estate_units_id_company_uq').on(t.id, t.companyId),
    unique('real_estate_units_id_project_uq').on(t.id, t.projectId),
    foreignKey({
      name: 'real_estate_units_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    index('real_estate_units_project_idx').on(t.companyId, t.projectId, t.status),
    check('real_estate_units_type_ck', sql`${t.unitType} in ('apartment','villa','shop','office','land','parking','storage','other')`),
    check('real_estate_units_status_ck', sql`${t.status} in ('available','reserved','sold','handed_over')`),
    check('real_estate_units_price_ck', sql`(${t.listPrice} is null or (${t.listPrice} >= 0 and ${t.listCurrency} is not null))`),
    check('real_estate_units_area_ck', sql`(${t.grossM2} is null or ${t.grossM2} > 0) and (${t.netM2} is null or ${t.netM2} > 0)`),
  ],
);

/**
 * Satış sözleşmesi: bir birim, bir alıcı, dövizli bedel ve taksit planı. Etkinleşince taksit başına alıcı carisine
 * vadeli 120 satırı ve ertelenmiş gelir (380) yazılır; teslimde gelire (600) aktarılır.
 */
export const salesContracts = pgTable(
  'sales_contracts',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    unitId: uuid().notNull(),
    projectId: uuid().notNull(),
    partyId: uuid().notNull(),
    contractDate: date({ mode: 'string' }).notNull(),
    plannedHandover: date({ mode: 'string' }),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    price: money().notNull(),
    downPayment: money().notNull().default('0'),
    /** Gelir tanıma yöntemi (veri olarak saklanır): on_handover. */
    recognition: text().notNull().default('on_handover'),
    /** draft | active | handed_over | terminated | cancelled */
    status: text().notNull().default('draft'),
    /** Etkinleşme tarihi ve kuru (sözleşme para biriminden defter para birimine). */
    activatedOn: date({ mode: 'string' }),
    activationFx: rate(),
    activationEntryId: uuid(),
    handedOverOn: date({ mode: 'string' }),
    handoverEntryId: uuid(),
    terminatedOn: date({ mode: 'string' }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    penaltyNote: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sales_contracts_code_uq').on(t.companyId, t.code),
    unique('sales_contracts_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'sales_contracts_unit_fk',
      columns: [t.unitId, t.projectId],
      foreignColumns: [realEstateUnits.id, realEstateUnits.projectId],
    }),
    foreignKey({
      name: 'sales_contracts_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'sales_contracts_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    foreignKey({
      name: 'sales_contracts_activation_fk',
      columns: [t.activationEntryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    foreignKey({
      name: 'sales_contracts_handover_fk',
      columns: [t.handoverEntryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    // Birim başına tek canlı sözleşme (taslak, etkin ya da teslim edilmiş)
    uniqueIndex('sales_contracts_unit_live_uq')
      .on(t.unitId)
      .where(sql`${t.status} in ('draft','active','handed_over')`),
    index('sales_contracts_project_idx').on(t.companyId, t.projectId, t.status),
    index('sales_contracts_party_idx').on(t.companyId, t.partyId),
    check('sales_contracts_status_ck', sql`${t.status} in ('draft','active','handed_over','terminated','cancelled')`),
    check('sales_contracts_recognition_ck', sql`${t.recognition} in ('on_handover')`),
    check('sales_contracts_amount_ck', sql`${t.price} > 0 and ${t.downPayment} >= 0 and ${t.downPayment} <= ${t.price}`),
    check(
      'sales_contracts_active_ck',
      sql`${t.status} in ('draft','cancelled') or (${t.activatedOn} is not null and ${t.activationEntryId} is not null and ${t.activationFx} is not null)`,
    ),
    check('sales_contracts_handover_ck', sql`(${t.status} = 'handed_over') = (${t.handoverEntryId} is not null)`),
  ],
);

/** Taksit planı satırı. Taslakta serbestçe düzenlenir; etkinleşince değişmez ve `journal_line_id` açık kalemi gösterir. */
export const salesInstallments = pgTable(
  'sales_installments',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    contractId: uuid().notNull(),
    seq: integer().notNull(),
    /** down_payment | installment | balloon */
    kind: text().notNull().default('installment'),
    dueDate: date({ mode: 'string' }).notNull(),
    /** Sözleşme para biriminde. */
    amount: money().notNull(),
    journalLineId: uuid(),
    /** Alıcıdan tahsil edilen fon/harç satırı (kind = 'fee'): kaynak tarife ve etiket. Bedele sayılmaz; 329 yükümlülüğüne yazılır. */
    feeScheduleId: uuid(),
    label: text(),
  },
  (t) => [
    unique('sales_installments_seq_uq').on(t.contractId, t.seq),
    unique('sales_installments_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'sales_installments_contract_fk',
      columns: [t.contractId, t.companyId],
      foreignColumns: [salesContracts.id, salesContracts.companyId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sales_installments_line_fk',
      columns: [t.journalLineId, t.companyId],
      foreignColumns: [journalLines.id, journalLines.companyId],
    }),
    index('sales_installments_due_idx').on(t.companyId, t.dueDate),
    foreignKey({
      name: 'sales_installments_fee_fk',
      columns: [t.feeScheduleId, t.companyId],
      foreignColumns: [feeSchedules.id, feeSchedules.companyId],
    }),
    check('sales_installments_kind_ck', sql`${t.kind} in ('down_payment','installment','balloon','fee')`),
    check('sales_installments_fee_ck', sql`(${t.kind} = 'fee') or (${t.feeScheduleId} is null and ${t.label} is null)`),
    check('sales_installments_amount_ck', sql`${t.amount} > 0 and ${t.seq} >= 1`),
  ],
);

/** Teslim öncesi fesih: tahsil edilen tutardan kesinti ve iade; ödenmemiş taksitler kapatılır. Değişmez. */
export const salesTerminations = pgTable(
  'sales_terminations',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    contractId: uuid().notNull(),
    terminationDate: date({ mode: 'string' }).notNull(),
    reason: text().notNull(),
    /** Sözleşme para biriminde. */
    collected: money().notNull(),
    retained: money().notNull(),
    refund: money().notNull(),
    entryId: uuid().notNull(),
    /** İadenin ödendiği kasa/banka hesabı (iade varsa). */
    refundAccountId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sales_terminations_contract_uq').on(t.contractId),
    foreignKey({
      name: 'sales_terminations_contract_fk',
      columns: [t.contractId, t.companyId],
      foreignColumns: [salesContracts.id, salesContracts.companyId],
    }),
    foreignKey({
      name: 'sales_terminations_entry_fk',
      columns: [t.entryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    foreignKey({
      name: 'sales_terminations_account_fk',
      columns: [t.refundAccountId, t.companyId],
      foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId],
    }),
    check('sales_terminations_amount_ck', sql`${t.collected} >= 0 and ${t.retained} >= 0 and ${t.refund} >= 0 and ${t.retained} + ${t.refund} = ${t.collected}`),
    check('sales_terminations_refund_ck', sql`${t.refund} = 0 or ${t.refundAccountId} is not null`),
  ],
);

/**
 * Kasasız açık kalem kapatma: fesihte ödenmemiş taksit kalemi, fesih yevmiyesinin cari alacak satırıyla kalem bazında
 * kapatılır (`party_allocations`'ın kasa/banka hareketsiz karşılığı). Cari açık kalem hesabı bunları okur; FIFO havuzuna girmez.
 */
export const salesWriteoffs = pgTable(
  'sales_writeoffs',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    contractId: uuid().notNull(),
    partyId: uuid().notNull(),
    /** Kapatılan taksit satırı ve kapatan (fesih yevmiyesi) cari satırı. */
    chargeLineId: uuid().notNull(),
    settleLineId: uuid().notNull(),
    entryId: uuid().notNull(),
    /**
     * Kalemin para biriminde ve defter tutarında kapatılan pay. Yalnızca kur/yuvarlama artığı kalmış kalemde (kalan 0,00,
     * defter tutarı > 0) `amount` 0'dır: artık defter para birimindeki bir cari satırıyla kapatılır.
     */
    amount: money().notNull(),
    amountBase: money().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sales_writeoffs_settle_uq').on(t.settleLineId),
    index('sales_writeoffs_charge_idx').on(t.chargeLineId),
    index('sales_writeoffs_party_idx').on(t.companyId, t.partyId),
    foreignKey({
      name: 'sales_writeoffs_contract_fk',
      columns: [t.contractId, t.companyId],
      foreignColumns: [salesContracts.id, salesContracts.companyId],
    }),
    foreignKey({
      name: 'sales_writeoffs_party_fk',
      columns: [t.partyId, t.companyId],
      foreignColumns: [parties.id, parties.companyId],
    }),
    foreignKey({
      name: 'sales_writeoffs_charge_fk',
      columns: [t.chargeLineId, t.companyId],
      foreignColumns: [journalLines.id, journalLines.companyId],
    }),
    foreignKey({
      name: 'sales_writeoffs_settle_fk',
      columns: [t.settleLineId, t.companyId],
      foreignColumns: [journalLines.id, journalLines.companyId],
    }),
    foreignKey({
      name: 'sales_writeoffs_entry_fk',
      columns: [t.entryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
    }),
    check('sales_writeoffs_amount_ck', sql`${t.amount} >= 0 and ${t.amountBase} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Nakit projeksiyonu (Faz B4): elle girilen ek kalemler (kira, maaş, vergi vb.)
// ---------------------------------------------------------------------------

export const cashForecastItems = pgTable(
  'cash_forecast_items',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    itemDate: date({ mode: 'string' }).notNull(),
    /** in | out */
    direction: text().notNull(),
    description: text().notNull(),
    amount: money().notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    projectId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('cash_forecast_items_id_company_uq').on(t.id, t.companyId),
    foreignKey({
      name: 'cash_forecast_items_project_fk',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    index('cash_forecast_items_date_idx').on(t.companyId, t.itemDate),
    check('cash_forecast_items_direction_ck', sql`${t.direction} in ('in','out')`),
    check('cash_forecast_items_amount_ck', sql`${t.amount} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// Altyapı fonları ve harçlar (Faz B4): tarihli, kaynak notlu, doğrulama alanlı tarifeler
// ---------------------------------------------------------------------------

/**
 * Altyapı fonu/harç tarifesi (elektrik, su, kanalizasyon, belediye, tapu vb.). Oranlar/tutarlar kodda sabit değildir:
 * tarihli kayıt, kaynak notu ve "doğrulandı" işareti taşır (tax_rates deseni). `side`: buyer = alıcıdan tahsil edilen fon
 * (satış sözleşmesine eklenir), project = projenin ödediği maliyet (tahmin ve bütçe karşılaştırması).
 * `basis`: per_unit (birim başına), per_m2 (brüt m² başına), pct_of_price (sözleşme bedeli yüzdesi), fixed (sabit).
 */
export const feeSchedules = pgTable(
  'fee_schedules',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    side: text().notNull(),
    basis: text().notNull(),
    /** Tutar (para biriminde) ya da yüzde (pct_of_price). */
    amount: numeric({ precision: 19, scale: 4 }).notNull(),
    currencyCode: text().references(() => currencies.code),
    validFrom: date({ mode: 'string' }).notNull(),
    validTo: date({ mode: 'string' }),
    sourceNote: text(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('fee_schedules_uq').on(t.companyId, t.code, t.validFrom),
    unique('fee_schedules_id_company_uq').on(t.id, t.companyId),
    check('fee_schedules_side_ck', sql`${t.side} in ('buyer','project')`),
    check('fee_schedules_basis_ck', sql`${t.basis} in ('per_unit','per_m2','pct_of_price','fixed')`),
    check('fee_schedules_amount_ck', sql`${t.amount} >= 0 and (${t.basis} <> 'pct_of_price' or ${t.amount} <= 100)`),
    check('fee_schedules_currency_ck', sql`(${t.basis} = 'pct_of_price') or ${t.currencyCode} is not null`),
    check('fee_schedules_range_ck', sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

// ---------------------------------------------------------------------------
// Yabancı işçi belge ve teminat takibi (Faz D5). Yasal süre/ücret/tutar/makam kodda ve tohumda YOKTUR: belge türleri kullanıcı
// kataloğudur, uyarı günü ve teminat tutarı tarihli, doğrulama alanlı, varsayılan KAPALI kullanıcı parametresidir.
// ---------------------------------------------------------------------------

/** Belge türü kataloğu (kullanıcı yönetir). Yalnızca genel adlar tohumlanır; geçerlilik süresi/ücret/makam yoktur. Silinmez, pasifleştirilir. */
export const foreignDocTypes = pgTable(
  'foreign_doc_types',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique('foreign_doc_types_uq').on(t.companyId, t.code), unique('foreign_doc_types_id_company_uq').on(t.id, t.companyId)],
);

/** Personelin yabancı işçi belgesi. Numara şifreli + maskeli (D1 kimlik numarası gibi). Tarih/numara yalnızca yenileme ile değişir. */
export const foreignWorkerDocs = pgTable(
  'foreign_worker_docs',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid().notNull(),
    typeId: uuid().notNull(),
    numberEnc: text(),
    numberLast4: text(),
    issuingAuthority: text(),
    issueDate: date({ mode: 'string' }),
    expiryDate: date({ mode: 'string' }),
    /** Dosya yükleme olanağı yoktur: ek belgeye metin atfı (dosya adı/klasör/arşiv no). */
    referenceNote: text(),
    note: text(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedBy: uuid().references(() => users.id),
    revokeReason: text(),
    renewalCount: integer().notNull().default(0),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('foreign_worker_docs_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'foreign_worker_docs_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'foreign_worker_docs_type_fk', columns: [t.typeId, t.companyId], foreignColumns: [foreignDocTypes.id, foreignDocTypes.companyId] }),
    index('foreign_worker_docs_emp_idx').on(t.companyId, t.employeeId),
    index('foreign_worker_docs_expiry_idx').on(t.companyId, t.expiryDate),
    check('foreign_worker_docs_dates_ck', sql`${t.expiryDate} is null or ${t.issueDate} is null or ${t.expiryDate} >= ${t.issueDate}`),
    check('foreign_worker_docs_revoke_ck', sql`(${t.revokedAt} is null) = (${t.revokeReason} is null) and (${t.revokedAt} is null) = (${t.revokedBy} is null)`),
  ],
);

/** Belge yenileme geçmişi: salt-eklenir (düzeltilemez/silinemez; sahip rolü dahil). */
export const foreignDocRenewals = pgTable(
  'foreign_doc_renewals',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    docId: uuid().notNull(),
    prevIssueDate: date({ mode: 'string' }),
    prevExpiryDate: date({ mode: 'string' }),
    prevNumberLast4: text(),
    newIssueDate: date({ mode: 'string' }),
    newExpiryDate: date({ mode: 'string' }),
    newNumberLast4: text(),
    note: text(),
    renewedBy: uuid().references(() => users.id),
    renewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'foreign_doc_renewals_doc_fk', columns: [t.docId, t.companyId], foreignColumns: [foreignWorkerDocs.id, foreignWorkerDocs.companyId] }),
    index('foreign_doc_renewals_doc_idx').on(t.docId),
  ],
);

/**
 * Yabancı işçi parametreleri: tarihli, kaynak notlu, doğrulama alanlı, varsayılan KAPALI (payroll_params deseni). Anahtarlar:
 * guarantee_amount (teminat tutarı, para birimi zorunlu) ve expiry_warning_days (uyarı günü). Değer kodda/tohumda YOKTUR.
 */
export const foreignWorkerParams = pgTable(
  'foreign_worker_params',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    key: text().notNull(),
    value: numeric({ precision: 19, scale: 4 }).notNull(),
    currency: text(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    enabled: boolean().notNull().default(false),
    sourceNote: text(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('foreign_worker_params_uq').on(t.companyId, t.key, t.effectiveFrom),
    unique('foreign_worker_params_id_company_uq').on(t.id, t.companyId),
    check('foreign_worker_params_key_ck', sql`${t.key} in ('guarantee_amount','expiry_warning_days')`),
    check('foreign_worker_params_value_ck', sql`${t.value} >= 0 and (${t.key} <> 'expiry_warning_days' or (${t.value} = trunc(${t.value}) and ${t.value} <= 3650))`),
    check('foreign_worker_params_currency_ck', sql`(${t.key} = 'guarantee_amount' and ${t.currency} is not null and ${t.currency} ~ '^[A-Z]{3}$') or (${t.key} <> 'guarantee_amount' and ${t.currency} is null)`),
  ],
);

/** Teminat kaydı: tutar, kayıt tarihinde geçerli kullanıcı parametresinden anlık görüntüdür. held → refunded | forfeited. */
export const foreignWorkerGuarantees = pgTable(
  'foreign_worker_guarantees',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid().notNull(),
    docId: uuid(),
    paramId: uuid().notNull(),
    projectId: uuid(),
    amount: money().notNull(),
    currency: text().notNull(),
    /** Kayıt anında parametrenin doğrulanmış olup olmadığı (anlık görüntü). */
    paramVerified: boolean().notNull().default(false),
    depositedDate: date({ mode: 'string' }).notNull(),
    depositReference: text(),
    /** held | refunded | forfeited */
    status: text().notNull().default('held'),
    resolvedDate: date({ mode: 'string' }),
    resolutionNote: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'foreign_worker_guarantees_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'foreign_worker_guarantees_doc_fk', columns: [t.docId, t.companyId], foreignColumns: [foreignWorkerDocs.id, foreignWorkerDocs.companyId] }),
    foreignKey({ name: 'foreign_worker_guarantees_param_fk', columns: [t.paramId, t.companyId], foreignColumns: [foreignWorkerParams.id, foreignWorkerParams.companyId] }),
    foreignKey({ name: 'foreign_worker_guarantees_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    index('foreign_worker_guarantees_emp_idx').on(t.companyId, t.employeeId),
    check('foreign_worker_guarantees_status_ck', sql`${t.status} in ('held','refunded','forfeited')`),
    check('foreign_worker_guarantees_amount_ck', sql`${t.amount} > 0 and ${t.currency} ~ '^[A-Z]{3}$'`),
    check('foreign_worker_guarantees_resolved_ck', sql`(${t.status} = 'held') = (${t.resolvedDate} is null) and (${t.resolvedDate} is null or ${t.resolvedDate} >= ${t.depositedDate})`),
  ],
);

// ---------------------------------------------------------------------------
// Çek/senet portföyü ve takas, banka teminat mektubu portföyü (Faz X1)
// ---------------------------------------------------------------------------

/**
 * Çek/senet: alınan (müşteriden; portföy/tahsil/ciro) ve verilen (tedarikçiye). Yalnızca defter para biriminde.
 * Durum yalnızca geçerli geçişlerle (cheques_guard) ve olay kaydıyla değişir; belge silinmez, tutar/cari/vade sonradan değişmez.
 */
export const cheques = pgTable(
  'cheques',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** received | issued */
    direction: text().notNull(),
    /** cheque | note */
    docType: text().notNull(),
    docNo: text().notNull(),
    bankName: text().notNull().default(''),
    branch: text(),
    /** Alınanda keşideci (müşteri), verilende lehtar (tedarikçi). */
    partyId: uuid().notNull(),
    amount: money().notNull(),
    amountBase: money().notNull(),
    fxRate: numeric({ precision: 20, scale: 8 }),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    issueDate: date({ mode: 'string' }).notNull(),
    dueDate: date({ mode: 'string' }).notNull(),
    status: text().notNull(),
    /** Ciro edilmişse ciro edilen tedarikçi (yalnızca status = endorsed). */
    holderPartyId: uuid(),
    /** Son tahsile verme/ödeme banka hesabı. */
    bankAccountId: uuid(),
    /** Kayıt (alınış/veriliş) yevmiyesi. */
    entryId: uuid().notNull(),
    description: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cheques_id_company_uq').on(t.id, t.companyId),
    unique('cheques_number_uq').on(t.companyId, t.direction, t.docType, t.bankName, t.docNo),
    foreignKey({ name: 'cheques_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'cheques_holder_fk', columns: [t.holderPartyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'cheques_bank_fk', columns: [t.bankAccountId, t.companyId], foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId] }),
    foreignKey({ name: 'cheques_entry_fk', columns: [t.entryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    index('cheques_party_idx').on(t.companyId, t.partyId),
    index('cheques_due_idx').on(t.companyId, t.dueDate),
    check('cheques_direction_ck', sql`${t.direction} in ('received','issued')`),
    check('cheques_doc_type_ck', sql`${t.docType} in ('cheque','note')`),
    check(
      'cheques_status_ck',
      sql`(${t.direction} = 'received' and ${t.status} in ('portfolio','in_collection','collected','bounced','endorsed','returned')) or (${t.direction} = 'issued' and ${t.status} in ('issued','paid','bounced','cancelled'))`,
    ),
    check('cheques_amount_ck', sql`${t.amount} > 0 and ${t.currencyCode} ~ '^[A-Z]{3}$' and ${t.dueDate} >= ${t.issueDate}`),
    check('cheques_holder_ck', sql`(${t.status} = 'endorsed') = (${t.holderPartyId} is not null)`),
  ],
);

/** Takas/toplu işlem başlığı: tek yevmiye ve (tahsile verme/ödemede) tek banka satırı; tek belgelik işlem de bir toplu işlemdir. */
export const chequeBatches = pgTable(
  'cheque_batches',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    batchNo: text().notNull(),
    /** deposit | collect | bounce | return | endorse | unendorse | pay | cancel */
    action: text().notNull(),
    eventDate: date({ mode: 'string' }).notNull(),
    bankAccountId: uuid(),
    partyId: uuid(),
    total: money().notNull(),
    currencyCode: text().notNull().references(()=>currencies.code),
    totalBase: money().notNull(),
    docCount: integer().notNull(),
    entryId: uuid().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('cheque_batches_id_company_uq').on(t.id, t.companyId),
    unique('cheque_batches_no_uq').on(t.companyId, t.batchNo),
    foreignKey({ name: 'cheque_batches_bank_fk', columns: [t.bankAccountId, t.companyId], foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId] }),
    foreignKey({ name: 'cheque_batches_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'cheque_batches_entry_fk', columns: [t.entryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    check('cheque_batches_action_ck', sql`${t.action} in ('deposit','collect','bounce','return','endorse','unendorse','pay','cancel')`),
    check('cheque_batches_amount_ck', sql`${t.total} > 0 and ${t.docCount} > 0`),
  ],
);

/** Salt-eklenir durum geçmişi: her durum değişikliği (ve kayıt) bir olaydır, yevmiyesiyle birlikte. */
export const chequeEvents = pgTable(
  'cheque_events',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    chequeId: uuid().notNull(),
    /** Kayıt olayında null. */
    fromStatus: text(),
    toStatus: text().notNull(),
    eventDate: date({ mode: 'string' }).notNull(),
    batchId: uuid(),
    entryId: uuid().notNull(),
    /** Ciroda ciro edilen cari. */
    partyId: uuid(),
    bankAccountId: uuid(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('cheque_events_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'cheque_events_cheque_fk', columns: [t.chequeId, t.companyId], foreignColumns: [cheques.id, cheques.companyId] }),
    foreignKey({ name: 'cheque_events_batch_fk', columns: [t.batchId, t.companyId], foreignColumns: [chequeBatches.id, chequeBatches.companyId] }),
    foreignKey({ name: 'cheque_events_entry_fk', columns: [t.entryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    foreignKey({ name: 'cheque_events_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'cheque_events_bank_fk', columns: [t.bankAccountId, t.companyId], foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId] }),
    index('cheque_events_cheque_idx').on(t.chequeId),
  ],
);

/**
 * Çek/senet kaydının (alınan) ya da ciro/verilen kaydının kapattığı açık kalem: `party_allocations`'ın kasa/banka hareketsiz karşılığı.
 * Cari açık kalem hesabı (`loadPartyLines`) bunları okur. Yalnızca eklenir; belge karşılıksız/iade dönse bile eşleştirme kalır,
 * yeniden açılan alacak/borç yeni bir cari satırdır.
 */
export const chequeAllocations = pgTable(
  'cheque_allocations',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    chequeId: uuid().notNull(),
    eventId: uuid().notNull(),
    partyId: uuid().notNull(),
    /** receivable | payable */
    control: text().notNull(),
    chargeLineId: uuid().notNull(),
    settleLineId: uuid().notNull(),
    amount: money().notNull(),
    amountBase: money().notNull(),
    settleAmount: money().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('cheque_allocations_settle_uq').on(t.settleLineId),
    index('cheque_allocations_charge_idx').on(t.chargeLineId),
    index('cheque_allocations_party_idx').on(t.companyId, t.partyId),
    foreignKey({ name: 'cheque_allocations_cheque_fk', columns: [t.chequeId, t.companyId], foreignColumns: [cheques.id, cheques.companyId] }),
    foreignKey({ name: 'cheque_allocations_event_fk', columns: [t.eventId, t.companyId], foreignColumns: [chequeEvents.id, chequeEvents.companyId] }),
    foreignKey({ name: 'cheque_allocations_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'cheque_allocations_charge_fk', columns: [t.chargeLineId, t.companyId], foreignColumns: [journalLines.id, journalLines.companyId] }),
    foreignKey({ name: 'cheque_allocations_settle_fk', columns: [t.settleLineId, t.companyId], foreignColumns: [journalLines.id, journalLines.companyId] }),
    check('cheque_allocations_control_ck', sql`${t.control} in ('receivable','payable')`),
    check('cheque_allocations_amount_ck', sql`${t.amount} > 0 and ${t.amountBase} > 0 and ${t.settleAmount} > 0`),
  ],
);

/**
 * Banka teminat mektubu (nazım takip; yevmiye yazmaz). given: bankanın bizim adımıza lehtara verdiği; received: taşeron/tedarikçiden alınan.
 * Komisyon oranı/tutarı kullanıcı girişidir (kodda oran yok). active → returned | liquidated | expired.
 */
export const bankGuarantees = pgTable(
  'bank_guarantees',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** given | received */
    direction: text().notNull(),
    letterNo: text().notNull(),
    bankName: text().notNull(),
    branch: text(),
    partyId: uuid(),
    counterpartyName: text().notNull(),
    projectId: uuid(),
    subcontractId: uuid(),
    purpose: text(),
    amount: money().notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    issueDate: date({ mode: 'string' }).notNull(),
    expiryDate: date({ mode: 'string' }),
    commissionRate: numeric({ precision: 7, scale: 4 }),
    commissionAmount: money(),
    commissionNote: text(),
    note: text(),
    /** active | returned | liquidated | expired */
    status: text().notNull().default('active'),
    resolvedDate: date({ mode: 'string' }),
    resolutionNote: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bank_guarantees_no_uq').on(t.companyId, t.direction, t.bankName, t.letterNo),
    foreignKey({ name: 'bank_guarantees_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'bank_guarantees_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'bank_guarantees_subcontract_fk', columns: [t.subcontractId, t.companyId], foreignColumns: [subcontracts.id, subcontracts.companyId] }),
    index('bank_guarantees_expiry_idx').on(t.companyId, t.expiryDate),
    check('bank_guarantees_direction_ck', sql`${t.direction} in ('given','received')`),
    check('bank_guarantees_status_ck', sql`${t.status} in ('active','returned','liquidated','expired')`),
    check('bank_guarantees_amount_ck', sql`${t.amount} > 0 and ${t.currencyCode} ~ '^[A-Z]{3}$' and (${t.expiryDate} is null or ${t.expiryDate} >= ${t.issueDate})`),
    check('bank_guarantees_commission_ck', sql`(${t.commissionRate} is null or ${t.commissionRate} between 0 and 100) and (${t.commissionAmount} is null or ${t.commissionAmount} >= 0)`),
    check(
      'bank_guarantees_resolved_ck',
      sql`(${t.status} = 'active') = (${t.resolvedDate} is null) and (${t.resolvedDate} is null or ${t.resolvedDate} >= ${t.issueDate}) and (${t.status} <> 'expired' or ${t.expiryDate} is not null)`,
    ),
  ],
);

/** Portföy ayarları (şirket başına tek satır): teminat mektubu uyarı günü kullanıcı verisidir; boş = uyarı yok. */
export const portfolioSettings = pgTable(
  'portfolio_settings',
  {
    companyId: uuid()
      .primaryKey()
      .references(() => companies.id),
    guaranteeWarningDays: integer(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('portfolio_settings_ck', sql`${t.guaranteeWarningDays} is null or ${t.guaranteeWarningDays} between 0 and 3650`)],
);

// ---------------------------------------------------------------------------
// Satış teklifi ve siparişi (X2)
// ---------------------------------------------------------------------------

/**
 * Satış teklifi (kind = quote) ve siparişi (kind = order): ortak başlık. Yevmiye ve stok hareketi YAZMAZ; teslim (irsaliye) ve
 * fatura satırları sipariş satırına bağlanır, karşılanan miktar oradan türer. Durum geçişleri veritabanında (sales_orders_guard,
 * ERP15) ve salt-eklenir olay geçmişiyle (sales_order_events) korunur.
 */
export const salesOrders = pgTable(
  'sales_orders',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** quote | order */
    kind: text().notNull(),
    branchId: uuid(),
    /** quote: draft/sent/accepted/rejected/converted/cancelled; order: draft/confirmed/closed/cancelled. */
    status: text().notNull().default('draft'),
    /** Taslaktan çıkarken (gönderildi/onaylandı) atanan boşluksuz numara (TKL/SSP). */
    docNo: text(),
    partyId: uuid().notNull(),
    docDate: date({ mode: 'string' }).notNull(),
    validUntil: date({ mode: 'string' }),
    deliveryDate: date({ mode: 'string' }),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    vatIncluded: boolean().notNull().default(false),
    warehouseId: uuid(),
    notes: text(),
    /** Siparişi doğuran teklif. */
    quoteId: uuid(),
    netTotal: money().notNull().default('0'),
    vatTotal: money().notNull().default('0'),
    grossTotal: money().notNull().default('0'),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sales_orders_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'sales_orders_branch_fk', columns: [t.branchId, t.companyId], foreignColumns: [companyBranches.id, companyBranches.companyId] }),
    unique('sales_orders_no_uq').on(t.companyId, t.docNo),
    index('sales_orders_kind_idx').on(t.companyId, t.kind, t.docDate),
    index('sales_orders_party_idx').on(t.companyId, t.partyId),
    // Bir teklif en çok bir siparişe dönüşür
    uniqueIndex('sales_orders_quote_uq')
      .on(t.companyId, t.quoteId)
      .where(sql`${t.quoteId} is not null`),
    foreignKey({ name: 'sales_orders_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'sales_orders_warehouse_fk', columns: [t.warehouseId, t.companyId], foreignColumns: [warehouses.id, warehouses.companyId] }),
    foreignKey({ name: 'sales_orders_quote_fk', columns: [t.quoteId, t.companyId], foreignColumns: [t.id, t.companyId] }),
    check('sales_orders_kind_ck', sql`${t.kind} in ('quote','order')`),
    check(
      'sales_orders_status_ck',
      sql`${t.status} in ('draft','sent','accepted','rejected','converted','confirmed','closed','cancelled')`,
    ),
    check('sales_orders_numbered_ck', sql`${t.status} = 'draft' or ${t.status} = 'cancelled' or ${t.docNo} is not null`),
    check('sales_orders_totals_ck', sql`${t.netTotal} >= 0 and ${t.vatTotal} >= 0 and ${t.grossTotal} = ${t.netTotal} + ${t.vatTotal}`),
  ],
);

export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    orderId: uuid().notNull(),
    lineNo: integer().notNull(),
    /** Boşsa serbest metin satırı (hizmet/işçilik). */
    itemId: uuid(),
    description: text().notNull(),
    quantity: qty().notNull(),
    unit: text(),
    unitPrice: unitCost().notNull(),
    discountPct: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    vatCode: text(),
    vatRate: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    net: money().notNull(),
    vat: money().notNull(),
    gross: money().notNull(),
    /** Siparişte, kaynak teklif satırı. */
    quoteLineId: uuid(),
  },
  (t) => [
    unique('sales_order_lines_uq').on(t.orderId, t.lineNo),
    unique('sales_order_lines_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'sales_order_lines_order_fk', columns: [t.orderId, t.companyId], foreignColumns: [salesOrders.id, salesOrders.companyId] }).onDelete('cascade'),
    foreignKey({ name: 'sales_order_lines_item_fk', columns: [t.itemId, t.companyId], foreignColumns: [items.id, items.companyId] }),
    foreignKey({ name: 'sales_order_lines_quote_line_fk', columns: [t.quoteLineId, t.companyId], foreignColumns: [t.id, t.companyId] }),
    check(
      'sales_order_lines_amounts_ck',
      sql`${t.quantity} > 0 and ${t.unitPrice} >= 0 and ${t.discountPct} between 0 and 100 and ${t.vatRate} between 0 and 100 and ${t.net} >= 0 and ${t.vat} >= 0 and ${t.gross} = ${t.net} + ${t.vat}`,
    ),
  ],
);

/** Durum geçmişi: yalnızca eklenir (silinmez/değişmez); her durum değişikliği aynı işlemde bir olay yazar. */
export const salesOrderEvents = pgTable(
  'sales_order_events',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    orderId: uuid().notNull(),
    /** Oluşturma olayında null. */
    fromStatus: text(),
    toStatus: text().notNull(),
    reason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sales_order_events_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'sales_order_events_order_fk', columns: [t.orderId, t.companyId], foreignColumns: [salesOrders.id, salesOrders.companyId] }),
    index('sales_order_events_order_idx').on(t.orderId),
  ],
);

// ---------------------------------------------------------------------------
// Toplu faturalama (X2)
// ---------------------------------------------------------------------------

/** Toplu faturalama çalıştırması (salt-eklenir sonuç kaydı). */
export const invoiceBatches = pgTable(
  'invoice_batches',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    invoiceDate: date({ mode: 'string' }).notNull(),
    /** party | note */
    grouping: text().notNull(),
    post: boolean().notNull(),
    invoicesCreated: integer().notNull().default(0),
    invoicesFailed: integer().notNull().default(0),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('invoice_batches_id_company_uq').on(t.id, t.companyId),
    check('invoice_batches_grouping_ck', sql`${t.grouping} in ('party','note')`),
  ],
);

/** Çalıştırmanın cari/fatura başına sonucu: oluşan fatura ya da hata. Yalnızca eklenir. */
export const invoiceBatchItems = pgTable(
  'invoice_batch_items',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    batchId: uuid().notNull(),
    partyId: uuid().notNull(),
    /** created | failed */
    status: text().notNull(),
    /** Oluşan fatura (bilgi amaçlı; taslak fatura silinirse kayıt kalır, bağlantı ölür). */
    invoiceId: uuid(),
    /** Faturaya giren irsaliyeler (id listesi, virgülle). */
    noteIds: text().notNull().default(''),
    errorCode: text(),
    errorMessage: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('invoice_batch_items_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'invoice_batch_items_batch_fk', columns: [t.batchId, t.companyId], foreignColumns: [invoiceBatches.id, invoiceBatches.companyId] }),
    foreignKey({ name: 'invoice_batch_items_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    index('invoice_batch_items_batch_idx').on(t.batchId),
    check('invoice_batch_items_status_ck', sql`${t.status} in ('created','failed')`),
    check('invoice_batch_items_result_ck', sql`(${t.status} = 'failed') = (${t.errorCode} is not null)`),
  ],
);


// ---------------------------------------------------------------------------
// Fiyat listeleri, cari özel fiyat/iskonto (X3)
// ---------------------------------------------------------------------------

/** Adlandırılmış fiyat listesi: satış ya da alış, tek para birimli, isteğe bağlı geçerlilik tarihli. Şirket varsayılanı tür başına en çok bir tane. */
export const priceLists = pgTable(
  'price_lists',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    /** sales | purchase */
    kind: text().notNull(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    validFrom: date({ mode: 'string' }),
    validTo: date({ mode: 'string' }),
    isActive: boolean().notNull().default(true),
    /** Cari listesi yoksa kullanılan şirket varsayılanı (tür başına tek). */
    isDefault: boolean().notNull().default(false),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('price_lists_company_code_uq').on(t.companyId, t.code),
    unique('price_lists_id_company_uq').on(t.id, t.companyId),
    uniqueIndex('price_lists_default_uq')
      .on(t.companyId, t.kind)
      .where(sql`${t.isDefault}`),
    check('price_lists_kind_ck', sql`${t.kind} in ('sales','purchase')`),
    check('price_lists_valid_ck', sql`${t.validTo} is null or ${t.validFrom} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

/** Liste fiyat satırı: stok kartı başına birim fiyat, isteğe bağlı miktar kademesi (min_qty) ve geçerlilik aralığı. */
export const priceListItems = pgTable(
  'price_list_items',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    priceListId: uuid().notNull(),
    itemId: uuid().notNull(),
    /** Bu fiyatın başladığı en az miktar (0 = tüm miktarlar). */
    minQty: qty().notNull().default('0'),
    price: unitCost().notNull(),
    validFrom: date({ mode: 'string' }),
    validTo: date({ mode: 'string' }),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('price_list_items_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'price_list_items_list_fk', columns: [t.priceListId, t.companyId], foreignColumns: [priceLists.id, priceLists.companyId] }),
    foreignKey({ name: 'price_list_items_item_fk', columns: [t.itemId, t.companyId], foreignColumns: [items.id, items.companyId] }),
    index('price_list_items_lookup_idx').on(t.priceListId, t.itemId),
    uniqueIndex('price_list_items_uq').on(t.priceListId, t.itemId, t.minQty, sql`(coalesce(${t.validFrom}, '0001-01-01'::date))`),
    check('price_list_items_ck', sql`${t.price} >= 0 and ${t.minQty} >= 0 and (${t.validTo} is null or ${t.validFrom} is null or ${t.validTo} >= ${t.validFrom})`),
  ],
);

/** Cari özel fiyat ve/veya kalem iskontosu: fiyat listesinden önce gelir. Fiyat boş olabilir (yalnızca iskonto). */
export const partyPrices = pgTable(
  'party_prices',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    partyId: uuid().notNull(),
    itemId: uuid().notNull(),
    /** sales | purchase */
    kind: text().notNull(),
    /** Fiyat doluysa fiyatın para birimi. */
    currencyCode: text().references(() => currencies.code),
    price: unitCost(),
    discountPct: numeric({ precision: 7, scale: 4 }),
    minQty: qty().notNull().default('0'),
    validFrom: date({ mode: 'string' }),
    validTo: date({ mode: 'string' }),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('party_prices_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'party_prices_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'party_prices_item_fk', columns: [t.itemId, t.companyId], foreignColumns: [items.id, items.companyId] }),
    index('party_prices_lookup_idx').on(t.partyId, t.itemId, t.kind),
    uniqueIndex('party_prices_uq').on(t.partyId, t.itemId, t.kind, t.minQty, sql`(coalesce(${t.validFrom}, '0001-01-01'::date))`),
    check('party_prices_kind_ck', sql`${t.kind} in ('sales','purchase')`),
    check(
      'party_prices_ck',
      sql`(${t.price} is not null or ${t.discountPct} is not null) and (${t.price} is null or ${t.currencyCode} is not null) and ${t.price} >= 0 and ${t.discountPct} between 0 and 100 and ${t.minQty} >= 0 and (${t.validTo} is null or ${t.validFrom} is null or ${t.validTo} >= ${t.validFrom})`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Seri no takibi (X3)
// ---------------------------------------------------------------------------

/**
 * Seri no sicili: kart başına seri no ve güncel durum. Durum ve depo yalnızca seri hareketi (serial_events) eklenince,
 * veritabanı tetikleyicisiyle değişir. pending = hareket yazılana dek geçici; void = girişi ters çevrilmiş (sicilden düşmüş) kayıt.
 */
export const itemSerials = pgTable(
  'item_serials',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    itemId: uuid().notNull(),
    serialNo: text().notNull(),
    /** pending | in_stock | issued | returned | scrapped | void */
    status: text().notNull(),
    /** Yalnızca in_stock iken. */
    warehouseId: uuid(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('item_serials_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'item_serials_item_fk', columns: [t.itemId, t.companyId], foreignColumns: [items.id, items.companyId] }),
    foreignKey({ name: 'item_serials_warehouse_fk', columns: [t.warehouseId, t.companyId], foreignColumns: [warehouses.id, warehouses.companyId] }),
    uniqueIndex('item_serials_no_uq')
      .on(t.companyId, t.itemId, t.serialNo)
      .where(sql`${t.status} <> 'void'`),
    index('item_serials_status_idx').on(t.companyId, t.itemId, t.status),
    check('item_serials_format_ck', sql`${t.serialNo} <> '' and ${t.serialNo} = upper(btrim(${t.serialNo}))`),
    check('item_serials_status_ck', sql`${t.status} in ('pending','in_stock','issued','returned','scrapped','void')`),
    check('item_serials_warehouse_ck', sql`(${t.status} = 'in_stock') = (${t.warehouseId} is not null)`),
  ],
);

/** Seri hareketi: salt-eklenir geçmiş. Her satır bir stok belgesi satırına bağlıdır (stok hareketiyle aynı belge ve satır no). */
export const serialEvents = pgTable(
  'serial_events',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    seq: bigserial({ mode: 'number' }).notNull(),
    serialId: uuid().notNull(),
    itemId: uuid().notNull(),
    /** receive | issue | return_in | return_out | scrap | transfer | reversal */
    event: text().notNull(),
    fromStatus: text().notNull(),
    toStatus: text().notNull(),
    fromWarehouseId: uuid(),
    toWarehouseId: uuid(),
    stockDocumentId: uuid().notNull(),
    lineNo: integer().notNull(),
    /** Giriş için tedarikçi, çıkış için müşteri (iade denetimi bunu kullanır). */
    partyId: uuid(),
    /** Ters hareket: tersine çevrilen hareket. */
    reversalOfId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('serial_events_seq_uq').on(t.seq),
    unique('serial_events_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'serial_events_serial_fk', columns: [t.serialId, t.companyId], foreignColumns: [itemSerials.id, itemSerials.companyId] }),
    foreignKey({ name: 'serial_events_doc_fk', columns: [t.stockDocumentId, t.companyId], foreignColumns: [stockDocuments.id, stockDocuments.companyId] }),
    foreignKey({ name: 'serial_events_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'serial_events_reversal_fk', columns: [t.reversalOfId, t.companyId], foreignColumns: [t.id, t.companyId] }),
    uniqueIndex('serial_events_reversal_uq')
      .on(t.reversalOfId)
      .where(sql`${t.reversalOfId} is not null`),
    index('serial_events_serial_idx').on(t.serialId, t.seq),
    index('serial_events_doc_idx').on(t.stockDocumentId, t.lineNo),
    check('serial_events_event_ck', sql`${t.event} in ('receive','issue','return_in','return_out','scrap','transfer','reversal')`),
    check('serial_events_reversal_ck', sql`(${t.event} = 'reversal') = (${t.reversalOfId} is not null)`),
  ],
);

/** Taslak irsaliye/fatura satırına girilen seri no'lar (kayıtta stok hareketine seri olayı olarak işlenir; kayıttan sonra satırla birlikte donar). */
export const documentLineSerials = pgTable(
  'document_line_serials',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    deliveryLineId: uuid(),
    invoiceLineId: uuid(),
    serialNo: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('document_line_serials_format_ck', sql`${t.serialNo} <> '' and ${t.serialNo} = upper(btrim(${t.serialNo}))`),
    foreignKey({ name: 'document_line_serials_delivery_fk', columns: [t.deliveryLineId, t.companyId], foreignColumns: [deliveryNoteLines.id, deliveryNoteLines.companyId] }).onDelete('cascade'),
    foreignKey({ name: 'document_line_serials_invoice_fk', columns: [t.invoiceLineId, t.companyId], foreignColumns: [invoiceLines.id, invoiceLines.companyId] }).onDelete('cascade'),
    uniqueIndex('document_line_serials_delivery_uq')
      .on(t.deliveryLineId, t.serialNo)
      .where(sql`${t.deliveryLineId} is not null`),
    uniqueIndex('document_line_serials_invoice_uq')
      .on(t.invoiceLineId, t.serialNo)
      .where(sql`${t.invoiceLineId} is not null`),
    check('document_line_serials_one_ck', sql`(${t.deliveryLineId} is null) <> (${t.invoiceLineId} is null)`),
  ],
);

// ---------------------------------------------------------------------------
// İthalat maliyet dağıtımı ve gider kartları (Faz X4)
// ---------------------------------------------------------------------------

/**
 * İthalat dosyası: ithal malların alış faturası/irsaliye satırlarını ve ek maliyet kalemlerini (navlun, sigorta, gümrük vergisi…) toplar.
 * Durum draft → allocated → posted → cancelled; geçişler ve değişmezlik `import_files_guard` ile (ERP18).
 * Tutarlar kullanıcı girişidir; kodda sabit oran ya da vergi kuralı yoktur.
 */
export const importFiles = pgTable(
  'import_files',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** İTH-2026-0001 (oluşturulurken, boşluksuz). */
    code: text().notNull(),
    name: text().notNull(),
    /** Beyanname/dosya referansı (serbest metin; ek dosya yerine metin referansı). */
    reference: text(),
    description: text(),
    /** Maliyet kalemlerinin varsayılan dağıtım yöntemi. */
    method: text().notNull().default('value'),
    fileDate: date({ mode: 'string' }).notNull(),
    status: text().notNull().default('draft'),
    allocatedAt: timestamp({ withTimezone: true }),
    postDate: date({ mode: 'string' }),
    postedAt: timestamp({ withTimezone: true }),
    postedBy: uuid().references(() => users.id),
    stockDocumentId: uuid(),
    journalEntryId: uuid(),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
    cancelStockDocumentId: uuid(),
    cancelJournalEntryId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('import_files_id_company_uq').on(t.id, t.companyId),
    unique('import_files_code_uq').on(t.companyId, t.code),
    foreignKey({ name: 'import_files_stock_doc_fk', columns: [t.stockDocumentId, t.companyId], foreignColumns: [stockDocuments.id, stockDocuments.companyId] }),
    foreignKey({ name: 'import_files_cancel_stock_doc_fk', columns: [t.cancelStockDocumentId, t.companyId], foreignColumns: [stockDocuments.id, stockDocuments.companyId] }),
    foreignKey({ name: 'import_files_entry_fk', columns: [t.journalEntryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    foreignKey({ name: 'import_files_cancel_entry_fk', columns: [t.cancelJournalEntryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    index('import_files_status_idx').on(t.companyId, t.status),
    check('import_files_method_ck', sql`${t.method} in ('value','quantity','weight','manual')`),
    check('import_files_status_ck', sql`${t.status} in ('draft','allocated','posted','cancelled')`),
    check('import_files_posted_ck', sql`${t.status} not in ('posted') or (${t.journalEntryId} is not null and ${t.postedAt} is not null and ${t.postDate} is not null)`),
  ],
);

/** Dosyaya alınan mal satırı: kayıtlı alış faturası (stoklu, irsaliyesiz satır) ya da alış irsaliyesi satırı; miktar/değer anlık görüntüdür. */
export const importFileLines = pgTable(
  'import_file_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    importFileId: uuid().notNull(),
    lineNo: integer().notNull(),
    /** invoice | delivery */
    sourceKind: text().notNull(),
    invoiceLineId: uuid(),
    deliveryLineId: uuid(),
    itemId: uuid().notNull(),
    warehouseId: uuid().notNull(),
    /** Kaynak belge numarası ve tarihi (görüntüleme için anlık görüntü). */
    sourceDocNo: text().notNull(),
    sourceDate: date({ mode: 'string' }).notNull(),
    quantity: qty().notNull(),
    /** Şirket para biriminde stok defteri mal değeri. */
    valueBase: money().notNull(),
    /** Satır toplam ağırlığı (kullanıcı girişi; ağırlığa göre dağıtımda zorunlu). */
    weight: qty(),
    /** Kayıtta yazılır: payın stokta kalan ve satılan mal maliyetine giden kısmı. */
    stockedAmount: money(),
    cogsAmount: money(),
    /** Kaynak satır aynı anda yalnızca tek aktif dosyada olabilir; iptalde false olur. */
    isActive: boolean().notNull().default(true),
  },
  (t) => [
    unique('import_file_lines_uq').on(t.importFileId, t.lineNo),
    unique('import_file_lines_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'import_file_lines_file_fk', columns: [t.importFileId, t.companyId], foreignColumns: [importFiles.id, importFiles.companyId] }),
    foreignKey({ name: 'import_file_lines_invoice_line_fk', columns: [t.invoiceLineId, t.companyId], foreignColumns: [invoiceLines.id, invoiceLines.companyId] }),
    foreignKey({ name: 'import_file_lines_delivery_line_fk', columns: [t.deliveryLineId, t.companyId], foreignColumns: [deliveryNoteLines.id, deliveryNoteLines.companyId] }),
    foreignKey({ name: 'import_file_lines_item_fk', columns: [t.itemId, t.companyId], foreignColumns: [items.id, items.companyId] }),
    foreignKey({ name: 'import_file_lines_warehouse_fk', columns: [t.warehouseId, t.companyId], foreignColumns: [warehouses.id, warehouses.companyId] }),
    uniqueIndex('import_file_lines_invoice_active_uq').on(t.invoiceLineId).where(sql`${t.isActive} and ${t.invoiceLineId} is not null`),
    uniqueIndex('import_file_lines_delivery_active_uq').on(t.deliveryLineId).where(sql`${t.isActive} and ${t.deliveryLineId} is not null`),
    index('import_file_lines_item_idx').on(t.companyId, t.itemId),
    check(
      'import_file_lines_source_ck',
      sql`(${t.sourceKind} = 'invoice' and ${t.invoiceLineId} is not null and ${t.deliveryLineId} is null) or (${t.sourceKind} = 'delivery' and ${t.deliveryLineId} is not null and ${t.invoiceLineId} is null)`,
    ),
    check('import_file_lines_qty_ck', sql`${t.quantity} > 0 and ${t.valueBase} >= 0 and (${t.weight} is null or ${t.weight} > 0)`),
  ],
);

/** Ek maliyet kalemi: kullanıcı tutarı (para birimi + kur), ödenen cari, isteğe bağlı bağlı gider faturası. */
export const importCostLines = pgTable(
  'import_cost_lines',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    importFileId: uuid().notNull(),
    lineNo: integer().notNull(),
    /** freight | insurance | customs_duty | other_tax | brokerage | other */
    kind: text().notNull(),
    description: text().notNull(),
    partyId: uuid(),
    /** Bağlı gider/alış faturası (yalnızca bilgi ve cari tutarlılığı; tutar kullanıcı girişidir). */
    invoiceId: uuid(),
    currencyCode: text()
      .notNull()
      .references(() => currencies.code),
    /** `currencyCode` cinsinden tutar. */
    amount: money().notNull(),
    /** Yabancı para biriminde, tutarın şirket para birimine çevrildiği kur (kullanıcı verir ya da o günkü kayıtlı kur). */
    fxRate: rate(),
    amountBase: money().notNull(),
    /** Bu kalemin dağıtım yöntemi (value | quantity | weight | manual). */
    method: text().notNull(),
    /** Alacak hesabı: gideri ilk yazdığınız hesap (boşsa eşlemedeki aktarım hesabı). */
    creditAccountId: uuid(),
    reference: text(),
  },
  (t) => [
    unique('import_cost_lines_uq').on(t.importFileId, t.lineNo),
    unique('import_cost_lines_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'import_cost_lines_file_fk', columns: [t.importFileId, t.companyId], foreignColumns: [importFiles.id, importFiles.companyId] }),
    foreignKey({ name: 'import_cost_lines_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'import_cost_lines_invoice_fk', columns: [t.invoiceId, t.companyId], foreignColumns: [invoices.id, invoices.companyId] }),
    foreignKey({ name: 'import_cost_lines_account_fk', columns: [t.creditAccountId, t.companyId], foreignColumns: [accounts.id, accounts.companyId] }),
    check('import_cost_lines_kind_ck', sql`${t.kind} in ('freight','insurance','customs_duty','other_tax','brokerage','other')`),
    check('import_cost_lines_method_ck', sql`${t.method} in ('value','quantity','weight','manual')`),
    check('import_cost_lines_amount_ck', sql`${t.amount} > 0 and ${t.amountBase} > 0 and (${t.fxRate} is null or ${t.fxRate} > 0)`),
  ],
);

/** Dağıtım sonucu: her maliyet kaleminin her mal satırına düşen payı (şirket para biriminde). Σ pay = kalemin tutarı. */
export const importAllocations = pgTable(
  'import_allocations',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    importFileId: uuid().notNull(),
    costLineId: uuid().notNull(),
    fileLineId: uuid().notNull(),
    amount: money().notNull(),
  },
  (t) => [
    unique('import_allocations_uq').on(t.costLineId, t.fileLineId),
    foreignKey({ name: 'import_allocations_file_fk', columns: [t.importFileId, t.companyId], foreignColumns: [importFiles.id, importFiles.companyId] }),
    foreignKey({ name: 'import_allocations_cost_fk', columns: [t.costLineId, t.companyId], foreignColumns: [importCostLines.id, importCostLines.companyId] }),
    foreignKey({ name: 'import_allocations_line_fk', columns: [t.fileLineId, t.companyId], foreignColumns: [importFileLines.id, importFileLines.companyId] }),
    check('import_allocations_amount_ck', sql`${t.amount} >= 0`),
  ],
);

/** Dosya geçmişi: yalnızca eklenir (tetikleyici UPDATE/DELETE'i reddeder). */
export const importFileEvents = pgTable(
  'import_file_events',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    importFileId: uuid().notNull(),
    /** created | saved | allocated | reopened | posted | cancelled */
    action: text().notNull(),
    fromStatus: text(),
    toStatus: text().notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'import_file_events_file_fk', columns: [t.importFileId, t.companyId], foreignColumns: [importFiles.id, importFiles.companyId] }),
    index('import_file_events_file_idx').on(t.importFileId, t.createdAt),
  ],
);

/**
 * Gider kartı: gider türü kataloğu. Varsayılan gider hesabı, isteğe bağlı KDV kodu, stopaj oranı (kullanıcı verisi, doğrulanmadı) ve proje/iş kalemi/maliyet kodu.
 */
export const expenseCards = pgTable(
  'expense_cards',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    code: text().notNull(),
    name: text().notNull(),
    accountId: uuid().notNull(),
    /** tax_rates.code; oran gider tarihinde çözülür. */
    taxCode: text(),
    /** Stopaj yüzdesi (kullanıcı verisi; kodda oran yoktur). */
    withholdingRate: numeric({ precision: 7, scale: 4 }),
    projectId: uuid(),
    wbsId: uuid(),
    costCodeId: uuid(),
    notes: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('expense_cards_id_company_uq').on(t.id, t.companyId),
    unique('expense_cards_code_uq').on(t.companyId, t.code),
    foreignKey({ name: 'expense_cards_account_fk', columns: [t.accountId, t.companyId], foreignColumns: [accounts.id, accounts.companyId] }),
    foreignKey({ name: 'expense_cards_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'expense_cards_wbs_fk', columns: [t.wbsId, t.projectId], foreignColumns: [projectWbs.id, projectWbs.projectId] }),
    foreignKey({ name: 'expense_cards_cost_code_fk', columns: [t.costCodeId, t.companyId], foreignColumns: [costCodes.id, costCodes.companyId] }),
    check('expense_cards_withholding_ck', sql`${t.withholdingRate} is null or (${t.withholdingRate} >= 0 and ${t.withholdingRate} <= 100)`),
    check('expense_cards_dim_ck', sql`(${t.wbsId} is null and ${t.costCodeId} is null) or ${t.projectId} is not null`),
  ],
);

/**
 * Gider fişi: hızlı gider girişi. Kaydedilirken yevmiye yazılır (B gider [+ KDV] / A kasa-banka ya da cari [+ stopaj]); düzeltme iptal + yeniden girişle.
 * Yalnızca şirket para biriminde. Kaydedilmiş fiş değişmez ve silinmez (`expense_entries_guard`, ERP19).
 */
export const expenseEntries = pgTable(
  'expense_entries',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    entryNo: text().notNull(),
    entryDate: date({ mode: 'string' }).notNull(),
    cardId: uuid().notNull(),
    description: text().notNull(),
    /** Ödenen/borçlanılan cari (cari ödemede zorunlu; kasa/banka ödemesinde isteğe bağlı rapor boyutu). */
    partyId: uuid(),
    /** treasury | party | employee */
    paymentKind: text().notNull(),
    employeeId:uuid(),
    advanceId:uuid(),
    advanceAppliedAmount:numeric({precision:19,scale:2}).notNull().default('0'),
    treasuryAccountId: uuid(),
    dueDate: date({ mode: 'string' }),
    net: money().notNull(),
    vatCode: text(),
    vatRate: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    vat: money().notNull(),
    withholdingRate: numeric({ precision: 7, scale: 4 }).notNull().default('0'),
    withholding: money().notNull(),
    gross: money().notNull(),
    /** Ödenecek/borçlanılan tutar = brüt − stopaj. */
    payable: money().notNull(),
    /** Belge/fiş numarası ya da ek dosya referansı (metin). */
    documentRef: text(),
    projectId: uuid(),
    wbsId: uuid(),
    costCodeId: uuid(),
    journalEntryId: uuid().notNull(),
    status: text().notNull().default('posted'),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
    cancelJournalEntryId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('expense_entries_no_uq').on(t.companyId, t.entryNo),
    unique('expense_entries_id_company').on(t.id,t.companyId),
    foreignKey({name:'expense_entries_employee_fk',columns:[t.employeeId,t.companyId],foreignColumns:[employees.id,employees.companyId]}),
    foreignKey({name:'expense_entries_advance_fk',columns:[t.advanceId,t.companyId],foreignColumns:[employeeAdvances.id,employeeAdvances.companyId]}),
    foreignKey({ name: 'expense_entries_card_fk', columns: [t.cardId, t.companyId], foreignColumns: [expenseCards.id, expenseCards.companyId] }),
    foreignKey({ name: 'expense_entries_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'expense_entries_treasury_fk', columns: [t.treasuryAccountId, t.companyId], foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId] }),
    foreignKey({ name: 'expense_entries_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'expense_entries_wbs_fk', columns: [t.wbsId, t.projectId], foreignColumns: [projectWbs.id, projectWbs.projectId] }),
    foreignKey({ name: 'expense_entries_cost_code_fk', columns: [t.costCodeId, t.companyId], foreignColumns: [costCodes.id, costCodes.companyId] }),
    foreignKey({ name: 'expense_entries_entry_fk', columns: [t.journalEntryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    foreignKey({ name: 'expense_entries_cancel_entry_fk', columns: [t.cancelJournalEntryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    index('expense_entries_date_idx').on(t.companyId, t.entryDate),
    index('expense_entries_card_idx').on(t.companyId, t.cardId),
    check('expense_entries_status_ck', sql`${t.status} in ('posted','cancelled')`),
    check('expense_entries_payment_ck', sql`(${t.paymentKind} = 'treasury' and ${t.treasuryAccountId} is not null) or (${t.paymentKind} = 'party' and ${t.partyId} is not null and ${t.treasuryAccountId} is null) or (${t.paymentKind}='employee' and ${t.employeeId} is not null and (${t.advanceAppliedAmount}=${t.payable} or ${t.treasuryAccountId} is not null))`),
    check('expense_entries_advance_ck',sql`${t.advanceAppliedAmount}>=0 and ${t.advanceAppliedAmount}<=${t.payable} and (${t.advanceAppliedAmount}=0 or ${t.advanceId} is not null) and (${t.paymentKind}='employee' or (${t.employeeId} is null and ${t.advanceId} is null and ${t.advanceAppliedAmount}=0))`),
    check('expense_entries_amounts_ck', sql`${t.net} > 0 and ${t.vat} >= 0 and ${t.withholding} >= 0 and ${t.gross} = ${t.net} + ${t.vat} and ${t.payable} = ${t.gross} - ${t.withholding} and ${t.payable} >= 0`),
    check('expense_entries_cancel_ck', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null and ${t.cancelJournalEntryId} is not null)`),
  ],
);

// ---------------------------------------------------------------------------
// Personel cari ve avans takibi (Faz X5)
// ---------------------------------------------------------------------------

/**
 * Şirket başına personel cari ayarı: bordrodan avans kesintisinin isteğe bağlı üst sınırı (kullanıcı verisi; kodda yasal sınır YOKTUR,
 * varsayılan sınırsız). Yüzde, avans kesintisi öncesi net ücrete uygulanır. Doğrulama alanları "doğrulanmadı" rozetini taşır.
 */
export const employeeLedgerSettings = pgTable(
  'employee_ledger_settings',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    deductionCapPct: numeric({ precision: 7, scale: 4 }),
    sourceNote: text(),
    verifiedBy: text(),
    verifiedAt: timestamp({ withTimezone: true }),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employee_ledger_settings_company_uq').on(t.companyId),
    check('employee_ledger_settings_cap_ck', sql`${t.deductionCapPct} is null or (${t.deductionCapPct} > 0 and ${t.deductionCapPct} <= 100)`),
  ],
);

/**
 * Personel avansı: kasa/bankadan personele verilen ödeme (kasa/banka hareketi `treasury_txn_id`; yevmiye: borç personel avansları, alacak kasa/banka).
 * Kapanan tutar `settled_amount` taksit satırlarından türetilir (tetikleyici); durum open → partial → settled, yalnız kapanmamış avans iptal edilir.
 * Silinmez (ERP20).
 */
export const employeeAdvances = pgTable(
  'employee_advances',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    number: text().notNull(),
    employeeId: uuid().notNull(),
    advanceDate: date({ mode: 'string' }).notNull(),
    amount: numeric({ precision: 19, scale: 2 }).notNull(),
    purpose: text().notNull(),
    projectId: uuid(),
    treasuryAccountId: uuid().notNull(),
    treasuryTxnId: uuid().notNull(),
    settledAmount: numeric({ precision: 19, scale: 2 }).notNull().default('0'),
    /** open | partial | settled | cancelled */
    status: text().notNull().default('open'),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => users.id),
    cancelReason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('employee_advances_number_uq').on(t.companyId, t.number),
    unique('employee_advances_id_company_uq').on(t.id, t.companyId),
    unique('employee_advances_txn_uq').on(t.treasuryTxnId),
    foreignKey({ name: 'employee_advances_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'employee_advances_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'employee_advances_treasury_account_fk', columns: [t.treasuryAccountId, t.companyId], foreignColumns: [treasuryAccounts.id, treasuryAccounts.companyId] }),
    foreignKey({ name: 'employee_advances_txn_fk', columns: [t.treasuryTxnId, t.companyId], foreignColumns: [treasuryTransactions.id, treasuryTransactions.companyId] }),
    index('employee_advances_employee_idx').on(t.companyId, t.employeeId, t.advanceDate),
    check('employee_advances_status_ck', sql`${t.status} in ('open','partial','settled','cancelled')`),
    check('employee_advances_amount_ck', sql`${t.amount} > 0`),
    check('employee_advances_settled_ck', sql`${t.settledAmount} >= 0 and ${t.settledAmount} <= ${t.amount}`),
    check('employee_advances_cancel_ck', sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`),
  ],
);

/**
 * Avans kapama taksiti (yalnız eklenir): bordrodan kesinti (`payroll`, bordro onayında) ya da kasa/bankadan geri ödeme (`repayment`).
 * Bordro iptali/geri ödeme iptali satırı SİLMEZ; `reversed_*` alanları bir kez doldurulur ve tutar kapanan toplamdan düşer (ERP20).
 */
export const employeeAdvanceSettlements = pgTable(
  'employee_advance_settlements',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    advanceId: uuid().notNull(),
    /** payroll | repayment | expense */
    kind: text().notNull(),
    amount: numeric({ precision: 19, scale: 2 }).notNull(),
    settledDate: date({ mode: 'string' }).notNull(),
    payrollRunId: uuid(),
    treasuryTxnId: uuid(),
    expenseEntryId:uuid(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    reversedAt: timestamp({ withTimezone: true }),
    reversedBy: uuid().references(() => users.id),
    reverseReason: text(),
  },
  (t) => [
    foreignKey({ name: 'employee_advance_settlements_advance_fk', columns: [t.advanceId, t.companyId], foreignColumns: [employeeAdvances.id, employeeAdvances.companyId] }),
    foreignKey({ name: 'employee_advance_settlements_run_fk', columns: [t.payrollRunId, t.companyId], foreignColumns: [payrollRuns.id, payrollRuns.companyId] }),
    foreignKey({ name: 'employee_advance_settlements_txn_fk', columns: [t.treasuryTxnId, t.companyId], foreignColumns: [treasuryTransactions.id, treasuryTransactions.companyId] }),
    foreignKey({name:'employee_advance_settlements_expense_fk',columns:[t.expenseEntryId,t.companyId],foreignColumns:[expenseEntries.id,expenseEntries.companyId]}),
    uniqueIndex('employee_advance_settlements_expense_uq').on(t.expenseEntryId).where(sql`${t.expenseEntryId} is not null`),
    index('employee_advance_settlements_advance_idx').on(t.advanceId),
    uniqueIndex('employee_advance_settlements_run_uq').on(t.advanceId, t.payrollRunId).where(sql`${t.payrollRunId} is not null`),
    uniqueIndex('employee_advance_settlements_txn_uq').on(t.treasuryTxnId).where(sql`${t.treasuryTxnId} is not null`),
    check('employee_advance_settlements_kind_ck', sql`${t.kind} in ('payroll','repayment','expense')`),
    check('employee_advance_settlements_amount_ck', sql`${t.amount} > 0`),
    check('employee_advance_settlements_source_ck', sql`(${t.kind} = 'payroll' and ${t.payrollRunId} is not null and ${t.treasuryTxnId} is null and ${t.expenseEntryId} is null) or (${t.kind} = 'repayment' and ${t.treasuryTxnId} is not null and ${t.payrollRunId} is null and ${t.expenseEntryId} is null) or (${t.kind}='expense' and ${t.expenseEntryId} is not null and ${t.payrollRunId} is null and ${t.treasuryTxnId} is null)`),
    check('employee_advance_settlements_reverse_ck', sql`(${t.reversedAt} is null) = (${t.reverseReason} is null)`),
  ],
);

/** Taslak bordroda seçilen avans kesintileri (plan). Bordro onayında taksite dönüşür; onaydan sonra değişmez (ERP20). */
export const employeeAdvanceDeductions = pgTable(
  'employee_advance_deductions',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    runId: uuid().notNull(),
    advanceId: uuid().notNull(),
    employeeId: uuid().notNull(),
    amount: numeric({ precision: 19, scale: 2 }).notNull(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('employee_advance_deductions_uq').on(t.runId, t.advanceId),
    foreignKey({ name: 'employee_advance_deductions_run_fk', columns: [t.runId, t.companyId], foreignColumns: [payrollRuns.id, payrollRuns.companyId] }),
    foreignKey({ name: 'employee_advance_deductions_advance_fk', columns: [t.advanceId, t.companyId], foreignColumns: [employeeAdvances.id, employeeAdvances.companyId] }),
    foreignKey({ name: 'employee_advance_deductions_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    check('employee_advance_deductions_amount_ck', sql`${t.amount} > 0`),
  ],
);

/** Avans durum geçmişi (yalnız eklenir; tetikleyici yazar). */
export const employeeAdvanceEvents = pgTable(
  'employee_advance_events',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    advanceId: uuid().notNull(),
    fromStatus: text(),
    toStatus: text().notNull(),
    settledAmount: numeric({ precision: 19, scale: 2 }).notNull(),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'employee_advance_events_advance_fk', columns: [t.advanceId, t.companyId], foreignColumns: [employeeAdvances.id, employeeAdvances.companyId] }),
    index('employee_advance_events_advance_idx').on(t.advanceId, t.createdAt),
  ],
);

/** Net maaş ödemesi: kasa/banka hareketi (diğer ödeme, karşı hesap "ödenecek net ücret") ile personel cari bağlantısı. Yalnız eklenir (ERP20). */
export const employeeSalaryPayments = pgTable(
  'employee_salary_payments',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    employeeId: uuid().notNull(),
    payrollRunId: uuid(),
    treasuryTxnId: uuid().notNull(),
    payDate: date({ mode: 'string' }).notNull(),
    amount: numeric({ precision: 19, scale: 2 }).notNull(),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('employee_salary_payments_txn_uq').on(t.treasuryTxnId),
    foreignKey({ name: 'employee_salary_payments_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'employee_salary_payments_run_fk', columns: [t.payrollRunId, t.companyId], foreignColumns: [payrollRuns.id, payrollRuns.companyId] }),
    foreignKey({ name: 'employee_salary_payments_txn_fk', columns: [t.treasuryTxnId, t.companyId], foreignColumns: [treasuryTransactions.id, treasuryTransactions.companyId] }),
    index('employee_salary_payments_employee_idx').on(t.companyId, t.employeeId, t.payDate),
    check('employee_salary_payments_amount_ck', sql`${t.amount} > 0`),
  ],
);


// --- Rehber, ajanda ve görüşme notları (Faz X6) --------------------------------------------------------

/** Rehber kurumu (banka, kamu kurumu, tedarikçi…). Kategori kullanıcı yönetimli serbest metindir. Silinmez, arşivlenir (ERP21). */
export const directoryOrganizations = pgTable(
  'directory_organizations',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    name: text().notNull(),
    category: text().notNull().default('Diğer'),
    address: text(),
    phone: text(),
    email: text(),
    web: text(),
    /** İsteğe bağlı bağlantı: aynı kurumun cari kartı. */
    partyId: uuid(),
    note: text(),
    isArchived: boolean().notNull().default(false),
    archivedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('directory_organizations_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'directory_organizations_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    index('directory_organizations_name_idx').on(t.companyId, t.name),
    check('directory_organizations_name_ck', sql`length(btrim(${t.name})) >= 2`),
    check('directory_organizations_archive_ck', sql`${t.isArchived} = (${t.archivedAt} is not null)`),
  ],
);

/**
 * Rehber kişisi. Telefon/e-posta/adres kişisel veridir (şifrelenmez, envanterde işaretli); kimlik no ve doğum tarihi
 * rehberde HİÇ tutulmaz. Silinmez: arşivlenir, birleştirilir (merged_into_id) ya da anonimleştirilir (ERP21).
 */
export const directoryContacts = pgTable(
  'directory_contacts',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    fullName: text().notNull(),
    title: text(),
    organizationId: uuid(),
    phone: text(),
    phone2: text(),
    email: text(),
    email2: text(),
    address: text(),
    partyId: uuid(),
    employeeId: uuid(),
    projectId: uuid(),
    tags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    note: text(),
    isArchived: boolean().notNull().default(false),
    archivedAt: timestamp({ withTimezone: true }),
    mergedIntoId: uuid(),
    anonymizedAt: timestamp({ withTimezone: true }),
    anonymizedBy: uuid().references(() => users.id),
    anonymizeReason: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('directory_contacts_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'directory_contacts_org_fk', columns: [t.organizationId, t.companyId], foreignColumns: [directoryOrganizations.id, directoryOrganizations.companyId] }),
    foreignKey({ name: 'directory_contacts_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'directory_contacts_employee_fk', columns: [t.employeeId, t.companyId], foreignColumns: [employees.id, employees.companyId] }),
    foreignKey({ name: 'directory_contacts_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'directory_contacts_merged_fk', columns: [t.mergedIntoId, t.companyId], foreignColumns: [t.id, t.companyId] }),
    index('directory_contacts_name_idx').on(t.companyId, t.fullName),
    index('directory_contacts_org_idx').on(t.companyId, t.organizationId),
    check('directory_contacts_name_ck', sql`length(btrim(${t.fullName})) >= 2`),
    check('directory_contacts_archive_ck', sql`${t.isArchived} = (${t.archivedAt} is not null)`),
    check('directory_contacts_merged_ck', sql`${t.mergedIntoId} is null or ${t.isArchived}`),
    check('directory_contacts_anonymized_ck', sql`(${t.anonymizedAt} is null) = (${t.anonymizeReason} is null) and (${t.anonymizedAt} is null or ${t.isArchived})`),
  ],
);

/**
 * Görüşme notu: kişi ve/veya kuruma bağlı etkileşim kaydı. Yalnızca eklenir (silinmez); yazarı düzenleyebilir, geçmiş denetim
 * izindedir. `private` notu yalnızca yazarı görür (kısıtlayıcı RLS politikası), `shared` notu rehber okuyan herkes.
 */
export const directoryNotes = pgTable(
  'directory_notes',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    contactId: uuid(),
    organizationId: uuid(),
    /** call | meeting | email | other */
    kind: text().notNull(),
    noteDate: date({ mode: 'string' }).notNull(),
    summary: text().notNull(),
    /** private | shared */
    visibility: text().notNull().default('private'),
    projectId: uuid(),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    clearedAt: timestamp({ withTimezone: true }),
    editedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: 'directory_notes_contact_fk', columns: [t.contactId, t.companyId], foreignColumns: [directoryContacts.id, directoryContacts.companyId] }),
    foreignKey({ name: 'directory_notes_org_fk', columns: [t.organizationId, t.companyId], foreignColumns: [directoryOrganizations.id, directoryOrganizations.companyId] }),
    foreignKey({ name: 'directory_notes_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    unique('directory_notes_id_company_uq').on(t.id, t.companyId),
    index('directory_notes_contact_idx').on(t.companyId, t.contactId, t.noteDate),
    index('directory_notes_org_idx').on(t.companyId, t.organizationId, t.noteDate),
    check('directory_notes_kind_ck', sql`${t.kind} in ('call','meeting','email','other')`),
    check('directory_notes_visibility_ck', sql`${t.visibility} in ('private','shared')`),
    check('directory_notes_subject_ck', sql`${t.contactId} is not null or ${t.organizationId} is not null`),
    check('directory_notes_summary_ck', sql`length(btrim(${t.summary})) >= 1`),
  ],
);

/**
 * Ajanda kalemi: görev/hatırlatma ya da randevu. `ownerId` boşsa şirket ajandasıdır. Hatırlatma ofseti (dakika) bildirim kaynağı
 * `agenda_reminder` tarafından kullanılır (Faz N1; push yoktur). Silinmez; iptal edilir (ERP21).
 */
export const agendaItems = pgTable(
  'agenda_items',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** task | appointment */
    kind: text().notNull().default('task'),
    title: text().notNull(),
    description: text(),
    dueDate: date({ mode: 'string' }).notNull(),
    allDay: boolean().notNull().default(true),
    startTime: text(),
    endTime: text(),
    remindBeforeMinutes: integer(),
    /** open | done | cancelled */
    status: text().notNull().default('open'),
    completedAt: timestamp({ withTimezone: true }),
    ownerId: uuid().references(() => users.id),
    contactId: uuid(),
    organizationId: uuid(),
    partyId: uuid(),
    projectId: uuid(),
    sourceNoteId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'agenda_items_contact_fk', columns: [t.contactId, t.companyId], foreignColumns: [directoryContacts.id, directoryContacts.companyId] }),
    foreignKey({ name: 'agenda_items_org_fk', columns: [t.organizationId, t.companyId], foreignColumns: [directoryOrganizations.id, directoryOrganizations.companyId] }),
    foreignKey({ name: 'agenda_items_party_fk', columns: [t.partyId, t.companyId], foreignColumns: [parties.id, parties.companyId] }),
    foreignKey({ name: 'agenda_items_project_fk', columns: [t.projectId, t.companyId], foreignColumns: [projects.id, projects.companyId] }),
    foreignKey({ name: 'agenda_items_note_fk', columns: [t.sourceNoteId, t.companyId], foreignColumns: [directoryNotes.id, directoryNotes.companyId] }),
    index('agenda_items_due_idx').on(t.companyId, t.status, t.dueDate),
    index('agenda_items_owner_idx').on(t.companyId, t.ownerId, t.dueDate),
    check('agenda_items_kind_ck', sql`${t.kind} in ('task','appointment')`),
    check('agenda_items_status_ck', sql`${t.status} in ('open','done','cancelled')`),
    check('agenda_items_title_ck', sql`length(btrim(${t.title})) >= 1`),
    check('agenda_items_time_ck', sql`(${t.allDay} and ${t.startTime} is null and ${t.endTime} is null) or (not ${t.allDay} and ${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and (${t.endTime} is null or (${t.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.endTime} > ${t.startTime})))`),
    check('agenda_items_remind_ck', sql`${t.remindBeforeMinutes} is null or ${t.remindBeforeMinutes} between 0 and 43200`),
    check('agenda_items_done_ck', sql`(${t.status} = 'done') = (${t.completedAt} is not null)`),
  ],
);

// ---------------------------------------------------------------------------
// Çoklu şirket konsolidasyonu (Faz X7)
// ---------------------------------------------------------------------------
// Bu tablolar KULLANICIYA aittir (şirkete değil): `company_id` sütunu bilerek yoktur; RLS `owner_user_id = app_user_id()`
// ile sahibine açar. Üye şirket sütunu `member_company_id`dir ve şirket verisini okutmaz — şirket verisi yalnızca o şirketin
// RLS bağlamında (app.company_id) tek tek okunur (bkz. docs/ARCHITECTURE.md, Faz X7).

export const consolidationGroups = pgTable(
  'consolidation_groups',
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    /** Rapor (grup) para birimi; eliminasyon tutarları bu para biriminde girilir, sonradan değişmez. */
    reportingCurrency: text()
      .notNull()
      .references(() => currencies.code),
    isArchived: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('consolidation_groups_name_uq').on(t.ownerUserId, t.name),
    check('consolidation_groups_name_ck', sql`length(btrim(${t.name})) >= 2`),
  ],
);

export const consolidationMembers = pgTable(
  'consolidation_members',
  {
    id: id(),
    groupId: uuid()
      .notNull()
      .references(() => consolidationGroups.id),
    memberCompanyId: uuid()
      .notNull()
      .references(() => companies.id),
    addedAt: createdAt(),
  },
  (t) => [unique('consolidation_members_uq').on(t.groupId, t.memberCompanyId), index('consolidation_members_company_idx').on(t.memberCompanyId)],
);

/** Elle girilen eliminasyon (mahsup) kaydı başlığı. Salt eklenir; yalnızca iptal (void) bilgisi bir kez yazılır. Yöntem doğrulanmadı. */
export const consolidationEliminations = pgTable(
  'consolidation_eliminations',
  {
    id: id(),
    groupId: uuid()
      .notNull()
      .references(() => consolidationGroups.id),
    periodFrom: date({ mode: 'string' }).notNull(),
    periodTo: date({ mode: 'string' }).notNull(),
    /** intercompany_balance | intercompany_sales | other */
    kind: text().notNull().default('intercompany_balance'),
    description: text().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    voidedAt: timestamp({ withTimezone: true }),
    voidedBy: uuid().references(() => users.id),
    voidReason: text(),
  },
  (t) => [
    index('consolidation_eliminations_group_idx').on(t.groupId, t.periodFrom, t.periodTo),
    check('consolidation_eliminations_kind_ck', sql`${t.kind} in ('intercompany_balance','intercompany_sales','other')`),
    check('consolidation_eliminations_period_ck', sql`${t.periodFrom} <= ${t.periodTo}`),
    check('consolidation_eliminations_desc_ck', sql`length(btrim(${t.description})) >= 2`),
    check('consolidation_eliminations_void_ck', sql`(${t.voidedAt} is null) = (${t.voidedBy} is null) and (${t.voidedAt} is null) = (${t.voidReason} is null)`),
  ],
);

export const consolidationEliminationLines = pgTable(
  'consolidation_elimination_lines',
  {
    id: id(),
    eliminationId: uuid().notNull(),
    groupId: uuid().notNull(),
    lineNo: integer().notNull(),
    /** Hesap kodu (şirket hesap planı kodu; şirketler arası kodla eşlenir). Grup para biriminde tutar. */
    accountCode: text().notNull(),
    debit: money().notNull().default('0'),
    credit: money().notNull().default('0'),
    memo: text(),
  },
  (t) => [
    // Kısa adlar: varsayılan ad 63 karakteri aşıp PostgreSQL'de kesiliyordu (0079'da yeniden adlandırıldı).
    foreignKey({ name: 'consolidation_elim_lines_elimination_fk', columns: [t.eliminationId], foreignColumns: [consolidationEliminations.id] }),
    foreignKey({ name: 'consolidation_elim_lines_group_fk', columns: [t.groupId], foreignColumns: [consolidationGroups.id] }),
    unique('consolidation_elimination_lines_uq').on(t.eliminationId, t.lineNo),
    check('consolidation_elimination_lines_amount_ck', sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} > 0) <> (${t.credit} > 0)`),
    check('consolidation_elimination_lines_code_ck', sql`${t.accountCode} ~ '^[0-9][0-9A-Za-z.]{0,19}$'`),
  ],
);

// ---------------------------------------------------------------------------
// Yıl sonu kapanışı ve devir (Faz Y1). Hesap seçimleri ve yöntem doğrulanmamıştır (LEGAL-NOTES §23).
// Mali yıl, ay bazlı dönemlerin (fiscal_periods) kullanıcı tanımlı bir aralığıdır; kod takvim yılını varsaymaz.
// Kapatılan yılın dönemleri mevcut dönem kilidiyle kapatılır; veritabanı tetikleyicisi kapalı yıla kayıt ve dönem açmayı engeller (ERP23).
// ---------------------------------------------------------------------------

export const fiscalYears = pgTable(
  'fiscal_years',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    /** Kullanıcıya gösterilen ad ve kapanış onayında yazılan metin (varsayılan "2026"). */
    name: text().notNull(),
    startDate: date({ mode: 'string' }).notNull(),
    endDate: date({ mode: 'string' }).notNull(),
    /** open | closed (kapatma ve yeniden açma geçmişi fiscal_year_events'te) */
    status: text().notNull().default('open'),
    closedAt: timestamp({ withTimezone: true }),
    closedBy: uuid().references(() => users.id),
    /** Son yeniden açma gerekçesi (veritabanı tetikleyicisi yeniden açmada zorunlu tutar). */
    reopenReason: text(),
    reopenedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('fiscal_years_id_company_uq').on(t.id, t.companyId),
    unique('fiscal_years_start_uq').on(t.companyId, t.startDate),
    check('fiscal_years_status_ck', sql`${t.status} in ('open','closed')`),
    check('fiscal_years_range_ck', sql`${t.endDate} > ${t.startDate}`),
    check('fiscal_years_closed_ck', sql`${t.status} = 'open' or (${t.closedAt} is not null and ${t.closedBy} is not null)`),
  ],
);

export const fiscalYearEvents = pgTable(
  'fiscal_year_events',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    fiscalYearId: uuid().notNull(),
    /** close | reopen */
    action: text().notNull(),
    reason: text(),
    /** Kapanışta: dönem sonucu (defter para birimi, kâr +). */
    resultBase: money(),
    closeEntryId: uuid(),
    carryEntryId: uuid(),
    /** Kapanış seçenekleri ve kullanılan hesap eşlemeleri (anlık görüntü). */
    snapshot: jsonb(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    by: uuid()
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    unique('fiscal_year_events_id_company_uq').on(t.id, t.companyId),
    foreignKey({ name: 'fiscal_year_events_year_fk', columns: [t.fiscalYearId, t.companyId], foreignColumns: [fiscalYears.id, fiscalYears.companyId] }),
    foreignKey({ name: 'fiscal_year_events_close_entry_fk', columns: [t.closeEntryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    foreignKey({ name: 'fiscal_year_events_carry_entry_fk', columns: [t.carryEntryId, t.companyId], foreignColumns: [journalEntries.id, journalEntries.companyId] }),
    index('fiscal_year_events_year_idx').on(t.fiscalYearId, t.at),
    check('fiscal_year_events_action_ck', sql`${t.action} in ('close','reopen')`),
    check('fiscal_year_events_reason_ck', sql`${t.action} <> 'reopen' or length(btrim(coalesce(${t.reason}, ''))) >= 5`),
  ],
);

// ---------------------------------------------------------------------------
// Work tracking, document archive, field operations and external portal
// ---------------------------------------------------------------------------
export const workItems = pgTable('work_items', {
  id:id(),companyId:uuid().notNull().references(()=>companies.id),title:text().notNull(),description:text().notNull().default(''),
  dueDate:date({mode:'string'}).notNull(),ownerId:uuid().notNull().references(()=>users.id),createdBy:uuid().notNull().references(()=>users.id),
  priority:text().notNull().default('normal'),status:text().notNull().default('open'),recordKind:text(),recordId:uuid(),version:integer().notNull().default(1),
  createdAt:createdAt(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[unique('work_items_id_company').on(t.id,t.companyId),index('work_items_due_idx').on(t.companyId,t.ownerId,t.status,t.dueDate),check('work_items_title_ck',sql`length(btrim(${t.title})) between 2 and 200`),check('work_items_priority_ck',sql`${t.priority} in ('normal','high')`),check('work_items_status_ck',sql`${t.status} in ('open','done','cancelled')`),check('work_items_version_ck',sql`${t.version} > 0`),check('work_items_ref_ck',sql`(${t.recordKind} is null) = (${t.recordId} is null)`),check('work_items_record_kind_ck',sql`${t.recordKind} is null or ${t.recordKind} in ('party','invoice','project','subcontract','sales_contract','employee','foreign_worker_doc','transaction','site_report','defect','rfi','site_instruction','quality_check','safety','manufacturing_model','manufacturing_production','manufacturing_subcontract','manufacturing_resource','manufacturing_maintenance','wms_lot','logistics_shipment','leather_model','leather_piece','leather_production','leather_subcontract','leather_custom_order','leather_service','pos_sale')`)]);

export const recordDocuments = pgTable('record_documents', {
 id:id(),companyId:uuid().notNull().references(()=>companies.id),recordKind:text().notNull(),recordId:uuid().notNull(),filename:text().notNull(),mime:text().notNull(),size:integer().notNull(),sha256:text().notNull(),previousId:uuid(),createdBy:uuid().notNull().references(()=>users.id),createdAt:createdAt(),
},t=>[unique('record_documents_id_company_uq').on(t.id,t.companyId),unique('record_documents_previous_uq').on(t.previousId),foreignKey({name:'record_documents_previous_fk',columns:[t.previousId,t.companyId],foreignColumns:[t.id,t.companyId]}),index('record_documents_record_idx').on(t.companyId,t.recordKind,t.recordId,t.createdAt),check('record_documents_size_ck',sql`${t.size} between 1 and 104857600`),check('record_documents_mime_ck',sql`${t.mime} in ('application/pdf','image/jpeg','image/png')`),check('record_documents_kind_ck',sql`${t.recordKind} in ('party','invoice','project','subcontract','sales_contract','employee','foreign_worker_doc','transaction','site_report','defect','rfi','site_instruction','quality_check','safety','manufacturing_model','manufacturing_production','manufacturing_subcontract','manufacturing_resource','manufacturing_maintenance','wms_lot','logistics_shipment','leather_model','leather_piece','leather_production','leather_subcontract','leather_custom_order','leather_service','pos_sale')`)]);
export const recordDocumentContent = pgTable('record_document_content', {
 id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),content:text().notNull(),
},t=>[foreignKey({name:'record_document_content_document_fk',columns:[t.id,t.companyId],foreignColumns:[recordDocuments.id,recordDocuments.companyId]})]);
export const workAlertStates=pgTable('work_alert_states',{
 companyId:uuid().notNull().references(()=>companies.id),userId:uuid().notNull().references(()=>users.id),key:text().notNull(),snoozedUntil:date({mode:'string'}),readAt:timestamp({withTimezone:true}),
},t=>[primaryKey({columns:[t.companyId,t.userId,t.key]})]);
export const operationEntries=pgTable('operation_entries',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),kind:text().notNull(),title:text().notNull(),projectId:uuid(),partyId:uuid(),ownerId:uuid().notNull().references(()=>users.id),eventDate:date({mode:'string'}).notNull(),dueDate:date({mode:'string'}).notNull(),payload:jsonb().notNull(),status:text().notNull().default('open'),version:integer().notNull().default(1),createdBy:uuid().notNull().references(()=>users.id),createdAt:createdAt(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[index('operation_entries_list_idx').on(t.companyId,t.kind,t.status,t.dueDate),index('operation_entries_project_idx').on(t.companyId,t.projectId,t.kind),foreignKey({name:'operation_entries_project_fk',columns:[t.projectId,t.companyId],foreignColumns:[projects.id,projects.companyId]}),foreignKey({name:'operation_entries_party_fk',columns:[t.partyId,t.companyId],foreignColumns:[parties.id,parties.companyId]}),check('operation_entries_kind_ck',sql`${t.kind} in ('collection','site_report','schedule','equipment','equipment_log','defect','rfi','site_instruction','quality_check','safety')`),check('operation_entries_status_ck',sql`${t.status} in ('open','done','cancelled')`),check('operation_entries_title_ck',sql`length(btrim(${t.title})) between 2 and 200`),check('operation_entries_version_ck',sql`${t.version}>0`),check('operation_entries_ref_ck',sql`(${t.kind}='collection' and ${t.partyId} is not null) or (${t.kind}<>'collection' and ${t.projectId} is not null)`)]);
export const cashScenarios=pgTable('cash_scenarios',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),name:text().notNull(),assumptions:jsonb().notNull(),createdBy:uuid().notNull().references(()=>users.id),createdAt:createdAt(),
});

export const offlineDraftReceipts=pgTable('offline_draft_receipts',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),userId:uuid().notNull().references(()=>users.id),clientId:uuid().notNull(),kind:text().$type<'stock_count'|'field_task'>().notNull(),requestHash:text().notNull(),resultId:uuid().notNull(),resultPath:text().notNull(),branchSelection:text().notNull(),createdAt:createdAt(),
},t=>[unique('offline_draft_receipts_client_uq').on(t.companyId,t.userId,t.clientId),check('offline_draft_receipts_kind_ck',sql`${t.kind} in ('stock_count','field_task')`),check('offline_draft_receipts_hash_ck',sql`${t.requestHash}~'^[0-9a-f]{64}$'`),check('offline_draft_receipts_branch_ck',sql`${t.branchSelection} in ('all','unassigned') or ${t.branchSelection}~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`)]);
export const portalLinks=pgTable('portal_links',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),orgId:uuid().notNull().references(()=>organizations.id),partyId:uuid().notNull(),label:text().notNull(),tokenHash:text().notNull().unique(),passwordHash:text().notNull(),expiresAt:timestamp({withTimezone:true}).notNull(),revokedAt:timestamp({withTimezone:true}),createdBy:uuid().notNull().references(()=>users.id),createdAt:createdAt(),documentIds:uuid().array().notNull().default(sql`'{}'::uuid[]`),scopes:jsonb().$type<PortalDocumentScopes>().notNull().default(sql`'{"invoices":false,"quotes":false,"orders":false}'::jsonb`),
},t=>[foreignKey({name:'portal_links_party_fk',columns:[t.partyId,t.companyId],foreignColumns:[parties.id,parties.companyId]})]);
export const portalAccessEvents=pgTable('portal_access_events',{
 id:id(),companyId:uuid().notNull().references(()=>companies.id),linkId:uuid().notNull().references(()=>portalLinks.id),action:text().notNull(),at:timestamp({withTimezone:true}).notNull().defaultNow(),
});

// Bildirimler (uygulama içi + isteğe bağlı e-posta özeti)
// ---------------------------------------------------------------------------

/**
 * Bildirim: kullanıcıya adreslenmiş, GENEL metinli (yalnızca sayı + bağlantı; ad, kimlik, tutar, belge no yok) uyarı. Zamanlayıcı
 * (`modules/notifications/scheduler.ts`) her kullanıcı için kaynak kontrollerini çalıştırır; aynı durum için kopya üretmez
 * (`dedupe_key` = durum parmak izi; `bucket_date` = şirket saat dilimindeki gün) ve koşul kalkınca `resolved_at` doldurur.
 * Kullanıcı yalnızca okur (`read_at`) ya da kapatır (`dismissed_at`); içerik alanları değiştirilemez (ERP25). Silme yalnızca
 * kapanmış (okunmuş/kapatılmış/çözülmüş) satırların saklama süresi dolunca `notification_prune` ile olur.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    kind: text().notNull(),
    /** info | warning | critical */
    severity: text().notNull().default('info'),
    title: text().notNull(),
    body: text().notNull().default(''),
    /** Arayüz içi yol (örn. /treasury/cheques). */
    link: text().notNull(),
    /** Bildirimin temsil ettiği kayıt sayısı (metinde de geçer; sıralama/özet için). */
    count: integer().notNull().default(1),
    dedupeKey: text().notNull(),
    bucketDate: date({ mode: 'string' }).notNull(),
    createdAt: createdAt(),
    readAt: timestamp({ withTimezone: true }),
    dismissedAt: timestamp({ withTimezone: true }),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('notifications_dedupe_uq').on(t.companyId, t.userId, t.kind, t.dedupeKey, t.bucketDate),
    index('notifications_user_idx').on(t.companyId, t.userId, t.createdAt),
    index('notifications_open_idx').on(t.companyId, t.userId).where(sql`${t.resolvedAt} is null and ${t.dismissedAt} is null`),
    check('notifications_kind_ck', sql`${t.kind} ~ '^[a-z][a-z_]{1,40}$'`),
    check('notifications_severity_ck', sql`${t.severity} in ('info','warning','critical')`),
    check('notifications_title_ck', sql`length(btrim(${t.title})) between 1 and 200`),
    check('notifications_body_ck', sql`length(${t.body}) <= 1000`),
    check('notifications_link_ck', sql`${t.link} ~ '^/[^/]' or ${t.link} = '/'`),
    check('notifications_count_ck', sql`${t.count} >= 0`),
  ],
);

/** Bildirim tercihi (kullanıcı + şirket + tür): uygulama içi açık varsayılan, e-posta özeti KAPALI varsayılan; gün eşiği boşsa kaynak ayarı/varsayılan. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    kind: text().notNull(),
    inApp: boolean().notNull().default(true),
    email: boolean().notNull().default(false),
    leadDays: integer(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.userId, t.kind] }),
    check('notification_preferences_kind_ck', sql`${t.kind} ~ '^[a-z][a-z_]{1,40}$'`),
    check('notification_preferences_lead_ck', sql`${t.leadDays} is null or ${t.leadDays} between 0 and 365`),
  ],
);

/**
 * Kişisel arayüz tercihi (kullanıcı + şirket + anahtar): favoriler, pano düzeni, tablo yoğunluğu. İş verisi taşımaz;
 * anahtarlar API'de beyaz listelidir, değer boyutu veritabanında da sınırlıdır. Satır yalnız sahibine görünür (RLS).
 */
export const userUiPreferences = pgTable(
  'user_ui_preferences',
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    key: text().notNull(),
    value: jsonb().$type<unknown>().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.userId, t.key] }),
    check('user_ui_preferences_key_ck', sql`${t.key} ~ '^[a-z][a-z.]{1,40}$'`),
    check('user_ui_preferences_size_ck', sql`octet_length(${t.value}::text) <= 16384`),
  ],
);

/**
 * Günlük e-posta özeti kaydı (kullanıcı + şirket + gün): özet o gün için TALEP EDİLDİĞİNDE yazılır; aynı gün ikinci özet doğmaz
 * (gönderim "en çok bir kez": SMTP hatasında aynı gün yeniden denenmez).
 */
export const notificationDigests = pgTable(
  'notification_digests',
  {
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    digestDate: date({ mode: 'string' }).notNull(),
    itemCount: integer().notNull(),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.userId, t.digestDate] }), check('notification_digests_count_ck', sql`${t.itemCount} >= 1`)],
);

export * from './construction-schema';

export * from './administration-schema';
export * from './leather-schema';
export * from './pos-schema';

export * from './manufacturing-schema';
