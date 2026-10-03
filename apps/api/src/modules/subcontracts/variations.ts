import { and, desc, eq, sql } from 'drizzle-orm';
import {
  dec,
  todayIso,
  type ClientAcceptVariationInput,
  type CreateVariationInput,
  type UpdateVariationInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import {
  companies,
  subcontractBoqLines,
  subcontractRevisions,
  subcontracts,
  variationOrders,
} from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import {
  cancelRequest,
  registerApprovalHandler,
  requestApproval,
  requestsForDoc,
  type ApprovalCtx,
  type ApprovalRequestWithSteps,
} from '../approvals/service';
import { nextNumber } from '../settings/numbering';
import { requireRate } from '../settings/rates';
import { createRevision, currentRevision, type SubcontractCtx } from './service';

export { variationSummary } from './service';

type VariationRow = typeof variationOrders.$inferSelect;

export const formatVariationCode = (n: number) => `DE-${String(n).padStart(4, '0')}`;

async function lockVariation(tx: Tx, id: string): Promise<VariationRow> {
  const [row] = await tx
    .select()
    .from(variationOrders)
    .where(eq(variationOrders.id, id))
    .for('update');
  if (!row) throw notFound('Değişiklik emri');
  return row;
}

async function lockContract(tx: Tx, id: string) {
  const [row] = await tx.select().from(subcontracts).where(eq(subcontracts.id, id)).for('update');
  if (!row) throw notFound('Sözleşme');
  return row;
}

const revisionTotal = async (tx: Tx, revisionId: string) => {
  const [r] = await tx
    .execute<{ total: string }>(
      sql`
    select coalesce(sum(round(quantity * unit_price, 2)), 0)::text as total from subcontract_boq_lines where revision_id = ${revisionId}`,
    )
    .then((x) => x.rows);
  return dec(r?.total ?? 0);
};

/** Gün ekler (ISO tarih). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Yeni BOQ, hakedişte kesinleşmiş (ya da onaya gönderilmiş) kümülatif miktarların altına inemez; kümülatifi olan satır silinemez.
 * Aksi halde ödenmiş/ödenecek iş sözleşmede karşılıksız kalırdı.
 */
async function assertAboveCertified(tx: Tx, subcontractId: string, revisionId: string) {
  const rows = await tx.execute<{
    lineKey: string;
    cum: string;
    description: string;
    qty: string | null;
  }>(sql`
    with cum as (
      select p.line_key, max(p.cum_qty) as cum, min(p.description) as description
        from progress_payment_lines p join progress_payments pp on pp.id = p.payment_id
       where pp.subcontract_id = ${subcontractId} and pp.status in ('posted', 'submitted')
       group by p.line_key)
    select c.line_key as "lineKey", c.cum::text as cum, c.description, l.quantity::text as qty
      from cum c left join subcontract_boq_lines l on l.revision_id = ${revisionId} and l.line_key = c.line_key
     where c.cum > 0 and (l.quantity is null or l.quantity < c.cum)`);
  const bad = rows.rows[0];
  if (bad) {
    throw unprocessable(
      bad.qty === null
        ? `${bad.description}: hakedişte ${dec(bad.cum).toFixed(4)} miktar işlenmiş satır kaldırılamaz`
        : `${bad.description}: yeni miktar (${dec(bad.qty).toFixed(4)}) hakedişte işlenen kümülatif miktarın (${dec(bad.cum).toFixed(4)}) altına inemez`,
      'VARIATION_BELOW_CERTIFIED',
    );
  }
}

export async function createVariation(
  tx: Tx,
  ctx: SubcontractCtx,
  subcontractId: string,
  input: CreateVariationInput,
) {
  const sc = await lockContract(tx, subcontractId);
  if (sc.status !== 'active')
    throw unprocessable(
      'Değişiklik emri yalnızca yürürlükteki sözleşmeye açılır',
      'SUBCONTRACT_NOT_ACTIVE',
    );
  const base = await currentRevision(tx, sc.id);
  if (!base)
    throw unprocessable('Sözleşmenin yürürlükteki revizyonu yok', 'SUBCONTRACT_NO_REVISION');
  const rev = await createRevision(
    tx,
    ctx,
    sc.id,
    { title: input.title, copyFromCurrent: true },
    { forVariation: true },
  );
  const code = formatVariationCode(await nextNumber(tx, ctx.companyId, 'VARIATION_ORDER', 0));
  const [row] = await tx
    .insert(variationOrders)
    .values({
      companyId: ctx.companyId,
      subcontractId: sc.id,
      projectId: sc.projectId,
      direction: sc.direction,
      revisionId: rev.id,
      baseRevisionId: base.id,
      code,
      title: input.title,
      reason: input.reason,
      description: input.description ?? null,
      timeExtensionDays: input.timeExtensionDays ?? 0,
      createdBy: ctx.userId,
    })
    .returning();
  return getVariation(tx, row!.id);
}

export async function updateVariation(tx: Tx, id: string, input: UpdateVariationInput) {
  const vo = await lockVariation(tx, id);
  if (vo.status !== 'draft' && vo.status !== 'rejected')
    throw unprocessable(
      'Yalnızca taslak ya da reddedilmiş değişiklik emri düzenlenir',
      'VARIATION_NOT_EDITABLE',
    );
  if (!vo.revisionId)
    throw unprocessable('Bu değişiklik emrinin revizyonu yok', 'VARIATION_NO_REVISION');
  await tx
    .update(variationOrders)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      ...(input.timeExtensionDays !== undefined
        ? { timeExtensionDays: input.timeExtensionDays }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(variationOrders.id, id));
  if (input.title !== undefined)
    await tx
      .update(subcontractRevisions)
      .set({ title: input.title })
      .where(eq(subcontractRevisions.id, vo.revisionId));
  return getVariation(tx, id);
}

/** Onaya gönderir: tutar farkı ve kümülatif kontrolü; onay tutarı farkın mutlak değeri (defter para birimi). */
export async function submitVariation(tx: Tx, approvalCtx: ApprovalCtx, id: string) {
  const vo = await lockVariation(tx, id);
  if (vo.status !== 'draft' && vo.status !== 'rejected')
    throw unprocessable(
      'Yalnızca taslak ya da reddedilmiş değişiklik emri gönderilir',
      'VARIATION_NOT_EDITABLE',
    );
  if (!vo.revisionId)
    throw unprocessable('Bu değişiklik emrinin revizyonu yok', 'VARIATION_NO_REVISION');
  const sc = await lockContract(tx, vo.subcontractId);
  if (sc.status !== 'active')
    throw unprocessable('Sözleşme yürürlükte değil', 'SUBCONTRACT_NOT_ACTIVE');
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(subcontractBoqLines)
    .where(eq(subcontractBoqLines.revisionId, vo.revisionId));
  if (!count?.n) throw unprocessable('Boş BOQ ile değişiklik emri gönderilemez', 'REVISION_EMPTY');
  await assertAboveCertified(tx, sc.id, vo.revisionId);

  const current = await currentRevision(tx, sc.id);
  const before = current ? await revisionTotal(tx, current.id) : dec(0);
  const after = await revisionTotal(tx, vo.revisionId);
  const delta = after.minus(before);
  if (delta.isZero() && vo.timeExtensionDays === 0) {
    const changed = await tx.execute(sql`
      select 1 from subcontract_boq_lines n full join (select * from subcontract_boq_lines where revision_id = ${current?.id ?? null}) o on o.line_key = n.line_key and n.revision_id = ${vo.revisionId}
       where (n.revision_id = ${vo.revisionId} or n.id is null)
         and (n.id is null or o.id is null or n.quantity <> o.quantity or n.unit_price <> o.unit_price or n.description <> o.description or n.wbs_id <> o.wbs_id)
       limit 1`);
    if (changed.rows.length === 0)
      throw unprocessable(
        'Değişiklik emrinde değişiklik yok (BOQ ve süre aynı)',
        'VARIATION_EMPTY',
      );
  }
  const [company] = await tx.select({ base: companies.baseCurrency }).from(companies).where(sql`${companies.id} = app_company_id()`);
  const fx =
    sc.currencyCode === company!.base
      ? dec(1)
      : await requireRate(tx, sc.currencyCode, company!.base, todayIso(), company!.base);

  await tx
    .update(variationOrders)
    .set({
      status: 'submitted',
      submittedAt: new Date(),
      submittedBy: approvalCtx.userId,
      rejectionNote: null,
      amountBefore: before.toFixed(4),
      amountAfter: after.toFixed(4),
      amountDelta: delta.toFixed(4),
      updatedAt: new Date(),
    })
    .where(eq(variationOrders.id, id));
  await requestApproval(tx, approvalCtx, {
    docType: 'variation_order',
    docId: id,
    projectId: vo.projectId,
    amount: delta.abs().times(fx).toFixed(2),
  });
  return getVariation(tx, id);
}

/** Uygular: revizyon yürürlüğe girer, eskisi devre dışı kalır, bitiş tarihi uzar; tutarlar kesinleşir. */
async function applyVariation(tx: Tx, userId: string, vo: VariationRow) {
  const sc = await lockContract(tx, vo.subcontractId);
  if (sc.status !== 'active')
    throw unprocessable('Sözleşme yürürlükte değil', 'SUBCONTRACT_NOT_ACTIVE');
  if (!vo.revisionId)
    throw unprocessable('Bu değişiklik emrinin revizyonu yok', 'VARIATION_NO_REVISION');
  await assertAboveCertified(tx, sc.id, vo.revisionId);
  const current = await currentRevision(tx, sc.id);
  const before = current ? await revisionTotal(tx, current.id) : dec(0);
  const after = await revisionTotal(tx, vo.revisionId);
  const [rev] = await tx
    .select()
    .from(subcontractRevisions)
    .where(eq(subcontractRevisions.id, vo.revisionId));
  await tx
    .update(subcontractRevisions)
    .set({ status: 'approved', approvedAt: new Date(), approvedBy: userId })
    .where(eq(subcontractRevisions.id, vo.revisionId));
  await tx
    .update(subcontractRevisions)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(subcontractRevisions.subcontractId, sc.id),
        eq(subcontractRevisions.status, 'approved'),
        sql`${subcontractRevisions.revisionNo} < ${rev!.revisionNo}`,
      ),
    );
  const newEnd =
    vo.timeExtensionDays > 0 && sc.endDate ? addDays(sc.endDate, vo.timeExtensionDays) : sc.endDate;
  if (newEnd !== sc.endDate)
    await tx
      .update(subcontracts)
      .set({ endDate: newEnd, updatedAt: new Date() })
      .where(eq(subcontracts.id, sc.id));
  await tx
    .update(variationOrders)
    .set({
      status: 'applied',
      appliedAt: new Date(),
      amountBefore: before.toFixed(4),
      amountAfter: after.toFixed(4),
      amountDelta: after.minus(before).toFixed(4),
      previousEndDate: sc.endDate,
      newEndDate: newEnd,
      updatedAt: new Date(),
    })
    .where(eq(variationOrders.id, vo.id));
}

