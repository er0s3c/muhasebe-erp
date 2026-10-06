import { and, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DAY_MS,
  LicenseTokenError,
  decodeRequestCode,
  formatActivationCode,
  normalizeActivationCode,
  offlineRequestSchema,
  signToken,
} from '@erp/license-core';
import { audit } from '../audit';
import { activations, auditLog, customers, licenses } from '../db/schema';
import { badRequest, conflict, notFound } from '../errors';
import { adminRoute } from './admin-auth';
import {
  buildLease,
  countActiveActivations,
  createCustomer,
  createCustomerSchema,
  createLicense,
  createLicenseSchema,
  deleteCustomer,
  deactivateActivation,
  extendLicense,
  getLicenseForUpdate,
  regenerateCode,
  serializeActivation,
  serializeLicense,
  setLicenseStatus,
  updateLicense,
  updateLicenseSchema,
} from './licenses';

const idParam = z.object({ id: z.uuid() });

export const adminApiRoutes: FastifyPluginAsync = async (app) => {
  const actor = (admin: { id: string }, ip: string) => ({ actor: 'admin' as const, adminId: admin.id, ip });

  // ---- Özet ------------------------------------------------------------------------------------------------
  app.get(
    '/admin/api/dashboard',
    adminRoute(app, async ({ tx }) => {
      const now = new Date(app.now());
      const soon = new Date(app.now() + 30 * DAY_MS);
      const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(customers);
      const byStatus = await tx.select({ status: licenses.status, n: sql<number>`count(*)::int` }).from(licenses).groupBy(licenses.status);
      const [act] = await tx
        .select({
          active: sql<number>`count(*) filter (where ${activations.status} = 'active')::int`,
          flagged: sql<number>`count(*) filter (where ${activations.flagged} and ${activations.status} = 'active')::int`,
          devices: sql<number>`coalesce(sum(${activations.reportedDevices}) filter (where ${activations.status} = 'active'), 0)::int`,
        })
        .from(activations);
      const [exp] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(licenses)
        .where(and(eq(licenses.status, 'active'), lt(licenses.validUntil, soon), sql`${licenses.validUntil} >= ${now}`));
      return {
        customers: c?.n ?? 0,
        licenses: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
        activations: { active: act?.active ?? 0, flagged: act?.flagged ?? 0, reportedDevices: act?.devices ?? 0 },
        expiringIn30Days: exp?.n ?? 0,
      };
    }),
  );

  // ---- Müşteriler --------------------------------------------------------------------------------------------
  app.get(
    '/admin/api/customers',
    adminRoute(app, async ({ tx, req }) => {
      const q = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
      const escaped = q.q?.replace(/[\\%_]/g, (m) => `\\${m}`);
      const rows = await tx
        .select()
        .from(customers)
        .where(escaped ? or(ilike(customers.name, `%${escaped}%`), ilike(customers.email, `%${escaped}%`)) : undefined)
        .orderBy(customers.name)
        .limit(500);
      return { customers: rows };
    }),
  );

  app.post(
    '/admin/api/customers',
    adminRoute(app, async ({ tx, admin, req, reply }) => {
      const customer = await createCustomer(tx, createCustomerSchema.parse(req.body), actor(admin, req.ip));
      void reply.code(201);
      return { customer };
    }),
  );

  app.get(
    '/admin/api/customers/:id',
    adminRoute(app, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const [customer] = await tx.select().from(customers).where(eq(customers.id, id));
      if (!customer) throw notFound('Müşteri bulunamadı');
      const rows = await tx.select().from(licenses).where(eq(licenses.customerId, id)).orderBy(desc(licenses.createdAt));
      const [activationsCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(activations)
        .innerJoin(licenses, eq(activations.licenseId, licenses.id)).where(eq(licenses.customerId, id));
      return { customer, licenses: rows.map(serializeLicense), activationCount: activationsCount?.n ?? 0 };
    }),
  );

  app.patch(
    '/admin/api/customers/:id',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const input = createCustomerSchema.partial().parse(req.body);
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined) set[k] = v;
      if (Object.keys(set).length === 0) throw badRequest('Değiştirilecek alan yok');
      const [row] = await tx.update(customers).set(set).where(eq(customers.id, id)).returning();
      if (!row) throw notFound('Müşteri bulunamadı');
      await audit(tx, { ...actor(admin, req.ip), action: 'customer.update', targetType: 'customer', targetId: id, meta: { fields: Object.keys(set) } });
      return { customer: row };
    }),
  );

  app.delete(
    '/admin/api/customers/:id',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const deleted = await deleteCustomer(tx, id, actor(admin, req.ip));
      return { ok: true, deleted };
    }),
  );

  // ---- Lisanslar ----------------------------------------------------------------------------------------------
  app.get(
    '/admin/api/licenses',
    adminRoute(app, async ({ tx, req }) => {
      const q = z
        .object({ status: z.enum(['active', 'suspended', 'revoked']).optional(), customerId: z.uuid().optional() })
        .parse(req.query);
      const conds = [q.status ? eq(licenses.status, q.status) : undefined, q.customerId ? eq(licenses.customerId, q.customerId) : undefined].filter((c) => c !== undefined);
      const rows = await tx
        .select({ license: licenses, customer: customers.name })
        .from(licenses)
        .innerJoin(customers, eq(customers.id, licenses.customerId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(licenses.createdAt))
        .limit(500);
      const counts = await tx
        .select({ licenseId: activations.licenseId, n: sql<number>`count(*) filter (where ${activations.status} = 'active')::int`, devices: sql<number>`coalesce(sum(${activations.reportedDevices}) filter (where ${activations.status} = 'active'), 0)::int`, flagged: sql<number>`bool_or(${activations.flagged} and ${activations.status} = 'active')` })
        .from(activations)
        .where(inArray(activations.licenseId, rows.map((r) => r.license.id).concat('00000000-0000-0000-0000-000000000000')))
        .groupBy(activations.licenseId);
      const byLicense = new Map(counts.map((c) => [c.licenseId, c]));
      return {
        licenses: rows.map((r) => ({
          ...serializeLicense(r.license),
          customer: r.customer,
          activeActivations: byLicense.get(r.license.id)?.n ?? 0,
          reportedDevices: byLicense.get(r.license.id)?.devices ?? 0,
          flagged: byLicense.get(r.license.id)?.flagged ?? false,
        })),
      };
    }),
  );

  app.post(
    '/admin/api/licenses',
    adminRoute(app, async ({ tx, admin, req, reply }) => {
      const { license, code } = await createLicense(tx, createLicenseSchema.parse(req.body), actor(admin, req.ip));
      void reply.code(201);
      // Kod yalnızca burada bir kez görünür.
      return { license: serializeLicense(license), activationCode: formatActivationCode(normalizeActivationCode(code)!) };
    }),
  );

  app.get(
    '/admin/api/licenses/:id',
    adminRoute(app, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const [row] = await tx
        .select({ license: licenses, customer: customers.name })
        .from(licenses)
        .innerJoin(customers, eq(customers.id, licenses.customerId))
        .where(eq(licenses.id, id));
      if (!row) throw notFound('Lisans bulunamadı');
      const acts = await tx.select().from(activations).where(eq(activations.licenseId, id)).orderBy(desc(activations.lastSeenAt));
      return { license: { ...serializeLicense(row.license), customer: row.customer }, activations: acts.map(serializeActivation) };
    }),
  );

  app.patch(
    '/admin/api/licenses/:id',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      return { license: serializeLicense(await updateLicense(tx, id, updateLicenseSchema.parse(req.body), actor(admin, req.ip))) };
    }),
  );

  app.post(
    '/admin/api/licenses/:id/extend',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const { validUntil } = z.object({ validUntil: createLicenseSchema.shape.validUntil }).parse(req.body);
      return { license: serializeLicense(await extendLicense(tx, id, validUntil, actor(admin, req.ip))) };
    }),
  );

  for (const [path, status] of [
    ['suspend', 'suspended'],
    ['resume', 'active'],
    ['revoke', 'revoked'],
  ] as const) {
    app.post(
      `/admin/api/licenses/:id/${path}`,
      adminRoute(app, async ({ tx, admin, req }) => {
        const { id } = idParam.parse(req.params);
        return { license: serializeLicense(await setLicenseStatus(tx, id, status, actor(admin, req.ip))) };
      }),
    );
  }

  app.post(
    '/admin/api/licenses/:id/regenerate-code',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const { license, code } = await regenerateCode(tx, id, actor(admin, req.ip));
      return { license: serializeLicense(license), activationCode: formatActivationCode(normalizeActivationCode(code)!) };
    }),
  );

  // ---- Etkinleştirmeler ---------------------------------------------------------------------------------------
  app.post(
    '/admin/api/activations/:id/deactivate',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      return { activation: serializeActivation(await deactivateActivation(tx, id, actor(admin, req.ip))) };
    }),
  );

  app.post(
    '/admin/api/activations/:id/clear-flag',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const [row] = await tx.update(activations).set({ flagged: false, flagReason: null }).where(eq(activations.id, id)).returning();
      if (!row) throw notFound('Etkinleştirme bulunamadı');
      await audit(tx, { ...actor(admin, req.ip), action: 'activation.clear_flag', targetType: 'activation', targetId: id });
      return { activation: serializeActivation(row) };
    }),
  );

  // ---- Çevrimdışı etkinleştirme -------------------------------------------------------------------------------
  /**
   * Müşterinin uygulamasından aldığı "istek kodunu" imzalı, uzun süreli bir çevrimdışı kiraya çevirir.
   * Kurulumun açık anahtarı bu noktada sabitlenir; kira yenilenemez (süre bitince yeni istek kodu gerekir).
   */
  app.post(
    '/admin/api/licenses/:id/offline-lease',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const { requestCode, days } = z.object({ requestCode: z.string().min(20).max(4096), days: z.number().int().min(1).max(400).default(90) }).parse(req.body);
      let decoded: ReturnType<typeof decodeRequestCode>;
      try {
        decoded = decodeRequestCode(requestCode);
      } catch (err) {
        if (err instanceof LicenseTokenError) throw badRequest('İstek kodu geçersiz', 'INVALID_REQUEST_CODE');
        throw err;
      }
      const request = offlineRequestSchema.safeParse(decoded.payload);
      if (!request.success) throw badRequest('İstek kodu içeriği geçersiz', 'INVALID_REQUEST_CODE');
      const now = app.now();
      if (Math.abs(now - request.data.ts) > 7 * DAY_MS) throw badRequest('İstek kodu çok eski; uygulamadan yenisini alın', 'REQUEST_CODE_EXPIRED');

      const license = await getLicenseForUpdate(tx, id);
      if (!license.offlineAllowed) throw conflict('Bu lisans çevrimdışı etkinleştirmeye izin vermiyor', 'OFFLINE_NOT_ALLOWED');
      if (license.status !== 'active') throw conflict('Lisans etkin değil', 'LICENSE_NOT_ACTIVE');
      if (license.validUntil.getTime() < now) throw conflict('Lisansın süresi dolmuş', 'LICENSE_EXPIRED');
      const [customer] = await tx.select({ name: customers.name }).from(customers).where(eq(customers.id, license.customerId));

      const [existing] = await tx.select().from(activations).where(eq(activations.installationId, request.data.installationId));
      if (existing) {
        if (existing.licenseId !== license.id) throw conflict('Bu kurulum başka bir lisansa bağlı', 'INSTALLATION_IN_USE');
        if (existing.publicKey !== decoded.publicKey) throw conflict('Kurulum anahtarı uyuşmuyor', 'INSTALLATION_KEY_MISMATCH');
        await tx
          .update(activations)
          .set({ status: 'active', deactivatedAt: null, fingerprint: request.data.fingerprint, offline: true, appVersion: request.data.appVersion, lastSeenAt: new Date(now) })
          .where(eq(activations.id, existing.id));
      } else {
        if ((await countActiveActivations(tx, license.id)) >= license.maxActivations) {
          throw conflict(`Bu lisans en fazla ${license.maxActivations} sunucuda etkinleştirilebilir`, 'ACTIVATION_LIMIT');
        }
        await tx.insert(activations).values({
          licenseId: license.id,
          installationId: request.data.installationId,
          publicKey: decoded.publicKey,
          fingerprint: request.data.fingerprint,
          appVersion: request.data.appVersion,
          offline: true,
          lastSeenAt: new Date(now),
        });
      }
      const lease = buildLease(license, customer!.name, { installationId: request.data.installationId, fingerprint: request.data.fingerprint }, { typ: 'offline-lease', nonce: request.data.requestId, now, leaseDays: days });
      await audit(tx, { ...actor(admin, req.ip), action: 'license.offline_lease', targetType: 'license', targetId: id, meta: { installationId: request.data.installationId, days } });
      return { lease: signToken('offline-lease', lease, app.signer), leaseUntil: new Date(lease.leaseUntil).toISOString() };
    }),
  );

  // ---- Denetim kaydı ------------------------------------------------------------------------------------------
  app.get(
    '/admin/api/audit',
    adminRoute(app, async ({ tx, req }) => {
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().optional() }).parse(req.query);
      const rows = await tx
        .select()
        .from(auditLog)
        .where(q.before ? lt(auditLog.id, q.before) : undefined)
        .orderBy(desc(auditLog.id))
        .limit(q.limit);
      return { entries: rows };
    }),
  );
};
