import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SECTORS } from '@erp/shared';
import {
  DAY_MS,
  clientSupportsSectors,
  LICENSE_KINDS,
  activationCodePrefix,
  formatActivationCode,
  generateActivationCode,
  hashActivationCode,
  normalizeActivationCode,
  type Lease,
} from '@erp/license-core';
import { audit, type AuditEntry } from '../audit';
import type { Tx } from '../db/client';
import { activations, customers, licenses } from '../db/schema';
import { badRequest, conflict, notFound } from '../errors';

export type LicenseRow = typeof licenses.$inferSelect;
export type ActivationRow = typeof activations.$inferSelect;
export type Actor = Pick<AuditEntry, 'actor' | 'adminId' | 'ip'>;

export function requireSupportedSectors(license: Pick<LicenseRow, 'sectors'>, supportedSectors?: readonly string[]) {
  if (!clientSupportsSectors(license.sectors, supportedSectors)) {
    throw conflict('Bu lisansın sektörünü destekleyen ERP sürümüne güncelleyin.', 'CLIENT_UPDATE_REQUIRED');
  }
}

const dateInput = z.union([z.iso.datetime({ offset: true }), z.iso.date()]).transform((v) => {
  // Yalnızca tarih verilirse o günün sonuna kadar geçerli sayılır (23:59:59.999 UTC).
  const d = v.length <= 10 ? new Date(`${v}T23:59:59.999Z`) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error('Geçersiz tarih');
  return d;
});

/**
 * Alan tanımları VARSAYILANSIZDIR (güncellemede eksik alan "değişmesin" demektir; varsayılan uygulanırsa kısmi güncelleme
 * sessizce diğer alanları sıfırlardı). Oluştururken varsayılanlar `createLicenseSchema` içinde verilir.
 */
const licenseFields = {
  kind: z.enum(LICENSE_KINDS),
  sectors: z
    .array(z.enum(SECTORS))
    .min(1)
    .max(SECTORS.length)
    .refine((a) => new Set(a).size === a.length, 'Sektörler tekrar etmemeli'),
  deviceLimit: z.number().int().min(1).max(10_000),
  companyLimit: z.number().int().min(1).max(10_000),
  validUntil: dateInput,
  leaseDays: z.number().int().min(1).max(60),
  validityMode: z.enum(['lease', 'subscription']),
  graceDays: z.number().int().min(0).max(90),
  deviceIdleDays: z.number().int().min(1).max(365),
  maxActivations: z.number().int().min(1).max(20),
  offlineAllowed: z.boolean(),
  notes: z.string().trim().max(2000).nullish(),
};

export const createLicenseSchema = z.object({
  customerId: z.uuid(),
  ...licenseFields,
  kind: licenseFields.kind.default('commercial'),
  companyLimit: licenseFields.companyLimit.default(1),
  leaseDays: licenseFields.leaseDays.default(7),
  validityMode: licenseFields.validityMode.default('subscription'),
  graceDays: licenseFields.graceDays.default(15),
  deviceIdleDays: licenseFields.deviceIdleDays.default(30),
  maxActivations: licenseFields.maxActivations.default(1),
  offlineAllowed: licenseFields.offlineAllowed.default(false),
});
export type CreateLicenseInput = z.infer<typeof createLicenseSchema>;

export const updateLicenseSchema = z
  .object(licenseFields)
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Değiştirilecek en az bir alan verin');
export type UpdateLicenseInput = z.infer<typeof updateLicenseSchema>;

