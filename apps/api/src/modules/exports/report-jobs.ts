import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { EXPORT_FORMATS, idParam } from '@erp/shared';
import { withContext } from '../../db/client';
import { exportEvents, reportJobs } from '../../db/schema';
import { renderCsv } from '../../files/csv-write';
import { writeXlsx, XLSX_CONTENT_TYPE } from '../../files/xlsx-write';
import { AppError, badRequest, forbidden, notFound } from '../../http/errors';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { EXPORTS } from './registry';
import { assertExportAllowed } from './routes';
import type { BuildCtx } from './builders';

/**
 * Arka planda büyük rapor (öneri 20). İstek kuyruğa alınır ve yanıt hemen döner; rapor ayrı bir veritabanı işleminde, tek
 * anlık görüntüyle (REPEATABLE READ) üretilir. İlerleme ve iptal izlenir; dosya 24 saat tutulur, yalnız isteyen kullanıcı indirir.
 * Süreç yeniden başlarsa yarım kalan iş "çalışıyor" görünmez: 30 dakikadan eski çalışan iş başarısız sayılır.
 */
const TTL_MS = 24 * 3600 * 1000;
const STALE_MS = 30 * 60 * 1000;

interface JobCtx {
  companyId: string;
  userId: string;
  orgId: string;
  /** İsteği yapanın şube görünümü; arka plan işi de aynı şube süzgeciyle okur. */
  branch: { id: string; selection: string };
  build: Omit<BuildCtx, 'tx'>;
}

async function setJob(app: FastifyInstance, ctx: JobCtx, id: string, values: Partial<typeof reportJobs.$inferInsert>) {
  await withContext(app.db, { userId: ctx.userId, orgId: ctx.orgId, companyId: ctx.companyId }, (tx) => tx.update(reportJobs).set(values).where(eq(reportJobs.id, id)));
}

export async function runReportJob(app: FastifyInstance, id: string, ctx: JobCtx, attempt = 0): Promise<void> {
  // Anlık dışa aktarmalarla aynı eşzamanlılık sınırı; doluysa kısa bekleyip tekrar dener
  if (!app.exportGate.tryAcquire()) {
    if (attempt > 150) return setJob(app, ctx, id, { status: 'failed', error: 'Dışa aktarma kuyruğu çok uzun sürdü', finishedAt: new Date() });
    setTimeout(() => void runReportJob(app, id, ctx, attempt + 1), 2000).unref();
    return;
  }
  try {
    const started = await withContext(app.db, { userId: ctx.userId, orgId: ctx.orgId, companyId: ctx.companyId }, async (tx) => {
      const [job] = await tx.update(reportJobs).set({ status: 'running', progress: 10, startedAt: new Date() }).where(and(eq(reportJobs.id, id), eq(reportJobs.status, 'queued'))).returning();
      return job;
    });
    if (!started) {
      // İsteğin işlemi henüz kaydedilmemiş olabilir: iş görünür olana kadar kısa aralıklarla yeniden dene
      const exists = await withContext(app.db, { userId: ctx.userId, orgId: ctx.orgId, companyId: ctx.companyId }, (tx) => tx.select({ id: reportJobs.id }).from(reportJobs).where(eq(reportJobs.id, id)));
      if (!exists.length && attempt < 50) setTimeout(() => void runReportJob(app, id, ctx, attempt + 1), 100).unref();
      return;
    }
    const def = EXPORTS.find((d) => d.key === started.reportKey);
    if (!def) return setJob(app, ctx, id, { status: 'failed', error: 'Rapor tanımı bulunamadı', finishedAt: new Date() });
    // Saklanan ham sorgu çalıştırılırken bir kez ayrıştırılır (ayrıştırılmış çıktı şemaya yeniden girmez: ör. "true" → true)
    const query = def.schema.parse(started.params);
    // Tutarlı görünüm: raporun tüm sorguları aynı anlık görüntüden okur
    const tables = await app.db.transaction(
      async (tx) => {
        await tx.execute(
          sql`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.org_id', ${ctx.orgId}, true), set_config('app.company_id', ${ctx.companyId}, true), set_config('app.branch_id', ${ctx.branch.id}, true), set_config('app.branch_selection', ${ctx.branch.selection}, true), set_config('transaction_read_only', 'on', true)`,
        );
        return def.build({ ...ctx.build, tx }, query as never);
      },
      { isolationLevel: 'repeatable read' },
    );
    const rowCount = (started.format === 'csv' ? [tables[0]!] : tables).reduce((n, t) => n + t.rows.length, 0);
    const body = started.format === 'csv' ? Buffer.from(renderCsv(tables[0]!), 'utf8') : Buffer.from(writeXlsx(tables));
    await withContext(app.db, { userId: ctx.userId, orgId: ctx.orgId, companyId: ctx.companyId }, async (tx) => {
      // Üretim sırasında iptal edildiyse dosya yazılmaz
      const [done] = await tx
        .update(reportJobs)
        .set({
          status: 'completed',
          progress: 100,
          rowCount,
          fileName: `${def.fileName(query as never)}.${started.format}`,
          content: body.toString('base64'),
          finishedAt: new Date(),
          expiresAt: new Date(Date.now() + TTL_MS),
        })
        .where(and(eq(reportJobs.id, id), eq(reportJobs.status, 'running')))
        .returning({ id: reportJobs.id });
      if (done) await tx.insert(exportEvents).values({ companyId: ctx.companyId, userId: ctx.userId, reportKey: def.key, format: started.format, rowCount, requestId: `job:${id}` });
    });
  } catch (error) {
    if (!(error instanceof AppError)) app.log.error({ err: error, reportJobId: id }, 'Arka plan raporu hazırlanamadı');
    await setJob(app, ctx, id, { status: 'failed', error: error instanceof AppError ? error.message : 'Rapor hazırlanamadı', finishedAt: new Date() }).catch(() => undefined);
  } finally {
    app.exportGate.release();
  }
}

