import { eq, sql } from 'drizzle-orm';
import {
  applyRate,
  createExpenseEntrySchema,
  createTreasuryTransactionSchema,
  dec,
  roundMoney,
  toDbRate,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { expenseCards, treasuryAccounts } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { resolveVat } from '../invoices/service';
import { requireRate } from '../settings/rates';
import { documentHash } from './document-hash';

export interface FinancialSnapshot {
  payload: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  hash: string;
  amount: string;
  currency: string;
  documentDate: string;
  projectId: string | null;
}
export interface FinancialContext {
  companyId: string;
  baseCurrency: string;
  branchId?: string | null;
}
export async function contextBranchId(tx: Tx) {
  const r = await tx.execute<{ branchId: string | null }>(
    sql`select nullif(current_setting('app.branch_id',true),'') as "branchId"`,
  );
  return r.rows[0]?.branchId ?? null;
}

export async function paymentSnapshot(
  tx: Tx,
  ctx: FinancialContext,
  value: unknown,
): Promise<FinancialSnapshot> {
  const input = createTreasuryTransactionSchema.parse(value);
  if (dec(input.amount).decimalPlaces() > 2)
    throw unprocessable('Tutar en çok 2 ondalık basamak içerebilir', 'AMOUNT_PRECISION');
  if (input.type !== 'payment' && input.type !== 'other_payment')
    throw unprocessable('Onay taslağı için ödeme türü seçin', 'APPROVAL_PAYMENT_TYPE');
  const [account] = await tx
    .select()
    .from(treasuryAccounts)
    .where(eq(treasuryAccounts.id, input.accountId));
  if (!account) throw notFound('Kasa/banka hesabı');
  const rate =
    account.currencyCode === ctx.baseCurrency
      ? dec(1)
      : input.fxRate
        ? dec(input.fxRate)
        : await requireRate(
            tx,
            account.currencyCode,
            ctx.baseCurrency,
            input.date,
            ctx.baseCurrency,
          );
  const payload = {
    ...input,
    amount: dec(input.amount).toFixed(2),
    ...(account.currencyCode === ctx.baseCurrency ? {} : { fxRate: toDbRate(rate) }),
  };
  if (rate.lte(0)) throw unprocessable('Kur sıfırdan büyük olmalı', 'FX_RATE_INVALID');
  const amount = applyRate(input.amount, rate).toFixed(2);
  const snapshot = {
    version: 'financial-approval-v1',
    companyId: ctx.companyId,
    branchId: ctx.branchId ?? (await contextBranchId(tx)),
    type: 'payment',
    input: payload,
    accountCurrency: account.currencyCode,
    accountLedgerId: account.accountId,
    baseCurrency: ctx.baseCurrency,
    effectiveRate: toDbRate(rate),
    amountBase: amount,
  };
  return {
    payload,
    snapshot,
    hash: documentHash(snapshot),
    amount,
    currency: account.currencyCode,
    documentDate: input.date,
    projectId: input.projectId ?? null,
  };
}

export async function expenseSnapshot(
  tx: Tx,
  ctx: FinancialContext,
  value: unknown,
): Promise<FinancialSnapshot> {
  const input = createExpenseEntrySchema.parse(value);
  if (dec(input.net).decimalPlaces() > 2)
    throw unprocessable('Tutar en çok 2 ondalık basamak içerebilir', 'AMOUNT_PRECISION');
  const [card] = await tx.select().from(expenseCards).where(eq(expenseCards.id, input.cardId));
  if (!card) throw notFound('Gider kartı');
  const taxCode = input.taxCode === undefined ? card.taxCode : input.taxCode || null;
  const rate = taxCode ? (await resolveVat(tx, [taxCode], input.entryDate)).get(taxCode) : '0';
  if (rate === undefined)
    throw unprocessable('Gider tarihinde geçerli KDV oranı yok', 'EXPENSE_TAX_RATE_MISSING');
  const withholdingRate = dec(
    input.withholdingRate === undefined
      ? (card.withholdingRate ?? 0)
      : (input.withholdingRate ?? 0),
  );
  const dimensions =
    input.projectId !== undefined
      ? {
          projectId: input.projectId ?? null,
          wbsId: input.wbsId ?? null,
          costCodeId: input.costCodeId ?? null,
        }
      : { projectId: card.projectId, wbsId: card.wbsId, costCodeId: card.costCodeId };
  const payload = {
    ...input,
    ...dimensions,
    net: dec(input.net).toFixed(2),
    taxCode,
    withholdingRate: withholdingRate.toFixed(4),
  };
  const vat = roundMoney(dec(input.net).times(rate).div(100));
  const withholding = roundMoney(dec(input.net).times(withholdingRate).div(100));
  const amount = dec(input.net).plus(vat).toFixed(2);
  const snapshot = {
    version: 'financial-approval-v1',
    companyId: ctx.companyId,
    branchId: ctx.branchId ?? (await contextBranchId(tx)),
    type: 'expense',
    input: payload,
    ledgerAccountId: card.accountId,
    vatRate: dec(rate).toFixed(4),
    gross: amount,
    withholding: withholding.toFixed(2),
    payable: dec(amount).minus(withholding).toFixed(2),
    baseCurrency: ctx.baseCurrency,
  };
  return {
    payload,
    snapshot,
    hash: documentHash(snapshot),
    amount,
    currency: ctx.baseCurrency,
    documentDate: input.entryDate,
    projectId: dimensions.projectId,
  };
}

export const financialSnapshot = (
  tx: Tx,
  ctx: FinancialContext,
  type: 'payment' | 'expense',
  value: unknown,
) => (type === 'payment' ? paymentSnapshot(tx, ctx, value) : expenseSnapshot(tx, ctx, value));
