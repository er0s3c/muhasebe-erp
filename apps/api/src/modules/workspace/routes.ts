import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  documentUploadSchema,
  idParam,
  recordRefSchema,
  recordKindSchema,
  todayIso,
  workItemSchema,
  workItemUpdateSchema,
  type RecordKind,
  type WorkItem,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors';
import { RECORDS, canAccessRecord, requireRecord, searchRecords } from './records';
import { trContains } from '../../db/search';
import { agendaSummary } from '../directory/agenda';
import { workAlerts } from './alerts';
import { isoDate } from '@erp/shared';
import { setupChecklist } from './setup';
import { operationalSettings } from '../administration/settings';
import { storeAsset, readAsset } from '../construction-control/storage';

const taskFields = sql`w.id, w.title, w.description, w.due_date::text AS "dueDate", w.owner_id AS "ownerId",
  u.full_name AS "ownerName", w.priority, w.status, w.version, w.record_kind AS "recordKind", w.record_id AS "recordId", w.created_by AS "createdBy"`;
const admin = (c: TenantCtx) => c.can('members.manage');
const canWrite = (c: TenantCtx) =>
  Array.from(c.access.permissions).some(
    (p) => !p.endsWith('.read') && p !== 'workspace.use' && p !== 'data.export',
  );
