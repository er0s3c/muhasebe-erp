import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { applyRate, dec, toDbRate, type InvoiceType, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import {
  approvalRules,
  invoiceLines,
  invoices,
  parties,
  salesOrderLines,
  salesOrders,
} from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import {
  prepareLines,
  type InvoiceCtx,
  type LineSource,
  type PreparedLine,
} from '../invoices/service';
import { lookupRate, requireRate } from '../settings/rates';
import { documentHash } from './document-hash';

export async function invoiceApprovalSnapshot(
  tx: Tx,
  ctx: Pick<InvoiceCtx, 'companyId' | 'baseCurrency'>,
  inv: typeof invoices.$inferSelect,
  stored: (typeof invoiceLines.$inferSelect)[],
  prepared: PreparedLine[],
  fx: MoneyValue,
) {
  const [party] = await tx
    .select({
      id: parties.id,
      name: parties.name,
      taxNumber: parties.taxNumber,
      taxOffice: parties.taxOffice,
      taxStatus: parties.taxStatus,
      address: parties.address,
      paymentTermDays: parties.paymentTermDays,
    })
    .from(parties)
    .where(eq(parties.id, inv.partyId));
  const amount = applyRate(
    prepared.reduce((sum, line) => sum.plus(line.gross), dec(0)),
    fx,
  ).toFixed(2);
  const projectIds = [
    ...new Set(stored.map((line) => line.projectId).filter((id): id is string => !!id)),
  ];
  if (projectIds.length > 1) {
    const [specific] = await tx
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.docType, 'invoice'),
          eq(approvalRules.isActive, true),
          inArray(approvalRules.projectId, projectIds),
          sql`${approvalRules.minAmount} <= ${amount}::numeric`,
          or(isNull(approvalRules.maxAmount), sql`${approvalRules.maxAmount} > ${amount}::numeric`),
        ),
      )
      .limit(1);
    if (specific)
      throw unprocessable(
        'Belgede birden çok proje ve projeye özel onay kuralı var. Projelerin faturalarını ayırarak onaya gönderin.',
        'APPROVAL_MULTIPLE_PROJECTS',
      );
  }
  const projectId = projectIds.length === 1 ? projectIds[0]! : null;
  const returnContext = inv.returnOfId
    ? (
        await tx.execute<Record<string, unknown>>(sql`select i.id,i.fx_rate,i.tax_totals_snapshot,
    (select jsonb_agg(to_jsonb(l) order by l.line_no) from invoice_lines l where l.invoice_id=i.id) as lines
    from invoices i where i.id=${inv.returnOfId} or (i.return_of_id=${inv.returnOfId} and i.status='posted') order by i.id`)
      ).rows
    : [];
  const serials = (
    await tx.execute<Record<string, unknown>>(
      sql`select invoice_line_id,serial_no from document_line_serials where invoice_line_id in (select id from invoice_lines where invoice_id=${inv.id}) order by invoice_line_id,serial_no`,
    )
  ).rows;
  const snapshot = {
    version: 'invoice-approval-v1',
    companyId: ctx.companyId,
    branchId: inv.branchId,
    id: inv.id,
    type: inv.type,
    partyId: inv.partyId,
    party,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    externalNo: inv.externalNo,
    currencyCode: inv.currencyCode,
    baseCurrency: ctx.baseCurrency,
    effectiveRate: toDbRate(fx),
    fxRateType: inv.fxRateType,
    fxReason: inv.fxReason,
    vatIncluded: inv.vatIncluded,
    warehouseId: inv.warehouseId,
    returnOfId: inv.returnOfId,
    description: inv.description,
    matchOverrideReason: inv.matchOverrideReason,
    lines: stored.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      itemId: l.itemId,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      vatCode: l.vatCode,
      taxRuleId: l.taxRuleId,
      productClass: l.productClass,
      transactionType: l.transactionType,
      accountId: l.accountId,
      sourceLineId: l.sourceLineId,
      deliveryLineId: l.deliveryLineId,
      poLineId: l.poLineId,
      salesOrderLineId: l.salesOrderLineId,
      projectId: l.projectId,
      wbsId: l.wbsId,
    })),
    effectiveTaxes: prepared.map((l) => ({
      vatRate: l.vatRate,
      taxRuleSnapshot: l.taxRuleSnapshot,
      taxCalculation: l.taxCalculation,
      net: l.net.toFixed(2),
      vat: l.vat.toFixed(2),
      gross: l.gross.toFixed(2),
    })),
    serials,
    returnContext,
  };
  return {
    snapshot,
    hash: documentHash(snapshot),
    amount,
    projectId,
    branchId: inv.branchId,
  };
}