const jobOut = (j: typeof reportJobs.$inferSelect) => {
  const stale = j.status === 'running' && j.startedAt !== null && Date.now() - j.startedAt.getTime() > STALE_MS;
  const expired = j.status === 'completed' && j.expiresAt !== null && j.expiresAt.getTime() < Date.now();
  return {
    id: j.id,
    reportKey: j.reportKey,
    format: j.format,
    status: stale ? 'failed' : expired ? 'expired' : j.status,
    progress: j.progress,
    rowCount: j.rowCount,
    fileName: j.fileName,
    error: stale ? 'İşlem yarıda kaldı; yeniden başlatın' : j.error,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
    expiresAt: j.expiresAt,
  };
};

export const reportJobRoutes: FastifyPluginAsync = async (app) => {
  const own = async (c: TenantCtx, id: string) => {
    const [j] = await c.tx.select().from(reportJobs).where(and(eq(reportJobs.id, id), eq(reportJobs.userId, c.user.id)));
    if (!j) throw notFound('Rapor işi');
    return j;
  };

  app.post(
    '/api/report-jobs',
    // Asıl yetki raporun kendi iznidir (aşağıda); rota düzeyinde yalnız çalışma alanı kullanımı istenir
    tenantRoute(app, { permission: 'workspace.use', operation: 'read', limit: { name: 'report-job', max: 20, windowMs: 60_000 } }, async (c) => {
      const body = z.object({ reportKey: z.string().max(80), format: z.enum(EXPORT_FORMATS).default('xlsx'), query: z.record(z.string(), z.unknown()).default({}) }).parse(c.req.body);
      const def = EXPORTS.find((d) => d.key === body.reportKey);
      if (!def) throw badRequest('Rapor bulunamadı', 'REPORT_NOT_FOUND');
      // Anlık dışa aktarmayla aynı izin ve modül kuralı
      if (!c.access.permissions.has(def.permission)) throw forbidden();
      if (!def.alternateModules && !c.enabledModules.has(def.module)) throw forbidden('Bu raporun modülü şirketinizde etkin değil');
      assertExportAllowed(def, c);
      if (!def.formats.includes(body.format)) throw badRequest(`Bu rapor yalnızca ${def.formats.join(', ').toUpperCase()} olarak alınabilir`, 'EXPORT_FORMAT_UNSUPPORTED');
      // Sorgu şimdi doğrulanır, ham hali saklanır; çalıştırıcı aynı şemayla ayrıştırır
      def.schema.parse(body.query);
      const [job] = await c.tx.insert(reportJobs).values({ companyId: c.company.id, userId: c.user.id, reportKey: def.key, format: body.format, params: body.query }).returning();
      const jobCtx: JobCtx = {
        companyId: c.company.id,
        userId: c.user.id,
        orgId: c.user.orgId,
        branch: { id: c.branch.activeBranchId ?? '', selection: c.branch.selection },
        build: {
          company: { name: c.company.name, baseCurrency: c.company.baseCurrency, reportingCurrency: c.company.reportingCurrency, timeZone: c.company.timeZone },
          user: { id: c.user.id, role: c.role },
          access: { companyId: c.company.id, permissions: c.access.permissions, enabledModules: c.enabledModules },
        },
      };
      // İş ayrı işlemde başlar; isteğin işlemi kaydedilene kadar iş görünmez, çalıştırıcı bunu bekler
      setTimeout(() => void runReportJob(app, job!.id, jobCtx), 20).unref();
      void c.reply.code(202);
      return { job: jobOut(job!) };
    }),
  );
  app.get(
    '/api/report-jobs',
    tenantRoute(app, {}, async (c) => ({
      jobs: (await c.tx.select().from(reportJobs).where(eq(reportJobs.userId, c.user.id)).orderBy(desc(reportJobs.createdAt)).limit(50)).map(jobOut),
    })),
  );
  app.get('/api/report-jobs/:id', tenantRoute(app, {}, async (c) => ({ job: jobOut(await own(c, idParam.parse(c.req.params).id)) })));
  app.post(
    '/api/report-jobs/:id/cancel',
    tenantRoute(app, { permission: 'workspace.use', operation: 'read' }, async (c) => {
      const j = await own(c, idParam.parse(c.req.params).id);
      if (!['queued', 'running'].includes(j.status)) throw badRequest('Yalnız bekleyen ya da çalışan rapor iptal edilir', 'REPORT_JOB_NOT_ACTIVE');
      const [u] = await c.tx.update(reportJobs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(reportJobs.id, j.id)).returning();
      return { job: jobOut(u!) };
    }),
  );
  app.get(
    '/api/report-jobs/:id/download',
    tenantRoute(app, {}, async (c) => {
      const j = await own(c, idParam.parse(c.req.params).id);
      const out = jobOut(j);
      if (out.status === 'expired') throw new AppError(410, 'REPORT_JOB_EXPIRED', 'Raporun indirme süresi doldu; yeniden hazırlayın');
      if (j.status !== 'completed' || !j.content) throw badRequest('Rapor henüz hazır değil', 'REPORT_JOB_NOT_READY');
      void c.reply
        .header('cache-control', 'no-store')
        .header('content-type', j.format === 'csv' ? 'text/csv; charset=utf-8' : XLSX_CONTENT_TYPE)
        .header('content-disposition', `attachment; filename="${j.fileName}"`);
      return Buffer.from(j.content, 'base64');
    }),
  );
};
