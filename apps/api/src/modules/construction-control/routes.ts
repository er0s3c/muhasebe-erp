import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  assetUploadSchema,
  locationSchema,
  drawingSchema,
  drawingDecisionSchema,
  drawingPinSchema,
  progressPhotoSchema,
  todayIso,
  idParam,
  type ConstructionRisk,
  type ConstructionCockpit,
  type ConstructionDrawing,
  type ConstructionWorkflow,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, notFound, forbidden } from '../../http/errors';
import { requireRecord } from '../workspace/records';
import { projectCostReport } from '../projects/reports';
import { readAsset, storeAsset, validateAsset } from './storage';
import { hydrateWorkflow, workflowAllowed } from './workflows';
const read = { module: 'construction.projects', permission: 'projects.read' as const };
const write = { module: 'construction.projects', permission: 'projects.manage' as const };
const approval = { module: 'construction.projects', permission: 'projects.budget' as const };
const projectQuery = z.object({ projectId: z.uuid() });
const drawingSelect = sql`id,project_id as "projectId",asset_id as "assetId",code,title,discipline,revision,previous_id as "previousId",status,version,created_at as "createdAt"`;
export async function first<T extends object>(c: TenantCtx, q: SQL, label = 'Kayıt') {
  const rows = await c.tx.execute<T & Record<string, unknown>>(q);
  if (!rows.rows[0]) throw notFound(label);
  return rows.rows[0];
}
async function project(c: TenantCtx, id: string) {
  await requireRecord(c, 'project', id);
}
async function location(c: TenantCtx, id: string, projectId: string) {
  return first<{ id: string; kind: string }>(
    c,
    sql`select id,kind from construction_locations where id=${id}::uuid and project_id=${projectId}::uuid`,
    'Konum',
  );
}
async function drawing(c: TenantCtx, id: string) {
  return first<ConstructionDrawing>(
    c,
    sql`select ${drawingSelect} from construction_drawings where id=${id}::uuid`,
    'Çizim',
  );
}
async function asset(c: TenantCtx, id: string, projectId?: string) {
  return first<{ id: string; projectId: string; filename: string; mime: string; sha256: string }>(
    c,
    sql`select id,project_id as "projectId",filename,mime,sha256 from construction_assets where id=${id}::uuid ${projectId ? sql`and project_id=${projectId}::uuid` : sql``}`,
    'Dosya',
  );
}

