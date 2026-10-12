import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import {
  resolveEnabledModules,
  idParam,
  createInvoiceSchema,
  createDeliveryNoteSchema,
  type Role,
  type Sector,
  type ConstructionWorkflow,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { withContext, setContext } from '../../db/client';
import { badRequest, conflict, forbidden } from '../../http/errors';
import { loadMemberAccess } from '../access/effective';
import { requireRecord } from '../workspace/records';
import { first } from './routes';
import { readAsset, storeAsset } from './storage';
import { createInvoiceDraft } from '../invoices/service';
import { createDeliveryDraft } from '../deliveries/service';
import { ensureConcreteAction, expireReservations } from './workflows';
const read = { module: 'construction.projects', permission: 'projects.read' as const },
  write = { ...read, permission: 'projects.manage' as const };
const columns = sql`j.id,j.project_id as "projectId",j.asset_id as "assetId",j.kind,j.status,j.attempts,j.progress,j.error,j.summary,j.version,j.reviewed_record_kind as "reviewedRecordKind",j.reviewed_record_id as "reviewedRecordId",a.filename`;
async function job(c: TenantCtx, id: string) {
  return first<{
    id: string;
    projectId: string;
    assetId: string;
    kind: 'ifc' | 'ocr';
    status: string;
    resultHash: string | null;
    version: number;
    reviewedRecordId: string | null;
  }>(
    c,
    sql`select ${columns},j.result_hash as "resultHash" from construction_jobs j join construction_assets a on a.id=j.asset_id where j.id=${id}::uuid`,
  );
}
/** "1.234,56" / "1,234.56" / "1234,5" → "1234.56"; anlaşılmazsa null. */
export function ocrAmount(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  const decimalSep = lastComma > lastDot ? ',' : lastDot > lastComma ? '.' : null;
  let digits = s;
  if (decimalSep) {
    const [int, frac] = [s.slice(0, s.lastIndexOf(decimalSep)), s.slice(s.lastIndexOf(decimalSep) + 1)];
    // Tek ayırıcı ve üç haneli kesir: binlik ayırıcıdır (1.250 → 1250)
    digits = frac.length === 3 && !(lastComma >= 0 && lastDot >= 0) ? int.replace(/[.,]/g, '') + frac : int.replace(/[.,]/g, '') + '.' + frac;
  }
  return /^\d+(\.\d+)?$/.test(digits) ? digits : null;
}

/**
 * OCR önerileri (öneri 103): her alan, metinde bulunduğu satır ve kaynak parçasıyla birlikte döner; kullanıcı öneriyi
 * belgedeki yeriyle karşılaştırarak doğrular. Öneriler kesinleştirme yapmaz, yalnız taslağı doldurur.
 */
export function ocrSuggestions(text: string) {
  const fields: { field: 'date' | 'currency' | 'total' | 'externalNo'; value: string; sourceText: string; line: number }[] = [];
  const locate = (field: (typeof fields)[number]['field'], m: RegExpMatchArray | null, value: string | null) => {
    if (!m || value === null || m.index === undefined) return;
    const line = text.slice(0, m.index).split('\n').length;
    const lineText = text.split('\n')[line - 1] ?? m[0];
    fields.push({ field, value, sourceText: lineText.trim().slice(0, 200), line });
  };
  const date = text.match(/\b(\d{2})[./-](\d{2})[./-](20\d{2})\b/);
  const dateValue = date ? `${date[3]}-${date[2]}-${date[1]}` : null;
  locate('date', date, dateValue);
  const cur = text.match(/\b(TRY|EUR|USD|GBP)\b/) ?? text.match(/\bTL\b/);
  const currency = cur ? (cur[1] ?? 'TRY') : null;
  locate('currency', cur, currency);
  const totalMatch = text.match(/(?:genel\s*toplam|grand\s*total|ödenecek|toplam)\s*[:=]?\s*([\d.,]+)/i);
  const total = totalMatch?.[1] ?? null;
  locate('total', totalMatch, ocrAmount(total));
  const extMatch = text.match(/(?:fatura|invoice|irsaliye)\s*(?:no|numarası|number)\s*[:=]?\s*([A-Z0-9-]+)/i);
  const externalNo = extMatch?.[1] ?? null;
  locate('externalNo', extMatch, externalNo);
  return {
    date: dateValue,
    currency,
    totalText: total,
    total: ocrAmount(total),
    externalNo,
    fields,
    warning:
      'OCR önerileri doğrulanmamıştır. Toplamı, tarihi, döviz kurunu ve satırları kaynak belgeyle kontrol edin.',
  };
}

/**
 * İçerik üzerinden belge tekrar kontrolü (öneri 104): dosya özeti farklı olsa da aynı tedarikçi belge numarası ya da aynı
 * tarih + toplamlı kaydedilmiş/taslak alış-gider faturası ve aynı metin sonucuna sahip başka OCR işi aranır.
 */
async function ocrDuplicates(c: TenantCtx, r: { id: string; assetId: string; resultHash: string | null }, storageDir: string) {
  if (!r.resultHash) return { invoices: [], jobs: [], suggestions: null };
  const result = JSON.parse((await readAsset(storageDir, c.company.id, r.resultHash)).toString()) as { text?: string };
  const s = ocrSuggestions(result.text ?? '');
  const invoices = s.externalNo || (s.date && s.total)
    ? (
        await c.tx.execute<{ id: string; invoiceNo: string | null; externalNo: string | null; invoiceDate: string; grossTotal: string; currencyCode: string; partyName: string | null; status: string; reason: string }>(
          sql`select i.id, i.invoice_no as "invoiceNo", i.external_no as "externalNo", i.invoice_date::text as "invoiceDate", i.gross_total::text as "grossTotal",
                     i.currency_code as "currencyCode", p.name as "partyName", i.status,
                     case when ${s.externalNo}::text is not null and upper(i.external_no) = upper(${s.externalNo}::text) then 'external_no' else 'date_total' end as reason
                from invoices i left join parties p on p.id = i.party_id
               where i.status <> 'cancelled' and i.type in ('purchase','expense')
                 and ((${s.externalNo}::text is not null and upper(i.external_no) = upper(${s.externalNo}::text))
                   or (${s.date}::date is not null and ${s.total}::numeric is not null and i.invoice_date = ${s.date}::date and i.gross_total = ${s.total}::numeric))
               order by i.invoice_date desc limit 10`,
        )
      ).rows
    : [];
  const jobs = (
    await c.tx.execute<{ id: string; filename: string; reviewedRecordKind: string | null }>(
      sql`select j.id, a.filename, j.reviewed_record_kind as "reviewedRecordKind" from construction_jobs j join construction_assets a on a.id = j.asset_id
           where j.kind = 'ocr' and j.status = 'completed' and j.result_hash = ${r.resultHash} and j.id <> ${r.id}::uuid and j.asset_id <> ${r.assetId}::uuid limit 10`,
    )
  ).rows;
  return { invoices, jobs, suggestions: s };
}
export const constructionJobRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/construction/jobs',
    tenantRoute(app, read, async (c) => {
      const q = z.object({ projectId: z.uuid() }).parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      return {
        items: (
          await c.tx.execute(
            sql`select ${columns} from construction_jobs j join construction_assets a on a.id=j.asset_id where j.project_id=${q.projectId}::uuid order by j.created_at desc limit 100`,
          )
        ).rows,
      };
    }),
  );
  app.post(
    '/api/construction/jobs',
    tenantRoute(app, write, async (c) => {
      const b = z.object({ assetId: z.uuid(), kind: z.enum(['ifc', 'ocr']) }).parse(c.req.body);
      const a = await first<{ id: string; projectId: string; mime: string }>(
        c,
        sql`select id,project_id as "projectId",mime from construction_assets where id=${b.assetId}::uuid`,
      );
      if (
        b.kind === 'ifc'
          ? a.mime !== 'application/x-step'
          : !['application/pdf', 'image/png', 'image/jpeg'].includes(a.mime)
      )
        throw badRequest('Dosya bu işlem için uygun değil.');
      const old = await c.tx.execute(
        sql`select id from construction_jobs where asset_id=${a.id}::uuid and kind=${b.kind} and status in ('queued','running','completed') order by created_at desc limit 1`,
      );
      if (old.rows[0]) return { item: await job(c, String(old.rows[0].id)) };
      const id = randomUUID();
      await c.tx.execute(
        sql`insert into construction_jobs(id,company_id,project_id,created_by,asset_id,kind) values(${id},${c.company.id},${a.projectId},${c.user.id},${a.id},${b.kind})`,
      );
      c.reply.code(201);
      return { item: await job(c, id) };
    }),
  );
  app.post(
    '/api/construction/jobs/:id/retry',
    tenantRoute(app, write, async (c) => {
      const r = await job(c, idParam.parse(c.req.params).id);
      const b = z.object({ version: z.number().int().positive() }).parse(c.req.body);
      if (r.status !== 'failed' || r.version !== b.version)
        throw conflict('Yalnızca güncel başarısız iş yeniden denenir.');
      await c.tx.execute(
        sql`update construction_jobs set status='queued',progress=0,error=null,version=version+1 where id=${r.id}::uuid and version=${b.version}`,
      );
      return { item: await job(c, r.id) };
    }),
  );
  app.get(
    '/api/construction/jobs/:id/result',
    tenantRoute(app, read, async (c) => {
      const r = await job(c, idParam.parse(c.req.params).id);
      if (r.status !== 'completed' || !r.resultHash)
        throw badRequest('İş sonucu henüz hazır değil.');
      c.reply.header('cache-control', 'no-store');
      return JSON.parse(
        (
          await readAsset(app.config.CONSTRUCTION_STORAGE_DIR, c.company.id, r.resultHash)
        ).toString(),
      );
    }),
  );
  app.get(
    '/api/construction/jobs/:id/duplicates',
    tenantRoute(app, read, async (c) => {
      const r = await job(c, idParam.parse(c.req.params).id);
      if (r.kind !== 'ocr' || r.status !== 'completed') throw badRequest('Tamamlanmış OCR sonucu seçin.');
      return ocrDuplicates(c, r, app.config.CONSTRUCTION_STORAGE_DIR);
    }),
  );
  app.get(
    '/api/construction/jobs/:id/model-links',
    tenantRoute(app, read, async (c) => {
      const r = await job(c, idParam.parse(c.req.params).id);
      if (r.kind !== 'ifc') throw badRequest('IFC işi seçin.');
      const rows = await c.tx.execute<{ operationId: string | null }>(
        sql`select id,guid,wbs_id as "wbsId",operation_id as "operationId",version from construction_model_links where job_id=${r.id}::uuid`,
      );
      const items = [];
      for (const row of rows.rows) {
        if (row.operationId) {
          try {
            const op = await first<{ kind: string }>(
              c,
              sql`select kind from operation_entries where id=${row.operationId}::uuid`,
            );
            await requireRecord(c, op.kind as 'rfi', row.operationId);
          } catch {
            continue;
          }
        }
        items.push(row);
      }
      return { items };
    }),
  );
  app.put(
    '/api/construction/jobs/:id/model-links',
    tenantRoute(app, write, async (c) => {
      const r = await job(c, idParam.parse(c.req.params).id);
      const b = z
        .object({
          guid: z.string().min(1).max(100),
          wbsId: z.uuid().nullable(),
          operationId: z.uuid().nullable(),
          version: z.number().int().min(0),
        })
        .parse(c.req.body);
      if (r.kind !== 'ifc' || !r.resultHash) throw badRequest('İşlenmiş IFC modeli seçin.');
      const model = JSON.parse(
        (
          await readAsset(app.config.CONSTRUCTION_STORAGE_DIR, c.company.id, r.resultHash)
        ).toString(),
      ) as { elements: { guid: string }[] };
      if (!model.elements.some((e) => e.guid === b.guid))
        throw badRequest('Model elemanı bulunamadı.');
      if (b.wbsId)
        await first(
          c,
          sql`select id from project_wbs where id=${b.wbsId}::uuid and project_id=${r.projectId}::uuid and is_active`,
        );
      if (b.operationId) {
        const op = await first<{ kind: string }>(
          c,
          sql`select kind from operation_entries where id=${b.operationId}::uuid and project_id=${r.projectId}::uuid`,
        );
        if (
          ![
            'rfi',
            'quality_check',
            'safety',
            'site_report',
            'site_instruction',
            'schedule',
          ].includes(op.kind)
        )
          throw badRequest('Bu operasyon modele bağlanamaz.');
        await requireRecord(c, op.kind as 'rfi', b.operationId, true);
      }
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':model:' + r.id + ':' + b.guid},0))`,
      );
      const old = await c.tx.execute<{ id: string; version: number }>(
        sql`select id,version from construction_model_links where job_id=${r.id}::uuid and guid=${b.guid}`,
      );
      if ((old.rows[0]?.version ?? 0) !== b.version)
        throw conflict('Eleman bağlantısı değişti; yenileyin.');
      await c.tx.execute(
        sql`insert into construction_model_links(id,company_id,job_id,guid,wbs_id,operation_id) values(${randomUUID()},${c.company.id},${r.id},${b.guid},${b.wbsId},${b.operationId}) on conflict(company_id,job_id,guid) do update set wbs_id=excluded.wbs_id,operation_id=excluded.operation_id,version=construction_model_links.version+1`,
      );
      return { saved: true };
    }),
  );
  app.post(
    '/api/construction/jobs/:id/review',
    tenantRoute(app, write, async (c) => {
      const r = await job(c, idParam.parse(c.req.params).id);
      const b = z
        .object({
          version: z.number().int().positive(),
          type: z.enum(['invoice', 'delivery', 'report']),
          input: z.unknown(),
          confirmation: z.literal(true),
          /** Olası tekrar bulunduğunda kullanıcının bilerek devam ettiği (öneri 104). */
          acceptDuplicate: z.boolean().optional(),
        })
        .parse(c.req.body);
      if (
        typeof b.input === 'object' &&
        b.input !== null &&
        'post' in b.input &&
        b.input.post === true
      )
        throw badRequest('OCR aktarımı yalnızca taslak oluşturur.');
      await c.tx.execute(sql`select id from construction_jobs where id=${r.id}::uuid for update`);
      const current = await job(c, r.id);
      if (current.version !== b.version || current.reviewedRecordId)
        throw conflict('Sonuç değişti veya daha önce aktarıldı.');
      if (r.kind !== 'ocr' || r.status !== 'completed')
        throw badRequest('Tamamlanmış OCR sonucu seçin.');
      const ctx = {
        companyId: c.company.id,
        userId: c.user.id,
        baseCurrency: c.company.baseCurrency,
        reportingCurrency: c.company.reportingCurrency,
        allowNegativeStock: c.company.allowNegativeStock,
      };
      let id: string, kind: string;
      if (b.type === 'invoice') {
        const dup = await ocrDuplicates(c, r, app.config.CONSTRUCTION_STORAGE_DIR);
        if ((dup.invoices.length || dup.jobs.length) && !b.acceptDuplicate)
          throw conflict('Bu belge daha önce kaydedilmiş olabilir; olası tekrarları kontrol edin', 'OCR_POSSIBLE_DUPLICATE');
        c.require('invoices.manage');
        if (!c.enabledModules.has('core.invoices')) throw forbidden();
        const input = createInvoiceSchema.parse(b.input);
        if (input.type !== 'purchase' && input.type !== 'expense')
          throw badRequest('OCR ilk sürümü alış/gider taslağı oluşturur.');
        if (input.lines.some((l) => l.projectId && l.projectId !== r.projectId))
          throw badRequest('Satırlar aynı projeye ait olmalı.');
        const result = await createInvoiceDraft(c.tx, ctx, input);
        id = result;
        kind = 'invoice';
      } else if (b.type === 'delivery') {
        c.require('deliveries.manage');
        if (!c.enabledModules.has('core.deliveries')) throw forbidden();
        const input = createDeliveryNoteSchema.parse(b.input);
        if (input.type !== 'purchase')
          throw badRequest('OCR ilk sürümü alış irsaliyesi taslağı oluşturur.');
        const result = await createDeliveryDraft(c.tx, ctx, input);
        id = result;
        kind = 'delivery';
      } else {
        const p = z
          .object({
            title: z.string().min(2).max(200),
            workDone: z.string().min(2).max(4000),
            date: z.iso.date(),
          })
          .parse(b.input);
        id = randomUUID();
        kind = 'site_report';
        await c.tx.execute(
          sql`insert into operation_entries(id,company_id,project_id,kind,title,event_date,due_date,owner_id,payload,created_by) values(${id},${c.company.id},${r.projectId},'site_report',${p.title},${p.date},${p.date},${c.user.id},${JSON.stringify({ workers: 0, workDone: p.workDone, issues: '' })}::jsonb,${c.user.id})`,
        );
      }
      const f = await first<{ filename: string; mime: string; size: number; sha256: string }>(
        c,
        sql`select filename,mime,size,sha256 from construction_assets where id=${r.assetId}::uuid`,
      );
      const docId = randomUUID();
      await c.tx.execute(
        sql`insert into record_documents(id,company_id,record_kind,record_id,filename,mime,size,sha256,created_by) values(${docId},${c.company.id},${kind},${id},${f.filename},${f.mime},${f.size},${f.sha256},${c.user.id})`,
      );
      await c.tx.execute(
        sql`insert into record_document_content(id,company_id,content) values(${docId},${c.company.id},${(await readAsset(app.config.CONSTRUCTION_STORAGE_DIR, c.company.id, f.sha256)).toString('base64')})`,
      );
      await c.tx.execute(
        sql`update construction_jobs set reviewed_record_kind=${kind},reviewed_record_id=${id},version=version+1 where id=${r.id}::uuid`,
      );
      return { recordKind: kind, recordId: id };
    }),
  );
};
async function python(app: FastifyInstance, kind: string, source: string, output: string) {
  const script = fileURLToPath(new URL('./construction-worker.py', import.meta.url));
  await new Promise<void>((resolvePromise, reject) => {
    const p = spawn(app.config.CONSTRUCTION_WORKER_EXECUTABLE ?? app.config.CONSTRUCTION_PYTHON, app.config.CONSTRUCTION_WORKER_EXECUTABLE ? [kind, source, output] : [script, kind, source, output], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    p.stderr.on('data', (chunk) => {
      error = (error + String(chunk)).slice(-3000);
    });
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('Yerel işlem 5 dakika sınırını aştı.'));
    }, 300000);
    p.on('error', () => {
      clearTimeout(timer);
      reject(
        new Error(
          'Yerel Python çalışma zamanı bulunamadı. CONSTRUCTION_PYTHON ayarını kontrol edin.',
        ),
      );
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            error.includes('ModuleNotFoundError')
              ? 'Yerel IFC/PDF bağımlılığı eksik. İnşaat çalışma zamanı kurulumunu tamamlayın.'
              : error.includes('ValueError:')
                ? error.split('ValueError:').pop()!.trim()
                : 'Dosya yerel işleyici tarafından okunamadı. Biçimini kontrol edin.',
          ),
        );
    });
  });
}
export async function processConstructionJobs(app: FastifyInstance) {
  const targets = (
    await app.db.execute<{ company_id: string; organization_id: string }>(
      sql`select company_id,organization_id from notification_scan_targets()`,
    )
  ).rows;
  for (const target of targets) {
    const context = { companyId: target.company_id, orgId: target.organization_id };
    const claimed = await withContext(app.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('erp-maintenance-write'))`);
      if ((await tx.execute(sql`select id from app_updates where status='applying' limit 1`)).rows[0]) return null;
      const candidate = (
        await tx.execute<{ id: string; createdBy: string }>(
          sql`select id,created_by as "createdBy" from construction_jobs where status='queued' or(status='running' and lease_until<now()) order by created_at for update skip locked limit 1`,
        )
      ).rows[0];
      if (!candidate) return null;
      const member = (
        await tx.execute<{ role: Role }>(
          sql`select m.role from memberships m join users u on u.id=m.user_id where m.user_id=${candidate.createdBy}::uuid and m.company_id=${target.company_id}::uuid and u.is_active`,
        )
      ).rows[0];
      const company = (
        await tx.execute<{ sector: Sector }>(
          sql`select sector from companies where id=${target.company_id}::uuid`,
        )
      ).rows[0];
      const modules = (
        await tx.execute<{ module: string; enabled: boolean }>(
          sql`select module,enabled from company_modules`,
        )
      ).rows;
      await setContext(tx, { ...context, userId: candidate.createdBy });
      const permissions = member
        ? (await loadMemberAccess(tx, target.company_id, candidate.createdBy, member.role))
            .permissions
        : null;
      if (
        !permissions?.has('projects.manage') ||
        !company ||
        !resolveEnabledModules(company.sector, modules).has('construction.projects')
      ) {
        await tx.execute(
          sql`update construction_jobs set status='failed',error='İşi oluşturan kullanıcının etkin proje yetkisi kaldırıldı.',lease_until=null,version=version+1 where id=${candidate.id}::uuid`,
        );
        return null;
      }
      return (
        await tx.execute<{
          id: string;
          assetId: string;
          kind: 'ifc' | 'ocr';
          mime: string;
          hash: string;
          attempts: number;
        }>(
          sql`update construction_jobs j set status='running',attempts=attempts+1,lease_until=now()+interval '10 minutes',progress=10,error=null,version=version+1 from construction_assets a where j.id=${candidate.id}::uuid and a.id=j.asset_id returning j.id,j.asset_id as "assetId",j.kind,j.attempts,a.mime,a.sha256 as hash`,
        )
      ).rows[0];
    });
    if (!claimed) continue;
    let temp: string | undefined;
    try {
      const root = resolve(app.config.CONSTRUCTION_STORAGE_DIR);
      await mkdir(root, { recursive: true });
      temp = await mkdtemp(join(root, '.job-'));
      const source = join(temp, 'source'),
        output = join(temp, 'result.json');
      await writeFile(source, await readAsset(root, target.company_id, claimed.hash), {
        mode: 0o600,
      });
      let result: Record<string, unknown>;
      if (claimed.kind === 'ifc') {
        await python(app, 'ifc', source, output);
        result = JSON.parse(await readFile(output, 'utf8'));
      } else {
        let text = '',
          images: string[] = [];
        if (claimed.mime === 'application/pdf') {
          await python(app, 'pdf', source, output);
          const extracted = JSON.parse(await readFile(output, 'utf8'));
          text = extracted.text;
          images = extracted.images;
        } else images = [source];
        if (images.length) {
          const lang = resolve(app.config.CONSTRUCTION_TESSDATA_DIR);
          try {
            await access(join(lang, 'eng.traineddata.gz'));
            await access(join(lang, 'tur.traineddata.gz'));
          } catch {
            throw new Error(
              'Yerel Türkçe/İngilizce OCR dil dosyaları eksik. Çalışma zamanı kurulumunu tamamlayın.',
            );
          }
          const worker = await createWorker('eng+tur', 1, {
            langPath: lang,
            cachePath: temp,
            gzip: true,
          });
          try {
            for (const [i, path] of images.entries()) {
              if (dirname(path) !== temp) throw new Error('Geçersiz yerel çıktı.');
              const recognition = worker.recognize(await readFile(path));
              let timeout: ReturnType<typeof setTimeout> | undefined;
              try {
                const result = await Promise.race([
                  recognition,
                  new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                      () =>
                        reject(
                          new Error(
                            'OCR sayfası işleme süresi aşıldı; daha küçük bir belgeyle yeniden deneyin.',
                          ),
                        ),
                      60000,
                    );
                  }),
                ]);
                text += '\n' + result.data.text;
              } finally {
                if (timeout) clearTimeout(timeout);
              }
              await withContext(app.db, context, (tx) =>
                tx.execute(
                  sql`update construction_jobs set progress=${Math.round(20 + ((i + 1) / images.length) * 70)} where id=${claimed.id}::uuid and attempts=${claimed.attempts}`,
                ),
              );
            }
          } finally {
            await worker.terminate();
          }
        }
        result = { text: text.slice(0, 200000), suggestions: ocrSuggestions(text) };
      }
      const hash = await storeAsset(
        app.config.CONSTRUCTION_STORAGE_DIR,
        target.company_id,
        Buffer.from(JSON.stringify(result)),
      );
      const summary =
        claimed.kind === 'ifc'
          ? {
              elements: (result.elements as unknown[]).length,
              warnings: result.warnings,
              schema: result.schema,
            }
          : { suggestions: result.suggestions, characters: String(result.text).length };
      await withContext(app.db, context, (tx) =>
        tx.execute(
          sql`update construction_jobs set status='completed',progress=100,result_hash=${hash},summary=${JSON.stringify(summary)}::jsonb,lease_until=null,error=null,version=version+1 where id=${claimed.id}::uuid and attempts=${claimed.attempts} and status='running'`,
        ),
      );
    } catch (e) {
      await withContext(app.db, context, (tx) =>
        tx.execute(
          sql`update construction_jobs set status='failed',error=${(e instanceof Error ? e.message : 'İşlenemeyen yerel dosya.').slice(0, 2000)},lease_until=null,version=version+1 where id=${claimed.id}::uuid and attempts=${claimed.attempts}`,
        ),
      );
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
    }
    return true;
  }
  return false;
}
export function startConstructionScheduler(app: FastifyInstance) {
  if (!app.config.CONSTRUCTION_JOBS_ENABLED) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processConstructionMaintenance(app);
      await processConstructionJobs(app);
    } catch (e) {
      app.log.warn({ err: e }, 'İnşaat işlem kuyruğu');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  return () => clearInterval(timer);
}
export async function processConstructionMaintenance(app: FastifyInstance) {
  const targets = (
    await app.db.execute<{ company_id: string; organization_id: string }>(
      sql`select company_id,organization_id from notification_scan_targets()`,
    )
  ).rows;
  for (const target of targets)
    await withContext(
      app.db,
      { companyId: target.company_id, orgId: target.organization_id },
      async (tx) => {
        const member = (
          await tx.execute<{ id: string; role: Role; sector: Sector }>(
            sql`select u.id,m.role,c.sector from memberships m join users u on u.id=m.user_id join companies c on c.id=m.company_id where m.company_id=${target.company_id}::uuid and m.role in ('owner','admin') and u.is_active order by (m.role='owner') desc limit 1`,
          )
        ).rows[0];
        if (!member) return;
        await setContext(tx, {
          companyId: target.company_id,
          orgId: target.organization_id,
          userId: member.id,
        });
        const access = await loadMemberAccess(tx, target.company_id, member.id, member.role);
        const modules = (
          await tx.execute<{ module: string; enabled: boolean }>(
            sql`select module,enabled from company_modules`,
          )
        ).rows;
        const enabledModules = resolveEnabledModules(member.sector, modules);
        if (
          !enabledModules.has('construction.projects') ||
          !access.permissions.has('projects.manage')
        )
          return;
        const c = {
          tx,
          company: { id: target.company_id },
          user: { id: member.id },
          enabledModules,
          access,
          can: (permission: Parameters<TenantCtx['can']>[0]) => access.permissions.has(permission),
        };
        await expireReservations(c);
        const samples = (
          await tx.execute<ConstructionWorkflow & Record<string, unknown>>(
            sql`select id,project_id as "projectId",title,payload,owner_id as "ownerId",location_id as "locationId",linked_id as "linkedId" from construction_workflows where kind='concrete' and status='approved' and linked_id is null order by created_at for update skip locked limit 100`,
          )
        ).rows;
        // Her numunenin son laboratuvar sonucu tek sorguda (numune başına ayrı sorgu yok)
        const latest = samples.length
          ? (
              await tx.execute<{ workflowId: string; data: Record<string, unknown> }>(
                sql`select distinct on (workflow_id) workflow_id as "workflowId", data from construction_workflow_events where action='lab_results' and workflow_id in (${sql.join(samples.map((r) => sql`${r.id}::uuid`), sql`, `)}) order by workflow_id, at desc, id desc`,
              )
            ).rows
          : [];
        const lastBy = new Map(latest.map((row) => [row.workflowId, row.data]));
        for (const r of samples) {
          const last = lastBy.get(r.id);
          if (last) r.payload = { ...r.payload, samples: last.samples };
          await ensureConcreteAction(c, r);
        }
      },
    );
}
