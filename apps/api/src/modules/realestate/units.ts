import { eq, sql } from 'drizzle-orm';
import { dec, generateUnitNumbers, toDbAmount, type BulkUnitsInput, type CreateUnitInput, type UpdateUnitInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { projects, realEstateUnits } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';

export interface RealEstateCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
}

async function requireOwnProject(tx: Tx, projectId: string) {
  const [p] = await tx.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
  if (p.kind !== 'own') throw unprocessable('Birim yalnızca kendi projesine (satış projesi) eklenir', 'PROJECT_NOT_OWN');
  if (p.status === 'completed' || p.status === 'cancelled') throw unprocessable('Kapalı projeye birim eklenemez', 'PROJECT_CLOSED');
  return p;
}

const values = (companyId: string, userId: string, projectId: string, v: Omit<CreateUnitInput, 'projectId'>) => ({
  companyId,
  projectId,
  block: v.block ?? '',
  floor: v.floor ?? null,
  unitNo: v.unitNo,
  unitType: v.unitType ?? 'apartment',
  grossM2: v.grossM2 ?? null,
  netM2: v.netM2 ?? null,
  rooms: v.rooms ?? null,
  listPrice: v.listPrice != null ? toDbAmount(dec(v.listPrice)) : null,
  listCurrency: v.listPrice != null ? (v.listCurrency ?? null) : null,
  note: v.note ?? null,
  createdBy: userId,
});

export async function createUnit(tx: Tx, ctx: RealEstateCtx, input: CreateUnitInput) {
  await requireOwnProject(tx, input.projectId);
  const [row] = await tx.insert(realEstateUnits).values(values(ctx.companyId, ctx.userId, input.projectId, input)).returning();
  return getUnit(tx, row!.id);
}

export async function bulkCreateUnits(tx: Tx, ctx: RealEstateCtx, input: BulkUnitsInput) {
  await requireOwnProject(tx, input.projectId);
  const nums = generateUnitNumbers(input.floorFrom, input.floorTo, input.perFloor);
  const rows = nums.map((n) => values(ctx.companyId, ctx.userId, input.projectId, { block: input.block, floor: n.floor, unitNo: n.unitNo, unitType: input.unitType, grossM2: input.grossM2, netM2: input.netM2, rooms: input.rooms, listPrice: input.listPrice, listCurrency: input.listCurrency }));
  const created = await tx.insert(realEstateUnits).values(rows).onConflictDoNothing().returning({ id: realEstateUnits.id });
  return { created: created.length, skipped: rows.length - created.length };
}

export async function updateUnit(tx: Tx, id: string, input: UpdateUnitInput) {
  const [cur] = await tx.select().from(realEstateUnits).where(eq(realEstateUnits.id, id)).for('update');
  if (!cur) throw notFound('Birim');
  const v = values(cur.companyId, cur.createdBy ?? '', cur.projectId, input);
  await tx
    .update(realEstateUnits)
    .set({ block: v.block, floor: v.floor, unitNo: v.unitNo, unitType: v.unitType, grossM2: v.grossM2, netM2: v.netM2, rooms: v.rooms, listPrice: v.listPrice, listCurrency: v.listCurrency, note: v.note })
    .where(eq(realEstateUnits.id, id));
  return getUnit(tx, id);
}

export async function deleteUnit(tx: Tx, id: string) {
  const [cur] = await tx.select({ id: realEstateUnits.id }).from(realEstateUnits).where(eq(realEstateUnits.id, id)).for('update');
  if (!cur) throw notFound('Birim');
  await tx.delete(realEstateUnits).where(eq(realEstateUnits.id, id));
}

const UNIT_SELECT = sql`
  select u.id, u.project_id as "projectId", p.code as "projectCode", u.block, u.floor, u.unit_no as "unitNo", u.unit_type as "unitType",
         u.gross_m_2::text as "grossM2", u.net_m_2::text as "netM2", u.rooms, u.list_price::text as "listPrice", u.list_currency as "listCurrency",
         u.status, u.note,
         c.id as "contractId", c.code as "contractCode", c.status as "contractStatus", pa.name as "buyerName"
    from real_estate_units u
    join projects p on p.id = u.project_id
    left join sales_contracts c on c.unit_id = u.id and c.status in ('draft','active','handed_over')
    left join parties pa on pa.id = c.party_id`;

export async function getUnit(tx: Tx, id: string) {
  const r = await tx.execute<Record<string, unknown>>(sql`${UNIT_SELECT} where u.id = ${id}`);
  if (!r.rows[0]) throw notFound('Birim');
  return { unit: r.rows[0] };
}

export async function listUnits(tx: Tx, q: { projectId?: string; status?: string; block?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`${UNIT_SELECT}
    where (${q.projectId ?? null}::uuid is null or u.project_id = ${q.projectId ?? null}::uuid)
      and (${q.status ?? null}::text is null or u.status = ${q.status ?? null}::text)
      and (${q.block ?? null}::text is null or u.block = ${q.block ?? null}::text)
    order by p.code, u.block, u.floor nulls first, u.unit_no`);
  return { units: rows.rows };
}
