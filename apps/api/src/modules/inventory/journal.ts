import { dec, toDbAmount, type AccountMappingKey, type CurrencyCode, type MoneyValue, type StockDocType } from '@erp/shared';
import type { Tx } from '../../db/client';
import { createJournalEntry, type AutoJournalLine, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import type { StockCtx } from './documents';
import type { DraftRow } from './planner';

export const STOCK_DOC_LABEL: Record<StockDocType, string> = {
  opening: 'Stok devri',
  receipt: 'Stok girişi',
  issue: 'Stok sarfı',
  waste: 'Stok fire',
  transfer: 'Stok transferi',
  count: 'Sayım farkı',
};

export const ledgerCtxOf = (ctx: StockCtx): LedgerCtx => ({
  companyId: ctx.companyId,
  userId: ctx.userId,
  baseCurrency: ctx.baseCurrency,
  reportingCurrency: ctx.reportingCurrency,
});

/**
 * Belge türüne göre stok hesabının karşı hesabı. Giriş yönlü ve çıkış yönlü satırlar ayrı eşlenir;
 * böylece bir sayımdaki fazla (gelir) ve eksik (zarar) aynı fişte doğru hesaba gider, ters belgeler
 * de aynı kuralla kendiliğinden ters yönde çalışır. Transferde stok hesabı değişmez, fiş yoktur.
 */
const OFFSET: Record<Exclude<StockDocType, 'transfer'>, { in: AccountMappingKey; out: AccountMappingKey }> = {
  opening: { in: 'opening_offset', out: 'opening_offset' },
  receipt: { in: 'stock_gain', out: 'stock_gain' },
  issue: { in: 'consumption', out: 'consumption' },
  waste: { in: 'stock_loss', out: 'stock_loss' },
  count: { in: 'stock_gain', out: 'stock_loss' },
};

export interface StockAmounts {
  /** Giren mal değeri (miktar satırlarının pozitifleri). */
  inflow: MoneyValue;
  /** Çıkan mal değeri (mutlak). */
  outflow: MoneyValue;
  /** İşaretli maliyet düzeltmesi toplamı (eksi: envanter azalır, fark satılan mal maliyetine). */
  adjust: MoneyValue;
}

export function stockAmounts(rows: readonly DraftRow[]): StockAmounts {
  let inflow = dec(0);
  let outflow = dec(0);
  let adjust = dec(0);
  for (const r of rows) {
    if (r.kind === 'cost_adjust') adjust = adjust.plus(r.value);
    else if (r.qty.gt(0)) inflow = inflow.plus(r.value);
    else outflow = outflow.plus(r.value.abs());
  }
  return { inflow, outflow, adjust };
}

/**
 * Faturadan doğmayan (elle girilen / sayımdan gelen) stok belgesi için yevmiye üretir.
 * Tutar yoksa (sıfır maliyetli giriş, transfer) fiş yazılmaz ve null döner.
 */
export async function journalStockDocument(
  tx: Tx,
  ctx: StockCtx,
  doc: { id: string; docNo: string; docDate: string; type: string; description: string | null },
  rows: readonly DraftRow[],
): Promise<string | null> {
  const type = doc.type as StockDocType;
  if (type === 'transfer') return null;
  const { inflow, outflow, adjust } = stockAmounts(rows);
  const keys = new Set<AccountMappingKey>();
  if (inflow.gt(0)) keys.add('stock').add(OFFSET[type].in);
  if (outflow.gt(0)) keys.add('stock').add(OFFSET[type].out);
  if (!adjust.isZero()) keys.add('stock').add('cogs');
  if (keys.size === 0) return null;

  const acc: Partial<Record<AccountMappingKey, string>> = await requireMappings(tx, [...keys]);
  const line = (key: AccountMappingKey, side: 'debit' | 'credit', amount: MoneyValue): AutoJournalLine => ({
    accountId: acc[key]!,
    currency: ctx.baseCurrency as CurrencyCode,
    debit: side === 'debit' ? toDbAmount(amount) : '0',
    credit: side === 'credit' ? toDbAmount(amount) : '0',
  });

  const lines: AutoJournalLine[] = [];
  if (inflow.gt(0)) lines.push(line('stock', 'debit', inflow), line(OFFSET[type].in, 'credit', inflow));
  if (outflow.gt(0)) lines.push(line(OFFSET[type].out, 'debit', outflow), line('stock', 'credit', outflow));
  if (adjust.isNegative()) lines.push(line('cogs', 'debit', adjust.abs()), line('stock', 'credit', adjust.abs()));
  else if (adjust.gt(0)) lines.push(line('stock', 'debit', adjust), line('cogs', 'credit', adjust));

  const text = `${STOCK_DOC_LABEL[type]} ${doc.docNo}${doc.description ? ` — ${doc.description}` : ''}`.slice(0, 300);
  const entry = await createJournalEntry(
    tx,
    ledgerCtxOf(ctx),
    { entryDate: doc.docDate, description: text, lines, post: true },
    { source: { type: 'stock_document', id: doc.id } },
  );
  return entry.id;
}
