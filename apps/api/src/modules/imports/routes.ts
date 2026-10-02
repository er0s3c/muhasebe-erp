import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  IMPORT_FIELDS,
  IMPORT_KINDS,
  IMPORT_KIND_LABELS,
  IMPORT_LIMITS,
  importParseSchema,
  importRunSchema,
  type ImportCommitResult,
  type ImportKind,
  type ImportParseResult,
  type ImportPreview,
} from '@erp/shared';
import { renderCsv } from '../../files/csv-write';
import type { ReportTable } from '../../files/table';
import { writeXlsx, XLSX_CONTENT_TYPE } from '../../files/xlsx-write';
import { tenantRoute } from '../../http/context';
import { unprocessable } from '../../http/errors';
import type { ImportCtx, PlanResult } from './handlers/common';
import { suggestMapping } from './mapping';
import { IMPORT_HANDLERS } from './registry';
import { readTable, splitHeader } from './table';

/** Base64 dosya (5 MB → ~6,7 MB) ve satır listesi için yeterli; Fastify'ın 1 MiB varsayılanı bu uçlarda aşılır. */
const IMPORT_BODY_LIMIT = 8 * 1024 * 1024;
/** Hata listesinin ve ön izlemedeki satır iletisinin en büyük uzunluğu (yanıt boyutunu sınırlar). */
const MAX_ERROR_DETAILS = 200;

const templateQuery = z.object({ format: z.enum(EXPORT_FORMATS).default('xlsx') });

function toPreview(kind: ImportKind, plan: PlanResult): ImportPreview {
  const counts = { total: plan.rows.length, ok: 0, skip: 0, error: 0 };
  for (const r of plan.rows) counts[r.status]++;
  const generalErrors = plan.general.some((m) => m.severity === 'error');
  return {
    kind,
    counts,
    rows: plan.rows,
    general: plan.general,
    summary: plan.summary,
    unmatched: plan.unmatched,
    // Önce doğrula sonra yaz: tek bir hata bile varsa hiçbir kayıt yazılmaz
    canCommit: !generalErrors && counts.error === 0 && counts.ok > 0,
  };
}

function templateTable(kind: ImportKind): ReportTable {
  const fields = IMPORT_FIELDS[kind];
  return {
    key: `sablon-${kind}`,
    title: IMPORT_KIND_LABELS[kind],
    columns: fields.map((f) => ({ key: f.key, label: f.label, kind: 'text' as const, width: Math.max(16, f.label.length + 4) })),
    rows: [Object.fromEntries(fields.map((f) => [f.key, f.example]))],
    plain: true,
  };
}

/**
 * Toplu içe aktarma (durumsuz sunucu): `parse` dosyayı okuyup sütun eşlemesi önerir; `preview` eşlenmiş satırları
 * hiçbir şey yazmadan doğrular; `commit` aynı doğrulamayı yeniden çalıştırır ve hata yoksa tek işlemde yazar
 * (istek zaten tek işlemdedir: ya hepsi ya hiçbiri). Her tür kendi modülü ve iznimle korunur.
 */
export const importRoutes: FastifyPluginAsync = async (app) => {
  for (const kind of IMPORT_KINDS) {
    const handler = IMPORT_HANDLERS[kind];
    const guard = { module: handler.module, permission: handler.permission };
    // Ayrıştırma/ön izleme/yazma pahalıdır (dosya çözme, doğrulama); şablon indirme sınırsızdır.
    const heavy = { ...guard, limit: { name: 'import', max: 30, windowMs: 60_000 } };
    const base = `/api/imports/${kind}`;

    app.post(
      `${base}/parse`,
      { bodyLimit: IMPORT_BODY_LIMIT },
      tenantRoute(app, heavy, async ({ req }): Promise<ImportParseResult> => {
        const input = importParseSchema.parse(req.body);
        // Base64 kabaca 4/3 büyür; şişirilmiş gövde çözülmeden reddedilir
        if (input.contentBase64.length > Math.ceil((IMPORT_LIMITS.maxFileBytes * 4) / 3) + 16) {
          throw unprocessable(`Dosya en çok ${Math.round(IMPORT_LIMITS.maxFileBytes / 1024 / 1024)} MB olabilir`, 'IMPORT_FILE_TOO_LARGE');
        }
        const bytes = Buffer.from(input.contentBase64, 'base64');
        const raw = readTable(bytes, input.fileName, input.sheet);
        const { headers, rows, suggestedNumberFormat } = splitHeader(raw, kind);
        return {
          fileName: input.fileName,
          format: raw.format,
          sheets: raw.sheets,
          sheet: raw.sheet,
          headers,
          rows,
          suggestedMapping: suggestMapping(kind, headers),
          suggestedNumberFormat,
        };
      }),
    );

    app.post(
      `${base}/preview`,
      { bodyLimit: IMPORT_BODY_LIMIT },
      tenantRoute(app, heavy, async ({ tx, req, company, user }): Promise<ImportPreview> => {
        const input = importRunSchema.parse(req.body);
        const ctx: ImportCtx = { tx, company, userId: user.id };
        return toPreview(kind, await handler.plan(ctx, input.rows, input.options));
      }),
    );

    app.post(
      `${base}/commit`,
      { bodyLimit: IMPORT_BODY_LIMIT },
      tenantRoute(app, heavy, async ({ tx, req, company, user }): Promise<ImportCommitResult> => {
        const input = importRunSchema.parse(req.body);
        const ctx: ImportCtx = { tx, company, userId: user.id };
        const plan = await handler.plan(ctx, input.rows, input.options);
        const preview = toPreview(kind, plan);
        if (!preview.canCommit) {
          const failing = preview.rows.filter((r) => r.status === 'error');
          if (failing.length === 0 && preview.general.every((m) => m.severity !== 'error')) {
            throw unprocessable('İçe aktarılacak geçerli satır yok', 'IMPORT_EMPTY');
          }
          throw unprocessable('Dosyada hata var; hiçbir kayıt yazılmadı. Hataları düzeltip yeniden deneyin', 'IMPORT_INVALID', {
            general: preview.general.filter((m) => m.severity === 'error'),
            rows: failing.slice(0, MAX_ERROR_DETAILS).map((r) => ({
              row: r.row,
              label: r.label,
              messages: r.messages.filter((m) => m.severity === 'error'),
            })),
            errorRows: failing.length,
          });
        }
        const result = await plan.apply();
        return { kind, created: result.created, skipped: result.skipped ?? preview.counts.skip, summary: result.summary, entries: result.entries };
      }),
    );

    app.get(
      `${base}/template`,
      tenantRoute(app, guard, async ({ req, reply }) => {
        const { format } = templateQuery.parse(req.query);
        const table = templateTable(kind);
        void reply
          .header('cache-control', 'no-store')
          .header('content-disposition', `attachment; filename="sablon-${kind.replace(/_/g, '-')}.${format}"`);
        if (format === 'csv') {
          void reply.header('content-type', 'text/csv; charset=utf-8');
          return renderCsv(table);
        }
        void reply.header('content-type', XLSX_CONTENT_TYPE);
        return Buffer.from(writeXlsx([table]));
      }),
    );
  }
};
