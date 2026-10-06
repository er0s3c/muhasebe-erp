import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  WORKFLOW_KINDS,
  WORKFLOW_PAYLOADS,
  workflowSchema,
  analyzeUnitRate,
  analyzeFeasibility,
  criticalPath,
  measureDrawing,
  dec,
  todayIso,
  idParam,
  createProjectSchema,
  createPurchaseRequestSchema,
  type WorkflowKind,
  type ConstructionWorkflow,
  type Permission,
  type CalendarActivity,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { badRequest, conflict, forbidden } from '../../http/errors';
import { requireRecord } from '../workspace/records';
import { isModuleDenied } from '../access/effective';
import { first } from './routes';
import { createProgress } from '../subcontracts/progress';
import { createVariation } from '../subcontracts/variations';
import { createRequest } from '../procurement/requests';
import { createProject } from '../projects/service';
import { createWbs } from '../projects/wbs';
import { createBudget, putBudgetLines } from '../projects/budgets';
import { projectCostReport } from '../projects/reports';
import { writeXlsx, XLSX_CONTENT_TYPE } from '../../files/xlsx-write';
type WorkflowWriter = Pick<TenantCtx, 'tx'> & { company: { id: string }; user: { id: string } };
const read = { module: 'construction.projects', permission: 'projects.read' as const };
const select = sql`id,project_id as "projectId",kind,title,location_id as "locationId",wbs_id as "wbsId",owner_id as "ownerId",status,version,payload,computed,linked_kind as "linkedKind",linked_id as "linkedId",created_at as "createdAt"`;
export const workflowAccess: Record<
  WorkflowKind,
  { module: string; read: Permission; write: Permission; approve: Permission }
