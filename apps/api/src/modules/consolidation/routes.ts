import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  addGroupMemberSchema,
  consolidationReportQuerySchema,
  createEliminationSchema,
  createGroupSchema,
  executiveSummaryQuerySchema,
  fxPositionQuerySchema,
  intercompanyHintsQuerySchema,
  updateGroupSchema,
  uuid,
  voidEliminationSchema,
  pageQuerySchema,
} from '@erp/shared';
import { renderCsv } from '../../files/csv-write';
import type { ReportTable } from '../../files/table';
import { writeXlsx, XLSX_CONTENT_TYPE } from '../../files/xlsx-write';
import { authedRoute, tenantRoute, type AuthCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { paged } from '../../http/paging';
import { companyExecutive, groupExecutive } from './executive';
import { companyFxPosition, groupFxPosition } from './fx-position';
import { addMember, createElimination, createGroup, listEligibleCompanies, listEliminations, listGroups, removeMember, updateGroup, voidElimination } from './groups';
import { intercompanyHints } from './hints';
import { consolidatedReport } from './report';
import { consolidatedTables, executiveTables, groupFxPositionTables } from './tables';
import { forEachScope, resolveGroupAccess } from './access';
import { loadMemberAccess, requireResourceOperation } from '../access/effective';
import { exportEvents } from '../../db/schema';

const idParam = z.object({ id: uuid });
const memberParam = z.object({ id: uuid, companyId: uuid });
const elimParam = z.object({ id: uuid, eid: uuid });
const formatSchema = z.object({ format: z.enum(EXPORT_FORMATS).default('xlsx') });
const EXPORT_KEYS = ['consolidated', 'fx-position', 'executive-summary'] as const;
const exportParam = z.object({ id: uuid, key: z.enum(EXPORT_KEYS) });

/**
 * Çoklu şirket konsolidasyonu rotaları (Faz X7). Grup uçları şirket başlığı (X-Company-Id) KULLANMAZ: yalnızca oturumdaki kullanıcı ve
 * grup kimliği vardır; üye şirketler sunucuda gruptan okunur ve HER istekte yeniden doğrulanır (access.ts).
 */
export const consolidationRoutes: FastifyPluginAsync = async (app) => {
  /** Ağır uçlar: kullanıcı başına dakikada en çok 30 (RATE_LIMIT_ENABLED iken). */
  const limit = async (ctx: AuthCtx, name: string) => {
    const r = await app.limiter.consume(`${name}:${ctx.user.id}`, 30, 60_000);
    if (!r.ok) {
      void ctx.reply.header('retry-after', String(r.retryAfterSec));
      throw new AppError(429, 'RATE_LIMITED', 'Çok fazla istek; lütfen biraz sonra tekrar deneyin');
    }
  };

  // ---- Grup yönetimi (kullanıcıya ait) ------------------------------------------------------------------------------
  app.get('/api/consolidation/eligible-companies', authedRoute(app, async (ctx) => ({ companies: await listEligibleCompanies(app, ctx) })));
  app.get('/api/consolidation/groups', authedRoute(app, async (ctx) => ({ groups: await listGroups(app, ctx) })));

  app.post(
    '/api/consolidation/groups',
    authedRoute(app, async (ctx) => {
      const group = await createGroup(app, ctx, createGroupSchema.parse(ctx.req.body));
      void ctx.reply.code(201);
      return { group };
    }),
  );
  app.patch(
    '/api/consolidation/groups/:id',
    authedRoute(app, async (ctx) => ({ group: await updateGroup(ctx, idParam.parse(ctx.req.params).id, updateGroupSchema.parse(ctx.req.body)) })),
  );
  app.post(
    '/api/consolidation/groups/:id/members',
    authedRoute(app, async (ctx) => {
      await addMember(app, ctx, idParam.parse(ctx.req.params).id, addGroupMemberSchema.parse(ctx.req.body).companyId);
      void ctx.reply.code(201);
      return { ok: true };
    }),
  );
  app.delete(
    '/api/consolidation/groups/:id/members/:companyId',
    authedRoute(app, async (ctx) => {
      const p = memberParam.parse(ctx.req.params);
      await removeMember(ctx, p.id, p.companyId);
      return { ok: true };
    }),
  );

  // ---- Eliminasyonlar ----------------------------------------------------------------------------------------------
  app.get(
    '/api/consolidation/groups/:id/eliminations',
    authedRoute(app, async (ctx) => {
      const page = pageQuerySchema.parse(ctx.req.query);
      const pg = paged(await listEliminations(ctx, idParam.parse(ctx.req.params).id, { includeVoided: true, limit: page.limit + 1, offset: page.offset }), page);
      return { eliminations: pg.rows, truncated: pg.truncated };
    }),
  );
  app.post(
    '/api/consolidation/groups/:id/eliminations',
    authedRoute(app, async (ctx) => {
      const head = await createElimination(ctx, idParam.parse(ctx.req.params).id, createEliminationSchema.parse(ctx.req.body));
      void ctx.reply.code(201);
      return { elimination: head };
    }),
  );
  app.post(
    '/api/consolidation/groups/:id/eliminations/:eid/void',
    authedRoute(app, async (ctx) => {
      const p = elimParam.parse(ctx.req.params);
      return { elimination: await voidElimination(ctx, p.id, p.eid, voidEliminationSchema.parse(ctx.req.body).reason) };
    }),
  );

  // ---- Raporlar (grup) ---------------------------------------------------------------------------------------------
  app.get(
    '/api/consolidation/groups/:id/report',
    authedRoute(app, async (ctx) => {
      await limit(ctx, 'consolidation');
      return { report: await consolidatedReport(app, ctx, idParam.parse(ctx.req.params).id, consolidationReportQuerySchema.parse(ctx.req.query)) };
    }),
  );
  app.get(
    '/api/consolidation/groups/:id/fx-position',
    authedRoute(app, async (ctx) => {
      await limit(ctx, 'consolidation');
      return { report: await groupFxPosition(app, ctx, idParam.parse(ctx.req.params).id, fxPositionQuerySchema.parse(ctx.req.query)) };
    }),
  );
  app.get(
    '/api/consolidation/groups/:id/executive-summary',
    authedRoute(app, async (ctx) => {
      await limit(ctx, 'consolidation');
      return { report: await groupExecutive(app, ctx, idParam.parse(ctx.req.params).id, executiveSummaryQuerySchema.parse(ctx.req.query)) };
    }),
  );
  app.get(
    '/api/consolidation/groups/:id/intercompany-hints',
    authedRoute(app, async (ctx) => {
      await limit(ctx, 'consolidation');
      return intercompanyHints(app, ctx, idParam.parse(ctx.req.params).id, intercompanyHintsQuerySchema.parse(ctx.req.query).asOf);
    }),
  );

  // ---- Grup dışa aktarma (xlsx/csv): ekrandaki rapor ile aynı servis fonksiyonları ---------------------------------
  app.get(
    '/api/consolidation/groups/:id/export/:key',
    authedRoute(app, async (ctx) => {
      await limit(ctx, 'consolidation-export');
      const { id, key } = exportParam.parse(ctx.req.params);
      const { format } = formatSchema.parse(ctx.req.query);
      const groupAccess = await resolveGroupAccess(app, ctx, id);
      await forEachScope(ctx.tx, groupAccess, async scope => {
        requireResourceOperation(await loadMemberAccess(ctx.tx, scope.companyId, ctx.user.id, scope.role), 'core.ledger', 'export');
        if (key === 'fx-position') requireResourceOperation(await loadMemberAccess(ctx.tx, scope.companyId, ctx.user.id, scope.role), 'core.treasury', 'export');
      });
      if (!app.exportGate.tryAcquire()) {
        void ctx.reply.header('retry-after', '5');
        throw new AppError(429, 'EXPORT_BUSY', 'Şu anda başka dışa aktarmalar çalışıyor; birkaç saniye sonra tekrar deneyin');
      }
      try {
        let tables: ReportTable[];
        let name: string;
        if (key === 'consolidated') {
          const q = consolidationReportQuerySchema.parse(ctx.req.query);
          tables = consolidatedTables(await consolidatedReport(app, ctx, id, q));
          name = `konsolide-${q.from}_${q.to}`;
        } else if (key === 'fx-position') {
          const q = fxPositionQuerySchema.parse(ctx.req.query);
          tables = groupFxPositionTables(await groupFxPosition(app, ctx, id, q));
          name = `grup-doviz-pozisyonu-${q.asOf}`;
        } else {
          const q = executiveSummaryQuerySchema.parse(ctx.req.query);
          tables = executiveTables(await groupExecutive(app, ctx, id, q));
          name = `grup-yonetici-ozeti-${q.from}_${q.to}`;
        }
        void ctx.reply.header('cache-control', 'no-store').header('content-disposition', `attachment; filename="${name}.${format}"`);
        const recordExport = async () => {
          await forEachScope(ctx.tx, groupAccess, async scope => {
            await ctx.tx.insert(exportEvents).values({ companyId: scope.companyId, userId: ctx.user.id, reportKey: `consolidation.${key}`, format, rowCount: (format === 'csv' ? [tables[0]!] : tables).reduce((n, table) => n + table.rows.length, 0), requestId: ctx.req.id, ip: ctx.req.ip });
          });
        };
        if (format === 'csv') {
          void ctx.reply.header('content-type', 'text/csv; charset=utf-8');
          const csv = renderCsv(tables[0]!);
          await recordExport();
          return csv;
        }
        void ctx.reply.header('content-type', XLSX_CONTENT_TYPE);
        const workbook = Buffer.from(writeXlsx(tables));
        await recordExport();
        return workbook;
      } finally {
        app.exportGate.release();
      }
    }),
  );

  // ---- Şirket düzeyi raporlar (X-Company-Id; tek şirket, kendi RLS bağlamı) --------------------------------------------
  app.get(
    '/api/reports/fx-position',
    tenantRoute(app, { module: 'core.treasury', permission: 'reports.read' }, async ({ tx, req, company }) => ({
      report: await companyFxPosition(tx, { companyId: company.id, name: company.name, baseCurrency: company.baseCurrency }, fxPositionQuerySchema.parse(req.query)),
    })),
  );
  app.get(
    '/api/reports/executive-summary',
    tenantRoute(app, { module: 'reports.executive', permission: 'reports.read' }, async ({ tx, req, company, access, enabledModules }) => ({
      report: await companyExecutive(
        tx,
        { companyId: company.id, name: company.name, baseCurrency: company.baseCurrency, reportingCurrency: company.reportingCurrency, permissions: access.permissions, enabledModules },
        executiveSummaryQuerySchema.parse(req.query),
      ),
    })),
  );
};
