import {
  INVOICE_TYPE_META,
  dec,
  toDbAmount,
  toDbRate,
  type AccountMappingKey,
  type CurrencyCode,
  type InvoiceType,
  type MoneyValue,
} from '@erp/shared';
import type { AutoJournalLine } from '../ledger/journal';

/** Yevmiye kurucusunun ihtiyaç duyduğu eşlemeler: hangi anahtarların gerektiği türe göre değişir. */
export function requiredMappingKeys(type: InvoiceType, opts: { hasStock: boolean; hasStockAdjust: boolean }): AccountMappingKey[] {
  const meta = INVOICE_TYPE_META[type];
  const keys = new Set<AccountMappingKey>([meta.control, meta.side === 'sales' ? 'vat_output' : 'vat_input']);
  if (meta.side === 'sales') {
    keys.add(meta.isReturn ? 'sales_return' : 'sales_revenue');
    if (opts.hasStock) keys.add('stock').add('cogs');
  } else {
    keys.add('default_expense');
    if (opts.hasStock) keys.add('stock');
    if (opts.hasStock && (type === 'purchase_return' || opts.hasStockAdjust)) keys.add('cogs');
  }
  return [...keys];
}

export interface JournalInvoiceLine {
  /** Fatura para biriminde satır tutarları. */
  net: MoneyValue;
  vat: MoneyValue;
  /** Defter para birimi karşılıkları (satır satır yuvarlanmış). */
  netBase: MoneyValue;
  vatBase: MoneyValue;
  /** KDV oranı (yüzde, gruplama için). */
  vatRate: string;
  /** Serbest satır / satış hesabı ezmesi; boşsa eşleme. */
  accountId: string | null;
  isStock: boolean;
  /** Stokta hareket eden maliyet (defter para birimi, pozitif): çıkışta maliyet, girişte değer. */
  costValue: MoneyValue;
  /** Proje boyutu (yalnızca stoksuz alış/gider/alış iadesi satırı): gider satırına yazılır, KDV ve cari satırına yazılmaz. */
  projectId?: string | null;
  wbsId?: string | null;
}

export interface BuildJournalInput {
  type: InvoiceType;
  baseCurrency: string;
  currency: string;
  fx: MoneyValue;
  partyId: string;
  dueDate: string;
  mapping: Partial<Record<AccountMappingKey, string>>;
  lines: JournalInvoiceLine[];
  /** Alış girişinde eksi bakiye kapanışından doğan maliyet düzeltmesi toplamı (işaretli; eksi = envanter azalır). */
  stockAdjust: MoneyValue;
}

export interface BuiltJournal {
  lines: AutoJournalLine[];
  /** Cari satırın defter para birimi tutarı (= faturanın brüt tutarı, base). */
  grossBase: MoneyValue;
}

/**
 * Faturanın yevmiye satırlarını kurar (saf fonksiyon; veritabanına dokunmaz).
 *
 * Denge: cari satırın defter tutarı, gövde satırlarının defter tutarları toplamıdır; gövde satırları da
 * satır başına yuvarlanmış `netBase`/`vatBase` değerlerinden gelir. Böylece kur yuvarlaması fişi bozmaz.
 * Stok/maliyet satırları defter para birimindedir ve kendi içinde dengelidir (B maliyet / A stok gibi).
 */
