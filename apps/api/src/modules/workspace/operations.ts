import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  idParam,
  operationKindSchema,
  operationPayloads,
  operationSchema,
  scheduleImpact,
  todayIso,
  type OperationInput,
  type OperationKind,
  type OperationRow,
  type Permission,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors';
import { requireRecord } from './records';
import { isModuleDenied } from '../access/effective';
import { trContains } from '../../db/search';

const select = sql`o.id,o.kind,o.title,o.project_id AS "projectId",o.party_id AS "partyId",o.owner_id AS "ownerId",u.full_name AS "ownerName",o.event_date::text AS "eventDate",o.due_date::text AS "dueDate",o.payload,o.status,o.version,o.created_by AS "createdBy", (select name from projects where id=o.project_id) as "projectName", (select name from parties where id=o.party_id) as "partyName"`;
export const operationAccess: Record<
  OperationKind,
  { module: string; read: Permission; write: Permission }
> = {
  collection: { module: 'core.parties', read: 'parties.read', write: 'parties.manage' },
  site_report: { module: 'construction.projects', read: 'projects.read', write: 'projects.manage' },
  schedule: { module: 'construction.projects', read: 'projects.read', write: 'projects.manage' },
  rfi: { module: 'construction.projects', read: 'projects.read', write: 'projects.manage' },
  site_instruction: {
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
  },
  quality_check: {
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
  },
  safety: { module: 'construction.projects', read: 'projects.read', write: 'projects.manage' },
  equipment: { module: 'construction.projects', read: 'projects.read', write: 'projects.manage' },
  equipment_log: {
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
  },
  defect: {
    module: 'construction.realestate',
    read: 'realestate.read',
    write: 'realestate.manage',
  },
};
function requireAccess(c: TenantCtx, kind: OperationKind, write = false) {
  const access = operationAccess[kind];
  if (!c.enabledModules.has(access.module) || isModuleDenied(c.access,access.module) || !c.can(write ? access.write : access.read))
    throw forbidden();
}
async function getEntry(c: TenantCtx, id: string) {
  const rows = await c.tx.execute<OperationRow>(
    sql`select ${select} from operation_entries o join users u on u.id=o.owner_id where o.id=${id}::uuid`,
  );
  const row = rows.rows[0];
  if (!row) throw notFound();
  requireAccess(c, row.kind);
  return row;
}
async function validate(c: TenantCtx, input: OperationInput, id: string) {
  requireAccess(c, input.kind, true);
  if (input.projectId) await requireRecord(c, 'project', input.projectId);
  if (input.partyId) await requireRecord(c, 'party', input.partyId);
  if (input.ownerId) {
    const result = await c.tx.execute(
      sql`select 1 from memberships m join users u on u.id=m.user_id where m.company_id=${c.company.id}::uuid and m.user_id=${input.ownerId}::uuid and u.is_active`,
    );
    if (!result.rows.length) throw notFound('Sorumlu');
  }
  const payload = operationPayloads[input.kind].parse(input.payload);
  if (input.kind === 'collection') {
    const p = operationPayloads.collection.parse(payload);
    if (p.invoiceId) {
      await requireRecord(c, 'invoice', p.invoiceId);
      const invoice = await c.tx.execute(
        sql`select id from invoices where id=${p.invoiceId}::uuid and party_id=${input.partyId}::uuid`,
      );
      if (!invoice.rows.length) throw badRequest('Fatura seçilen cariye ait değil.');
    }
  }
  if (input.kind === 'equipment_log') {
    const p = operationPayloads.equipment_log.parse(payload);
    const equipment = await getEntry(c, p.equipmentId);
    if (
      equipment.kind !== 'equipment' ||
      equipment.status !== 'open' ||
      equipment.projectId !== input.projectId
    )
      throw badRequest('Ekipman bu projede etkin değil.');
    if (p.invoiceId) await requireRecord(c, 'invoice', p.invoiceId);
  }
  if (input.kind === 'defect') {
    const p = operationPayloads.defect.parse(payload);
    const unit = await c.tx.execute(
      sql`select id from real_estate_units where id=${p.unitId}::uuid and project_id=${input.projectId}::uuid`,
    );
    if (!unit.rows.length) throw notFound('Proje birimi');
    if (p.contractorId) await requireRecord(c, 'party', p.contractorId);
  }
  if (input.kind === 'schedule') {
    const p = operationPayloads.schedule.parse(payload);
    if (p.wbsId) {
      const row = await c.tx.execute(
        sql`select id from project_wbs where id=${p.wbsId}::uuid and project_id=${input.projectId}::uuid`,
      );
      if (!row.rows.length) throw notFound('Proje iş kalemi');
    }
    await c.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':schedule:' + input.projectId},0))`,
    );
    const rows = await c.tx.execute<{ id: string; payload: Record<string, unknown> }>(
      sql`select id,payload from operation_entries where kind='schedule' and project_id=${input.projectId}::uuid and status<>'cancelled' and id<>${id}::uuid`,
    );
    const list = [...rows.rows, { id, payload }].map((r) => ({
      id: r.id,
      ...operationPayloads.schedule.parse(r.payload),
    }));
    try {
      scheduleImpact(list, todayIso());
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  }
  return payload;
}
export const operationRoutes: FastifyPluginAsync = async (app) => {
  const access = { module: 'core.dashboard', permission: 'workspace.use' } as const;
  app.get(
    '/api/workspace/construction-summary',
    tenantRoute(app, access, async (c) => {
      const { projectId } = z.object({ projectId: z.uuid().optional() }).parse(c.req.query);
      if (projectId) await requireRecord(c, 'project', projectId);
      const kinds = (Object.keys(operationAccess) as OperationKind[]).filter(
        (k) => c.enabledModules.has(operationAccess[k].module) && !isModuleDenied(c.access,operationAccess[k].module) && c.can(operationAccess[k].read),
      );
      if (!kinds.length) return { items: [], asOf: todayIso() };
      const rows = await c.tx.execute(
        sql`select kind,count(*)::int as total,count(*) filter(where status='open')::int as open,count(*) filter(where status='done')::int as done,count(*) filter(where status='open' and due_date<${todayIso()}::date)::int as overdue from operation_entries where kind in (${sql.join(
          kinds.map((k) => sql`${k}`),
          sql`, `,
        )}) ${projectId ? sql`and project_id=${projectId}::uuid` : sql``} group by kind`,
      );
      return {
        items: kinds.map((kind) => ({
          kind,
          total: 0,
          open: 0,
          done: 0,
          overdue: 0,
          ...rows.rows.find((r) => r.kind === kind),
        })),
        asOf: todayIso(),
      };
    }),
  );
  app.get(
    '/api/workspace/handover/:id',
    tenantRoute(
      app,
      { module: 'construction.realestate', permission: 'realestate.read' },
      async (c) => {
        const { id } = idParam.parse(c.req.params);
        const rows = await c.tx.execute(
          sql`select u.id,u.block,u.unit_no as "unitNo",u.status,p.name as "projectName",p.code as "projectCode" from real_estate_units u join projects p on p.id=u.project_id where u.id=${id}::uuid`,
        );
        if (!rows.rows[0]) throw notFound('Birim');
        const defects = await c.tx
          .execute(sql`select o.id,o.title,o.status,o.due_date::text as "dueDate",o.payload->>'location' as location,o.payload->>'resolution' as resolution,u.full_name as "ownerName",p.name as "contractorName",
      (select count(*)::int from record_documents d where d.record_kind='defect' and d.record_id=o.id) as "documentCount"
      from operation_entries o join users u on u.id=o.owner_id left join parties p on p.id=nullif(o.payload->>'contractorId','')::uuid
      where o.kind='defect' and o.payload->>'unitId'=${id} and o.status<>'cancelled' order by o.due_date,o.id limit 1001`);
        return {
          company: c.company.name,
          unit: rows.rows[0],
          defects: defects.rows.slice(0, 1000),
          truncated: defects.rows.length > 1000,
          asOf: todayIso(),
        };
      },
    ),
  );
  app.get(
    '/api/workspace/units/:id',
    tenantRoute(
      app,
      { module: 'construction.realestate', permission: 'realestate.read' },
      async (c) => {
        const { id } = idParam.parse(c.req.params);
        return {
          items: (
            await c.tx.execute(
              sql`select id,block || ' ' || unit_no as name from real_estate_units where project_id=${id}::uuid order by block,unit_no limit 1000`,
            )
          ).rows,
        };
      },
    ),
  );
  app.get(
    '/api/workspace/operations',
    tenantRoute(app, access, async (c) => {
      const q = z
        .object({
          kind: operationKindSchema,
          id: z.uuid().optional(),
          projectId: z.uuid().optional(),
          status: z.enum(['open', 'done', 'cancelled', 'all']).default('all'),
          q: z.string().trim().max(100).default(''),
          due: z.enum(['all', 'overdue', 'today']).default('all'),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .parse(c.req.query);
      requireAccess(c, q.kind);
      const scope = sql`o.kind=${q.kind} ${q.projectId ? sql`and o.project_id=${q.projectId}::uuid` : sql``} ${q.id ? sql`and o.id=${q.id}::uuid` : sql``}`;
      const rowsSummary = await c.tx.execute<{
        total: number;
        open: number;
        done: number;
        overdue: number;
      }>(
        sql`select count(*)::int as total,count(*) filter(where o.status='open')::int as open,count(*) filter(where o.status='done')::int as done,count(*) filter(where o.status='open' and o.due_date<${todayIso()}::date)::int as overdue from operation_entries o where ${scope}`,
      );
      const promises =
        q.kind === 'collection'
          ? (
              await c.tx.execute(
                sql`select payload->>'currency' as currency,sum((payload->>'promiseAmount')::numeric)::text as amount from operation_entries o where ${scope} and status='open' and coalesce(payload->>'outcome','pending') not in ('paid','disputed','unreachable') group by payload->>'currency'`,
              )
            ).rows
          : [];
      const rows = await c.tx
        .execute<OperationRow>(sql`select ${select} from operation_entries o join users u on u.id=o.owner_id where o.kind=${q.kind}
      ${q.projectId ? sql`and o.project_id=${q.projectId}::uuid` : sql``} ${q.id ? sql`and o.id=${q.id}::uuid` : sql``}
      ${q.status !== 'all' ? sql`and o.status=${q.status}` : sql``}
      ${q.q ? sql`and ${trContains(['o.title', 'o.payload::text'], q.q)}` : sql``}
      ${q.due === 'overdue' ? sql`and o.status='open' and o.due_date<${todayIso()}::date` : q.due === 'today' ? sql`and o.status='open' and o.due_date=${todayIso()}::date` : sql``}
      order by case when o.status='open' then 0 else 1 end,o.due_date,o.id limit 101 offset ${q.offset}`);
      return {
        items: rows.rows.slice(0, 100),
        hasMore: rows.rows.length > 100,
        summary: { counts: rowsSummary.rows[0], promises },
      };
    }),
  );
  app.post(
    '/api/workspace/operations',
    tenantRoute(app, access, async (c) => {
      const input = operationSchema.parse(c.req.body);
      const id = input.id ?? uuidv7();
      requireAccess(c, input.kind, true);
      await c.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id},0))`);
      const existing = await c.tx.execute(
        sql`select id from operation_entries where id=${id}::uuid`,
      );
      if (existing.rows.length) {
        const item = await getEntry(c, id);
        if (
          item.createdBy !== c.user.id ||
          item.kind !== input.kind ||
          item.title !== input.title ||
          item.projectId !== (input.projectId ?? null) ||
          item.partyId !== (input.partyId ?? null) ||
          item.eventDate !== input.eventDate ||
          item.dueDate !== input.dueDate ||
          item.ownerId !== (input.ownerId ?? c.user.id) ||
          !isDeepStrictEqual(item.payload, operationPayloads[input.kind].parse(input.payload))
        )
          throw conflict(
            'Bu taslak daha önce farklı içerikle kaydedilmiş. Mevcut kaydı düzenleyin.',
          );
        return { item, replayed: true };
      }
      const payload = await validate(c, input, id);
      await c.tx
        .execute(sql`insert into operation_entries(id,company_id,kind,title,project_id,party_id,owner_id,event_date,due_date,payload,created_by)
      values(${id},${c.company.id},${input.kind},${input.title},${input.projectId ?? null},${input.partyId ?? null},${input.ownerId ?? c.user.id},${input.eventDate},${input.dueDate},${JSON.stringify(payload)}::jsonb,${c.user.id})`);
      void c.reply.code(201);
      return { item: await getEntry(c, id) };
    }),
  );
  app.put(
    '/api/workspace/operations/:id',
    tenantRoute(app, access, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const cur = await getEntry(c, id);
      requireAccess(c, cur.kind, true);
      const raw = z
        .object({
          version: z.number().int().positive(),
          status: z.enum(['open', 'done', 'cancelled']),
        })
        .parse(c.req.body);
      const input = operationSchema.parse(c.req.body);
      if (input.kind !== cur.kind) throw badRequest('Kayıt türü değiştirilemez.');
      if (cur.kind === 'schedule' && input.projectId !== cur.projectId)
        throw badRequest('İşin projesi değiştirilemez.');
      if (cur.kind === 'schedule' && raw.status === 'done')
        input.payload = { ...input.payload, progress: 100 };
      const payload = await validate(c, input, id);
      if (raw.status === 'done') {
        if (cur.kind === 'rfi' && !operationPayloads.rfi.parse(payload).response.trim())
          throw badRequest('Talebi kapatmak için teknik yanıt girin.');
        if (
          cur.kind === 'site_instruction' &&
          !operationPayloads.site_instruction.parse(payload).completionNote.trim()
        )
          throw badRequest('Talimatı kapatmak için uygulama açıklaması girin.');
        if (cur.kind === 'safety' && !operationPayloads.safety.parse(payload).resolution.trim())
          throw badRequest('Aksiyonu kapatmak için giderilme açıklaması girin.');
        if (cur.kind === 'quality_check') {
          const p = operationPayloads.quality_check.parse(payload);
          if (p.result === 'pending' || (p.result === 'fail' && !p.resolution.trim()))
            throw badRequest('Kontrol sonucunu ve uygunsuzluk varsa giderilme açıklamasını girin.');
        }
      }

      if (
        cur.kind === 'defect' &&
        raw.status === 'done' &&
        !operationPayloads.defect.parse(payload).resolution.trim()
      )
        throw badRequest('Kapatmak için çözüm açıklaması girin.');
      if (cur.kind === 'schedule' && raw.status === 'cancelled') {
        const deps = await c.tx.execute(
          sql`select id from operation_entries where kind='schedule' and status<>'cancelled' and payload->'dependencies' @> ${JSON.stringify([id])}::jsonb limit 1`,
        );
        if (deps.rows.length)
          throw conflict('Bu işe bağlı işler var; önce bağımlılıkları kaldırın.');
      }
      const result = await c.tx.execute(
        sql`update operation_entries set title=${input.title},project_id=${input.projectId ?? null},party_id=${input.partyId ?? null},owner_id=${input.ownerId ?? cur.ownerId},event_date=${input.eventDate},due_date=${input.dueDate},payload=${JSON.stringify(payload)}::jsonb,status=${raw.status},version=version+1,updated_at=now() where id=${id}::uuid and version=${raw.version} returning id`,
      );
      if (!result.rows.length) throw conflict('Kayıt değişti. Yenileyip tekrar deneyin.');
      return { item: await getEntry(c, id) };
    }),
  );
  app.get(
    '/api/workspace/schedule/:id',
    tenantRoute(
      app,
      { module: 'construction.projects', permission: 'projects.read' },
      async (c) => {
        const { id } = idParam.parse(c.req.params);
        await requireRecord(c, 'project', id);
        const rows = await c.tx.execute<{ id: string; payload: Record<string, unknown> }>(
          sql`select id,payload from operation_entries where kind='schedule' and project_id=${id}::uuid and status<>'cancelled'`,
        );
        return {
          items: scheduleImpact(
            rows.rows.map((r) => ({ id: r.id, ...operationPayloads.schedule.parse(r.payload) })),
            todayIso(),
          ),
          asOf: todayIso(),
        };
      },
    ),
  );
};