async function ownerValid(c: TenantCtx, id: string) {
  const r = await c.tx.execute(sql`select 1 from memberships m join users u on u.id = m.user_id
    where m.company_id = ${c.company.id}::uuid and m.user_id = ${id}::uuid and u.is_active`);
  if (!r.rows.length) throw notFound('Sorumlu kullanıcı');
}
export async function getTask(c: TenantCtx, id: string) {
  const r = await c.tx.execute<WorkItem>(
    sql`select ${taskFields} from work_items w join users u on u.id=w.owner_id where w.id=${id}::uuid`,
  );
  const item = r.rows[0];
  if (!item) throw notFound();
  if (item.recordKind && item.recordId) await requireRecord(c, item.recordKind, item.recordId);
  return item;
}

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  const access = { module: 'core.dashboard', permission: 'workspace.use' } as const;
  app.get('/api/workspace/setup', tenantRoute(app, access, setupChecklist));
  app.get(
    '/api/workspace/record',
    tenantRoute(app, access, async (c) => {
      const ref = recordRefSchema.parse(c.req.query);
      const def = await requireRecord(c, ref.kind, ref.id);
      const rows = await c.tx.execute<{ label: string }>(
        sql`select ${sql.raw(def.label)} as label from ${sql.identifier(def.table)} where id=${ref.id}::uuid`,
      );
      return {
        ...ref,
        label: rows.rows[0]!.label,
        path: def.path + ref.id,
        canWrite: canAccessRecord(c, ref.kind, true),
      };
    }),
  );
  app.get('/api/workspace/alerts', tenantRoute(app, access, workAlerts));
  app.post(
    '/api/workspace/alerts/state',
    tenantRoute(app, access, async (c) => {
      const input = z
        .object({ key: z.string().min(1).max(100), snoozedUntil: isoDate.nullable().default(null) })
        .parse(c.req.body);
      const current = await workAlerts(c);
      if (!current.items.some((i) => i.key === input.key)) throw notFound('Uyarı');
      await c.tx
        .execute(sql`insert into work_alert_states(company_id,user_id,key,snoozed_until,read_at)
      values(${c.company.id},${c.user.id},${input.key},${input.snoozedUntil},now())
      on conflict(company_id,user_id,key) do update set snoozed_until=excluded.snoozed_until,read_at=now()`);
      return { ok: true };
    }),
  );
  app.get(
    '/api/workspace/search',
    tenantRoute(
      app,
      { ...access, limit: { name: 'record-search', max: 90, windowMs: 60_000 } },
      async (c) => {
        const { q, kind } = z
          .object({ q: z.string().trim().min(2).max(100), kind: recordKindSchema.optional() })
          .parse(c.req.query);
        return searchRecords(c, q, kind);
      },
    ),
  );
  app.get(
    '/api/workspace/members',
    tenantRoute(app, access, async (c) => {
      if (!admin(c)) return { items: [] };
      return {
        items: (
          await c.tx
            .execute(sql`select u.id, u.full_name as name from memberships m join users u on u.id=m.user_id
      where m.company_id=${c.company.id}::uuid and u.is_active order by u.full_name`)
        ).rows,
      };
    }),
  );
  app.get(
    '/api/workspace/tasks',
    tenantRoute(app, access, async (c) => {
      const q = z
        .object({
          status: z.enum(['open', 'done', 'cancelled', 'all']).default('open'),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          q: z.string().trim().max(100).default(''),
          due: z.enum(['all', 'today', 'overdue', 'upcoming']).default('all'),
          scope: z.enum(['mine', 'team']).default('team'),
          priority:z.enum(['all','normal','high']).default('all'),
        })
        .parse(c.req.query);
      const kinds = (
        [
          'party',
          'invoice',
          'project',
          'subcontract',
          'sales_contract',
          'employee',
          'foreign_worker_doc',
          'transaction',
          'site_report',
          'defect',
          'rfi',
          'site_instruction',
          'quality_check',
          'safety',
        ] as RecordKind[]
      ).filter((k) => canAccessRecord(c, k));
      const visibility = kinds.length
        ? sql`(w.record_kind is null or w.record_kind in (${sql.join(
            kinds.map((k) => sql`${k}`),
            sql`, `,
          )}))`
        : sql`w.record_kind is null`;
      const ownership = q.scope === 'mine' ? sql`and w.owner_id=${c.user.id}::uuid` : sql``;
      const rows = await c.tx
        .execute<WorkItem>(sql`select ${taskFields} from work_items w join users u on u.id=w.owner_id
      where ${visibility} ${ownership} ${q.status === 'all' ? sql`` : sql`and w.status=${q.status}`}
      ${q.q ? sql`and ${trContains(['w.title', 'w.description'], q.q)}` : sql``}
      ${q.priority==='all'?sql``:sql`and w.priority=${q.priority}`}
      ${q.due === 'today' ? sql`and w.due_date=${todayIso()}::date` : q.due === 'overdue' ? sql`and w.due_date<${todayIso()}::date` : q.due === 'upcoming' ? sql`and w.due_date>${todayIso()}::date` : sql``}
      order by w.due_date, case when w.priority='high' then 0 else 1 end, w.id limit 101 offset ${q.offset}`);
      const counts = await c.tx.execute(
        sql`select count(*) filter(where status='open')::int as open,count(*) filter(where status='open' and due_date=${todayIso()}::date)::int as today,count(*) filter(where status='open' and due_date<${todayIso()}::date)::int as overdue,count(*) filter(where status='done')::int as done from work_items w where ${visibility} ${ownership}`,
      );
      return {
        items: rows.rows.slice(0, 100),
        hasMore: rows.rows.length > 100,
        today: todayIso(),
        counts: counts.rows[0],
      };
    }),
  );
  app.post(
    '/api/workspace/tasks',
    tenantRoute(app, access, async (c) => {
      if (!canWrite(c)) throw forbidden();
      const input = workItemSchema.parse(c.req.body);
      const owner = input.ownerId ?? c.user.id;
      if (owner !== c.user.id && !admin(c))
        throw forbidden('Başkasına görev atamak için yönetici yetkisi gerekir');
      await ownerValid(c, owner);
      if (input.record) await requireRecord(c, input.record.kind, input.record.id);
      const id = uuidv7();
      await c.tx
        .execute(sql`insert into work_items(id,company_id,title,description,due_date,owner_id,created_by,priority,record_kind,record_id)
      values(${id},${c.company.id},${input.title},${input.description},${input.dueDate},${owner},${c.user.id},${input.priority},${input.record?.kind ?? null},${input.record?.id ?? null})`);
      void c.reply.code(201);
      return { item: await getTask(c, id) };
    }),
  );
  app.patch(
    '/api/workspace/tasks/:id',
    tenantRoute(app, access, async (c) => {
      if (!canWrite(c)) throw forbidden();
      const { id } = idParam.parse(c.req.params);
      const input = workItemUpdateSchema.parse(c.req.body);
      const cur = await getTask(c, id);
      if (!admin(c) && cur.ownerId !== c.user.id && cur.createdBy !== c.user.id) throw forbidden();
      if (input.ownerId && input.ownerId !== cur.ownerId) {
        if (!admin(c)) throw forbidden();
        await ownerValid(c, input.ownerId);
      }
      if (input.record) await requireRecord(c, input.record.kind, input.record.id);
      const result = await c.tx
        .execute(sql`update work_items set title=${input.title ?? cur.title}, description=${input.description ?? cur.description},
      due_date=${input.dueDate ?? cur.dueDate}, owner_id=${input.ownerId ?? cur.ownerId}, priority=${input.priority ?? cur.priority},
      status=${input.status ?? cur.status}, record_kind=${input.record === null ? null : (input.record?.kind ?? cur.recordKind)}, record_id=${input.record === null ? null : (input.record?.id ?? cur.recordId)},
      version=version+1, updated_at=now() where id=${id}::uuid and version=${input.version} returning id`);
      if (!result.rows.length) throw conflict('Kayıt değişti. Sayfayı yenileyip tekrar deneyin.');
      if(input.status && input.status !== 'open') {
        await c.tx.execute(sql`update work_time_sessions set stopped_at=least(now(),started_at+interval '24 hours'),note=note || ' · Görev kapatıldı' where task_id=${id}::uuid and stopped_at is null`);
      }
      return { item: await getTask(c, id) };
    }),
  );
  app.get(
    '/api/workspace/agenda',
    tenantRoute(app, access, async (c) => {
      if (!c.enabledModules.has('core.directory') || !c.can('directory.read'))
        return {
          counts: { overdue: 0, today: 0, upcoming: 0 },
          overdue: [],
          today: [],
          upcoming: [],
        };
      return agendaSummary(
        c.tx,
        { companyId: c.company.id, userId: c.user.id, canManage: false },
        { scope: 'mine' },
      );
    }),
  );
  app.get(
    '/api/workspace/documents',
    tenantRoute(app, access, async (c) => {
      const q = z
        .object({
          kind: recordKindSchema.optional(),
          id: z.uuid().optional(),
          q: z.string().trim().max(100).default(''),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
          latest: z.enum(['true', 'false']).default('false'),
        })
        .parse(c.req.query);
      if (q.id && !q.kind) throw badRequest('Kayıt türünü belirtin.');
      if (q.id && q.kind) await requireRecord(c, q.kind, q.id);
      const visible = (Object.keys(RECORDS) as RecordKind[])
        .filter((k) => canAccessRecord(c, k) && (!q.kind || q.kind === k))
        .map((k) => {
          const d = RECORDS[k];
          return sql`(d.record_kind=${k} and exists(select 1 from ${sql.identifier(d.table)} r where r.id=d.record_id ${d.filter ? sql`and ${sql.raw(d.filter)}` : sql``}))`;
        });
      if (!visible.length) return { items: [], hasMore: false };
      const recordLabel = sql`case ${sql.join(
        (Object.keys(RECORDS) as RecordKind[])
          .filter((k) => canAccessRecord(c, k))
          .map((k) => {
            const def = RECORDS[k];
            return sql`when d.record_kind=${k} then (select ${sql.raw(def.label)} from ${sql.identifier(def.table)} r where r.id=d.record_id)`;
          }),
        sql` `,
      )} else null end`;
      const rows = await c.tx
        .execute(sql`select d.id,d.filename,d.mime,d.size,d.sha256,d.record_kind as "recordKind",d.record_id as "recordId",${recordLabel} as "recordLabel",d.previous_id as "previousId",d.created_at as "createdAt",u.full_name as "createdBy",not exists(select 1 from record_documents n where n.previous_id=d.id) as "isLatest"
       from record_documents d join users u on u.id=d.created_by where (${sql.join(visible, sql` or `)}) ${q.id ? sql`and d.record_id=${q.id}::uuid` : sql``} ${q.q ? sql`and ${trContains(['d.filename'], q.q)}` : sql``} ${q.latest === 'true' ? sql`and not exists(select 1 from record_documents n where n.previous_id=d.id)` : sql``} order by d.created_at desc,d.id limit 201 offset ${q.offset}`);
      return { items: rows.rows.slice(0, 200), hasMore: rows.rows.length > 200 };
    }),
  );
  app.post(
    '/api/workspace/documents',
    { bodyLimit: 141_000_000 },
    tenantRoute(
      app,
      { ...access, limit: { name: 'document-upload', max: 20, windowMs: 60_000 } },
      async (c) => {
        const input = documentUploadSchema.parse(c.req.body);
        await requireRecord(c, input.record.kind, input.record.id, true);
        const bytes = Buffer.from(input.base64, 'base64');
        const {settings}=await operationalSettings(c.tx);
        if (bytes.length < 4 || bytes.length > settings.documentLimitMb * 1024 * 1024)
          throw badRequest(`Dosya en fazla ${settings.documentLimitMb} MB olabilir.`);
        const valid =
          input.mime === 'application/pdf'
            ? bytes.subarray(0, 5).toString() === '%PDF-'
            : input.mime === 'image/png'
              ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!valid) throw badRequest('Dosya içeriği seçilen dosya türüyle uyuşmuyor.');
        if (input.previousId) {
          await c.tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${input.previousId}, 0))`,
          );
          const prev = await c.tx.execute(
            sql`select id from record_documents where id=${input.previousId}::uuid and record_kind=${input.record.kind} and record_id=${input.record.id}::uuid`,
          );
          if (!prev.rows.length) throw notFound('Önceki sürüm');
          const next = await c.tx.execute(
            sql`select id from record_documents where previous_id=${input.previousId}::uuid`,
          );
          if (next.rows.length) throw conflict('Bu dosyanın daha yeni bir sürümü var.');
        }
        const id = uuidv7();
        await c.tx
          .execute(sql`insert into record_documents(id,company_id,record_kind,record_id,filename,mime,size,sha256,previous_id,created_by)
      values(${id},${c.company.id},${input.record.kind},${input.record.id},${input.filename},${input.mime},${bytes.length},${createHash('sha256').update(bytes).digest('hex')},${input.previousId ?? null},${c.user.id})`);
        await storeAsset(app.config.CONSTRUCTION_STORAGE_DIR,c.company.id,bytes);
        void c.reply.code(201);
        return { id };
      },
    ),
  );
  app.get(
    '/api/workspace/documents/:id/download',
    tenantRoute(
      app,
      { ...access, limit: { name: 'document-download', max: 60, windowMs: 60_000 } },
      async (c) => {
        const { id } = idParam.parse(c.req.params);
        const r = await c.tx.execute<{
          record_kind: RecordKind;
          record_id: string;
          filename: string;
          mime: string;
          sha256: string;
        }>(
          sql`select record_kind,record_id,filename,mime,sha256 from record_documents where id=${id}::uuid`,
        );
        const row = r.rows[0];
        if (!row) throw notFound();
        await requireRecord(c, row.record_kind, row.record_id);
        const content = await c.tx.execute<{ content: string }>(
          sql`select content from record_document_content where id=${id}::uuid`,
        );
        const bytes=content.rows[0] ? Buffer.from(content.rows[0].content, 'base64') : await readAsset(app.config.CONSTRUCTION_STORAGE_DIR,c.company.id,row.sha256);
        return c.reply
          .header('content-type', row.mime)
          .header(
            'content-disposition',
            `attachment; filename="document-${id}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
          )
          .header('x-content-type-options', 'nosniff')
          .send(bytes);
      },
    ),
  );
};
