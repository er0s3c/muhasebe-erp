import { and, eq, inArray, sql } from 'drizzle-orm';
import { dec, roundMoney, todayIso, toDbAmount, type CreateRfqInput, type UpsertOfferInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies, parties, purchaseRequestLines, purchaseRequests, rfqOfferLines, rfqOffers, rfqs } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { nextNumber } from '../settings/numbering';
import { findRate } from '../settings/rates';
import { createOrder } from './orders';
import type { ProcurementCtx } from './requests';
import { pageSql, paged, type PageQuery } from '../../http/paging';

export const formatRfqCode = (n: number) => `RFQ-${String(n).padStart(4, '0')}`;

async function lockRfq(tx: Tx, id: string) {
  const [row] = await tx.select().from(rfqs).where(eq(rfqs.id, id)).for('update');
  if (!row) throw notFound('RFQ');
  return row;
}

export async function createRfq(tx: Tx, ctx: ProcurementCtx, input: CreateRfqInput) {
  const [req] = await tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, input.requestId));
  if (!req) throw notFound('Satın alma talebi');
  if (req.status !== 'approved') throw unprocessable('RFQ yalnızca onaylı talepten açılır', 'REQUEST_NOT_APPROVED');
  const [dup] = await tx.select({ code: rfqs.code }).from(rfqs).where(and(eq(rfqs.requestId, req.id), sql`${rfqs.status} <> 'cancelled'`));
  if (dup) throw unprocessable(`Talep için zaten bir RFQ var (${dup.code})`, 'RFQ_EXISTS');
  const code = formatRfqCode(await nextNumber(tx, ctx.companyId, 'RFQ', 0));
  const [row] = await tx.insert(rfqs).values({ companyId: ctx.companyId, code, requestId: req.id, dueDate: input.dueDate ?? null, note: input.note ?? null, createdBy: ctx.userId }).returning();
  return getRfq(tx, row!.id);
}

export async function upsertOffer(tx: Tx, ctx: ProcurementCtx, rfqId: string, input: UpsertOfferInput) {
  const q = await lockRfq(tx, rfqId);
  if (q.status !== 'open') throw unprocessable("Yalnızca açık RFQ'ya teklif girilir", 'RFQ_NOT_OPEN');
  const reqLines = await tx.select({ id: purchaseRequestLines.id }).from(purchaseRequestLines).where(eq(purchaseRequestLines.requestId, q.requestId));
  const valid = new Set(reqLines.map((l) => l.id));
  if (input.lines.some((l) => !valid.has(l.requestLineId))) throw unprocessable('Teklif satırı talebe ait değil', 'OFFER_LINE_UNKNOWN');
  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw unprocessable('Tedarikçi bulunamadı', 'PARTY_NOT_FOUND');
  if (party.kind === 'customer') throw unprocessable('Teklif veren cari tedarikçi türünde olmalı', 'PARTY_KIND_MISMATCH');

  const [existing] = await tx.select().from(rfqOffers).where(and(eq(rfqOffers.rfqId, rfqId), eq(rfqOffers.partyId, input.partyId)));
  let offerId: string;
  if (existing) {
    offerId = existing.id;
    await tx.update(rfqOffers).set({ currencyCode: input.currencyCode, deliveryDays: input.deliveryDays ?? null, paymentDays: input.paymentDays, note: input.note ?? null }).where(eq(rfqOffers.id, offerId));
    await tx.delete(rfqOfferLines).where(eq(rfqOfferLines.offerId, offerId));
  } else {
    const [row] = await tx
      .insert(rfqOffers)
      .values({ companyId: ctx.companyId, rfqId, partyId: input.partyId, currencyCode: input.currencyCode, deliveryDays: input.deliveryDays ?? null, paymentDays: input.paymentDays, note: input.note ?? null })
      .returning();
    offerId = row!.id;
  }
  await tx.insert(rfqOfferLines).values(input.lines.map((l) => ({ companyId: ctx.companyId, offerId, requestLineId: l.requestLineId, unitPrice: toDbAmount(dec(l.unitPrice)) })));
  return getRfq(tx, rfqId);
}