export const createCustomerSchema = z.object({
  name: z.string().trim().min(2).max(200),
  contactName: z.string().trim().max(200).nullish(),
  email: z.string().trim().max(254).nullish(),
  phone: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export async function createCustomer(tx: Tx, input: CreateCustomerInput, actor: Actor) {
  const [row] = await tx
    .insert(customers)
    .values({ name: input.name, contactName: input.contactName ?? null, email: input.email ?? null, phone: input.phone ?? null, notes: input.notes ?? null })
    .returning();
  await audit(tx, { ...actor, action: 'customer.create', targetType: 'customer', targetId: row!.id, meta: { name: row!.name } });
  return row!;
}

/** Customer, licenses and activations are removed in the same audited transaction. */
export async function deleteCustomer(tx: Tx, id: string, actor: Actor) {
  const result = await tx.execute<{ customer_name: string; license_count: number; activation_count: number }>(sql`SELECT * FROM public.delete_license_customer(${id}::uuid)`);
  const row = result.rows[0];
  if (!row) throw notFound('Müşteri bulunamadı');
  const deleted = { name: row.customer_name, licenseCount: row.license_count, activationCount: row.activation_count };
  await audit(tx, { ...actor, action: 'customer.delete', targetType: 'customer', targetId: id, meta: deleted });
  return deleted;
}

/** Yeni lisans ve etkinleştirme kodu (kod yalnızca burada bir kez döner; yalnızca özeti saklanır). */
export async function createLicense(tx: Tx, input: CreateLicenseInput, actor: Actor): Promise<{ license: LicenseRow; code: string }> {
  // Serialize license creation with customer deletion before the FK insert.
  const [customer] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).for('key share');
  if (!customer) throw notFound('Müşteri bulunamadı');
  if (input.validUntil.getTime() <= Date.now()) throw badRequest('Bitiş tarihi gelecekte olmalı', 'VALID_UNTIL_PAST');

  const code = generateActivationCode();
  const normalized = normalizeActivationCode(code)!;
  const [license] = await tx
    .insert(licenses)
    .values({
      customerId: input.customerId,
      kind: input.kind,
      sectors: input.sectors,
      deviceLimit: input.deviceLimit,
      companyLimit: input.companyLimit,
      deviceIdleDays: input.deviceIdleDays,
      validUntil: input.validUntil,
      leaseDays: input.leaseDays,
      validityMode: input.validityMode,
      graceDays: input.graceDays,
      maxActivations: input.maxActivations,
      offlineAllowed: input.offlineAllowed,
      notes: input.notes ?? null,
      codeHash: hashActivationCode(normalized),
      codePrefix: activationCodePrefix(normalized),
    })
    .returning();
  await audit(tx, {
    ...actor,
    action: 'license.create',
    targetType: 'license',
    targetId: license!.id,
    meta: { kind: input.kind, sectors: input.sectors, deviceLimit: input.deviceLimit, companyLimit: input.companyLimit, validUntil: input.validUntil.toISOString() },
  });
  return { license: license!, code };
}

export async function getLicenseForUpdate(tx: Tx, id: string): Promise<LicenseRow> {
  const rows = await tx.execute(sql`select id from licenses where id = ${id} for update`);
  if (rows.rows.length === 0) throw notFound('Lisans bulunamadı');
  const [row] = await tx.select().from(licenses).where(eq(licenses.id, id));
  return row!;
}

export async function updateLicense(tx: Tx, id: string, input: UpdateLicenseInput, actor: Actor): Promise<LicenseRow> {
  await getLicenseForUpdate(tx, id);
  const set: Partial<typeof licenses.$inferInsert> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  const [row] = await tx.update(licenses).set(set).where(eq(licenses.id, id)).returning();
  await audit(tx, { ...actor, action: 'license.update', targetType: 'license', targetId: id, meta: { fields: Object.keys(input) } });
  return row!;
}

export async function setLicenseStatus(tx: Tx, id: string, status: 'active' | 'suspended' | 'revoked', actor: Actor): Promise<LicenseRow> {
  const current = await getLicenseForUpdate(tx, id);
  // İptal kalıcıdır: iptal edilmiş lisans yeniden açılamaz (yeni lisans verilir).
  if (current.status === 'revoked') throw conflict('İptal edilmiş lisans yeniden etkinleştirilemez; yeni lisans verin', 'LICENSE_REVOKED');
  const [row] = await tx.update(licenses).set({ status, updatedAt: new Date() }).where(eq(licenses.id, id)).returning();
  await audit(tx, { ...actor, action: `license.${status === 'active' ? 'resume' : status === 'suspended' ? 'suspend' : 'revoke'}`, targetType: 'license', targetId: id });
  return row!;
}

export async function extendLicense(tx: Tx, id: string, validUntil: Date, actor: Actor): Promise<LicenseRow> {
  await getLicenseForUpdate(tx, id);
  const [row] = await tx.update(licenses).set({ validUntil, updatedAt: new Date() }).where(eq(licenses.id, id)).returning();
  await audit(tx, { ...actor, action: 'license.extend', targetType: 'license', targetId: id, meta: { validUntil: validUntil.toISOString() } });
  return row!;
}

/** Yeni kod üretir; eskisi anında geçersiz olur (mevcut etkinleştirmeler etkilenmez). */
export async function regenerateCode(tx: Tx, id: string, actor: Actor): Promise<{ license: LicenseRow; code: string }> {
  await getLicenseForUpdate(tx, id);
  const code = generateActivationCode();
  const normalized = normalizeActivationCode(code)!;
  const [row] = await tx
    .update(licenses)
    .set({ codeHash: hashActivationCode(normalized), codePrefix: activationCodePrefix(normalized), updatedAt: new Date() })
    .where(eq(licenses.id, id))
    .returning();
  await audit(tx, { ...actor, action: 'license.code_regenerated', targetType: 'license', targetId: id });
  return { license: row!, code };
}

/** Sunucu taşıma: etkinleştirmeyi devre dışı bırakır (kurulum yeniden etkinleştirilebilir). */
export async function deactivateActivation(tx: Tx, activationId: string, actor: Actor): Promise<ActivationRow> {
  const [act] = await tx.select().from(activations).where(eq(activations.id, activationId));
  if (!act) throw notFound('Etkinleştirme bulunamadı');
  await getLicenseForUpdate(tx, act.licenseId);
  if (act.status === 'deactivated') return act;
  const [row] = await tx.update(activations).set({ status: 'deactivated', deactivatedAt: new Date() }).where(eq(activations.id, activationId)).returning();
  await tx.update(licenses).set({ transfersUsed: sql`${licenses.transfersUsed} + 1`, updatedAt: new Date() }).where(eq(licenses.id, act.licenseId));
  await audit(tx, { ...actor, action: 'activation.deactivate', targetType: 'activation', targetId: activationId, meta: { licenseId: act.licenseId } });
  return row!;
}

export async function countActiveActivations(tx: Tx, licenseId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(activations)
    .where(and(eq(activations.licenseId, licenseId), eq(activations.status, 'active')));
  return r?.n ?? 0;
}

export const serializeLicense = (l: LicenseRow) => ({
  id: l.id,
  customerId: l.customerId,
  kind: l.kind,
  status: l.status,
  sectors: l.sectors,
  deviceLimit: l.deviceLimit,
  companyLimit: l.companyLimit,
  deviceIdleDays: l.deviceIdleDays,
  validUntil: l.validUntil.toISOString(),
  leaseDays: l.leaseDays,
  validityMode: l.validityMode,
  graceDays: l.graceDays,
  maxActivations: l.maxActivations,
  offlineAllowed: l.offlineAllowed,
  codePrefix: l.codePrefix,
  transfersUsed: l.transfersUsed,
  notes: l.notes,
  createdAt: l.createdAt.toISOString(),
  updatedAt: l.updatedAt.toISOString(),
});

export const serializeActivation = (a: ActivationRow) => ({
  id: a.id,
  licenseId: a.licenseId,
  installationId: a.installationId,
  fingerprintPrefix: a.fingerprint.slice(0, 12),
  appVersion: a.appVersion,
  status: a.status,
  offline: a.offline,
  firstSeenAt: a.firstSeenAt.toISOString(),
  lastSeenAt: a.lastSeenAt.toISOString(),
  lastIp: a.lastIp,
  reportedDevices: a.reportedDevices,
  reportedCompanies: a.reportedCompanies,
  fingerprintChanges: a.fingerprintChanges,
  flagged: a.flagged,
  flagReason: a.flagReason,
  deactivatedAt: a.deactivatedAt?.toISOString() ?? null,
});

/** Lisans satırından kira yükü üretir (imzalanmadan önce). Askıda/iptalde kira hemen biter ve durum bildirilir. */
export function buildLease(
  license: LicenseRow,
  customerName: string,
  installation: { installationId: string; fingerprint: string },
  o: { typ: Lease['typ']; nonce: string; now: number; leaseDays?: number; protocolVersion?: 2 },
): Lease {
  const validUntil = license.validUntil.getTime();
  const active = license.status === 'active';
  const subscription = o.protocolVersion === 2 && license.validityMode === 'subscription';
  const leaseUntil = active ? subscription ? validUntil : Math.min(o.now + (o.leaseDays ?? license.leaseDays) * DAY_MS, validUntil) : o.now;
  return {
    v: o.protocolVersion === 2 ? 2 : 1,
    ...(o.protocolVersion === 2 ? { validityMode: subscription ? 'subscription' as const : 'lease' as const } : {}),
    typ: o.typ,
    licenseId: license.id,
    customer: customerName,
    kind: license.kind as Lease['kind'],
    status: license.status as Lease['status'],
    sectors: license.sectors as Lease['sectors'],
    deviceLimit: license.deviceLimit,
    companyLimit: license.companyLimit,
    deviceIdleDays: license.deviceIdleDays,
    validUntil,
    leaseUntil,
    graceDays: license.graceDays,
    issuedAt: o.now,
    serverTime: o.now,
    installationId: installation.installationId,
    fingerprint: installation.fingerprint,
    nonce: o.nonce,
  };
}

export { formatActivationCode };
