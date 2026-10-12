import { and, desc, eq, getTableColumns, ilike, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { decodeFeedbackImage, feedbackContentHash, FEEDBACK_STATUSES, type FeedbackRequest } from '@erp/license-core';
import { audit } from '../audit';
import { activations, feedback, licenses } from '../db/schema';
import type { Tx } from '../db/client';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { adminRoute } from './admin-auth';
import type { ActivationRow } from './licenses';

const idParam = z.object({ id: z.uuid() });
const receipt = (r: typeof feedback.$inferSelect) => ({ id: r.id, reference: r.reference, status: r.status, createdAt: r.createdAt.toISOString() });

export async function receiveFeedback(tx: Tx, activation: ActivationRow, input: FeedbackRequest, now: number, ip: string) {
  const contentHash = feedbackContentHash(input);
  // Keep the same lock order as customer deletion: customer, license, installation.
  const customer = (await tx.execute<{ id: string; name: string }>(sql`select c.id, c.name from customers c inner join licenses l on l.customer_id = c.id where l.id = ${activation.licenseId}::uuid for key share of c`)).rows[0];
  if (!customer) throw notFound('Kurulumun müşterisi bulunamadı');
  await tx.select({ id: licenses.id }).from(licenses).where(eq(licenses.id, activation.licenseId)).for('key share');
  // Serialize retries for one installation without modifying licensing heartbeat timestamps.
  const [current] = await tx.select({ status: activations.status, fingerprint: activations.fingerprint }).from(activations).where(eq(activations.id, activation.id)).for('update');
  if (!current || current.status !== 'active') throw forbidden('Bu kurulum devre dışı bırakılmış; yeniden etkinleştirin', 'DEACTIVATED');
  if (current.fingerprint !== input.fingerprint) throw conflict('Sunucu parmak izi değişti; kurulumu yeniden doğrulayın', 'FINGERPRINT_CHANGED');
  const [previous] = await tx.select().from(feedback).where(and(eq(feedback.installationId, input.installationId), eq(feedback.requestId, input.feedback.requestId)));
  if (previous) {
    if (previous.contentHash !== contentHash) throw conflict('Aynı bildirim kimliği farklı bir içerikle gönderilemez', 'FEEDBACK_REQUEST_CONFLICT');
    return receipt(previous);
  }
  const [replayed] = await tx.select({ id: feedback.id }).from(feedback).where(and(eq(feedback.installationId, input.installationId), eq(feedback.nonce, input.nonce)));
  if (replayed) throw conflict('İstek yeniden oynatılmış', 'REPLAY');
  let screenshotData: Buffer | null = null;
  if (input.feedback.screenshot) {
    try { screenshotData = decodeFeedbackImage(input.feedback.screenshot); }
    catch (err) { throw badRequest(err instanceof Error ? err.message : 'Ekran görüntüsü geçersiz', 'INVALID_SCREENSHOT'); }
  }
  const id = uuidv7();
  const [row] = await tx.insert(feedback).values({
    id, reference: `GB-${id.replaceAll('-', '').slice(-12).toUpperCase()}`,
    installationId: input.installationId, activationId: activation.id,
    customerId: customer.id, customerName: customer.name,
    requestId: input.feedback.requestId, nonce: input.nonce, contentHash,
    companyId: input.company.id, companyName: input.company.name, companySector: input.company.sector,
    reporterId: input.reporter.id, reporterName: input.reporter.name, reporterEmail: input.reporter.email,
    pagePath: input.feedback.pagePath, pageTitle: input.feedback.pageTitle,
    message: input.feedback.message, steps: input.feedback.steps, expected: input.feedback.expected,
    appVersion: input.appVersion,
    screenshotName: input.feedback.screenshot?.name ?? null,
    screenshotMime: input.feedback.screenshot?.mime ?? null,
    screenshotSize: screenshotData?.length ?? null, screenshotData,
    createdAt: new Date(now), updatedAt: new Date(now),
  }).returning();
  await audit(tx, { actor: 'installation', action: 'feedback.create', targetType: 'feedback', targetId: id, ip, meta: { installationId: input.installationId, customerId: customer.id, hasScreenshot: Boolean(screenshotData) } });
  return receipt(row!);
}

const summaryColumns = {
  id: feedback.id, reference: feedback.reference, status: feedback.status,
  customerId: feedback.customerId, customerName: feedback.customerName,
  companyName: feedback.companyName, reporterName: feedback.reporterName,
  pageTitle: feedback.pageTitle, pagePath: feedback.pagePath, message: feedback.message,
  hasScreenshot: sql<boolean>`${feedback.screenshotData} is not null`, createdAt: feedback.createdAt,
};

export const feedbackAdminRoutes: FastifyPluginAsync = async app => {
  app.get('/admin/api/feedback', adminRoute(app, async ({ tx, req }) => {
    const query = z.object({
      q: z.string().trim().max(100).optional(), status: z.enum(FEEDBACK_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(req.query);
    const search = query.q?.replace(/[\\%_]/g, m => `\\${m}`);
    const where = and(query.status ? eq(feedback.status, query.status) : undefined,
      search ? or(...[feedback.reference, feedback.customerName, feedback.companyName, feedback.reporterName, feedback.message, feedback.pageTitle].map(c => ilike(c, `%${search}%`))) : undefined);
    const items = await tx.select(summaryColumns).from(feedback).where(where).orderBy(desc(feedback.createdAt), desc(feedback.id)).limit(query.limit).offset(query.offset);
    const [total] = await tx.select({ value: sql<number>`count(*)::int` }).from(feedback).where(where);
    const groups = await tx.select({ status: feedback.status, value: sql<number>`count(*)::int` }).from(feedback).groupBy(feedback.status);
    const counts = { new: 0, in_review: 0, resolved: 0 };
    for (const group of groups) counts[group.status as keyof typeof counts] = group.value;
    return { feedback: items, total: total?.value ?? 0, counts };
  }));
  app.get('/admin/api/feedback/:id', adminRoute(app, async ({ tx, req }) => {
    const { id } = idParam.parse(req.params);
    const { screenshotData: _data, nonce: _nonce, contentHash: _hash, ...columns } = getTableColumns(feedback);
    const [row] = await tx.select(columns).from(feedback).where(eq(feedback.id, id));
    if (!row) throw notFound('Geri bildirim bulunamadı');
    const { screenshotName, screenshotMime, screenshotSize, ...report } = row;
    return { feedback: { ...report, hasScreenshot: Boolean(screenshotName), screenshot: screenshotName ? { name: screenshotName, mime: screenshotMime, size: screenshotSize } : null } };
  }));
  app.get('/admin/api/feedback/:id/screenshot', adminRoute(app, async ({ tx, req, reply }) => {
    const { id } = idParam.parse(req.params);
    const [row] = await tx.select({ data: feedback.screenshotData, mime: feedback.screenshotMime }).from(feedback).where(eq(feedback.id, id));
    if (!row?.data || !row.mime) throw notFound('Ekran görüntüsü bulunamadı');
    void reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').type(row.mime);
    return reply.send(row.data);
  }));
  app.patch('/admin/api/feedback/:id', adminRoute(app, async ({ tx, req, admin }) => {
    const { id } = idParam.parse(req.params);
    const input = z.object({ status: z.enum(FEEDBACK_STATUSES), internalNote: z.string().trim().max(4000).refine(s => !s.includes('\0'), 'Not geçersiz bir karakter içeriyor').optional() }).strict().parse(req.body);
    const [row] = await tx.update(feedback).set({ ...input, updatedAt: new Date(app.now()) }).where(eq(feedback.id, id)).returning({ id: feedback.id, status: feedback.status, internalNote: feedback.internalNote, updatedAt: feedback.updatedAt });
    if (!row) throw notFound('Geri bildirim bulunamadı');
    await audit(tx, { actor: 'admin', adminId: admin.id, action: 'feedback.update', targetType: 'feedback', targetId: id, ip: req.ip, meta: { status: input.status, noteChanged: input.internalNote !== undefined } });
    return { feedback: row };
  }));
};