export async function deleteOffer(tx: Tx, rfqId: string, offerId: string) {
  const q = await lockRfq(tx, rfqId);
  if (q.status !== 'open') throw unprocessable("Yalnızca açık RFQ'nun teklifi silinir", 'RFQ_NOT_OPEN');
  const rows = await tx.delete(rfqOffers).where(and(eq(rfqOffers.id, offerId), eq(rfqOffers.rfqId, rfqId))).returning({ id: rfqOffers.id });
  if (rows.length === 0) throw notFound('Teklif');
  return getRfq(tx, rfqId);
}

/** Kazanan teklifle sipariş taslağı açar (tam teklif: tüm talep satırları fiyatlı olmalı). */
export async function awardRfq(tx: Tx, ctx: ProcurementCtx, rfqId: string, offerId: string) {
  const q = await lockRfq(tx, rfqId);
  if (q.status !== 'open') throw unprocessable('RFQ zaten sonuçlanmış', 'RFQ_NOT_OPEN');
  const [offer] = await tx.select().from(rfqOffers).where(and(eq(rfqOffers.id, offerId), eq(rfqOffers.rfqId, rfqId)));
  if (!offer) throw notFound('Teklif');
  const [req] = await tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, q.requestId));
  const reqLines = await tx.select().from(purchaseRequestLines).where(eq(purchaseRequestLines.requestId, q.requestId));
  const prices = new Map((await tx.select().from(rfqOfferLines).where(eq(rfqOfferLines.offerId, offerId))).map((l) => [l.requestLineId, l.unitPrice]));
  const missing = reqLines.filter((l) => !prices.has(l.id));
  if (missing.length > 0) throw unprocessable(`Teklif ${missing.length} talep satırını fiyatlamamış; eksiksiz teklif seçin`, 'OFFER_INCOMPLETE');

  const order = await createOrder(tx, ctx, {
    projectId: req!.projectId,
    requestId: req!.id,
    offerId,
    partyId: offer.partyId,
    currencyCode: offer.currencyCode as 'TRY' | 'GBP' | 'EUR' | 'USD',
    paymentDays: offer.paymentDays,
    note: `RFQ ${q.code} kazanan teklif`,
    lines: reqLines
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({ requestLineId: l.id, itemId: l.itemId, description: l.description, unit: l.unit, quantity: dec(l.quantity).toFixed(4), unitPrice: dec(prices.get(l.id)!).toFixed(4), wbsId: l.wbsId })),
  });
  await tx.update(rfqs).set({ status: 'awarded', awardedOfferId: offerId }).where(eq(rfqs.id, rfqId));
  return { rfq: await getRfq(tx, rfqId), order };
}

export async function cancelRfq(tx: Tx, rfqId: string) {
  const q = await lockRfq(tx, rfqId);
  if (q.status !== 'open') throw unprocessable('Yalnızca açık RFQ iptal edilir', 'RFQ_NOT_OPEN');
  await tx.update(rfqs).set({ status: 'cancelled' }).where(eq(rfqs.id, rfqId));
  return getRfq(tx, rfqId);
}

/**
 * Teklif karşılaştırması: teklif başına eksiksizlik, para birimi cinsinden toplam, defter para birimi karşılığı
 * (bugünkü kayıtlı kur; yoksa null), teslim süresi ve vade. "En ucuz" yalnızca eksiksiz ve kuru bilinen tekliflerden seçilir;
 * karar tek başına fiyata bağlı değildir (teslim ve vade yan yana gösterilir).
 */
