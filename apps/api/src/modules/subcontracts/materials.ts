import { eq, sql } from 'drizzle-orm';
import { roundMoney, toDbAmount, type GiveMaterialInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { subcontractMaterialIssues, subcontracts } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { postStockDocument, type StockCtx } from '../inventory/documents';
import { requireRate } from '../settings/rates';
import { getBalances } from './progress';

/**
 * Taşerona malzeme verme: sözleşmenin projesine ve iş kalemine etiketli stok sarfı (`issue`) belgesi açılır
 * (stok çıkar; Dr malzeme gideri / Cr stok). Bedel, stok çıkış maliyetidir (defter para birimi) ve sözleşme para birimine
 * verildiği günkü kurla çevrilir. Bakiye, sonraki hakedişlerde `material` ile mahsup edilir; mahsup maliyet satırlarını azaltır
 * (çift sayım olmaz). Yalnızca taşeron (verilen) sözleşmesi, yürürlükte.
 */
export async function giveMaterial(tx: Tx, ctx: StockCtx, subcontractId: string, input: GiveMaterialInput) {
  const [sc] = await tx.select().from(subcontracts).where(eq(subcontracts.id, subcontractId)).for('update');
  if (!sc) throw notFound('Taşeron sözleşmesi');
  if (sc.direction !== 'payable') throw unprocessable('Malzeme yalnızca taşeron sözleşmesine verilir', 'MATERIAL_NOT_ALLOWED');
  if (sc.status !== 'active') throw unprocessable('Malzeme yalnızca yürürlükteki sözleşmeye verilir', 'SUBCONTRACT_NOT_ACTIVE');

  const posted = await postStockDocument(tx, ctx, {
    type: 'issue',
    docDate: input.date,
    warehouseId: input.warehouseId,
    description: `Taşerona malzeme — ${sc.code}${input.note ? `: ${input.note}` : ''}`.slice(0, 200),
    lines: input.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, projectId: sc.projectId, wbsId: l.wbsId })),
  });
  const docId = posted.document.id as string;

  const [out] = await tx.execute<{ value: string }>(sql`select abs(coalesce(sum(value), 0))::text as value from stock_movements where document_id = ${docId}`).then((r) => r.rows);
  const amountBase = roundMoney(out?.value ?? '0');
  if (amountBase.lte(0)) {
    throw unprocessable('Verilen malzemenin stok maliyeti sıfır; mahsup edilecek bedel oluşmaz (kartlara maliyet girin)', 'MATERIAL_ZERO_COST');
  }
  const foreign = sc.currencyCode !== ctx.baseCurrency;
  const amount = foreign ? roundMoney(amountBase.div(await requireRate(tx, sc.currencyCode, ctx.baseCurrency, input.date, ctx.baseCurrency))) : amountBase;
  if (amount.lte(0)) throw unprocessable('Verilen malzemenin bedeli sözleşme para biriminde sıfıra yuvarlandı', 'MATERIAL_ZERO_COST');

  await tx.insert(subcontractMaterialIssues).values({
    companyId: ctx.companyId,
    subcontractId: sc.id,
    issueDate: input.date,
    stockDocumentId: docId,
    amount: toDbAmount(amount),
    amountBase: toDbAmount(amountBase),
    note: input.note ?? null,
    createdBy: ctx.userId,
  });
  return { document: posted.document, balances: await getBalances(tx, sc.id) };
}

export async function listMaterialIssues(tx: Tx, subcontractId: string) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select i.id, i.issue_date::text as "issueDate", i.amount::text as amount, i.amount_base::text as "amountBase", i.note,
           i.stock_document_id as "stockDocumentId", d.doc_no as "docNo", d.description
      from subcontract_material_issues i join stock_documents d on d.id = i.stock_document_id
     where i.subcontract_id = ${subcontractId}
     order by i.issue_date desc, i.created_at desc`);
  return { issues: rows.rows, balances: await getBalances(tx, subcontractId) };
}