> = Object.fromEntries(
  WORKFLOW_KINDS.map((kind) => {
    const real = ['feasibility', 'lead', 'buyer_option', 'warranty', 'passport'].includes(kind),
      proc = ['rate_analysis', 'tender', 'material_need', 'submittal'].includes(kind),
      sub = ['production', 'change_event', 'delay_claim'].includes(kind);
    return [
      kind,
      real
        ? {
            module: 'construction.realestate',
            read: 'realestate.read',
            write: 'realestate.manage',
            approve: 'realestate.approve',
          }
        : proc
          ? {
              module: 'construction.procurement',
              read: 'procurement.read',
              write: 'procurement.manage',
              approve: 'procurement.approve',
            }
          : sub
            ? {
                module: 'construction.subcontracts',
                read: 'subcontracts.read',
                write: 'subcontracts.manage',
                approve: 'subcontracts.approve',
              }
            : {
                module: 'construction.projects',
                read: 'projects.read',
                write: 'projects.manage',
                approve: 'projects.budget',
              },
    ];
  }),
) as typeof workflowAccess;
export function workflowAllowed(
  c: Pick<TenantCtx, 'enabledModules' | 'can' | 'access'>,
  kind: WorkflowKind,
  mode: 'read' | 'write' | 'approve' = 'read',
) {
  const a = workflowAccess[kind];
  return c.enabledModules.has(a.module) && !isModuleDenied(c.access,a.module) && c.can(a[mode]);
}
function access(c: TenantCtx, kind: WorkflowKind, mode: 'read' | 'write' | 'approve' = 'read') {
  if (!workflowAllowed(c, kind, mode)) throw forbidden();
  if (kind === 'forecast') c.require(mode === 'read' ? 'ledger.read' : 'projects.budget');
}
async function record(c: TenantCtx, id: string, lock = false) {
  const r = await first<ConstructionWorkflow>(
    c,
    sql`select ${select} from construction_workflows where id=${id}::uuid ${lock ? sql`for update` : sql``}`,
  );
  await hydrateWorkflow(c, r);
  return r;
}
async function serviceState(c: TenantCtx, id: string) {
  const events = await c.tx.execute<{ action: string; data: Record<string, unknown> }>(
    sql`select action,data from construction_workflow_events where workflow_id=${id}::uuid and action in ('service_updated','customer_confirmed') order by at,id`,
  );
  let state: Record<string, unknown> = {};
  for (const e of events.rows) {
    if (e.action === 'service_updated') state = { ...e.data };
    else state = { ...state, ...e.data };
  }
  return state;
}
export async function hydrateWorkflow(
  c: TenantCtx,
  r: Pick<ConstructionWorkflow, 'id' | 'kind' | 'projectId' | 'payload' | 'computed'>,
) {
  if (r.kind === 'maintenance') r.computed = await compute(c, r.kind, r.payload, r.projectId);
  if (r.kind === 'warranty') r.payload = { ...r.payload, ...(await serviceState(c, r.id)) };
  if (r.kind === 'concrete') {
    const latest = await c.tx.execute<{ data: { samples: unknown } }>(
      sql`select data from construction_workflow_events where workflow_id=${r.id}::uuid and action='lab_results' order by at desc,id desc limit 1`,
    );
    if (latest.rows[0]) r.payload = { ...r.payload, samples: latest.rows[0].data.samples };
    r.computed = await compute(c, r.kind, r.payload, r.projectId);
  }
}
async function event(
  c: WorkflowWriter,
  id: string,
  action: string,
  note: string,
  data: unknown = {},
) {
  await c.tx.execute(
    sql`insert into construction_workflow_events(id,company_id,workflow_id,action,note,data,by) values(${randomUUID()},${c.company.id},${id},${action},${note},${JSON.stringify(data)}::jsonb,${c.user.id})`,
  );
}
export async function ensureConcreteAction(c: WorkflowWriter, r: ConstructionWorkflow) {
  if (r.linkedId) return;
  const p = WORKFLOW_PAYLOADS.concrete.parse(r.payload);
  const failed = p.samples.filter((s) => s.strength !== null && s.strength < s.minimum);
  const late = p.samples.filter((s) => s.strength === null && s.testDate < todayIso());
  if (!failed.length && !late.length) return;
  const id = randomUUID();
  await c.tx.execute(
    sql`insert into operation_entries(id,company_id,kind,title,project_id,party_id,owner_id,event_date,due_date,payload,created_by) values(${id},${c.company.id},'quality_check',${r.title + ' — numune kontrolü'},${r.projectId},${p.supplierId},${r.ownerId},${todayIso()},${todayIso()},${JSON.stringify({ location: r.locationId, checkType: 'concrete', result: failed.length ? 'fail' : 'pending', findings: [...failed.map((s) => s.name + ' — uygunsuz'), ...late.map((s) => s.name + ' — sonuç gecikti')].join(', '), correctiveAction: 'Yetkili teknik değerlendirme yapılmalı.', resolution: '' })}::jsonb,${c.user.id})`,
  );
  await c.tx.execute(
    sql`update construction_workflows set linked_kind='quality_check',linked_id=${id} where id=${r.id}::uuid`,
  );
  await event(c, r.id, 'quality_action', 'Numune takibinden kalite aksiyonu açıldı.', {
    operationId: id,
  });
}
export async function expireReservations(
  c: WorkflowWriter & Pick<TenantCtx, 'enabledModules' | 'can' | 'access'>,
) {
  if (!workflowAllowed(c, 'lead', 'read')) return;
  const due = await c.tx.execute<{ id: string; unitId: string }>(
    sql`select id,payload->>'unitId' as "unitId" from construction_workflows where kind='lead' and status='reserved' and (payload->>'reservationUntil')::date<${todayIso()}::date order by payload->>'unitId' limit 100`,
  );
  for (const r of due.rows) {
    await c.tx.execute(sql`select id from real_estate_units where id=${r.unitId}::uuid for update`);
    const expired = await c.tx.execute(
      sql`update construction_workflows set status='lost',version=version+1 where id=${r.id}::uuid and status='reserved' and (payload->>'reservationUntil')::date<${todayIso()}::date returning id`,
    );
    if (!expired.rows.length) continue;
    await event(
      c,
      r.id,
      'reservation_expired',
      'Rezervasyon süresi doldu; birim serbest bırakıldı.',
    );
    await c.tx.execute(
      sql`update real_estate_units set status='available' where id=${r.unitId}::uuid and status='reserved' and not exists(select 1 from sales_contracts where unit_id=${r.unitId}::uuid and status in ('draft','active','handed_over')) and not exists(select 1 from construction_workflows where kind='lead' and status='reserved' and payload->>'unitId'=${r.unitId})`,
    );
  }
}
async function validateRefs(c: TenantCtx, b: z.infer<typeof workflowSchema>) {
  await requireRecord(c, 'project', b.projectId);
  if (b.locationId)
    await first(
      c,
      sql`select id from construction_locations where id=${b.locationId}::uuid and project_id=${b.projectId}::uuid`,
      'Konum',
    );
  if (b.wbsId)
    await first(
      c,
      sql`select id from project_wbs where id=${b.wbsId}::uuid and project_id=${b.projectId}::uuid and is_active`,
      'İş kalemi',
    );
  if (b.ownerId)
    await first(
      c,
      sql`select m.user_id from memberships m join users u on u.id=m.user_id where m.user_id=${b.ownerId}::uuid and m.company_id=${c.company.id}::uuid and u.is_active`,
      'Sorumlu',
    );
  const p = WORKFLOW_PAYLOADS[b.kind].parse(b.payload) as Record<string, unknown>;
  for (const field of ['supplierId', 'clientId', 'partyId', 'contractorId'])
    if (p[field]) await requireRecord(c, 'party', String(p[field]));
  for (const field of ['equipmentId', 'activityId', 'operationId'])
    if (p[field]) {
      const op = await first<{ kind: string }>(
        c,
        sql`select kind from operation_entries where id=${String(p[field])}::uuid ${field === 'equipmentId' ? sql`` : sql`and project_id=${b.projectId}::uuid`}`,
        'Operasyon',
      );
      const expected =
        field === 'equipmentId'
          ? ['equipment']
          : field === 'activityId'
            ? ['schedule']
            : ['rfi', 'site_instruction'];
      if (!expected.includes(op.kind)) throw badRequest('Bağlı operasyon türü uygun değil.');
    }
  if (p.activityIds)
    for (const id of p.activityIds as string[])
      await first(
        c,
        sql`select id from operation_entries where id=${id}::uuid and project_id=${b.projectId}::uuid and kind='schedule'`,
      );
  if (p.unitId) {
    c.require('realestate.read');
    await first(
      c,
      sql`select id from real_estate_units where id=${String(p.unitId)}::uuid and project_id=${b.projectId}::uuid`,
      'Birim',
    );
  }
  if (p.contractId) {
    await requireRecord(c, 'sales_contract', String(p.contractId));
    await first(
      c,
      sql`select id from sales_contracts where id=${String(p.contractId)}::uuid and unit_id=${String(p.unitId)}::uuid and status in ('active','handed_over')`,
      'Etkin birim sözleşmesi',
    );
  }
  if (p.subcontractId) {
    await requireRecord(c, 'subcontract', String(p.subcontractId));
    await first(
      c,
      sql`select id from subcontracts where id=${String(p.subcontractId)}::uuid and project_id=${b.projectId}::uuid`,
      'Proje sözleşmesi',
    );
  }
  if (p.itemId) {
    c.require('inventory.read');
    if (!c.enabledModules.has('core.inventory')) throw forbidden();
    await first(
      c,
      sql`select id from items where id=${String(p.itemId)}::uuid and is_active`,
      'Stok kartı',
    );
  }
  if (p.drawingId)
    await first(
      c,
      sql`select id from construction_drawings where id=${String(p.drawingId)}::uuid and project_id=${b.projectId}::uuid and status='approved'`,
      'Onaylı çizim',
    );
  const assetIds = [
    ...((p.assetIds ?? []) as string[]),
    ...((p.evidenceIds ?? []) as string[]),
    ...((p.evidence ?? []) as { assetId?: string }[]).flatMap((x) =>
      x.assetId ? [x.assetId] : [],
    ),
  ];
  for (const id of assetIds)
    await first(
      c,
      sql`select id from construction_assets where id=${id}::uuid and project_id=${b.projectId}::uuid`,
      'Proje dosyası',
    );
  for (const id of (p.photoIds ?? []) as string[])
    await first(
      c,
      sql`select id from construction_photos where id=${id}::uuid and project_id=${b.projectId}::uuid`,
      'Proje fotoğrafı',
    );
  if (p.devices)
    for (const d of p.devices as { documentIds: string[] }[])
      for (const id of d.documentIds)
        await first(
          c,
          sql`select id from construction_assets where id=${id}::uuid and project_id=${b.projectId}::uuid`,
        );
  if (p.orderId) {
    c.require('procurement.read');
    await first(
      c,
      sql`select id from purchase_orders where id=${String(p.orderId)}::uuid and project_id=${b.projectId}::uuid`,
    );
  }
  if (p.deliveryId) {
    c.require('deliveries.read');
    await first(
      c,
      sql`select id from delivery_notes where id=${String(p.deliveryId)}::uuid`,
      'Teslim belgesi',
    );
  }
  if (p.takeoffId) {
    const t = await record(c, String(p.takeoffId));
    if (t.kind !== 'takeoff' || t.projectId !== b.projectId || t.status !== 'approved')
      throw badRequest('Onaylı proje metrajı seçin.');
    if (b.kind === 'material_need')
      p.quantity = dec(String(t.computed.quantity))
        .times(Number(p.quantityPerUnit ?? 1))
        .toNumber();
  }
  if (b.kind === 'material_need' && p.activityId) {
    const scheduled = await first<{ start: string }>(
      c,
      sql`select payload->>'start' as start from operation_entries where id=${String(p.activityId)}::uuid`,
    );
    p.needDate = scheduled.start;
  }
  if (
    b.kind === 'maintenance' &&
    p.outageEnd &&
    (!p.outageStart || String(p.outageEnd) < String(p.outageStart))
  )
    throw badRequest('Arıza bitişi başlangıçtan önce olamaz.');
  if (b.kind === 'production') {
    const v = WORKFLOW_PAYLOADS.production.parse(p);
    if (!b.locationId || !b.wbsId || !v.photoIds.length)
      throw badRequest('Üretim için konum, iş kalemi ve en az bir fotoğraf gerekir.');
    const boq = await first<{ unit: string; wbsId: string }>(
      c,
      sql`select l.unit,l.wbs_id as "wbsId" from subcontract_boq_lines l join subcontract_revisions r on r.id=l.revision_id where l.subcontract_id=${v.subcontractId}::uuid and l.line_key=${v.lineKey}::uuid and r.status='approved' order by r.revision_no desc limit 1`,
      'BOQ satırı',
    );
    if (boq.unit !== v.unit || boq.wbsId !== b.wbsId)
      throw badRequest('Üretim birimi ve iş kalemi BOQ ile aynı olmalıdır.');
  }
  if (b.kind === 'concrete' && !b.locationId) throw badRequest('Döküm konumu gerekir.');
  if (b.kind === 'tender') {
    const v = WORKFLOW_PAYLOADS.tender.parse(p);
    if (v.previousId) {
      const prev = await record(c, v.previousId);
      if (prev.kind !== 'tender' || prev.projectId !== b.projectId)
        throw badRequest('Teklif revizyonu aynı proje içinde olmalıdır.');
    }
    for (const l of v.lines)
      if (l.analysisId) {
        const a = await record(c, l.analysisId);
        access(c, 'rate_analysis');
        if (
          a.kind !== 'rate_analysis' ||
          a.status !== 'approved' ||
          a.payload.currency !== v.currency ||
          a.payload.unit !== l.unit
        )
          throw badRequest('Aynı birim ve para biriminde onaylı analiz seçin.');
      }
  }
  return p;
}
async function compute(
  c: TenantCtx,
  kind: WorkflowKind,
  p: Record<string, unknown>,
  projectId: string,
  excludeId?: string,
): Promise<Record<string, unknown>> {
  if (kind === 'rate_analysis') return analyzeUnitRate(WORKFLOW_PAYLOADS.rate_analysis.parse(p));
  if (kind === 'feasibility') return analyzeFeasibility(WORKFLOW_PAYLOADS.feasibility.parse(p));
  if (kind === 'takeoff') {
    const v = WORKFLOW_PAYLOADS.takeoff.parse(p);
    return {
      quantity: measureDrawing(v.points, v.kind, v.pageWidth, v.pageHeight, v.unitsPerPixel),
      unit: v.unit,
    };
  }
  if (kind === 'readiness') {
    const v = WORKFLOW_PAYLOADS.readiness.parse(p);
    return {
      ready: v.drawingReady && v.materialReady && v.crewReady && v.approvalReady,
      blockers: [
        !v.drawingReady ? 'Çizim' : null,
        !v.materialReady ? 'Malzeme' : null,
        !v.crewReady ? 'Ekip' : null,
        !v.approvalReady ? 'Onay' : null,
      ].filter(Boolean),
    };
  }
  if (kind === 'concrete') {
    const v = WORKFLOW_PAYLOADS.concrete.parse(p);
    return {
      overdue: v.samples.filter((s) => s.strength === null && s.testDate < todayIso()).length,
      failed: v.samples.filter((s) => s.strength !== null && s.strength < s.minimum).length,
    };
  }
  if (kind === 'maintenance') {
    const v = WORKFLOW_PAYLOADS.maintenance.parse(p);
    const logs = await first<{ hours: string; count: number }>(
      c,
      sql`select coalesce(sum((payload->>'hours')::numeric),0)::text as hours,count(*)::int as count from operation_entries where kind='equipment_log' and status<>'cancelled' and payload->>'equipmentId'=${v.equipmentId}`,
    );
    return {
      operatingHours: logs.count ? logs.hours : null,
      hourRecords: logs.count,
      hoursDue: v.dueHours !== undefined && logs.count > 0 ? dec(logs.hours).gte(v.dueHours) : null,
      downtimeDays:
        v.outageStart && v.outageEnd
          ? Math.round((Date.parse(v.outageEnd) - Date.parse(v.outageStart)) / 86400000) + 1
          : null,
    };
  }
  if (kind === 'tender') {
    const v = WORKFLOW_PAYLOADS.tender.parse(p);
    const lines = [];
    for (const l of v.lines) {
      const a = l.analysisId ? await record(c, l.analysisId) : null;
      const unitPrice = a ? String(a.computed.unitPrice) : l.unitPrice;
      lines.push({
        ...l,
        unitPrice,
        analysisSnapshot: a
          ? { id: a.id, title: a.title, payload: a.payload, computed: a.computed }
          : null,
      });
    }
    const cost = lines.reduce((s, l) => s.plus(dec(l.quantity).times(l.unitPrice)), dec(0));
    return {
      cost: cost.toFixed(2),
      offer: cost.times(dec(100).plus(v.marginPct)).div(100).toFixed(2),
      currency: v.currency,
      lines,
    };
  }
  if (kind === 'forecast') {
    c.require('ledger.read');
    const v = WORKFLOW_PAYLOADS.forecast.parse(p),
      r = await projectCostReport(c.tx, projectId, v.date);
    if (!r.budget) throw badRequest('Tahmin için onaylı bütçe gerekir.');
    return {
      actual: r.totals.actual,
      budget: r.totals.budget,
      remaining: v.remainingEstimate,
      eac: dec(r.totals.actual).plus(v.remainingEstimate).toFixed(2),
      currency: c.company.baseCurrency,
      method: 'Gerçekleşen + kullanıcının kalan iş tahmini; taahhüt ayrıca eklenmez.',
    };
  }
  if (kind === 'material_need') {
    c.require('inventory.read');
    const v = WORKFLOW_PAYLOADS.material_need.parse(p);
    const stock = await first<{ qty: string }>(
      c,
      sql`select coalesce(sum(qty),0)::text as qty from stock_movements where item_id=${v.itemId}::uuid`,
    );
    const used = await first<{ qty: string }>(
      c,
      sql`select coalesce(sum((payload->>'reserveQuantity')::numeric),0)::text as qty from construction_workflows where kind='material_need' and status='approved' and payload->>'itemId'=${v.itemId} ${excludeId ? sql`and id<>${excludeId}::uuid` : sql``}`,
    );
    const open = await first<{ qty: string }>(
      c,
      sql`select coalesce(sum(greatest(l.quantity-coalesce((select sum(rl.quantity) from po_receipt_lines rl join po_receipts r on r.id=rl.receipt_id where rl.order_line_id=l.id and r.status='posted'),0),0)),0)::text as qty from purchase_order_lines l join purchase_orders o on o.id=l.order_id where l.item_id=${v.itemId}::uuid and o.project_id=${projectId}::uuid and o.status='issued'`,
    );
    const free = dec(stock.qty).minus(used.qty);
    const shortage = dec(v.quantity)
      .minus(free.gt(0) ? free : 0)
      .minus(open.qty);
    const date = new Date(v.needDate + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() - v.leadDays);
    return {
      stock: stock.qty,
      reserved: used.qty,
      available: free.toFixed(4),
      openOrder: open.qty,
      shortage: (shortage.gt(0) ? shortage : dec(0)).toFixed(4),
      orderBy: date.toISOString().slice(0, 10),
      unit: v.unit,
    };
  }
  return {};
}

