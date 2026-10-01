import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  dec,
  roundMoney,
  toDbAmount,
  todayIso,
  type BoqLineInput,
  type CreateRevisionInput,
  type CreateSubcontractInput,
  type PutBoqLinesInput,
  type UpdateSubcontractInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { costCodes, parties, projectWbs, projects, subcontractBoqLines, subcontractRevisions, subcontracts, variationOrders } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { nextNumber } from '../settings/numbering';
import { resolveParam } from './params';

export interface SubcontractCtx {
  companyId: string;
  userId: string;
}

const NUMBER_KEY = 'SUBCONTRACT';
export const formatSubcontractCode = (n: number, direction: 'payable' | 'receivable' = 'payable') =>
  `${direction === 'receivable' ? 'IVS' : 'TSZ'}-${String(n).padStart(4, '0')}`;

export async function getSubcontractRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(subcontracts).where(eq(subcontracts.id, id));
  if (!row) throw notFound('Taşeron sözleşmesi');
  return row;
}

async function lockSubcontract(tx: Tx, id: string) {
  const [row] = await tx.select().from(subcontracts).where(eq(subcontracts.id, id)).for('update');
  if (!row) throw notFound('Taşeron sözleşmesi');
  return row;
}

export const lineAmount = (quantity: string, unitPrice: string) => roundMoney(dec(quantity).mul(unitPrice));

/** Yürürlükteki revizyon: en yüksek numaralı onaylı revizyon (yoksa null). */
export async function currentRevision(tx: Tx, subcontractId: string) {
  const [row] = await tx
    .select()
    .from(subcontractRevisions)
    .where(and(eq(subcontractRevisions.subcontractId, subcontractId), eq(subcontractRevisions.status, 'approved')))
    .orderBy(desc(subcontractRevisions.revisionNo))
    .limit(1);
  return row ?? null;
}

async function getRevisionRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(subcontractRevisions).where(eq(subcontractRevisions.id, id));
  if (!row) throw notFound('Sözleşme revizyonu');
  return row;
}