registerApprovalHandler('variation_order', {
  async onResolved(
    tx: Tx,
    ctx: ApprovalCtx,
    request: ApprovalRequestWithSteps,
    outcome: 'approved' | 'rejected',
  ) {
    const vo = await lockVariation(tx, request.docId);
    if (outcome === 'rejected') {
      const note = [...request.steps].reverse().find((s) => s.status === 'rejected')?.note ?? null;
      await tx
        .update(variationOrders)
        .set({ status: 'rejected', rejectionNote: note, updatedAt: new Date() })
        .where(eq(variationOrders.id, vo.id));
      return;
    }
    // İşveren sözleşmesinde iç onaydan sonra işverenin kabulü beklenir; taşeronda hemen uygulanır
    if (vo.direction === 'receivable') {
      await tx
        .update(variationOrders)
        .set({ status: 'awaiting_client', approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(variationOrders.id, vo.id));
      return;
    }
    await tx
      .update(variationOrders)
      .set({ approvedAt: new Date() })
      .where(eq(variationOrders.id, vo.id));
    await applyVariation(tx, ctx.userId, { ...vo, approvedAt: new Date() });
  },
});

export async function acceptByClient(
  tx: Tx,
  ctx: SubcontractCtx,
  id: string,
  input: ClientAcceptVariationInput,
) {
  const vo = await lockVariation(tx, id);
  if (vo.status !== 'awaiting_client')
    throw unprocessable(
      'İşveren kabulü yalnızca iç onayı tamamlanmış işveren değişiklik emrine girilir',
      'VARIATION_NOT_AWAITING_CLIENT',
    );
  await tx
    .update(variationOrders)
    .set({
      clientAcceptedAt: input.acceptedAt,
      clientReference: input.reference,
      updatedAt: new Date(),
    })
    .where(eq(variationOrders.id, id));
  await applyVariation(tx, ctx.userId, {
    ...vo,
    clientAcceptedAt: input.acceptedAt,
    clientReference: input.reference,
  });
  return getVariation(tx, id);
}

/** İşveren reddi ya da iptal: taslak revizyon silinir (sözleşme aynen kalır). */
async function closeVariation(
  tx: Tx,
  vo: VariationRow,
  status: 'rejected' | 'cancelled',
  note: string | null,
) {
  await tx
    .update(variationOrders)
    .set({ status, ...(note ? { rejectionNote: note } : {}), updatedAt: new Date() })
    .where(eq(variationOrders.id, vo.id));
  if (vo.revisionId)
    await tx
      .delete(subcontractRevisions)
      .where(
        and(eq(subcontractRevisions.id, vo.revisionId), eq(subcontractRevisions.status, 'draft')),
      );
}

export async function rejectByClient(tx: Tx, id: string, note: string) {
  const vo = await lockVariation(tx, id);
  if (vo.status !== 'awaiting_client')
    throw unprocessable(
      'İşveren reddi yalnızca işveren kabulü bekleyen değişiklik emrine girilir',
      'VARIATION_NOT_AWAITING_CLIENT',
    );
  await closeVariation(tx, vo, 'rejected', `İşveren reddi: ${note}`);
  return getVariation(tx, id);
}

export async function cancelVariation(tx: Tx, approvalCtx: ApprovalCtx, id: string) {
  const vo = await lockVariation(tx, id);
  if (vo.status === 'applied' || vo.status === 'cancelled')
    throw unprocessable(
      'Uygulanmış ya da iptal edilmiş değişiklik emri iptal edilemez',
      'VARIATION_NOT_CANCELLABLE',
    );
  if (vo.status === 'submitted') {
    const pending = (await requestsForDoc(tx, 'variation_order', id)).find(
      (r) => r.status === 'pending',
    );
    if (pending) await cancelRequest(tx, approvalCtx, pending.id);
  }
  await closeVariation(tx, await lockVariation(tx, id), 'cancelled', null);
  return getVariation(tx, id);
}

// --- Okuma ----------------------------------------------------------------------------------------------------

export async function getVariation(tx: Tx, id: string) {
  const head = await tx.execute<Record<string, unknown>>(sql`
    select v.id, v.code, v.title, v.reason, v.description, v.status, v.direction, v.subcontract_id as "subcontractId", v.project_id as "projectId",
           v.revision_id as "revisionId", v.base_revision_id as "baseRevisionId", v.time_extension_days as "timeExtensionDays",
           v.previous_end_date::text as "previousEndDate", v.new_end_date::text as "newEndDate",
           v.amount_before::text as "amountBefore", v.amount_after::text as "amountAfter", v.amount_delta::text as "amountDelta",
           v.submitted_at as "submittedAt", v.approved_at as "approvedAt", v.client_accepted_at::text as "clientAcceptedAt",
           v.client_reference as "clientReference", v.applied_at as "appliedAt", v.rejection_note as "rejectionNote", v.created_at as "createdAt",
           s.code as "subcontractCode", s.title as "subcontractTitle", s.currency_code as "currencyCode", s.end_date::text as "contractEndDate",
           s.status as "subcontractStatus", pa.name as "partyName", p.code as "projectCode", p.name as "projectName",
           r.revision_no as "revisionNo", br.revision_no as "baseRevisionNo"
      from variation_orders v
      join subcontracts s on s.id = v.subcontract_id
      join parties pa on pa.id = s.party_id
      join projects p on p.id = v.project_id
      left join subcontract_revisions r on r.id = v.revision_id
      join subcontract_revisions br on br.id = v.base_revision_id
     where v.id = ${id}`);
  const vo = head.rows[0];
  if (!vo) throw notFound('Değişiklik emri');
  // Karşılaştırma: dayanak revizyon (uygulanmışsa onun yerine geçtiği) ile DE revizyonu, line_key üzerinden
  const lines = vo.revisionId
    ? (
        await tx.execute<Record<string, unknown>>(sql`
      select coalesce(n.line_key, o.line_key) as "lineKey", coalesce(n.line_no, 10000 + o.line_no) as "lineNo",
             coalesce(n.item_no, o.item_no) as "itemNo", coalesce(n.description, o.description) as description, coalesce(n.unit, o.unit) as unit,
             o.quantity::text as "oldQty", o.unit_price::text as "oldPrice", round(o.quantity * o.unit_price, 2)::text as "oldAmount",
             n.quantity::text as "newQty", n.unit_price::text as "newPrice", round(n.quantity * n.unit_price, 2)::text as "newAmount",
             (coalesce(round(n.quantity * n.unit_price, 2), 0) - coalesce(round(o.quantity * o.unit_price, 2), 0))::text as delta,
             case when o.id is null then 'added' when n.id is null then 'removed'
                  when n.quantity <> o.quantity or n.unit_price <> o.unit_price or n.description <> o.description or n.wbs_id <> o.wbs_id then 'changed'
                  else 'same' end as change
        from (select * from subcontract_boq_lines where revision_id = ${vo.revisionId}) n
        full join (select * from subcontract_boq_lines where revision_id = ${vo.baseRevisionId}) o on o.line_key = n.line_key
       order by 2`)
      ).rows
    : [];
  const before = lines.reduce((s, l) => s.plus(String(l.oldAmount ?? 0)), dec(0));
  const after = lines.reduce((s, l) => s.plus(String(l.newAmount ?? 0)), dec(0));
  const approvals = await requestsForDoc(tx, 'variation_order', id);
  const variation: Record<string, unknown> = {
    ...vo,
    // Gönderilmemiş DE'de anlık hesap; gönderilmiş/uygulanmışta kesinleşmiş tutarlar
    amountBefore: vo.amountBefore ?? before.toFixed(2),
    amountAfter: vo.amountAfter ?? after.toFixed(2),
    amountDelta: vo.amountDelta ?? after.minus(before).toFixed(2),
    projectedEndDate:
      vo.contractEndDate && Number(vo.timeExtensionDays) > 0 && vo.status !== 'applied'
        ? addDays(String(vo.contractEndDate), Number(vo.timeExtensionDays))
        : null,
  };
  return {
    variation,
    lines,
    approvals,
  };
}

export async function listVariations(
  tx: Tx,
  q: { subcontractId?: string; projectId?: string; direction?: string; status?: string },
) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select v.id, v.code, v.title, v.reason, v.status, v.direction, v.subcontract_id as "subcontractId", s.code as "subcontractCode",
           s.currency_code as "currencyCode", pa.name as "partyName", v.project_id as "projectId", p.code as "projectCode",
           v.time_extension_days as "timeExtensionDays", v.amount_delta::text as "amountDelta", v.created_at as "createdAt",
           v.applied_at as "appliedAt", v.client_reference as "clientReference"
      from variation_orders v
      join subcontracts s on s.id = v.subcontract_id
      join parties pa on pa.id = s.party_id
      join projects p on p.id = v.project_id
     where (${q.subcontractId ?? null}::uuid is null or v.subcontract_id = ${q.subcontractId ?? null}::uuid)
       and (${q.projectId ?? null}::uuid is null or v.project_id = ${q.projectId ?? null}::uuid)
       and (${q.direction ?? null}::text is null or v.direction = ${q.direction ?? null}::text)
       and (${q.status ?? null}::text is null or v.status = ${q.status ?? null}::text)
     order by v.created_at desc`);
  return { variations: rows.rows };
}

export async function variationOfRevision(tx: Tx, revisionId: string) {
  const [row] = await tx
    .select({ id: variationOrders.id, code: variationOrders.code })
    .from(variationOrders)
    .where(eq(variationOrders.revisionId, revisionId))
    .orderBy(desc(variationOrders.createdAt));
  return row ?? null;
}