export function buildInvoiceJournal(i: BuildJournalInput): BuiltJournal {
  const meta = INVOICE_TYPE_META[i.type];
  const salesSide = meta.side === 'sales';
  // Cari satırın tarafı: satış = borç (alacak doğar); iade ters; alış = alacak (borç doğar); iade ters
  const partyDebit = salesSide !== meta.isReturn;
  const bodySide: 'debit' | 'credit' = partyDebit ? 'credit' : 'debit';
  const foreign = i.currency !== i.baseCurrency;
  const m = i.mapping;
  const acc = (key: AccountMappingKey): string => {
    const id = m[key];
    if (!id) throw new Error(`eşleme eksik: ${key}`); // requireMappings çağıran tarafta denetler
    return id;
  };

  const out: AutoJournalLine[] = [];
  const line = (
    side: 'debit' | 'credit',
    accountId: string,
    amount: MoneyValue,
    amountBase: MoneyValue,
    extra: Partial<AutoJournalLine> = {},
    inBase = false,
  ) => {
    if (amount.isZero() && amountBase.isZero()) return;
    const doc = inBase ? amountBase : amount;
    const useForeign = foreign && !inBase;
    out.push({
      accountId,
      currency: (useForeign ? i.currency : i.baseCurrency) as CurrencyCode,
      ...(useForeign ? { fxRate: toDbRate(i.fx) } : {}),
      debit: side === 'debit' ? toDbAmount(doc) : '0',
      credit: side === 'credit' ? toDbAmount(doc) : '0',
      debitBase: side === 'debit' ? toDbAmount(amountBase) : '0',
      creditBase: side === 'credit' ? toDbAmount(amountBase) : '0',
      ...extra,
    });
  };

  let totalDoc = dec(0);
  let totalBase = dec(0);
  for (const l of i.lines) {
    totalDoc = totalDoc.plus(l.net).plus(l.vat);
    totalBase = totalBase.plus(l.netBase).plus(l.vatBase);
  }

  // 1) Cari satır
  line(partyDebit ? 'debit' : 'credit', acc(meta.control), totalDoc, totalBase, { partyId: i.partyId, dueDate: i.dueDate });

  // 2) Gövde: satış tarafında gelir/iade; alış tarafında stok ve gider
  // Gövde satırları hesap + proje + iş kalemi bazında toplanır: projesiz satırlar eskisi gibi hesap başına tek satır olur
  const groups = new Map<string, { accountId: string; projectId: string | null; wbsId: string | null; net: MoneyValue; base: MoneyValue }>();
  const addGroup = (accountId: string, net: MoneyValue, base: MoneyValue, projectId: string | null = null, wbsId: string | null = null) => {
    const key = `${accountId}|${projectId ?? ''}|${wbsId ?? ''}`;
    const g = groups.get(key) ?? { accountId, projectId, wbsId, net: dec(0), base: dec(0) };
    g.net = g.net.plus(net);
    g.base = g.base.plus(base);
    groups.set(key, g);
  };
  let stockNetBase = dec(0);
  for (const l of i.lines) {
    if (salesSide) {
      addGroup(l.accountId ?? acc(meta.isReturn ? 'sales_return' : 'sales_revenue'), l.net, l.netBase);
    } else if (l.isStock) {
      stockNetBase = stockNetBase.plus(l.netBase);
      // Alış iadesinde stok satırı, stok defterindeki çıkış değeriyle aşağıda ayrıca yazılır
      if (!meta.isReturn) addGroup(acc('stock'), l.net, l.netBase);
    } else {
      addGroup(l.accountId ?? acc('default_expense'), l.net, l.netBase, l.projectId ?? null, l.wbsId ?? null);
    }
  }
  for (const g of groups.values()) {
    line(bodySide, g.accountId, g.net, g.base, {
      ...(g.projectId ? { projectId: g.projectId } : {}),
      ...(g.wbsId ? { wbsId: g.wbsId } : {}),
    });
  }

  // 3) KDV (oran başına ayrı satır: KDV raporu ve mutabakat için okunaklı)
  const vatGroups = new Map<string, { vat: MoneyValue; base: MoneyValue }>();
  for (const l of i.lines) {
    const g = vatGroups.get(l.vatRate) ?? { vat: dec(0), base: dec(0) };
    g.vat = g.vat.plus(l.vat);
    g.base = g.base.plus(l.vatBase);
    vatGroups.set(l.vatRate, g);
  }
  const vatAccount = acc(salesSide ? 'vat_output' : 'vat_input');
  for (const [rate, g] of [...vatGroups].sort((a, b) => dec(a[0]).comparedTo(b[0]))) {
    line(bodySide, vatAccount, g.vat, g.base, { description: `KDV %${dec(rate).toFixed(2).replace(/\.?0+$/, '')}` });
  }

  // 4) Stok ve maliyet (defter para birimi)
  const stockCost = i.lines.filter((l) => l.isStock).reduce((s, l) => s.plus(l.costValue), dec(0));
  if (i.type === 'sales' && stockCost.gt(0)) {
    line('debit', acc('cogs'), stockCost, stockCost, {}, true);
    line('credit', acc('stock'), stockCost, stockCost, {}, true);
  } else if (i.type === 'sales_return' && stockCost.gt(0)) {
    line('debit', acc('stock'), stockCost, stockCost, {}, true);
    line('credit', acc('cogs'), stockCost, stockCost, {}, true);
  } else if (i.type === 'purchase_return' && i.lines.some((l) => l.isStock)) {
    // Stok defterinden ortalama maliyetle çıkan değer; iade tutarıyla farkı satılan mal maliyetine gider
    line('credit', acc('stock'), stockCost, stockCost, {}, true);
    const variance = stockNetBase.minus(stockCost);
    if (variance.gt(0)) line('credit', acc('cogs'), variance, variance, {}, true);
    else if (variance.isNegative()) line('debit', acc('cogs'), variance.abs(), variance.abs(), {}, true);
  }
  if (!salesSide && !meta.isReturn && !i.stockAdjust.isZero()) {
    const a = i.stockAdjust.abs();
    if (i.stockAdjust.isNegative()) {
      line('debit', acc('cogs'), a, a, {}, true);
      line('credit', acc('stock'), a, a, {}, true);
    } else {
      line('debit', acc('stock'), a, a, {}, true);
      line('credit', acc('cogs'), a, a, {}, true);
    }
  }

  return { lines: out, grossBase: totalBase };
}