export async function captureInvoice(
  tx: Tx,
  ctx: Pick<InvoiceCtx, 'companyId' | 'baseCurrency'>,
  id: string,
) {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
  if (!inv) throw notFound('Fatura');
  if (inv.status !== 'draft')
    throw unprocessable('Yalnızca taslak fatura onaya gönderilebilir', 'INVOICE_NOT_DRAFT');
  const stored = await tx
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(asc(invoiceLines.lineNo));
  const sources: LineSource[] = stored.map((l) => ({
    ...l,
    unit: l.unit as LineSource['unit'],
    transactionType: l.transactionType as LineSource['transactionType'],
    orderLineId: l.poLineId,
  }));
  const { lines } = await prepareLines(
    tx,
    inv.type as InvoiceType,
    inv.invoiceDate,
    sources,
    inv.vatIncluded,
    ctx.companyId,
    inv.partyId,
  );
  const [original] = inv.returnOfId
    ? await tx.select().from(invoices).where(eq(invoices.id, inv.returnOfId)).for('update')
    : [];
  const lookup = await lookupRate(
    tx,
    inv.currencyCode,
    ctx.baseCurrency,
    inv.invoiceDate,
    ctx.baseCurrency,
    inv.fxRateType ? { rateType: inv.fxRateType } : { legacyInverse: true },
  );
  const rate =
    original?.fxSnapshot && original.currencyCode === inv.currencyCode
      ? original.fxRate
      : inv.currencyCode === ctx.baseCurrency
        ? '1'
        : (inv.fxRate ?? lookup.rate);
  if (!rate) throw unprocessable('Belge tarihinde kur bulunamadı', 'FX_RATE_MISSING');
  return invoiceApprovalSnapshot(tx, ctx, inv, stored, lines, dec(rate));
}

export async function captureQuote(
  tx: Tx,
  ctx: { companyId: string; baseCurrency: string },
  id: string,
) {
  const [doc] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for('update');
  if (!doc) throw notFound('Satış teklifi');
  if (doc.kind !== 'quote')
    throw unprocessable('Yalnızca satış teklifi onaya gönderilir', 'SO_NOT_QUOTE');
  const lines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.orderId, id))
    .orderBy(asc(salesOrderLines.lineNo));
  const fx =
    doc.currencyCode === ctx.baseCurrency
      ? dec(1)
      : await requireRate(tx, doc.currencyCode, ctx.baseCurrency, doc.docDate, ctx.baseCurrency);
  const branchId = doc.branchId;
  const snapshot = {
    version: 'quote-approval-v1',
    companyId: ctx.companyId,
    branchId,
    projectId: null,
    id: doc.id,
    partyId: doc.partyId,
    docDate: doc.docDate,
    validUntil: doc.validUntil,
    currencyCode: doc.currencyCode,
    vatIncluded: doc.vatIncluded,
    warehouseId: doc.warehouseId,
    notes: doc.notes,
    effectiveRate: toDbRate(fx),
    lines,
  };
  return {
    snapshot,
    hash: documentHash(snapshot),
    amount: applyRate(doc.grossTotal, fx).toFixed(2),
    branchId,
    projectId: null,
    status: doc.status,
  };
}
