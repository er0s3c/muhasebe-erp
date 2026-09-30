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
    graceDays: integer().notNull().default(14),
    maxActivations: integer().notNull().default(1),
    offlineAllowed: boolean().notNull().default(false),
    /** Etkinleştirme kodunun özeti; kodun kendisi saklanmaz (yalnızca oluşturulurken bir kez gösterilir). */
    codeHash: text().notNull(),
    codePrefix: text().notNull(),
    /** Sunucu taşıma (devre dışı bırakma) sayısı. */
    transfersUsed: integer().notNull().default(0),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('licenses_code_hash_uq').on(t.codeHash),
    index('licenses_customer_idx').on(t.customerId),
    check('licenses_kind_ck', sql`${t.kind} in ('commercial', 'trial', 'demo')`),
    check('licenses_status_ck', sql`${t.status} in ('active', 'suspended', 'revoked')`),
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
