import { dec, toDbAmount, type AccountMappingKey, type CurrencyCode, type MoneyValue, type StockDocType } from '@erp/shared';
import type { Tx } from '../../db/client';
import { createJournalEntry, type AutoJournalLine, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import type { StockCtx } from './documents';
import type { DraftRow } from './planner';
import { requireItemMappings } from './accounting';

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

export interface OutflowGroup {
  projectId: string | null;
  wbsId: string | null;
  amount: MoneyValue;
}

/**
 * Çıkış değerini (mutlak) proje/iş kalemi bazında toplar; etiketsiz satırlar tek grupta kalır (eski davranış).
 * Gruplar ilk görülme sırasındadır; toplamları `stockAmounts().outflow`'a eşittir.
 */
export function outflowByDimension(rows: readonly DraftRow[]): OutflowGroup[] {
  const groups = new Map<string, OutflowGroup>();
  for (const r of rows) {
    if (r.kind !== 'qty' || !r.qty.lt(0)) continue;
    const key = `${r.projectId ?? ''}|${r.wbsId ?? ''}`;
    const g = groups.get(key) ?? { projectId: r.projectId ?? null, wbsId: r.wbsId ?? null, amount: dec(0) };
    g.amount = g.amount.plus(r.value.abs());
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.amount.gt(0));
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
  if (inflow.gt(0)) keys.add(OFFSET[type].in);
  if (outflow.gt(0)) keys.add(OFFSET[type].out);
  if (keys.size === 0 && adjust.isZero()) return null;

  const acc: Partial<Record<AccountMappingKey, string>> = await requireMappings(tx, [...keys]);
  const line = (
    key: AccountMappingKey,
    side: 'debit' | 'credit',
    amount: MoneyValue,
    dim: { projectId?: string | null; wbsId?: string | null } = {},
  ): AutoJournalLine => ({
    accountId: acc[key]!,
    currency: ctx.baseCurrency as CurrencyCode,
    debit: side === 'debit' ? toDbAmount(amount) : '0',
    credit: side === 'credit' ? toDbAmount(amount) : '0',
    ...(dim.projectId ? { projectId: dim.projectId } : {}),
    ...(dim.wbsId ? { wbsId: dim.wbsId } : {}),
  });

  const lines: AutoJournalLine[] = [];
  const itemMappings=await requireItemMappings(tx,[...new Set(rows.map(r=>r.itemId))]);
  const mappedLine=(accountId:string,side:'debit'|'credit',amount:MoneyValue):AutoJournalLine=>({accountId,currency:ctx.baseCurrency as CurrencyCode,debit:side==='debit'?toDbAmount(amount):'0',credit:side==='credit'?toDbAmount(amount):'0'});
  for(const [itemId,mapping] of itemMappings) {
    const part=rows.filter(r=>r.itemId===itemId), amounts=stockAmounts(part);
    if(amounts.inflow.gt(0))lines.push(mappedLine(mapping.stockAccountId,'debit',amounts.inflow),line(OFFSET[type].in,'credit',amounts.inflow));
    if(amounts.outflow.gt(0)){
      for(const g of outflowByDimension(part))lines.push(line(OFFSET[type].out,'debit',g.amount,g));
      lines.push(mappedLine(mapping.stockAccountId,'credit',amounts.outflow));
    }
    if(amounts.adjust.isNegative())lines.push(mappedLine(mapping.cogsAccountId,'debit',amounts.adjust.abs()),mappedLine(mapping.stockAccountId,'credit',amounts.adjust.abs()));
    else if(amounts.adjust.gt(0))lines.push(mappedLine(mapping.stockAccountId,'debit',amounts.adjust),mappedLine(mapping.cogsAccountId,'credit',amounts.adjust));
  }

  const grouped=new Map<string,AutoJournalLine>();
  for(const l of lines){const key=[l.accountId,l.currency,l.projectId??'',l.wbsId??'',dec(l.debit).gt(0)?'debit':'credit'].join('|');const previous=grouped.get(key);if(previous){previous.debit=toDbAmount(dec(previous.debit).plus(l.debit));previous.credit=toDbAmount(dec(previous.credit).plus(l.credit));}else grouped.set(key,{...l});}
  const text = `${STOCK_DOC_LABEL[type]} ${doc.docNo}${doc.description ? ` — ${doc.description}` : ''}`.slice(0, 300);
  const entry = await createJournalEntry(
    tx,
    ledgerCtxOf(ctx),
    { entryDate: doc.docDate, description: text, lines:[...grouped.values()], post: true },
    { source: { type: 'stock_document', id: doc.id } },
  );
  return entry.id;
}
