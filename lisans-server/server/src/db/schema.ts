import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/** Satıcı yöneticileri: parola (argon2) + zorunlu TOTP. TOTP sırrı sunucu anahtarıyla şifreli saklanır. */
export const admins = pgTable(
  'admins',
  {
    id: id(),
    email: text().notNull(),
    fullName: text().notNull(),
    passwordHash: text().notNull(),
    totpSecretEnc: text().notNull(),
    /** Son kabul edilen TOTP sayacı: aynı kodun yeniden kullanımını önler. */
    totpLastCounter: bigint({ mode: 'number' }).notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    lastLoginAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('admins_email_uq').on(t.email)],
);

/** Yönetici giriş anahtarları (WebAuthn/passkey): açık anahtar ve imza sayacı; özel anahtar kullanıcının cihazında/kasasındadır. */
export const adminPasskeys = pgTable(
  'admin_passkeys',
  {
    id: id(),
    adminId: uuid()
      .notNull()
      .references(() => admins.id),
    /** base64url kimlik bilgisi kimliği. */
    credentialId: text().notNull(),
    /** base64url COSE açık anahtarı. */
    publicKey: text().notNull(),
    counter: bigint({ mode: 'number' }).notNull().default(0),
    transports: text().array().notNull().default(sql`'{}'::text[]`),
    name: text().notNull(),
    /** Anahtar eşitlenen bir kasada mı (ör. Vaultwarden, iCloud) yoksa tek cihazda mı. */
    backedUp: boolean().notNull().default(false),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('admin_passkeys_credential_uq').on(t.credentialId), index('admin_passkeys_admin_idx').on(t.adminId)],
);

/** Oturum kimliği = çerezdeki rastgele değerin sha256 özeti. */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: text().primaryKey(),
    adminId: uuid()
      .notNull()
      .references(() => admins.id),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [index('admin_sessions_admin_idx').on(t.adminId)],
);

export const customers = pgTable('customers', {
  id: id(),
  name: text().notNull(),
  contactName: text(),
  email: text(),
  phone: text(),
  notes: text(),
  createdAt: createdAt(),
});

export const licenses = pgTable(
  'licenses',
  {
    id: id(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id),
    kind: text().notNull().default('commercial'),
    status: text().notNull().default('active'),
    sectors: text().array().notNull(),
    deviceLimit: integer().notNull(),
    companyLimit: integer().notNull().default(1),
    deviceIdleDays: integer().notNull().default(30),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    leaseDays: integer().notNull().default(7),
    validityMode: text().notNull().default('lease'),
    graceDays: integer().notNull().default(14),
    maxActivations: integer().notNull().default(1),
    offlineAllowed: boolean().notNull().default(false),
    /** Etkinleştirme kodunun özeti; kodun kendisi saklanmaz (yalnızca oluşturulurken bir kez gösterilir). */
    codeHash: text().notNull(),
    codePrefix: text().notNull(),
    /** Sunucu taşıma (devre dışı bırakma) sayısı. */
    transfersUsed: integer().notNull().default(0),
    /** Uzaktan güncelleme: satıcının bu lisansın kurulumlarına gönderdiği sürüm (boşsa teklif yok). */
    updateVersion: text(),
    updateSentAt: timestamp({ withTimezone: true }),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('licenses_code_hash_uq').on(t.codeHash),
    index('licenses_customer_idx').on(t.customerId),
    check('licenses_kind_ck', sql`${t.kind} in ('commercial', 'trial', 'demo')`),
    check('licenses_status_ck', sql`${t.status} in ('active', 'suspended', 'revoked')`),
    check('licenses_validity_mode_ck', sql`${t.validityMode} in ('lease', 'subscription')`),
    check('licenses_sectors_ck', sql`cardinality(${t.sectors}) >= 1 and ${t.sectors} <@ array['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE']::text[]`),
    check('licenses_limits_ck', sql`${t.deviceLimit} between 1 and 10000 and ${t.companyLimit} between 1 and 10000 and ${t.maxActivations} between 1 and 20`),
    check('licenses_days_ck', sql`${t.leaseDays} between 1 and 60 and ${t.graceDays} between 0 and 90 and ${t.deviceIdleDays} between 1 and 365`),
  ],
);

export const activations = pgTable(
  'activations',
  {
    id: id(),
    licenseId: uuid()
      .notNull()
      .references(() => licenses.id),
    installationId: uuid().notNull(),
    /** Etkinleştirmede sabitlenen ham (base64url) kurulum açık anahtarı. */
    publicKey: text().notNull(),
    fingerprint: text().notNull(),
    appVersion: text(),
    status: text().notNull().default('active'),
    offline: boolean().notNull().default(false),
    firstSeenAt: createdAt(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastIp: text(),
    /** Kabul edilen son istek zamanı (ms): daha eski/aynı `ts` yeniden oynatma sayılır. */
    lastTs: bigint({ mode: 'number' }).notNull().default(0),
    /** Kurulum kitinin hedefi (linux-x64 / win-x64); kalp atışıyla bildirilir, güncelleme dosyasını seçer. */
    platform: text(),
    reportedDevices: integer().notNull().default(0),
    reportedCompanies: integer().notNull().default(0),
    /** Son görülen farklı IP'ler (en çok 10): klon tespiti için. */
    ipHistory: jsonb().$type<{ ip: string; at: number }[]>().notNull().default(sql`'[]'::jsonb`),
    fingerprintChanges: integer().notNull().default(0),
    flagged: boolean().notNull().default(false),
    flagReason: text(),
    deactivatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('activations_installation_uq').on(t.installationId),
    index('activations_license_idx').on(t.licenseId),
    check('activations_status_ck', sql`${t.status} in ('active', 'deactivated')`),
  ],
);

/** Yalnızca eklenir (tetikleyiciyle, sahip dahil). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    actor: text().notNull(),
    adminId: uuid(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    ip: text(),
    meta: jsonb(),
  },
  (t) => [index('audit_log_at_idx').on(t.at)],
);

/**
 * Uzaktan güncelleme için yayımlanan sürümler. Dosyalar diskte (`RELEASES_DIR/<sürüm>/<ad>`) durur; `files` yüklenen her kit
 * arşivinin özeti ve boyutudur. Yayımlanınca manifesto satıcı anahtarıyla imzalanır ve artık dosya eklenemez.
 */
export const releases = pgTable(
  'releases',
  {
    id: id(),
    version: text().notNull(),
    notes: text().notNull().default(''),
    status: text().notNull().default('draft'),
    sourceCommit: text(),
    ciRun: text(),
    testsPassed: boolean().notNull().default(false),
    installerFile: jsonb().$type<{ name: string; sha256: string; size: number }>(),
    installerSignature: text(),
    files: jsonb().$type<{ target: 'linux-x64' | 'win-x64'; name: string; sha256: string; size: number }[]>().notNull().default(sql`'[]'::jsonb`),
    manifest: text(),
    createdBy: uuid().references(() => admins.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    publishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('releases_version_uq').on(t.version),
    check('releases_status_ck', sql`${t.status} in ('draft', 'published', 'withdrawn')`),
    check('releases_source_commit_ck', sql`${t.sourceCommit} is null or ${t.sourceCommit} ~ '^[0-9a-f]{40}$'`),
    check('releases_manifest_ck', sql`(${t.status} = 'draft') = (${t.manifest} is null)`),
  ],
);