export async function createSubcontract(tx: Tx, ctx: SubcontractCtx, input: CreateSubcontractInput) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, input.projectId));
  if (!project) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
  if (project.status === 'completed' || project.status === 'cancelled') {
    throw unprocessable(`${project.code} projesi tamamlanmış veya iptal edilmiş; sözleşme eklenemez`, 'PROJECT_CLOSED');
  }
  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw unprocessable('Taşeron cari bulunamadı', 'PARTY_NOT_FOUND');
  if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
  const receivable = input.direction === 'receivable';
  if (receivable) {
    if (party.kind === 'supplier') throw unprocessable('İşveren cari müşteri türünde olmalı', 'PARTY_KIND_MISMATCH');
    if (project.kind !== 'contract') throw unprocessable('İşveren sözleşmesi yalnızca "işverene yapılan iş" türündeki projede açılır', 'EMPLOYER_PROJECT_KIND');
    if (project.clientPartyId !== party.id) throw unprocessable('İşveren sözleşmesi projenin işvereniyle yapılır', 'EMPLOYER_PARTY_MISMATCH');
    const [dup] = await tx.select({ code: subcontracts.code }).from(subcontracts).where(and(eq(subcontracts.projectId, project.id), eq(subcontracts.direction, 'receivable'), sql`${subcontracts.status} <> 'terminated'`));
    if (dup) throw unprocessable(`Projede zaten işveren sözleşmesi var (${dup.code})`, 'EMPLOYER_CONTRACT_EXISTS');
  } else if (party.kind === 'customer') throw unprocessable('Taşeron cari tedarikçi türünde olmalı', 'PARTY_KIND_MISMATCH');

  // Yüzdeler verilmediyse bugün geçerli parametreden anlık görüntü alınır (doğrulanmamış olsa da; ekranda rozet gösterilir)
  const today = todayIso();
  const pct = async (given: string | undefined, kind: 'retention_pct' | 'withholding_pct' | 'advance_recoup_pct' | 'vat_withholding_pct') =>
    given ?? (await resolveParam(tx, kind, input.startDate ?? today))?.value ?? '0';

  const code = formatSubcontractCode(await nextNumber(tx, ctx.companyId, receivable ? `${NUMBER_KEY}:in` : NUMBER_KEY, 0), input.direction);
  const [row] = await tx
    .insert(subcontracts)
    .values({
      companyId: ctx.companyId,
      code,
      direction: input.direction,
      projectId: input.projectId,
      partyId: input.partyId,
      title: input.title,
      currencyCode: input.currencyCode,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      paymentDays: input.paymentDays,
      retentionPct: await pct(input.retentionPct, 'retention_pct'),
      advanceRecoupPct: await pct(input.advanceRecoupPct, 'advance_recoup_pct'),
      withholdingPct: await pct(input.withholdingPct, 'withholding_pct'),
      vatWithholdingPct: await pct(input.vatWithholdingPct, 'vat_withholding_pct'),
      penaltyNote: input.penaltyNote ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  // Revizyon 1 taslağı hemen açılır; BOQ buraya girilir
  await tx.insert(subcontractRevisions).values({ companyId: ctx.companyId, subcontractId: row!.id, revisionNo: 1, createdBy: ctx.userId });
  return row!;
}

export async function updateSubcontract(tx: Tx, id: string, input: UpdateSubcontractInput) {
  const current = await lockSubcontract(tx, id);
  if (current.status === 'completed' || current.status === 'terminated') {
    throw unprocessable('Tamamlanmış veya feshedilmiş sözleşme değiştirilemez', 'SUBCONTRACT_CLOSED');
  }
  const hasPct = input.retentionPct !== undefined || input.advanceRecoupPct !== undefined || input.withholdingPct !== undefined || input.vatWithholdingPct !== undefined;
  if (hasPct && current.status !== 'draft') {
    throw unprocessable('Yürürlükteki sözleşmenin kesinti yüzdeleri değiştirilemez', 'SUBCONTRACT_PCT_LOCKED');
  }
  const start = input.startDate !== undefined ? input.startDate : current.startDate;
  const end = input.endDate !== undefined ? input.endDate : current.endDate;
  if (start && end && end < start) throw unprocessable('Bitiş tarihi başlangıçtan önce olamaz', 'SUBCONTRACT_DATES');
  await tx.update(subcontracts).set({ ...input, updatedAt: new Date() }).where(eq(subcontracts.id, id));
  return getSubcontract(tx, id);
}

/** active → completed | terminated. */
export async function setSubcontractStatus(tx: Tx, id: string, status: 'completed' | 'terminated') {
  await lockSubcontract(tx, id);
  await tx.update(subcontracts).set({ status, updatedAt: new Date() }).where(eq(subcontracts.id, id));
  return getSubcontract(tx, id);
}

export async function deleteSubcontract(tx: Tx, id: string) {
  await lockSubcontract(tx, id);
  await tx.delete(subcontracts).where(eq(subcontracts.id, id));
}

// --- Revizyon ve BOQ ---------------------------------------------------------------------

export async function createRevision(
  tx: Tx,
  ctx: SubcontractCtx,
  subcontractId: string,
  input: CreateRevisionInput,
  opts: { forVariation?: boolean } = {},
) {
  const sc = await lockSubcontract(tx, subcontractId);
  if (sc.status === 'completed' || sc.status === 'terminated') {
    throw unprocessable('Tamamlanmış veya feshedilmiş sözleşmeye revizyon eklenemez', 'SUBCONTRACT_CLOSED');
  }
  // Yürürlükteki sözleşmede BOQ yalnızca değişiklik emriyle değişir (gerekçe, onay, süre etkisi izlenir)
  if (sc.status === 'active' && !opts.forVariation) {
    throw unprocessable('Yürürlükteki sözleşmede değişiklik, değişiklik emriyle yapılır', 'USE_VARIATION_ORDER');
  }
  const [draft] = await tx
    .select({ revisionNo: subcontractRevisions.revisionNo })
    .from(subcontractRevisions)
    .where(and(eq(subcontractRevisions.subcontractId, subcontractId), eq(subcontractRevisions.status, 'draft')));
  if (draft) throw unprocessable(`Sözleşmede zaten taslak bir revizyon var (rev. ${draft.revisionNo}); onaylayın ya da silin`, 'REVISION_DRAFT_EXISTS');

  const [last] = await tx
    .select({ max: sql<number>`coalesce(max(${subcontractRevisions.revisionNo}), 0)::int` })
    .from(subcontractRevisions)
    .where(eq(subcontractRevisions.subcontractId, subcontractId));
  const [row] = await tx
    .insert(subcontractRevisions)
    .values({ companyId: ctx.companyId, subcontractId, revisionNo: (last?.max ?? 0) + 1, title: input.title ?? null, createdBy: ctx.userId })
    .returning();

  if (input.copyFromCurrent) {
    const current = await currentRevision(tx, subcontractId);
    if (current) {
      await tx.execute(sql`
        insert into subcontract_boq_lines (id, company_id, revision_id, subcontract_id, project_id, line_key, line_no, item_no, description, unit, quantity, unit_price, wbs_id, cost_code_id)
        select gen_random_uuid(), company_id, ${row!.id}, subcontract_id, project_id, line_key, line_no, item_no, description, unit, quantity, unit_price, wbs_id, cost_code_id
          from subcontract_boq_lines where revision_id = ${current.id}`);
    }
  }
  return row!;
}

/** Taslak revizyonun tüm satırlarını verilen listeyle değiştirir. */
export async function putBoqLines(tx: Tx, ctx: SubcontractCtx, revisionId: string, input: PutBoqLinesInput) {
  const revision = await getRevisionRow(tx, revisionId);
  if (revision.status !== 'draft') throw unprocessable('Yalnızca taslak revizyon düzenlenebilir; yeni revizyon açın', 'REVISION_NOT_DRAFT');
  const sc = await lockSubcontract(tx, revision.subcontractId);
  // Onaydaki ya da işveren kabulü bekleyen DE'nin BOQ'su değişmez (onaylanan, onaya gönderilendir)
  const [vo] = await tx.select({ status: variationOrders.status }).from(variationOrders).where(eq(variationOrders.revisionId, revisionId));
  if (vo && vo.status !== 'draft' && vo.status !== 'rejected') {
    throw unprocessable('Onaydaki değişiklik emrinin BOQ\'su düzenlenemez', 'VARIATION_NOT_EDITABLE');
  }

  const wbsIds = [...new Set(input.lines.map((l) => l.wbsId))];
  if (wbsIds.length > 0) {
    const found = await tx.select({ id: projectWbs.id }).from(projectWbs).where(and(eq(projectWbs.projectId, sc.projectId), inArray(projectWbs.id, wbsIds)));
    if (found.length !== wbsIds.length) throw unprocessable('İş kalemlerinden biri sözleşmenin projesine ait değil', 'WBS_NOT_FOUND');
  }
  const codeIds = [...new Set(input.lines.map((l) => l.costCodeId).filter((c): c is string => !!c))];
  if (codeIds.length > 0) {
    const found = await tx.select({ id: costCodes.id }).from(costCodes).where(inArray(costCodes.id, codeIds));
    if (found.length !== codeIds.length) throw unprocessable('Maliyet kodlarından biri bulunamadı', 'COST_CODE_NOT_FOUND');
  }

  // Yürürlükteki revizyonda olmayan bir lineKey verilemez (kimlik uydurulamaz)
  const current = await currentRevision(tx, sc.id);
  // (taslağın kendi satırlarının anahtarları da geçerlidir: yeniden kaydetmede kimlik korunur)
  const knownKeys = new Set(
    (
      await tx
        .select({ k: subcontractBoqLines.lineKey })
        .from(subcontractBoqLines)
        .where(current ? inArray(subcontractBoqLines.revisionId, [current.id, revisionId]) : eq(subcontractBoqLines.revisionId, revisionId))
    ).map((r) => r.k),
  );
  for (const l of input.lines) {
    if (l.lineKey && !knownKeys.has(l.lineKey)) throw unprocessable('Bilinmeyen BOQ satır anahtarı', 'BOQ_LINE_KEY_UNKNOWN');
  }

  await tx.delete(subcontractBoqLines).where(eq(subcontractBoqLines.revisionId, revisionId));
  const rows = input.lines.map((l: BoqLineInput, i) => ({
    companyId: ctx.companyId,
    revisionId,
    subcontractId: sc.id,
    projectId: sc.projectId,
    lineKey: l.lineKey ?? randomUUID(),
    lineNo: i + 1,
    itemNo: l.itemNo ?? null,
    description: l.description,
    unit: l.unit,
    quantity: toDbAmount(dec(l.quantity)),
    unitPrice: toDbAmount(dec(l.unitPrice)),
    wbsId: l.wbsId,
    costCodeId: l.costCodeId ?? null,
  }));
  if (rows.length > 0) await tx.insert(subcontractBoqLines).values(rows);
  return getRevision(tx, revisionId);
}

/**
 * Taslağı onaylar; yürürlükteki revizyon olur, öncekinin yerini alır. İlk onayda sözleşme yürürlüğe girer.
 * Hakedişte kümülatif miktarı yeni miktardan büyük olan satır varsa onay reddedilir (B2c `certifiedByLine`).
 */
export async function approveRevision(tx: Tx, ctx: SubcontractCtx, revisionId: string) {
  const revision = await getRevisionRow(tx, revisionId);
  const sc = await lockSubcontract(tx, revision.subcontractId);
  const fresh = await getRevisionRow(tx, revisionId);
  if (fresh.status !== 'draft') throw unprocessable('Yalnızca taslak revizyon onaylanabilir', 'REVISION_NOT_DRAFT');
  if (await currentRevision(tx, sc.id)) {
    throw unprocessable('Yürürlükteki sözleşmenin revizyonu değişiklik emri akışıyla onaylanır', 'USE_VARIATION_ORDER');
  }
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(subcontractBoqLines).where(eq(subcontractBoqLines.revisionId, revisionId));
  if (!count || count.n === 0) throw unprocessable('Boş revizyon onaylanamaz; en az bir BOQ satırı girin', 'REVISION_EMPTY');

  await tx.update(subcontractRevisions).set({ status: 'approved', approvedAt: new Date(), approvedBy: ctx.userId }).where(eq(subcontractRevisions.id, revisionId));
  await tx
    .update(subcontractRevisions)
    .set({ status: 'superseded' })
    .where(and(eq(subcontractRevisions.subcontractId, sc.id), eq(subcontractRevisions.status, 'approved'), sql`${subcontractRevisions.revisionNo} < ${revision.revisionNo}`));
  if (sc.status === 'draft') await tx.update(subcontracts).set({ status: 'active', updatedAt: new Date() }).where(eq(subcontracts.id, sc.id));
  return getRevision(tx, revisionId);
}

export async function deleteRevision(tx: Tx, revisionId: string) {
  const revision = await getRevisionRow(tx, revisionId);
  if (revision.status !== 'draft') throw unprocessable('Onaylanmış revizyon silinemez', 'REVISION_NOT_DRAFT');
  await lockSubcontract(tx, revision.subcontractId);
  const [vo] = await tx.select({ code: variationOrders.code }).from(variationOrders).where(eq(variationOrders.revisionId, revisionId));
  if (vo) throw unprocessable(`Bu revizyon ${vo.code} değişiklik emrine bağlı; değişiklik emrini iptal edin`, 'REVISION_IN_VARIATION');
  await tx.delete(subcontractRevisions).where(eq(subcontractRevisions.id, revisionId));
}

export async function getRevision(tx: Tx, revisionId: string) {
  const revision = await getRevisionRow(tx, revisionId);
  const lines = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.line_key as "lineKey", l.line_no as "lineNo", l.item_no as "itemNo", l.description, l.unit,
           l.quantity::text as quantity, l.unit_price::text as "unitPrice",
           round(l.quantity * l.unit_price, 2)::text as amount,
           l.wbs_id as "wbsId", w.code as "wbsCode", w.name as "wbsName",
           l.cost_code_id as "costCodeId", c.code as "costCode"
      from subcontract_boq_lines l
      join project_wbs w on w.id = l.wbs_id
      left join cost_codes c on c.id = l.cost_code_id
     where l.revision_id = ${revisionId}
     order by l.line_no`);
  const total = lines.rows.reduce((acc, r) => acc.plus(dec(String(r.amount))), dec(0));
  return { revision: { ...revision, total: total.toFixed(2) }, lines: lines.rows };
}

/** Sözleşme özeti: ilk bedel, uygulanan DE toplamı, bekleyen DE (gönderilmiş + işveren kabulü bekleyen) ve uzatma günleri. */
export async function variationSummary(tx: Tx, subcontractId: string) {
  const [first] = await tx
    .select({ id: subcontractRevisions.id })
    .from(subcontractRevisions)
    .where(and(eq(subcontractRevisions.subcontractId, subcontractId), sql`${subcontractRevisions.status} <> 'draft'`))
    .orderBy(subcontractRevisions.revisionNo)
    .limit(1);
  const [o] = first
    ? await tx.execute<{ total: string }>(sql`
        select coalesce(sum(round(quantity * unit_price, 2)), 0)::text as total from subcontract_boq_lines where revision_id = ${first.id}`).then((x) => x.rows)
    : [];
  const original = dec(o?.total ?? 0);
  const [s] = await tx.execute<{ applied: string; pending: string; days: number; n: number }>(sql`
    select coalesce(sum(amount_delta) filter (where status = 'applied'), 0)::text as applied,
           coalesce(sum(amount_delta) filter (where status in ('submitted', 'awaiting_client')), 0)::text as pending,
           coalesce(sum(time_extension_days) filter (where status = 'applied'), 0)::int as days,
           count(*) filter (where status in ('submitted', 'awaiting_client'))::int as n
      from variation_orders where subcontract_id = ${subcontractId}`).then((x) => x.rows);
  return {
    originalAmount: original.toFixed(2),
    appliedVariations: dec(s?.applied ?? 0).toFixed(2),
    pendingVariations: dec(s?.pending ?? 0).toFixed(2),
    pendingCount: s?.n ?? 0,
    extensionDays: s?.days ?? 0,
  };
}

// --- Okuma ----------------------------------------------------------------------------------

export async function getSubcontract(tx: Tx, id: string) {
  const row = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.code, s.project_id as "projectId", s.party_id as "partyId", s.title, s.currency_code as "currencyCode",
           s.start_date as "startDate", s.end_date as "endDate", s.payment_days as "paymentDays", s.direction,
           s.retention_pct::text as "retentionPct", s.advance_recoup_pct::text as "advanceRecoupPct", s.withholding_pct::text as "withholdingPct", s.vat_withholding_pct::text as "vatWithholdingPct",
           s.penalty_note as "penaltyNote", s.status, s.created_at as "createdAt", s.updated_at as "updatedAt",
           p.code as "projectCode", p.name as "projectName", pa.code as "partyCode", pa.name as "partyName"
      from subcontracts s
      join projects p on p.id = s.project_id
      join parties pa on pa.id = s.party_id
     where s.id = ${id}`);
  const base = row.rows[0];
  if (!base) throw notFound('Taşeron sözleşmesi');
  const revisions = await tx.execute<Record<string, unknown>>(sql`
    select r.id, r.revision_no as "revisionNo", r.status, r.title, r.approved_at as "approvedAt", r.created_at as "createdAt",
           coalesce((select sum(round(l.quantity * l.unit_price, 2)) from subcontract_boq_lines l where l.revision_id = r.id), 0)::text as total,
           r.id = (select c.id from subcontract_revisions c where c.subcontract_id = r.subcontract_id and c.status = 'approved' order by c.revision_no desc limit 1) as "isCurrent",
           v.id as "variationId", v.code as "variationCode", v.status as "variationStatus"
      from subcontract_revisions r
      left join variation_orders v on v.revision_id = r.id
     where r.subcontract_id = ${id} order by r.revision_no desc`);
  const current = revisions.rows.find((r) => r.isCurrent);
  const variations = await variationSummary(tx, id);
  return { subcontract: { ...base, contractAmount: current ? String(current.total) : '0.00', ...variations }, revisions: revisions.rows };
}

export async function listSubcontracts(tx: Tx, q: { projectId?: string; partyId?: string; status?: string; direction?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.code, s.title, s.status, s.direction, s.currency_code as "currencyCode", s.project_id as "projectId",
           p.code as "projectCode", p.name as "projectName", s.party_id as "partyId", pa.name as "partyName",
           s.start_date as "startDate", s.end_date as "endDate",
           coalesce((select sum(round(l.quantity * l.unit_price, 2)) from subcontract_boq_lines l
                      where l.revision_id = (select c.id from subcontract_revisions c where c.subcontract_id = s.id and c.status = 'approved' order by c.revision_no desc limit 1)), 0)::text as "contractAmount"
      from subcontracts s
      join projects p on p.id = s.project_id
      join parties pa on pa.id = s.party_id
     where (${q.projectId ?? null}::uuid is null or s.project_id = ${q.projectId ?? null}::uuid)
       and (${q.partyId ?? null}::uuid is null or s.party_id = ${q.partyId ?? null}::uuid)
       and (${q.status ?? null}::text is null or s.status = ${q.status ?? null}::text)
       and (${q.direction ?? null}::text is null or s.direction = ${q.direction ?? null}::text)
     order by s.code desc`);
  return { subcontracts: rows.rows };
}

