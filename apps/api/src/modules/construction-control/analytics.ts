import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { dec, todayIso } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { forbidden } from '../../http/errors';
import { requireRecord } from '../workspace/records';
import { expireReservations } from './workflows';
const read = { module: 'construction.projects', permission: 'projects.read' as const };
export const constructionAnalyticsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/construction/sales-pipeline',
    tenantRoute(app, read, async (c) => {
      const q = z.object({ projectId: z.uuid() }).parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      c.require('realestate.read');
      if (!c.enabledModules.has('construction.realestate')) throw forbidden();
      await expireReservations(c);
      const items = await c.tx.execute(
        sql`select payload->>'source' as source,u.full_name as owner,count(*)::int as leads,count(*) filter(where w.status='visited')::int as visits,count(*) filter(where w.status='offered')::int as offers,count(*) filter(where w.status='reserved')::int as reservations,count(*) filter(where w.status='contracted')::int as contracts,count(*) filter(where w.status='lost')::int as lost,round(100.0*count(*) filter(where w.status='contracted')/nullif(count(*),0),1)::text as conversion from construction_workflows w join users u on u.id=w.owner_id where w.project_id=${q.projectId}::uuid and w.kind='lead' group by payload->>'source',u.full_name order by source,owner`,
      );
      return {
        items: items.rows,
        method:
          'Dönüşüm = sözleşmeli aday / tüm adaylar × 100. Aşamalar adayın güncel durumudur; ziyaret ve teklif geçmiş toplamı değildir.',
      };
    }),
  );
  app.get(
    '/api/construction/options',
    tenantRoute(app, read, async (c) => {
      const q = z.object({ projectId: z.uuid() }).parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      const projectId = q.projectId;
      await expireReservations(c);
      return {
        equipment: (
          await c.tx.execute(
            sql`select id,title as label from operation_entries where kind='equipment' and status='open' order by title limit 1000`,
          )
        ).rows,
        wbs: (
          await c.tx.execute(
            sql`select id,code||' · '||name as label from project_wbs where project_id=${projectId}::uuid and is_active order by code limit 1000`,
          )
        ).rows,
        operations: (
          await c.tx.execute(
            sql`select id,title as label,kind,payload->>'start' as start from operation_entries where project_id=${projectId}::uuid and status<>'cancelled' and (kind<>'defect' or ${c.can('realestate.read') && c.enabledModules.has('construction.realestate')}) order by title limit 1000`,
          )
        ).rows,
        assets: (
          await c.tx.execute(
            sql`select id,filename as label,mime from construction_assets where project_id=${projectId}::uuid order by created_at desc limit 1000`,
          )
        ).rows,
        photos: (
          await c.tx.execute(
            sql`select id,caption||' · '||date::text as label from construction_photos where project_id=${projectId}::uuid order by date desc limit 1000`,
          )
        ).rows,
        parties:
          c.can('parties.read') && c.enabledModules.has('core.parties')
            ? (
                await c.tx.execute(
                  sql`select id,code||' · '||name as label from parties where is_active order by name limit 1000`,
                )
              ).rows
            : [],
        items:
          c.can('inventory.read') && c.enabledModules.has('core.inventory')
            ? (
                await c.tx.execute(
                  sql`select id,code||' · '||name as label,unit from items where is_active order by name limit 1000`,
                )
              ).rows
            : [],
        subcontracts:
          c.can('subcontracts.read') && c.enabledModules.has('construction.subcontracts')
            ? (
                await c.tx.execute(
                  sql`select id,code||' · '||title as label,currency_code as currency from subcontracts where project_id=${projectId}::uuid and status='active' order by code limit 1000`,
                )
              ).rows
            : [],
        boq:
          c.can('subcontracts.read') && c.enabledModules.has('construction.subcontracts')
            ? (
                await c.tx.execute(
                  sql`select l.line_key as id,l.description as label,l.subcontract_id as "subcontractId",l.wbs_id as "wbsId",l.unit from subcontract_boq_lines l join subcontract_revisions r on r.id=l.revision_id where l.project_id=${projectId}::uuid and r.status='approved' order by l.line_no limit 2000`,
                )
              ).rows
            : [],
        units:
          c.can('realestate.read') && c.enabledModules.has('construction.realestate')
            ? (
                await c.tx.execute(
                  sql`select id,coalesce(block,'')||' · '||unit_no as label,status from real_estate_units where project_id=${projectId}::uuid order by unit_no limit 1000`,
                )
              ).rows
            : [],
        salesContracts:
          c.can('realestate.read') && c.enabledModules.has('construction.realestate')
            ? (
                await c.tx.execute(
                  sql`select id,code as label,unit_id as "unitId",party_id as "partyId" from sales_contracts where project_id=${projectId}::uuid and status in ('active','handed_over') order by code limit 1000`,
                )
              ).rows
            : [],
        orders:
          c.can('procurement.read') && c.enabledModules.has('construction.procurement')
            ? (
                await c.tx.execute(
                  sql`select id,code as label from purchase_orders where project_id=${projectId}::uuid order by code limit 1000`,
                )
              ).rows
            : [],
        owners: (
          await c.tx.execute(
            sql`select u.id,u.full_name as label from memberships m join users u on u.id=m.user_id where m.company_id=${c.company.id}::uuid and u.is_active order by u.full_name limit 1000`,
          )
        ).rows,
      };
    }),
  );
  app.get(
    '/api/construction/productivity',
    tenantRoute(app, read, async (c) => {
      const q = z
        .object({ projectId: z.uuid(), from: z.iso.date(), to: z.iso.date() })
        .refine((q) => q.to >= q.from)
        .parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      c.require('subcontracts.read');
      c.require('hr.read');
      if (!c.enabledModules.has('hr.core') || !c.enabledModules.has('construction.subcontracts'))
        throw forbidden();
      const productions = await c.tx.execute<{
        wbsId: string;
        unit: string;
        quantity: string;
        planned: string;
        count: number;
        dates: string[];
      }>(
        sql`select wbs_id as "wbsId",payload->>'unit' as unit,sum((payload->>'quantity')::numeric)::text as quantity,sum((payload->>'plannedQuantity')::numeric)::text as planned,count(*)::int as count,array_agg(distinct payload->>'date') as dates from construction_workflows where project_id=${q.projectId}::uuid and kind='production' and status in ('approved','closed') and (payload->>'date')::date between ${q.from}::date and ${q.to}::date group by wbs_id,payload->>'unit'`,
      );
      const items = [];
      for (const p of productions.rows) {
        const hours = await c.tx.execute<{ hours: string; count: number }>(
          sql`select coalesce(sum(normal_hours+overtime_hours),0)::text as hours,count(*)::int as count from attendance_entries where project_id=${q.projectId}::uuid and wbs_id=${p.wbsId}::uuid and work_date between ${q.from}::date and ${q.to}::date and work_date in (${sql.join(
            p.dates.map((d) => sql`${d}::date`),
            sql`,`,
          )})`,
        );
        const h = hours.rows[0]!;
        const units = productions.rows.filter((x) => x.wbsId === p.wbsId).length;
        items.push({
          ...p,
          hours: h.hours,
          attendanceRows: h.count,
          perHour:
            units === 1 && dec(h.hours).gt(0) ? dec(p.quantity).div(h.hours).toFixed(4) : null,
          planVariance: dec(p.quantity).minus(p.planned).toFixed(4),
          note:
            units > 1
              ? 'Aynı iş kaleminde farklı üretim birimleri var; saat dağılımı bilinmediği için oran hesaplanmadı.'
              : h.count
                ? 'İş kalemi toplamı; ekip adına göre personel ayrımı yapılmadı.'
                : 'Üretim günlerinde etiketli puantaj bulunamadı.',
        });
      }
      return { items, from: q.from, to: q.to };
    }),
  );
  app.get(
    '/api/construction/scorecards',
    tenantRoute(app, read, async (c) => {
      const q = z.object({ projectId: z.uuid() }).parse(c.req.query);
      await requireRecord(c, 'project', q.projectId);
      c.require('procurement.read');
      c.require('parties.read');
      if (!c.enabledModules.has('construction.procurement')) throw forbidden();
      const orders = await c.tx.execute<{
        id: string;
        partyId: string;
        name: string;
        due: string | null;
      }>(
        sql`select o.id,o.party_id as "partyId",p.name,(o.issued_at::date+f.delivery_days)::text as due from purchase_orders o join parties p on p.id=o.party_id left join rfq_offers f on f.id=o.offer_id where o.project_id=${q.projectId}::uuid and o.status in ('issued','closed') order by o.created_at limit 1000`,
      );
      const byParty = new Map<
        string,
        {
          partyId: string;
          name: string;
          orders: number;
          timed: number;
          onTime: number;
          qualityRecords: number;
          qualityFailures: number;
        }
      >();
      for (const o of orders.rows) {
        const row = byParty.get(o.partyId) ?? {
          partyId: o.partyId,
          name: o.name,
          orders: 0,
          timed: 0,
          onTime: 0,
          qualityRecords: 0,
          qualityFailures: 0,
        };
        row.orders++;
        const deliveries = await c.tx.execute<{ date: string; complete: boolean }>(
          sql`select max(r.receipt_date)::text as date,not exists(select 1 from purchase_order_lines l where l.order_id=${o.id}::uuid and l.quantity>coalesce((select sum(rl.quantity) from po_receipt_lines rl join po_receipts rr on rr.id=rl.receipt_id where rl.order_line_id=l.id and rr.status='posted'),0)) as complete from po_receipts r where r.order_id=${o.id}::uuid and r.status='posted'`,
        );
        const d = deliveries.rows[0]!;
        if (o.due && (d.complete || o.due < todayIso())) {
          row.timed++;
          if (d.complete && d.date <= o.due) row.onTime++;
        }
        byParty.set(o.partyId, row);
      }
      if (c.can('subcontracts.read') && c.enabledModules.has('construction.subcontracts')) {
        const contractors = await c.tx.execute<{ partyId: string; name: string }>(
          sql`select distinct s.party_id as "partyId",p.name from subcontracts s join parties p on p.id=s.party_id where s.project_id=${q.projectId}::uuid and s.status<>'cancelled'`,
        );
        for (const p of contractors.rows)
          if (!byParty.has(p.partyId))
            byParty.set(p.partyId, {
              ...p,
              orders: 0,
              timed: 0,
              onTime: 0,
              qualityRecords: 0,
              qualityFailures: 0,
            });
      }
      const details = new Map<
        string,
        { averageCorrectionDays: string | null; correctedRecords: number; production: unknown[] }
      >();
      for (const p of byParty.values()) {
        const quality = await c.tx.execute<{ count: number; failed: number }>(
          sql`select count(*)::int as count,count(*) filter(where payload->>'result'='fail')::int as failed from operation_entries where project_id=${q.projectId}::uuid and party_id=${p.partyId}::uuid and kind='quality_check'`,
        );
        p.qualityRecords = quality.rows[0]!.count;
        p.qualityFailures = quality.rows[0]!.failed;
        const corrections = await c.tx.execute<{ days: string | null; count: number }>(
          sql`select round(avg(extract(epoch from(updated_at-created_at))/86400),1)::text as days,count(*)::int as count from operation_entries where project_id=${q.projectId}::uuid and (party_id=${p.partyId}::uuid or payload->>'contractorId'=${p.partyId}) and kind in ('quality_check','defect') and status='done'`,
        );
        const production =
          c.can('subcontracts.read') && c.enabledModules.has('construction.subcontracts')
            ? (
                await c.tx.execute(
                  sql`select w.payload->>'unit' as unit,sum((w.payload->>'quantity')::numeric)::text as quantity,sum((w.payload->>'plannedQuantity')::numeric)::text as planned,round(100*sum((w.payload->>'quantity')::numeric)/nullif(sum((w.payload->>'plannedQuantity')::numeric),0),1)::text as achievement,count(*)::int as count from construction_workflows w join subcontracts s on s.id=(w.payload->>'subcontractId')::uuid where w.project_id=${q.projectId}::uuid and w.kind='production' and w.status in ('approved','closed') and s.party_id=${p.partyId}::uuid group by w.payload->>'unit'`,
                )
              ).rows
            : [];
        details.set(p.partyId, {
          averageCorrectionDays: corrections.rows[0]!.days,
          correctedRecords: corrections.rows[0]!.count,
          production,
        });
      }
      return {
        items: [...byParty.values()].map((p) => ({
          ...p,
          ...details.get(p.partyId),
          deliveryScore: p.timed ? Math.round((p.onTime / p.timed) * 100) : null,
          qualityScore: p.qualityRecords
            ? Math.round(((p.qualityRecords - p.qualityFailures) / p.qualityRecords) * 100)
            : null,
        })),
        method:
          'Teslim = zamanında tamamlanan / değerlendirilebilir sipariş × 100. Kalite = uygunsuzluk olmayan kontrol / tüm kontroller × 100. Düzeltme süresi kapanmış aksiyonun oluşturulma–son güncelleme farkıdır. Üretim başarısı birim bazında onaylı gerçekleşen / planlanan × 100. Eksik ölçütler puanlanmaz; birleşik puan yoktur.',
      };
    }),
  );
};
