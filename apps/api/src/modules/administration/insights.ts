import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import {
  insightConfigSchema,
  insightKeys,
  todayIso,
  idParam,
  dec,
  type InsightConfig,
  type SavedInsight,
  type InsightResult,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden, notFound, conflict, badRequest, AppError } from '../../http/errors';
import { EXPORTS } from '../exports/registry';
import { isModuleDenied } from '../access/effective';

const titles: Record<InsightConfig['reportKey'], string> = {
  'sales-report': 'Satış raporu',
  'purchase-report': 'Alış raporu',
  'trial-balance': 'Mizan',
  'stock-status': 'Stok durumu',
  'stock-analytics': 'ABC, hareketsiz stok ve devir',
  'supplier-performance': 'Tedarikçi teslim, iade ve fiyat performansı',
  'party-aging': 'Cari yaşlandırma',
  'project-profitability': 'Proje kârlılığı',
  'cheque-maturity': 'Çek / senet vadeleri',
  'cash-forecast': 'Nakit projeksiyonu',
};
function reportDef(c: TenantCtx, key: string) {
  const def = EXPORTS.find((d) => d.key === key);
  if (!def || !insightKeys.includes(key as InsightConfig['reportKey'])) throw notFound('Rapor');
  if (
    ![def.module, ...(def.alternateModules ?? [])].some(
      (module) => c.enabledModules.has(module) && !isModuleDenied(c.access, module),
    ) ||
    !c.can(def.permission)
  )
    throw forbidden('Bu rapor için okuma yetkiniz yok.');
  return def;
}
function visible(c: TenantCtx) {
  return sql`(created_by=${c.user.id}::uuid or config->>'shared'='true')`;
}
async function getView(c: TenantCtx, id: string) {
  const row = (
    await c.tx.execute<{ id: string; created_by: string; config: unknown; version: number }>(
      sql`select id,created_by,config,version from saved_insights where id=${id}::uuid and not archived and ${visible(c)}`,
    )
  ).rows[0];
  if (!row) throw notFound('Kaydedilmiş rapor');
  const config = insightConfigSchema.parse(row.config);
  reportDef(c, config.reportKey);
  return { row, config };
}
function sharing(c: TenantCtx, config: InsightConfig) {
  if (config.shared) c.require('members.manage');
}
export async function buildInsight(c: TenantCtx, input: InsightConfig): Promise<InsightResult> {
  const def = reportDef(c, input.reportKey),
    today = todayIso();
  const range =
    input.range === 'fixed'
      ? { from: input.from, to: input.to }
      : {
          from: input.range === 'year' ? today.slice(0, 4) + '-01-01' : today.slice(0, 8) + '01',
          to: today,
        };
  const query = def.schema.parse({ ...range, asOf: range.to, ...input.options, view: 'accounts' });
  if (!c.req.server.exportGate.tryAcquire())
    throw new AppError(
      429,
      'REPORT_BUSY',
      'Başka raporlar hazırlanıyor; biraz sonra tekrar deneyin.',
    );
  try {
    const tables = await def.build(
      {
        tx: c.tx,
        company: c.company,
        user: { id: c.user.id },
        access: {
          companyId: c.company.id,
          permissions: c.access.permissions,
          enabledModules: c.enabledModules,
        },
      },
      query as never,
    );
    let chart: InsightResult['chart'] = [],
      chartLabel: string | null = null,
      chartCurrency: string | null = null,
      chartError: string | null = null;
    if (input.chart) {
      const table = tables.find((t) => t.key === input.chart!.tableKey),
        label = table?.columns.find((col) => col.key === input.chart!.labelKey),
        value = table?.columns.find((col) => col.key === input.chart!.valueKey);
      if (
        !table ||
        !label ||
        !value ||
        !['text', 'date'].includes(label.kind) ||
        !['money', 'qty', 'int'].includes(value.kind)
      )
        throw badRequest('Grafik için raporun metin ve tutar sütunlarını seçin.');
      const currencies = new Set(
        table.rows.map((r) => r.currency ?? r.currencyCode).filter(Boolean),
      );
      const units = new Set(table.rows.map((r) => r.unit).filter(Boolean));
      if (
        (value.kind === 'money' && !value.currency && currencies.size > 1) ||
        (value.kind === 'qty' && units.size > 1)
      )
        chartError =
          'Farklı para birimi veya birimleri tek grafikte toplayamazsınız. Ortak defter tutarı sütununu seçin.';
      else {
        const grouped = new Map<string, ReturnType<typeof dec>>();
        for (const row of table.rows) {
          const amount = row[value.key];
          if (amount === null || amount === undefined || amount === '') continue;
          if (!/^-?\d+(\.\d+)?$/.test(String(amount))) {
            chartError = 'Grafik sütununda sayısal olmayan veya eksik sonuç var.';
            break;
          }
          const key = String(row[label.key] ?? 'Belirtilmedi').slice(0, 200);
          grouped.set(key, (grouped.get(key) ?? dec(0)).plus(amount));
        }
        if (!chartError) {
          const sorted = [...grouped]
            .sort((a, b) => b[1].abs().comparedTo(a[1].abs()))
            .slice(0, 20);
          const peak = sorted.reduce((n, r) => (r[1].abs().gt(n) ? r[1].abs() : n), dec(0));
          chart = sorted.map(([name, n]) => ({
            label: name,
            value: n.toFixed(value.kind === 'money' ? 2 : 4),
            share: peak.gt(0) ? n.abs().div(peak).toNumber() : 0,
          }));
          chartLabel = value.label;
          chartCurrency =
            value.currency ?? (currencies.size === 1 ? String([...currencies][0]) : null);
        }
      }
    }
    return {
      range,
      tables: tables.map((t) => ({ ...t, rowCount: t.rows.length, rows: t.rows.slice(0, 200) })),
      chart,
      chartLabel,
      chartCurrency,
      chartError,
    };
  } finally {
    c.req.server.exportGate.release();
  }
}
export const insightRoutes: FastifyPluginAsync = async (app) => {
  const access = { module: 'core.dashboard', permission: 'workspace.use' } as const;
  app.get(
    '/api/workspace/insights/catalog',
    tenantRoute(app, access, async (c) => ({
      items: insightKeys
        .filter((key) => {
          try {
            reportDef(c, key);
            return true;
          } catch {
            return false;
          }
        })
        .map((key) => ({ key, title: titles[key] })),
    })),
  );
  app.get(
    '/api/workspace/insights',
    tenantRoute(app, access, async (c) => {
      const rows = (
        await c.tx.execute<{ id: string; created_by: string; config: unknown; version: number }>(
          sql`select id,created_by,config,version from saved_insights where not archived and ${visible(c)} order by (config->>'position')::int,created_at limit 100`,
        )
      ).rows;
      const items: SavedInsight[] = [];
      for (const row of rows) {
        const config = insightConfigSchema.parse(row.config);
        try {
          reportDef(c, config.reportKey);
          items.push({ ...config, id: row.id, createdBy: row.created_by, version: row.version });
        } catch (error) {
          if ((error as { status?: number }).status !== 403) throw error;
        }
      }
      return { items, userId: c.user.id };
    }),
  );
  app.post(
    '/api/workspace/insights/preview',
    tenantRoute(
      app,
      { ...access, limit: { name: 'insight-preview', max: 20, windowMs: 60000 } },
      async (c) => buildInsight(c, insightConfigSchema.parse(c.req.body)),
    ),
  );
  app.post(
    '/api/workspace/insights',
    tenantRoute(
      app,
      { ...access, limit: { name: 'insight-write', max: 20, windowMs: 60000 } },
      async (c) => {
        const config = insightConfigSchema.parse(c.req.body);
        sharing(c, config);
        await buildInsight(c, config);
        await c.tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + c.user.id + ':insights'},0))`,
        );
        const count = (
          await c.tx.execute<{ n: number }>(
            sql`select count(*)::int as n from saved_insights where created_by=${c.user.id}::uuid and not archived`,
          )
        ).rows[0]!.n;
        if (count >= 25) throw badRequest('En fazla 25 aktif rapor kaydedebilirsiniz.');
        const id = uuidv7();
        await c.tx.execute(
          sql`insert into saved_insights(id,company_id,created_by,config) values(${id},${c.company.id},${c.user.id},${JSON.stringify(config)}::jsonb)`,
        );
        void c.reply.code(201);
        return { id };
      },
    ),
  );
  app.get(
    '/api/workspace/insights/:id',
    tenantRoute(
      app,
      { ...access, limit: { name: 'insight-read', max: 60, windowMs: 60000 } },
      async (c) => {
        const { config } = await getView(c, idParam.parse(c.req.params).id);
        return buildInsight(c, config);
      },
    ),
  );
  app.put(
    '/api/workspace/insights/:id',
    tenantRoute(
      app,
      { ...access, limit: { name: 'insight-write', max: 20, windowMs: 60000 } },
      async (c) => {
        const { id } = idParam.parse(c.req.params),
          { config, version } = z
            .object({ config: insightConfigSchema, version: z.number().int().positive() })
            .parse(c.req.body),
          existing = await getView(c, id);
        if (existing.row.created_by !== c.user.id) c.require('members.manage');
        sharing(c, config);
        await buildInsight(c, config);
        const rows = await c.tx.execute(
          sql`update saved_insights set config=${JSON.stringify(config)}::jsonb,version=version+1,updated_at=now() where id=${id}::uuid and version=${version} returning id`,
        );
        if (!rows.rows.length) throw conflict('Rapor planı değişti; yenileyin.');
        return { ok: true };
      },
    ),
  );
  app.post(
    '/api/workspace/insights/:id/archive',
    tenantRoute(app, access, async (c) => {
      const { id } = idParam.parse(c.req.params),
        { version } = z.object({ version: z.number().int().positive() }).parse(c.req.body),
        { row } = await getView(c, id);
      if (row.created_by !== c.user.id) c.require('members.manage');
      const result = await c.tx.execute(
        sql`update saved_insights set archived=true,version=version+1,updated_at=now() where id=${id}::uuid and version=${version} returning id`,
      );
      if (!result.rows.length) throw conflict('Rapor planı değişti; yenileyin.');
      return { ok: true };
    }),
  );
};