export async function cockpit(c: TenantCtx, projectId: string): Promise<ConstructionCockpit> {
  const p = await first<{ id: string; code: string; name: string }>(
    c,
    sql`select id,code,name from projects where id=${projectId}::uuid`,
    'Proje',
  );
  const date = todayIso();
  const operations = await c.tx.execute<{
    id: string;
    kind: string;
    title: string;
    due: string;
    owner: string;
    payload: Record<string, unknown>;
  }>(
    sql`select o.id,o.kind,o.title,o.due_date::text as due,u.full_name as owner,o.payload from operation_entries o join users u on u.id=o.owner_id where o.project_id=${projectId}::uuid and o.status='open' and o.kind<>'defect' order by o.due_date limit 501`,
  );
  const risks: ConstructionRisk[] = operations.rows
    .filter(
      (o) =>
        (o.due < date && ['rfi', 'schedule', 'safety', 'quality_check'].includes(o.kind)) ||
        (o.kind === 'safety' && ['high', 'critical'].includes(String(o.payload.severity))),
    )
    .slice(0, 100)
    .map((o) => ({
      key: 'operation:' + o.id,
      title: o.title,
      reason:
        o.kind === 'rfi'
          ? 'Teknik yanıtın termini geçti.'
          : o.kind === 'schedule'
            ? 'Programlanan işin termini geçti.'
            : 'Açık saha aksiyonunun termini geçti.',
      severity:
        o.kind === 'safety' && ['high', 'critical'].includes(String(o.payload.severity))
          ? 'critical'
          : 'warning',
      owner: o.owner,
      dueDate: o.due,
      path: `/workspace/operations?kind=${o.kind}&open=${o.id}`,
      action: o.kind === 'rfi' ? 'Teknik yanıtı tamamlayın.' : 'Sorumluyla aksiyonu güncelleyin.',
    }));
  const files = await c.tx.execute<
    ConstructionWorkflow & { owner: string | null } & Record<string, unknown>
  >(
    sql`select w.id,w.kind,w.title,w.payload,w.computed,w.project_id as "projectId",w.linked_id as "linkedId",u.full_name as owner from construction_workflows w left join users u on u.id=w.owner_id where w.project_id=${projectId}::uuid and w.status='approved' order by w.created_at desc limit 1000`,
  );
  for (const r of files.rows) {
    if (!workflowAllowed(c, r.kind)) continue;
    let reason = '',
      action = '',
      due: string | null = null;
    if (r.kind === 'concrete') {
      await hydrateWorkflow(c, r);
      if (Number(r.computed.failed)) {
        reason = `${r.computed.failed} numune kabul sınırının altında.`;
        action = 'Laboratuvar sonuçlarını ve kalite aksiyonunu inceleyin.';
      } else if (Number(r.computed.overdue)) {
        reason = `${r.computed.overdue} numunenin sonuç termini geçti.`;
        action = 'Laboratuvardan sonucu alın ve numune dosyasına ekleyin.';
      }
    }
    if (r.kind === 'permit' && String(r.payload.end) < date) {
      reason = 'Çalışma izninin geçerlilik süresi doldu.';
      action = 'İzni kapatın; çalışma devam edecekse yeni izin alın.';
      due = String(r.payload.end);
    }
    if (r.kind === 'maintenance') {
      await hydrateWorkflow(c, r);
      if (String(r.payload.dueDate) < date || r.computed.hoursDue === true) {
        reason =
          r.computed.hoursDue === true
            ? `Ekipman ${r.computed.operatingHours} çalışma saatine ulaştı; bakım eşiği ${r.payload.dueHours} saat.`
            : 'Planlanan ekipman bakım tarihi geçti.';
        action = 'Bakımı yapın, arıza ve kapanış kaydını güncelleyin.';
        due = String(r.payload.dueDate);
      }
    }
    if (r.kind === 'material_need' && Number(r.computed.shortage) > 0 && !r.linkedId) {
      reason = `İhtiyaç planında ${r.computed.shortage} ${r.payload.unit} karşılanmamış miktar var; kayıt onayındaki stok ve açık sipariş hesabı.`;
      action = 'Güncel stokla satın alma talebi oluşturun.';
      due = String(r.payload.needDate);
    }
    if (r.kind === 'readiness' && !r.computed.ready) {
      const schedule = await c.tx.execute<{ start: string }>(
        sql`select payload->>'start' as start from operation_entries where id=${String(r.payload.activityId)}::uuid and status='open'`,
      );
      due = schedule.rows[0]?.start ?? null;
      const horizon = new Date(date + 'T12:00:00Z');
      horizon.setUTCDate(horizon.getUTCDate() + 21);
      if (due && due <= horizon.toISOString().slice(0, 10)) {
        reason = `Yaklaşan işin hazırlığı tamamlanmadı: ${(r.computed.blockers as string[]).join(', ')}. ${String(r.payload.blocker)}`;
        action = 'Hazırlık engelini sorumluyla kaldırın.';
      }
    }
    if (reason)
      risks.push({
        key: 'workflow:' + r.id,
        title: r.title,
        reason,
        action,
        dueDate: due,
        owner: r.owner,
        severity: r.kind === 'concrete' && Number(r.computed.failed) > 0 ? 'critical' : 'warning',
        path: `/workspace/project-control?projectId=${projectId}&tab=${['material_need'].includes(r.kind) ? 'commercial' : r.kind === 'readiness' ? 'program' : 'field'}&open=${r.id}`,
      });
  }
  risks.sort(
    (a, b) =>
      Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
      (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
  );
  const counts = await first<{ open: number; overdue: number; drawings: number; photos: number }>(
    c,
    sql`select (select count(*)::int from operation_entries where project_id=${projectId}::uuid and status='open' and kind<>'defect') as open,(select count(*)::int from operation_entries where project_id=${projectId}::uuid and status='open' and kind<>'defect' and due_date<${date}::date) as overdue,(select count(*)::int from construction_drawings where project_id=${projectId}::uuid and status='approved') as drawings,(select count(*)::int from construction_photos where project_id=${projectId}::uuid) as photos`,
  );
  let metrics: ConstructionCockpit['metrics'] = null;
  const dataNotes: string[] = [];
  if (c.can('ledger.read') && c.enabledModules.has('core.ledger')) {
    const report = await projectCostReport(c.tx, projectId, date);
    metrics = report.budget ? report.totals : null;
    if (!report.budget)
      dataNotes.push('Onaylı bütçe bulunmuyor; maliyet performansı hesaplanmadı.');
    if (metrics && Number(metrics.eac) > Number(metrics.budget))
      risks.unshift({
        key: 'budget:' + projectId,
        title: 'Tahmini bütçe aşımı',
        reason: `Tahmini maliyet ${metrics.eac}; onaylı bütçe ${metrics.budget} ${c.company.baseCurrency}.`,
        severity: 'critical',
        owner: null,
        dueDate: null,
        path: `/projects/${projectId}`,
        action: 'İş kalemi sapmalarını ve kalan maliyet tahminini inceleyin.',
      });
  } else dataNotes.push('Mali göstergeler için muhasebe okuma yetkisi gerekir.');
  dataNotes.push(
    'Malzeme riskleri onay anındaki ihtiyaç hesabını gösterir; aktarım öncesinde stok ve açık sipariş yeniden hesaplanır.',
  );
  if (operations.rows.length > 500)
    dataNotes.push(
      'Risk ayrıntısında en erken terminli 500 kayıt incelendi; sayaçlar tüm kayıtları kapsar.',
    );
  const snapshots = await c.tx.execute<{
    date: string;
    payload: { counts: ConstructionCockpit['counts'] };
  }>(
    sql`select date::text,payload from construction_snapshots where project_id=${projectId}::uuid and date<=${date}::date-7 order by date desc limit 1`,
  );
  const previous = snapshots.rows[0];
  return {
    asOf: date,
    project: p,
    currency: c.company.baseCurrency,
    metrics,
    counts,
    previous: previous ? { date: previous.date, counts: previous.payload.counts } : null,
    risks,
    dataNotes,
  };
}

export const constructionControlRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/construction/order-submittals',
    tenantRoute(
      app,
      { module: 'construction.procurement', permission: 'procurement.read' },
      async (c) => {
        const { orderId } = z.object({ orderId: z.uuid() }).parse(c.req.query);
        await first(c, sql`select id from purchase_orders where id=${orderId}::uuid`, 'Sipariş');
        return {
          items: (
            await c.tx.execute(
              sql`select id,title,status,project_id as "projectId",payload->>'brand' as brand,payload->>'revision' as revision from construction_workflows where kind='submittal' and payload->>'orderId'=${orderId} order by created_at desc limit 100`,
            )
          ).rows,
        };
      },
    ),
  );
  app.get(
    '/api/construction/record-links',
    tenantRoute(app, read, async (c) => {
      const q = z
        .object({ kind: drawingPinSchema.shape.recordKind, id: z.uuid() })
        .parse(c.req.query);
      await requireRecord(c, q.kind, q.id);
      const items = await c.tx.execute(
        sql`select p.id,p.drawing_id as "drawingId",d.code,d.revision,d.project_id as "projectId",p.page,l.name as location from construction_pins p join construction_drawings d on d.id=p.drawing_id left join construction_locations l on l.id=p.location_id where p.record_kind=${q.kind} and p.record_id=${q.id}::uuid order by p.created_at limit 100`,
      );
      return { items: items.rows };
    }),
  );
  app.get(
    '/api/construction/locations',
    tenantRoute(app, read, async (c) => {
      const q = projectQuery.parse(c.req.query);
      await project(c, q.projectId);
      return {
        items: (
          await c.tx.execute(
            sql`select id,project_id as "projectId",parent_id as "parentId",kind,name from construction_locations where project_id=${q.projectId}::uuid order by created_at limit 2000`,
          )
        ).rows,
      };
    }),
  );
  app.post(
    '/api/construction/locations',
    tenantRoute(app, write, async (c) => {
      const b = locationSchema.parse(c.req.body);
      await project(c, b.projectId);
      if (b.parentId) {
        const p = await location(c, b.parentId, b.projectId);
        if (
          (b.kind === 'level' && p.kind !== 'building') ||
          (b.kind === 'zone' && p.kind !== 'level') ||
          b.kind === 'building'
        )
          throw badRequest('Konum sırası yapı → seviye → mahal olmalıdır.');
      } else if (b.kind !== 'building') throw badRequest('Üst konumu seçin.');
      const id = randomUUID();
      await c.tx.execute(
        sql`insert into construction_locations(id,company_id,project_id,parent_id,kind,name,created_by) values(${id},${c.company.id},${b.projectId},${b.parentId},${b.kind},${b.name},${c.user.id})`,
      );
      c.reply.code(201);
      return { item: { id, ...b } };
    }),
  );
  app.post(
    '/api/construction/assets',
    { bodyLimit: 36 * 1024 * 1024 },
    tenantRoute(app, write, async (c) => {
      const b = assetUploadSchema.parse(c.req.body);
      await project(c, b.projectId);
      const bytes = Buffer.from(b.base64, 'base64');
      validateAsset(bytes, b.mime);
      const {settings}=await operationalSettings(c.tx);
      if(bytes.length>settings.fieldLimitMb*1024*1024) throw badRequest(`Saha dosyası sınırı ${settings.fieldLimitMb} MB.`);
      const hash = await storeAsset(app.config.CONSTRUCTION_STORAGE_DIR, c.company.id, bytes);
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':asset:' + b.projectId + ':' + hash + ':' + b.filename},0))`,
      );
      const old = await c.tx.execute(
        sql`select id,project_id as "projectId",filename,mime,size from construction_assets where project_id=${b.projectId}::uuid and sha256=${hash} and filename=${b.filename} and mime=${b.mime} limit 1`,
      );
      if (old.rows[0]) return { item: old.rows[0] };
      const id = randomUUID();
      await c.tx.execute(
        sql`insert into construction_assets(id,company_id,project_id,filename,mime,size,sha256,created_by) values(${id},${c.company.id},${b.projectId},${b.filename},${b.mime},${bytes.length},${hash},${c.user.id})`,
      );
      c.reply.code(201);
      return {
        item: {
          id,
          projectId: b.projectId,
          filename: b.filename,
          mime: b.mime,
          size: bytes.length,
        },
      };
    }),
  );
  app.get(
    '/api/construction/assets/:id/download',
    tenantRoute(app, read, async (c) => {
      const f = await asset(c, idParam.parse(c.req.params).id);
      c.reply
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        )
        .type(f.mime);
      return c.reply.send(
        await readAsset(app.config.CONSTRUCTION_STORAGE_DIR, c.company.id, f.sha256),
      );
    }),
  );
  app.get(
    '/api/construction/drawings',
    tenantRoute(app, read, async (c) => {
      const q = projectQuery.parse(c.req.query);
      await project(c, q.projectId);
      return {
        items: (
          await c.tx.execute(
            sql`select ${drawingSelect} from construction_drawings where project_id=${q.projectId}::uuid order by code,created_at desc limit 1000`,
          )
        ).rows,
      };
    }),
  );
  app.post(
    '/api/construction/drawings',
    tenantRoute(app, write, async (c) => {
      const b = drawingSchema.parse(c.req.body);
      await project(c, b.projectId);
      const f = await asset(c, b.assetId, b.projectId);
      if (f.mime !== 'application/pdf') throw badRequest('Çizim PDF olmalıdır.');
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':drawing:' + b.projectId + ':' + b.code},0))`,
      );
      if (b.previousId) {
        const prev = await drawing(c, b.previousId);
        if (prev.projectId !== b.projectId || prev.code !== b.code)
          throw badRequest('Önceki revizyon aynı proje ve çizime ait olmalıdır.');
        const child = await c.tx.execute(
          sql`select id from construction_drawings where previous_id=${b.previousId}::uuid`,
        );
        if (child.rows.length) throw conflict('Bu revizyonun sonraki sürümü zaten var.');
      } else {
        const prev = await c.tx.execute(
          sql`select id from construction_drawings where project_id=${b.projectId}::uuid and code=${b.code}`,
        );
        if (prev.rows.length) throw conflict('Önceki revizyonu seçin.');
      }
      const id = randomUUID();
      await c.tx.execute(
        sql`insert into construction_drawings(id,company_id,project_id,asset_id,code,title,discipline,revision,previous_id,created_by) values(${id},${c.company.id},${b.projectId},${b.assetId},${b.code},${b.title},${b.discipline},${b.revision},${b.previousId},${c.user.id})`,
      );
      c.reply.code(201);
      return { item: await drawing(c, id) };
    }),
  );
  app.post(
    '/api/construction/drawings/:id/decision',
    tenantRoute(app, approval, async (c) => {
      const id = idParam.parse(c.req.params).id;
      const b = drawingDecisionSchema.parse(c.req.body);
      const d = await drawing(c, id);
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':drawing:' + d.projectId + ':' + d.code},0))`,
      );
      const current = await drawing(c, id);
      if (current.version !== b.version) throw conflict('Çizim değişti; yenileyin.');
      if (
        current.status === 'obsolete' ||
        (current.status === 'approved' && b.status === 'approved')
      )
        throw badRequest('Bu durum geçişi yapılamaz.');
      if (b.status === 'approved') {
        const child = await c.tx.execute(
          sql`select id from construction_drawings where previous_id=${id}::uuid`,
        );
        if (child.rows.length) throw badRequest('Sonraki revizyon varken eski sürüm onaylanamaz.');
        await c.tx.execute(
          sql`update construction_drawings set status='obsolete',version=version+1,decision_note='Yeni revizyon onaylandı' where project_id=${d.projectId}::uuid and code=${d.code} and status='approved'`,
        );
      }
      await c.tx.execute(
        sql`update construction_drawings set status=${b.status},version=version+1,decision_note=${b.note} where id=${id}::uuid`,
      );
      return { item: await drawing(c, id) };
    }),
  );
  app.get(
    '/api/construction/drawings/:id/pins',
    tenantRoute(app, read, async (c) => {
      const d = await drawing(c, idParam.parse(c.req.params).id);
      const rows = await c.tx.execute<{ recordKind: string; recordId: string }>(
        sql`select id,drawing_id as "drawingId",location_id as "locationId",page,x,y,label,record_kind as "recordKind",record_id as "recordId" from construction_pins where drawing_id=${d.id}::uuid order by created_at limit 2000`,
      );
      const visible = [];
      for (const row of rows.rows) {
        try {
          await requireRecord(c, row.recordKind as 'rfi', row.recordId);
          visible.push(row);
        } catch (err) {
          if (![403, 404].includes(Number((err as { status?: number }).status))) throw err;
        }
      }
      return { items: visible };
    }),
  );
  app.post(
    '/api/construction/pins',
    tenantRoute(app, write, async (c) => {
      const b = drawingPinSchema.parse(c.req.body);
      const d = await drawing(c, b.drawingId);
      if (d.status !== 'approved') throw badRequest('İşaretleme için onaylı çizim seçin.');
      await requireRecord(c, b.recordKind, b.recordId, true);
      await first(
        c,
        sql`select id from operation_entries where id=${b.recordId}::uuid and kind=${b.recordKind} and project_id=${d.projectId}::uuid`,
        'Proje operasyonu',
      );
      if (b.locationId) await location(c, b.locationId, d.projectId);
      await c.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':pin:' + b.clientId},0))`,
      );
      const old = await c.tx.execute<Record<string, unknown> & { id: string }>(
        sql`select id,drawing_id as "drawingId",record_id as "recordId",record_kind as "recordKind",location_id as "locationId",page,x,y,label from construction_pins where client_id=${b.clientId}::uuid`,
      );
      if (old.rows[0]) {
        if (Object.entries(b).some(([k, v]) => k !== 'clientId' && old.rows[0]![k] !== v))
          throw conflict('Gönderim kimliği farklı kayıt için kullanıldı.');
        return { item: old.rows[0] };
      }
      const id = randomUUID();
      await c.tx.execute(
        sql`insert into construction_pins(id,company_id,project_id,drawing_id,location_id,page,x,y,label,record_kind,record_id,client_id,created_by) values(${id},${c.company.id},${d.projectId},${d.id},${b.locationId},${b.page},${b.x},${b.y},${b.label},${b.recordKind},${b.recordId},${b.clientId},${c.user.id})`,
      );
      c.reply.code(201);
      return { item: { id, ...b } };
    }),
  );
  app.get(
    '/api/construction/photos',
    tenantRoute(app, read, async (c) => {
      const q = projectQuery.extend({ locationId: z.uuid().optional() }).parse(c.req.query);
      await project(c, q.projectId);
      return {
        items: (
          await c.tx.execute(
            sql`select p.id,p.project_id as "projectId",p.location_id as "locationId",l.name as "locationName",p.asset_id as "assetId",p.date::text,p.caption,p.panorama,p.operation_id as "operationId" from construction_photos p join construction_locations l on l.id=p.location_id where p.project_id=${q.projectId}::uuid ${q.locationId ? sql`and p.location_id=${q.locationId}::uuid` : sql``} order by p.date desc,p.created_at desc limit 500`,
          )
        ).rows,
      };
    }),
  );
  app.post(
    '/api/construction/photos',
    tenantRoute(app, write, async (c) => {
      const b = progressPhotoSchema.parse(c.req.body);
      await project(c, b.projectId);
      await location(c, b.locationId, b.projectId);
      const f = await asset(c, b.assetId, b.projectId);
      if (!f.mime.startsWith('image/')) throw badRequest('Fotoğraf PNG veya JPEG olmalıdır.');
      if (b.clientId) {
        await c.tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':photo:' + b.clientId},0))`,
        );
        const old = await c.tx.execute<{
          id: string;
          projectId: string;
          assetId: string;
          operationId: string | null;
          locationId: string;
          date: string;
          caption: string;
          panorama: boolean;
        }>(
          sql`select id,project_id as "projectId",asset_id as "assetId",operation_id as "operationId",location_id as "locationId",date::text,caption,panorama from construction_photos where client_id=${b.clientId}::uuid`,
        );
        if (old.rows[0]) {
          if (
            old.rows[0].projectId !== b.projectId ||
            old.rows[0].assetId !== b.assetId ||
            old.rows[0].operationId !== b.operationId ||
            old.rows[0].locationId !== b.locationId ||
            old.rows[0].date !== b.date ||
            old.rows[0].caption !== b.caption ||
            old.rows[0].panorama !== b.panorama
          )
            throw conflict('Gönderim kimliği farklı fotoğraf için kullanıldı.');
          return { item: old.rows[0] };
        }
      }
      if (b.operationId) {
        const op = await first<{ kind: string }>(
          c,
          sql`select kind from operation_entries where id=${b.operationId}::uuid and project_id=${b.projectId}::uuid`,
        );
        if (
          !['site_report', 'rfi', 'quality_check', 'safety', 'site_instruction'].includes(op.kind)
        )
          throw forbidden();
      }
      const id = randomUUID();
      await c.tx.execute(
        sql`insert into construction_photos(id,company_id,project_id,location_id,asset_id,date,caption,panorama,operation_id,client_id,created_by) values(${id},${c.company.id},${b.projectId},${b.locationId},${b.assetId},${b.date},${b.caption},${b.panorama},${b.operationId},${b.clientId ?? null},${c.user.id})`,
      );
      c.reply.code(201);
      return { item: { id, ...b } };
    }),
  );
  app.get(
    '/api/construction/cockpit',
    tenantRoute(app, read, async (c) => {
      const q = projectQuery.parse(c.req.query);
      await project(c, q.projectId);
      return cockpit(c, q.projectId);
    }),
  );
  app.post(
    '/api/construction/snapshots',
    tenantRoute(app, write, async (c) => {
      const q = projectQuery.parse(c.req.body);
      await project(c, q.projectId);
      const data = await cockpit(c, q.projectId);
      await c.tx.execute(
        sql`insert into construction_snapshots(id,company_id,project_id,date,payload,created_by) values(${randomUUID()},${c.company.id},${q.projectId},${data.asOf},${JSON.stringify({ counts: data.counts })}::jsonb,${c.user.id}) on conflict(company_id,project_id,date) do nothing`,
      );
      return { saved: true, date: data.asOf };
    }),
  );
};
import { operationalSettings } from '../administration/settings';