export const constructionWorkflowRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/construction/workflows/:id/concrete-results',
    tenantRoute(app, read, async (c) => {
      const r = await record(c, idParam.parse(c.req.params).id, true);
      access(c, 'concrete', 'approve');
      if (r.kind !== 'concrete' || r.status !== 'approved')
        throw badRequest('Onaylı ve açık döküm kaydı seçin.');
      const b = z
        .object({
          version: z.number().int().positive(),
          samples: WORKFLOW_PAYLOADS.concrete.shape.samples,
          note: z.string().trim().min(3).max(4000),
          assetIds: z.array(z.uuid()).max(30).default([]),
        })
        .parse(c.req.body);
      if (b.version !== r.version) throw conflict('Numune dosyası değişti; yenileyin.');
      const old = WORKFLOW_PAYLOADS.concrete.parse(r.payload);
      if (
        b.samples.length !== old.samples.length ||
        b.samples.some(
          (s, i) =>
            s.name !== old.samples[i]!.name ||
            s.testDate !== old.samples[i]!.testDate ||
            s.minimum !== old.samples[i]!.minimum,
        )
      )
        throw badRequest('Numune kimliği, termin ve kabul sınırı değiştirilemez.');
      for (const id of b.assetIds)
        await first(
          c,
          sql`select id from construction_assets where id=${id}::uuid and project_id=${r.projectId}::uuid`,
        );
      await event(c, r.id, 'lab_results', b.note, { samples: b.samples, assetIds: b.assetIds });
      await ensureConcreteAction(c, { ...r, payload: { ...r.payload, samples: b.samples } });
      await c.tx.execute(
        sql`update construction_workflows set version=version+1 where id=${r.id}::uuid`,
      );
      return { item: await record(c, r.id) };
    }),
  );
  app.get(
    '/api/construction/takeoff-export',
    tenantRoute(app, read, async (c) => {
      const q = z.object({ projectId: z.uuid() }).parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      const rows = await c.tx.execute<{
        title: string;
        drawing: string;
        page: number;
        quantity: string;
        unit: string;
        wbs: string | null;
        location: string | null;
        status: string;
      }>(
        sql`select w.title,d.code||' / '||d.revision as drawing,(w.payload->>'page')::int as page,w.computed->>'quantity' as quantity,w.payload->>'unit' as unit,p.code as wbs,l.name as location,w.status from construction_workflows w join construction_drawings d on d.id=(w.payload->>'drawingId')::uuid left join project_wbs p on p.id=w.wbs_id left join construction_locations l on l.id=w.location_id where w.project_id=${q.projectId}::uuid and w.kind='takeoff' and w.status in ('approved','closed') order by w.title limit 5000`,
      );
      const data = writeXlsx([
        {
          key: 'metraj',
          title: 'Onaylı metraj',
          columns: [
            { key: 'title', label: 'Metraj', kind: 'text' },
            { key: 'drawing', label: 'Çizim / revizyon', kind: 'text' },
            { key: 'page', label: 'Sayfa', kind: 'int' },
            { key: 'quantity', label: 'Miktar', kind: 'qty' },
            { key: 'unit', label: 'Birim', kind: 'text' },
            { key: 'wbs', label: 'İş kalemi', kind: 'text' },
            { key: 'location', label: 'Konum', kind: 'text' },
            { key: 'status', label: 'Durum', kind: 'text' },
          ],
          rows: rows.rows,
        },
      ]);
      c.reply
        .header('content-type', XLSX_CONTENT_TYPE)
        .header('content-disposition', 'attachment; filename="metraj.xlsx"')
        .header('cache-control', 'no-store');
      return c.reply.send(Buffer.from(data));
    }),
  );
  app.post(
    '/api/construction/workflows/:id/service',
    tenantRoute(app, read, async (c) => {
      const r = await record(c, idParam.parse(c.req.params).id, true);
      access(c, 'warranty', 'write');
      if (r.kind !== 'warranty' || r.status !== 'approved')
        throw badRequest('Onaylı ve açık servis kaydı seçin.');
      const b = z
        .object({
          version: z.number().int().positive(),
          appointment: z.iso.date().optional(),
          contractorId: z.uuid().optional(),
          coverage: z.enum(['pending', 'covered', 'excluded']),
          resolution: z.string().trim().max(4000).default(''),
          customerConfirmation: z.string().trim().max(1000).default(''),
        })
        .parse(c.req.body);
      if (b.version !== r.version) throw conflict('Servis kaydı değişti; yenileyin.');
      if (b.contractorId) await requireRecord(c, 'party', b.contractorId);
      if (b.resolution && b.coverage === 'pending')
        throw badRequest('Çözüm bildirmeden önce garanti kapsamını değerlendirin.');
      if (b.coverage === 'covered' && b.resolution && (!b.contractorId || !b.appointment))
        throw badRequest('Servis taşeronu ve randevu gerekir.');
      await event(
        c,
        r.id,
        'service_updated',
        b.resolution ? 'Servis çözümü bildirildi' : 'Servis ataması güncellendi',
        b,
      );
      await c.tx.execute(
        sql`update construction_workflows set version=version+1 where id=${r.id}::uuid`,
      );
      return { item: await record(c, r.id) };
    }),
  );
  app.get(
    '/api/construction/workflows',
    tenantRoute(app, read, async (c) => {
      const q = z
        .object({ projectId: z.uuid(), kind: z.enum(WORKFLOW_KINDS).optional() })
        .parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      const allowed = WORKFLOW_KINDS.filter(
        (k) =>
          workflowAllowed(c, k) &&
          (k !== 'forecast' || c.can('ledger.read')) &&
          (!q.kind || k === q.kind),
      );
      if (q.kind) access(c, q.kind);
      await expireReservations(c);
      if (!allowed.length) return { items: [] };
      const items = (
        await c.tx.execute(
          sql`select ${select} from construction_workflows where project_id=${q.projectId}::uuid and kind in (${sql.join(
            allowed.map((k) => sql`${k}`),
            sql`,`,
          )}) order by created_at desc limit 500`,
        )
      ).rows as unknown as ConstructionWorkflow[];
      for (const item of items) await hydrateWorkflow(c, item);
      return { items };
    }),
  );
  app.post(
    '/api/construction/workflows',
    tenantRoute(app, read, async (c) => {
      const b = workflowSchema.parse(c.req.body);
      access(c, b.kind, 'write');
      const payload = await validateRefs(c, b);
      if (b.kind === 'baseline') {
        payload.snapshot = (
          await c.tx.execute(
            sql`select id,title,payload,status,version from operation_entries where project_id=${b.projectId}::uuid and kind='schedule' and status<>'cancelled' order by id`,
          )
        ).rows;
      }
      const computed = await compute(c, b.kind, payload, b.projectId);
      const id = b.id ?? randomUUID();
      await c.tx.execute(
        sql`insert into construction_workflows(id,company_id,project_id,kind,title,location_id,wbs_id,owner_id,payload,computed,created_by) values(${id},${c.company.id},${b.projectId},${b.kind},${b.title},${b.locationId},${b.wbsId},${b.ownerId ?? c.user.id},${JSON.stringify(payload)}::jsonb,${JSON.stringify(computed)}::jsonb,${c.user.id})`,
      );
      await event(c, id, 'created', 'Kayıt oluşturuldu.');
      c.reply.code(201);
      return { item: await record(c, id) };
    }),
  );
  app.put(
    '/api/construction/workflows/:id',
    tenantRoute(app, read, async (c) => {
      const id = idParam.parse(c.req.params).id;
      const old = await record(c, id, true);
      access(c, old.kind, 'write');
      const b = workflowSchema.extend({ version: z.number().int().positive() }).parse(c.req.body);
      if (b.version !== old.version) throw conflict('Kayıt değişti; yenileyin.');
      if (b.kind !== old.kind || b.projectId !== old.projectId)
        throw badRequest('Kayıt türü/projesi değiştirilemez.');
      if (
        old.status !== 'draft' &&
        !(old.kind === 'lead' && ['contacted', 'visited', 'offered'].includes(old.status))
      )
        throw badRequest('Bu durumda kayıt değiştirilemez; yeni revizyon oluşturun.');
      if (b.kind === 'baseline')
        throw badRequest('Başlangıç planı anlık görüntüsü değişmez; yeni kayıt oluşturun.');
      const payload = await validateRefs(c, b);
      const computed = await compute(c, b.kind, payload, b.projectId);
      await c.tx.execute(
        sql`update construction_workflows set title=${b.title},location_id=${b.locationId},wbs_id=${b.wbsId},owner_id=${b.ownerId ?? old.ownerId},payload=${JSON.stringify(payload)}::jsonb,computed=${JSON.stringify(computed)}::jsonb,version=version+1 where id=${id}::uuid`,
      );
      await event(c, id, 'updated', 'Taslak güncellendi.');
      return { item: await record(c, id) };
    }),
  );
  app.get(
    '/api/construction/workflows/:id/events',
    tenantRoute(app, read, async (c) => {
      const r = await record(c, idParam.parse(c.req.params).id);
      access(c, r.kind);
      return {
        items: (
          await c.tx.execute(
            sql`select action,note,data,at,u.full_name as "byName" from construction_workflow_events e join users u on u.id=e.by where workflow_id=${r.id}::uuid order by at`,
          )
        ).rows,
      };
    }),
  );
  app.post(
    '/api/construction/workflows/:id/decision',
    tenantRoute(app, read, async (c) => {
      const r = await record(c, idParam.parse(c.req.params).id, true);
      const b = z
        .object({
          version: z.number().int().positive(),
          action: z.enum([
            'submit',
            'approve',
            'reject',
            'close',
            'cancel',
            'contacted',
            'visited',
            'offered',
            'reserved',
            'contracted',
            'lost',
          ]),
          note: z.string().trim().min(3).max(4000),
          contractId: z.uuid().optional(),
        })
        .parse(c.req.body);
      access(
        c,
        r.kind,
        ['approve', 'reject', 'contracted'].includes(b.action) ? 'approve' : 'write',
      );
      if (b.version !== r.version) throw conflict('Kayıt değişti; yenileyin.');
      let next: string;
      if (r.kind === 'lead') {
        const path = ['draft', 'contacted', 'visited', 'offered', 'reserved', 'contracted'];
        if (b.action === 'lost' && r.status !== 'contracted') next = 'lost';
        else if (path[path.indexOf(r.status) + 1] === b.action) next = b.action;
        else throw badRequest('CRM aşaması sıralı ilerlemelidir.');
        if (next === 'reserved') {
          const p = WORKFLOW_PAYLOADS.lead.parse(r.payload);
          if (!p.unitId || !p.reservationUntil || p.reservationUntil < todayIso())
            throw badRequest('Birim ve geçerli rezervasyon sonu gerekir.');
          const unit = await first<{ status: string }>(
            c,
            sql`select status from real_estate_units where id=${p.unitId}::uuid for update`,
          );
          if (unit.status !== 'available')
            throw conflict('Birim başka bir rezervasyon veya sözleşmede.');
          await c.tx.execute(
            sql`update construction_workflows set status='reserved' where id=${r.id}::uuid`,
          );
          await c.tx.execute(
            sql`update real_estate_units set status='reserved' where id=${p.unitId}::uuid`,
          );
        }
        if (next === 'contracted') {
          const p = WORKFLOW_PAYLOADS.lead.parse(r.payload);
          if (!b.contractId) throw badRequest('Mevcut satış sözleşmesini seçin.');
          await requireRecord(c, 'sales_contract', b.contractId);
          await first(
            c,
            sql`select id from sales_contracts where id=${b.contractId}::uuid and unit_id=${String(p.unitId)}::uuid and (${p.partyId ?? null}::uuid is null or party_id=${p.partyId ?? null}::uuid) and status in ('active','handed_over')`,
          );
          await c.tx.execute(
            sql`update construction_workflows set linked_kind='sales_contract',linked_id=${b.contractId}::uuid where id=${r.id}::uuid`,
          );
        }
        if (next === 'lost' && r.status === 'reserved') {
          const p = WORKFLOW_PAYLOADS.lead.parse(r.payload);
          await c.tx.execute(
            sql`update construction_workflows set status='lost' where id=${r.id}::uuid`,
          );
          await c.tx.execute(
            sql`update real_estate_units set status='available' where id=${String(p.unitId)}::uuid and status='reserved' and not exists(select 1 from sales_contracts where unit_id=${String(p.unitId)}::uuid and status in ('draft','active','handed_over'))`,
          );
        }
      } else {
        const transitions: Record<string, Record<string, string>> = {
          draft: { submit: 'submitted', cancel: 'cancelled' },
          submitted: { approve: 'approved', reject: 'rejected', cancel: 'cancelled' },
          approved: { close: 'closed', cancel: 'cancelled' },
        };
        next = transitions[r.status]?.[b.action] ?? '';
        if (r.kind === 'tender' && r.status === 'approved' && b.action === 'lost' && !r.linkedId)
          next = 'lost';
        if (!next) throw badRequest('Bu durum geçişi yapılamaz.');
        if (
          next === 'closed' &&
          r.kind === 'warranty' &&
          (!r.payload.resolution ||
            r.payload.coverage === 'pending' ||
            !r.payload.customerConfirmation)
        )
          throw badRequest(
            'Servis kapanışı için garanti değerlendirmesi, çözüm ve müşteri teyidi gerekir.',
          );
        if (next === 'cancelled' && r.linkedId)
          throw badRequest('Bağlı ERP kaydı bulunan dosya iptal edilemez.');
      }
      let computed = r.computed;
      if (next === 'approved') {
        await validateRefs(c, { ...r, ownerId: r.ownerId, payload: r.payload });
        computed = await compute(c, r.kind, r.payload, r.projectId);
        if (r.kind === 'permit') {
          const p = WORKFLOW_PAYLOADS.permit.parse(r.payload);
          if (p.end < todayIso() || p.checklist.some((x) => !x.checked))
            throw badRequest('İzin kontrol listesi tamamlanmalı ve geçerliliği sürmelidir.');
        }
        if (r.kind === 'reservation') {
          const p = WORKFLOW_PAYLOADS.reservation.parse(r.payload);
          await c.tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':equipment:' + p.equipmentId},0))`,
          );
          const overlaps = await c.tx.execute(
            sql`select id from construction_workflows where kind='reservation' and status='approved' and payload->>'equipmentId'=${p.equipmentId} and (payload->>'start')::date<=${p.end}::date and (payload->>'end')::date>=${p.start}::date`,
          );
          if (overlaps.rows.length)
            throw conflict('Ekipman bu tarihlerde başka bir iş için ayrılmış.');
          const outage = await c.tx.execute(
            sql`select id from construction_workflows where kind='maintenance' and status='approved' and payload->>'equipmentId'=${p.equipmentId} and (payload->>'outageStart')::date<=${p.end}::date and (payload->>'outageEnd' is null or (payload->>'outageEnd')::date>=${p.start}::date)`,
          );
          if (outage.rows.length)
            throw conflict('Ekipman bu tarihlerde arıza / bakım nedeniyle kullanılamıyor.');
        }
        if (r.kind === 'material_need') {
          const p = WORKFLOW_PAYLOADS.material_need.parse(r.payload);
          await c.tx.execute(sql`select id from items where id=${p.itemId}::uuid for update`);
          computed = await compute(c, r.kind, r.payload, r.projectId);
          if (
            p.reserveQuantity > p.quantity ||
            (p.reserveQuantity > 0 && dec(p.reserveQuantity).gt(String(computed.available)))
          )
            throw conflict('Ayrılacak miktar ihtiyaç veya serbest stok miktarını aşamaz.');
        }
        if (r.kind === 'production') {
          const p = WORKFLOW_PAYLOADS.production.parse(r.payload);
          await c.tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${c.company.id + ':production:' + p.subcontractId + ':' + p.lineKey},0))`,
          );
          const total = await first<{ quantity: string }>(
            c,
            sql`select coalesce(sum((payload->>'quantity')::numeric),0)::text as quantity from construction_workflows where kind='production' and status in ('approved','closed') and payload->>'subcontractId'=${p.subcontractId} and payload->>'lineKey'=${p.lineKey}`,
          );
          const limit = await first<{ quantity: string }>(
            c,
            sql`select l.quantity::text from subcontract_boq_lines l join subcontract_revisions rev on rev.id=l.revision_id where l.subcontract_id=${p.subcontractId}::uuid and l.line_key=${p.lineKey}::uuid and rev.status='approved' order by rev.revision_no desc limit 1`,
          );
          if (dec(total.quantity).plus(p.quantity).gt(limit.quantity))
            throw badRequest('Onaylı üretim toplamı sözleşme miktarını aşamaz.');
        }
        if (r.kind === 'concrete') await ensureConcreteAction(c, r);
      }
      await c.tx.execute(
        sql`update construction_workflows set status=${next},${next === 'approved' ? sql`computed=${JSON.stringify(computed)}::jsonb,` : sql``}version=version+1 where id=${r.id}::uuid`,
      );
      await event(c, r.id, b.action, b.note);
      return { item: await record(c, r.id) };
    }),
  );
  app.get(
    '/api/construction/program',
    tenantRoute(app, read, async (c) => {
      const q = z.object({ projectId: z.uuid() }).parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      const ops = await c.tx.execute<{
        id: string;
        title: string;
        version: number;
        wbsId: string | null;
        payload: CalendarActivity;
      }>(
        sql`select id,title,version,payload->>'wbsId' as "wbsId",payload from operation_entries where project_id=${q.projectId}::uuid and kind='schedule' and status<>'cancelled' order by event_date limit 2000`,
      );
      const calendars = await c.tx.execute<{ payload: Record<string, unknown> }>(
        sql`select payload from construction_workflows where project_id=${q.projectId}::uuid and kind='calendar' and status='approved' order by created_at desc limit 1`,
      );
      const calendar = calendars.rows[0]
        ? WORKFLOW_PAYLOADS.calendar.parse(calendars.rows[0].payload)
        : { weekdays: [1, 2, 3, 4, 5], holidays: [] };
      let result: ReturnType<typeof criticalPath>;
      try {
        result = criticalPath(
          ops.rows.map((x) => ({
            ...x.payload,
            id: x.id,
            title: x.title,
            version: x.version,
            wbsId: x.wbsId,
          })),
          calendar.weekdays,
          calendar.holidays,
        );
      } catch (e) {
        throw badRequest((e as Error).message);
      }
      const baselines = await c.tx.execute(
        sql`select ${select} from construction_workflows where project_id=${q.projectId}::uuid and kind='baseline' and status='approved' order by created_at desc limit 10`,
      );
      const horizon = new Date(todayIso() + 'T12:00:00Z');
      horizon.setUTCDate(horizon.getUTCDate() + 21);
      const readiness = await c.tx.execute<{
        id: string;
        title: string;
        payload: Record<string, unknown>;
        computed: Record<string, unknown>;
        owner: string;
      }>(
        sql`select w.id,w.title,w.payload,w.computed,u.full_name as owner from construction_workflows w join users u on u.id=w.owner_id where w.project_id=${q.projectId}::uuid and w.kind='readiness' and w.status='approved' order by w.created_at desc`,
      );
      const lookahead = result.activities
        .filter(
          (a) =>
            a.progress < 100 &&
            a.computedStart <= horizon.toISOString().slice(0, 10) &&
            a.computedEnd >= todayIso(),
        )
        .map((a) => ({
          activity: a,
          readiness: readiness.rows.find((r) => r.payload.activityId === a.id) ?? null,
        }));
      return { ...result, calendar, baselines: baselines.rows, lookahead };
    }),
  );
  app.post(
    '/api/construction/workflows/:id/transfer',
    tenantRoute(app, read, async (c) => {
      const r = await record(c, idParam.parse(c.req.params).id, true);
      access(c, r.kind, 'write');
      const b = z
        .object({
          version: z.number().int().positive(),
          quantity: z.coerce.number().positive().optional(),
        })
        .parse(c.req.body);
      if (r.version !== b.version) throw conflict('Kayıt değişti; yenileyin.');
      if (r.status !== 'approved') throw badRequest('Önce onaylayın.');
      const ctx = { companyId: c.company.id, userId: c.user.id };
      let linkedId: string, linkedKind: string;
      if (r.kind === 'production') {
        const p = WORKFLOW_PAYLOADS.production.parse(r.payload);
        await c.tx.execute(
          sql`select id from subcontracts where id=${p.subcontractId}::uuid for update`,
        );
        const used = await first<{ quantity: string }>(
          c,
          sql`select coalesce(sum(a.quantity::numeric),0)::text as quantity from construction_production_allocations a join progress_payments pp on pp.id=a.payment_id where a.production_id=${r.id}::uuid and pp.status<>'cancelled'`,
        );
        const q = b.quantity ? dec(b.quantity) : dec(p.quantity).minus(used.quantity);
        if (q.lte(0)) throw conflict('Üretimin tamamı hakedişe aktarılmış.');
        if (q.gt(dec(p.quantity).minus(used.quantity)))
          throw conflict('Bu üretim miktarı daha önce hakedişe aktarıldı.');
        const pending = await c.tx.execute(
          sql`select id from progress_payments where subcontract_id=${p.subcontractId}::uuid and status in ('draft','submitted','approved')`,
        );
        if (pending.rows.length)
          throw conflict('Sözleşmede bekleyen hakediş var; önce tamamlayın veya iptal edin.');
        const previous = await first<{ cum: string }>(
          c,
          sql`select coalesce(max(l.cum_qty),0)::text as cum from progress_payment_lines l join progress_payments pp on pp.id=l.payment_id where pp.subcontract_id=${p.subcontractId}::uuid and pp.status='posted' and l.line_key=${p.lineKey}::uuid`,
        );
        const result = await createProgress(
          c.tx,
          {
            ...ctx,
            baseCurrency: c.company.baseCurrency,
            reportingCurrency: c.company.reportingCurrency,
          },
          {
            subcontractId: p.subcontractId,
            periodEnd: p.date,
            lines: [{ lineKey: p.lineKey, cumulativeQty: dec(previous.cum).plus(q).toFixed(4) }],
            deductions: [],
            note: 'Saha üretimi: ' + r.title,
          },
        );
        linkedId = String(result.payment.id);
        linkedKind = 'progress_payment';
        await c.tx.execute(
          sql`insert into construction_production_allocations(id,company_id,production_id,payment_id,quantity) values(${randomUUID()},${c.company.id},${r.id},${linkedId},${q.toFixed(4)})`,
        );
      } else {
        if (r.linkedId) throw conflict('Dosya daha önce aktarıldı.');
        if (r.kind === 'material_need') {
          const p = WORKFLOW_PAYLOADS.material_need.parse(r.payload);
          const calc = await compute(c, r.kind, r.payload, r.projectId, r.id);
          if (dec(String(calc.shortage)).lte(0))
            throw badRequest('Karşılanmamış malzeme ihtiyacı yok.');
          const res = await createRequest(
            c.tx,
            { ...ctx, baseCurrency: c.company.baseCurrency },
            createPurchaseRequestSchema.parse({
              projectId: r.projectId,
              title: r.title,
              needDate: p.needDate,
              note: 'İhtiyaç planından oluşturuldu.',
              lines: [
                {
                  itemId: p.itemId,
                  description: r.title,
                  unit: p.unit,
                  quantity: String(calc.shortage),
                  wbsId: r.wbsId,
                },
              ],
            }),
          );
          linkedId = String((res.request as Record<string, unknown>).id);
          linkedKind = 'purchase_request';
        } else if (r.kind === 'change_event') {
          const p = WORKFLOW_PAYLOADS.change_event.parse(r.payload);
          const res = await createVariation(c.tx, ctx, p.subcontractId, {
            title: r.title,
            reason: p.reason,
            description: p.description + '\nEtki dosyası: ' + r.id,
            timeExtensionDays: p.days,
          });
          linkedId = String(res.variation.id);
          linkedKind = 'variation_order';
        } else if (r.kind === 'tender') {
          c.require('projects.budget');
          const p = WORKFLOW_PAYLOADS.tender.parse(r.payload);
          if (p.currency !== c.company.baseCurrency)
            throw badRequest('Proje bütçesine aktarım için teklif defter para biriminde olmalı.');
          const created = await createProject(
            c.tx,
            ctx,
            createProjectSchema.parse({
              name: r.title,
              kind: 'contract',
              clientPartyId: p.clientId,
            }),
          );
          const budget = await createBudget(c.tx, ctx, created.id, {
            title: r.title,
            copyFromCurrent: false,
          });
          const lines = [];
          for (const [i, line] of (
            r.computed.lines as { description: string; quantity: number; unitPrice: string }[]
          ).entries()) {
            const wbs = await createWbs(c.tx, c.company.id, created.id, {
              code: String(i + 1).padStart(3, '0'),
              name: line.description.slice(0, 160),
            });
            lines.push({
              wbsId: wbs.id,
              amount: dec(line.quantity).times(line.unitPrice).toFixed(2),
            });
          }
          await putBudgetLines(c.tx, c.company.id, budget.id, { lines });
          linkedId = created.id;
          linkedKind = 'project';
        } else if (r.kind === 'buyer_option') {
          c.require('procurement.manage');
          if (!c.enabledModules.has('construction.procurement')) throw forbidden();
          const p = WORKFLOW_PAYLOADS.buyer_option.parse(r.payload);
          const req = await createRequest(
            c.tx,
            { ...ctx, baseCurrency: c.company.baseCurrency },
            createPurchaseRequestSchema.parse({
              projectId: r.projectId,
              title: r.title,
              needDate: p.selectionDeadline,
              lines: [
                {
                  description: p.category + ' · ' + p.choice,
                  unit: 'adet',
                  quantity: '1',
                  itemId: p.itemId ?? null,
                  wbsId: r.wbsId,
                },
              ],
            }),
          );
          linkedId = String((req.request as Record<string, unknown>).id);
          linkedKind = 'purchase_request';
          await c.tx.execute(
            sql`insert into work_items(id,company_id,title,description,due_date,owner_id,record_kind,record_id,created_by) values(${randomUUID()},${c.company.id},${r.title},${'Onaylı daire seçimi: ' + r.id},${p.selectionDeadline},${r.ownerId},'purchase_request',${linkedId},${c.user.id})`,
          );
        } else throw badRequest('Bu kayıt için aktarım yok.');
      }
      await c.tx.execute(
        sql`update construction_workflows set linked_kind=${linkedKind},linked_id=${linkedId},version=version+1 where id=${r.id}::uuid`,
      );
      await event(c, r.id, 'transferred', 'Mevcut ERP taslağına aktarıldı.', {
        linkedKind,
        linkedId,
      });
      return { item: await record(c, r.id), linkedKind, linkedId };
    }),
  );
};