export async function getRfq(tx: Tx, id: string) {
  const [rfq] = await tx.select().from(rfqs).where(eq(rfqs.id, id));
  if (!rfq) throw notFound('RFQ');
  const [req] = await tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, rfq.requestId));
  const [project] = await tx.execute<{ code: string; name: string }>(sql`select code, name from projects where id = ${req!.projectId}`).then((r) => r.rows);
  const lines = (await tx.select().from(purchaseRequestLines).where(eq(purchaseRequestLines.requestId, rfq.requestId))).sort((a, b) => a.lineNo - b.lineNo);
  const offers = await tx.select().from(rfqOffers).where(eq(rfqOffers.rfqId, id));
  const offerLines = offers.length ? await tx.select().from(rfqOfferLines).where(inArray(rfqOfferLines.offerId, offers.map((o) => o.id))) : [];
  const partyRows = offers.length ? await tx.select({ id: parties.id, name: parties.name }).from(parties).where(inArray(parties.id, offers.map((o) => o.partyId))) : [];
  const partyName = new Map(partyRows.map((p) => [p.id, p.name]));
  const [company] = await tx.select({ base: companies.baseCurrency }).from(companies).where(sql`${companies.id} = app_company_id()`);
  const base = company!.base;
  const today = todayIso();

  const out = [];
  for (const o of offers) {
    const priced = new Map(offerLines.filter((l) => l.offerId === o.id).map((l) => [l.requestLineId, l.unitPrice]));
    const total = lines.reduce((s, l) => (priced.has(l.id) ? s.plus(roundMoney(dec(l.quantity).times(priced.get(l.id)!))) : s), dec(0));
    const rate = o.currencyCode === base ? dec(1) : await findRate(tx, o.currencyCode, base, today, base);
    out.push({
      id: o.id,
      partyId: o.partyId,
      partyName: partyName.get(o.partyId) ?? '',
      currencyCode: o.currencyCode,
      deliveryDays: o.deliveryDays,
      paymentDays: o.paymentDays,
      note: o.note,
      complete: lines.every((l) => priced.has(l.id)),
      pricedCount: priced.size,
      total: total.toFixed(2),
      totalBase: rate ? roundMoney(total.times(rate)).toFixed(2) : null,
      prices: Object.fromEntries(lines.map((l) => [l.id, priced.get(l.id) ? dec(priced.get(l.id)!).toFixed(4) : null])),
      awarded: rfq.awardedOfferId === o.id,
    });
  }
  const comparable = out.filter((o) => o.complete && o.totalBase !== null);
  const cheapest = comparable.length ? comparable.reduce((a, b) => (dec(a.totalBase!).lte(b.totalBase!) ? a : b)).id : null;
  const fastest = out.filter((o) => o.deliveryDays !== null).sort((a, b) => a.deliveryDays! - b.deliveryDays!)[0]?.id ?? null;
  return {
    rfq: { id: rfq.id, code: rfq.code, status: rfq.status, dueDate: rfq.dueDate, note: rfq.note, requestId: req!.id, requestCode: req!.code, requestTitle: req!.title, projectId: req!.projectId, projectCode: project?.code, awardedOfferId: rfq.awardedOfferId },
    lines: lines.map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, unit: l.unit, quantity: dec(l.quantity).toFixed(4), estUnitPrice: l.estUnitPrice })),
    offers: out,
    cheapestOfferId: cheapest,
    fastestOfferId: fastest,
    baseCurrency: base,
  };
}

export async function listRfqs(tx: Tx, page?: PageQuery) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select q.id, q.code, q.status, q.due_date::text as "dueDate", r.id as "requestId", r.code as "requestCode", r.title, p.code as "projectCode",
           (select count(*)::int from rfq_offers o where o.rfq_id = q.id) as "offerCount", q.created_at as "createdAt"
      from rfqs q join purchase_requests r on r.id = q.request_id left join projects p on p.id = r.project_id
     order by q.code desc ${pageSql(page)}`);
  const pg = paged(rows.rows, page);
  return { rfqs: pg.rows, truncated: pg.truncated };
}
