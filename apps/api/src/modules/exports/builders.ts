import { formatDateTR, ITEM_UNIT_LABELS, sum, todayIso, type ItemUnit, type TreasuryTxnType } from '@erp/shared';
import type { Tx } from '../../db/client';
import { unprocessable } from '../../http/errors';
import type { CellValue, ColumnKind, ReportTable, TableColumn } from '../../files/table';
import { BOOK_EXPORT_MAX_LINES, countBookLines, generalLedger, journalBook } from '../ledger/books';
import { accountLedger, trialBalance } from '../ledger/reports';
import { itemStatement } from '../inventory/items';
import { stockStatus } from '../inventory/reports';
import { itemProfitability, salesReport } from '../invoices/analytics';
import { vatSummary } from '../invoices/reports';
import { reconciliation } from '../bank-statements/service';
import { partyAging, partyOpenItems, partyStatement } from '../parties/service';
import { projectProfitability } from '../projects/profitability';
import { projectCostByCode, projectCostReport, projectsSummary } from '../projects/reports';
import { getContract, listContracts, listInstallments } from '../realestate/contracts';
import { listUnits } from '../realestate/units';
import { listProgress } from '../subcontracts/progress';
import { listSubcontracts } from '../subcontracts/service';
import { fxDifferences } from '../treasury/fx-report';
import { TXN_LABEL } from '../treasury/posting';
import { treasuryStatement } from '../treasury/reports';

/** Dışa aktarma bağlamı: işlem ve şirket bilgisi (başlık/alt başlıkta kullanılır). */
export interface BuildCtx {
  tx: Tx;
  company: { name: string; baseCurrency: string; reportingCurrency: string | null };
}

const CODE_IN_LABEL = /\(([A-Z]{3})\)$/;
/**
 * Sütun tanımı. `currency` verilmezse `money` sütununun başlığı "(TRY)" gibi bir para birimi koduyla bitiyorsa
 * oradan alınır (başlık zaten tutarın para birimini söylüyor); XLSX'te hücre biçimi simgeli olur (CSV etkilenmez).
 * Yüzde/oran gibi tutar olmayan `money` sütunlarına para birimi verilmez.
 */
export const col = (key: string, label: string, kind: ColumnKind = 'text', width?: number, currency?: string): TableColumn => {
  const c: TableColumn = { key, label, kind, width };
  const cur = currency ?? (kind === 'money' ? CODE_IN_LABEL.exec(label)?.[1] : undefined);
  if (cur) c.currency = cur;
  return c;
};
const period = (from: string, to: string) => `${formatDateTR(from)} – ${formatDateTR(to)}`;
const sub = (ctx: BuildCtx, ...parts: string[]) => [ctx.company.name, ...parts].join(' · ');
const unit = (u: string | null) => (u ? (ITEM_UNIT_LABELS[u as ItemUnit] ?? u) : null);

const STOCK_DOC_LABEL: Record<string, string> = {
  opening: 'Devir (açılış)',
  receipt: 'Giriş',
  issue: 'Çıkış / sarf',
  waste: 'Fire',
  transfer: 'Transfer',
  count: 'Sayım farkı',
};
export const INVOICE_TYPE_LABEL: Record<string, string> = {
  sales: 'Satış faturası',
  purchase: 'Alış faturası',
  expense: 'Gider faturası',
  sales_return: 'Satış iadesi',
  purchase_return: 'Alış iadesi',
};
const PARTY_KIND_LABEL: Record<string, string> = { customer: 'Müşteri', supplier: 'Tedarikçi', both: 'Müşteri ve tedarikçi' };

// --- Mevcut raporlar -----------------------------------------------------------

export async function trialBalanceTable(
  ctx: BuildCtx,
  q: { from: string; to: string; currency: 'base' | 'reporting'; view: 'groups' | 'accounts' },
): Promise<ReportTable[]> {
  const data = await trialBalance(ctx.tx, { from: q.from, to: q.to, currency: q.currency, baseCurrency: ctx.company.baseCurrency, reportingCurrency: ctx.company.reportingCurrency });
  const cur = q.currency === 'base' ? ctx.company.baseCurrency : (ctx.company.reportingCurrency ?? '');
  return [
    {
      key: 'mizan',
      title: 'Mizan',
      subtitle: sub(ctx, period(q.from, q.to), `${cur} cinsinden`),
      columns: [col('code', 'Kod', 'text', 12), col('name', 'Hesap', 'text', 44), col('opening', 'Açılış (B-A)', 'money', undefined, cur), col('debit', 'Dönem Borç', 'money', undefined, cur), col('credit', 'Dönem Alacak', 'money', undefined, cur), col('closing', 'Bakiye (B-A)', 'money', undefined, cur)],
      rows: data.rows.filter((r) => q.view === 'groups' || r.isPostable).map((r) => ({ code: r.code, name: r.name, opening: r.opening, debit: r.debit, credit: r.credit, closing: r.closing })),
      totals: { debit: data.totals.debit, credit: data.totals.credit },
    },
  ];
}

export async function accountLedgerTable(ctx: BuildCtx, q: { accountId: string; from: string; to: string }): Promise<ReportTable[]> {
  const d = await accountLedger(ctx.tx, q);
  const b = ctx.company.baseCurrency;
  const rows: Record<string, CellValue>[] = [{ description: 'Açılış bakiyesi', balance: d.opening }];
  for (const l of d.lines) {
    rows.push({
      date: l.entryDate,
      entryNo: l.entryNo,
      account: l.accountCode,
      description: l.description,
      currency: l.currencyCode,
      fxRate: l.currencyCode === b ? null : l.fxRate,
      debit: l.currencyCode === b ? null : l.debit,
      credit: l.currencyCode === b ? null : l.credit,
      debitBase: l.debitBase,
      creditBase: l.creditBase,
      balance: l.balance,
    });
  }
  return [
    {
      key: 'muavin',
      title: 'Hesap ekstresi (muavin)',
      sheet: 'Muavin',
      subtitle: sub(ctx, `${d.account.code} ${d.account.name}`, period(q.from, q.to)),
      columns: [
        col('date', 'Tarih', 'date'),
        col('entryNo', 'Fiş no', 'text', 18),
        col('account', 'Hesap', 'text', 12),
        col('description', 'Açıklama', 'text', 44),
        col('currency', 'Para birimi', 'text', 8),
        col('fxRate', 'Kur', 'rate'),
        col('debit', 'Borç (döviz)', 'money'),
        col('credit', 'Alacak (döviz)', 'money'),
        col('debitBase', `Borç (${b})`, 'money'),
        col('creditBase', `Alacak (${b})`, 'money'),
        col('balance', `Bakiye (${b})`, 'money'),
      ],
      rows,
      totals: { debitBase: d.totals.debitBase, creditBase: d.totals.creditBase },
    },
  ];
}

export async function partyAgingTable(ctx: BuildCtx, q: { type: 'receivable' | 'payable'; asOf: string }): Promise<ReportTable[]> {
  const d = await partyAging(ctx.tx, q);
  return [
    {
      key: `yaslandirma-${q.type === 'receivable' ? 'alacak' : 'borc'}`,
      title: `Cari yaşlandırma raporu · ${q.type === 'receivable' ? 'Alacaklar' : 'Borçlar'}`,
      sheet: 'Yaşlandırma',
      subtitle: sub(ctx, `${formatDateTR(q.asOf)} itibarıyla`, `${ctx.company.baseCurrency} cinsinden`),
      columns: [
        col('party', 'Cari', 'text', 44),
        col('notDue', 'Vadesi gelmemiş', 'money', undefined, ctx.company.baseCurrency),
        col('d1_30', '1–30 gün', 'money', undefined, ctx.company.baseCurrency),
        col('d31_60', '31–60 gün', 'money', undefined, ctx.company.baseCurrency),
        col('d61_90', '61–90 gün', 'money', undefined, ctx.company.baseCurrency),
        col('d90plus', '90+ gün', 'money', undefined, ctx.company.baseCurrency),
        col('unapplied', 'Avans / fazla ödeme', 'money', undefined, ctx.company.baseCurrency),
        col('total', 'Net bakiye', 'money', undefined, ctx.company.baseCurrency),
      ],
      rows: d.rows.map((r) => ({ party: `${r.partyCode} ${r.partyName}`, notDue: r.notDue, d1_30: r.d1_30, d31_60: r.d31_60, d61_90: r.d61_90, d90plus: r.d90plus, unapplied: r.unapplied, total: r.total })),
      totals: { ...d.totals },
    },
  ];
}

export async function partyStatementTable(ctx: BuildCtx, q: { partyId: string; from: string; to: string }): Promise<ReportTable[]> {
  const d = await partyStatement(ctx.tx, q.partyId, q);
  const b = ctx.company.baseCurrency;
  const rows: Record<string, CellValue>[] = [{ description: 'Açılış bakiyesi', balance: d.opening }];
  for (const l of d.lines) {
    rows.push({
      date: l.entryDate,
      entryNo: l.entryNo,
      description: l.description,
      due: l.dueDate,
      currency: l.currencyCode,
      fx: l.currencyCode === b ? null : Number(l.debit) > 0 ? l.debit : l.credit,
      debit: l.debitBase,
      credit: l.creditBase,
      balance: l.balance,
    });
  }
  return [
    {
      key: 'cari-ekstre',
      title: 'Cari ekstre',
      sheet: 'Cari ekstre',
      subtitle: sub(ctx, `${d.party.code} ${d.party.name}`, period(q.from, q.to)),
      columns: [
        col('date', 'Tarih', 'date'),
        col('entryNo', 'Fiş no', 'text', 18),
        col('description', 'Açıklama', 'text', 44),
        col('due', 'Vade', 'date'),
        col('currency', 'Para birimi', 'text', 8),
        col('fx', 'Döviz tutarı', 'money'),
        col('debit', `Borç (${b})`, 'money'),
        col('credit', `Alacak (${b})`, 'money'),
        col('balance', `Bakiye (${b})`, 'money'),
      ],
      rows,
      totals: { debit: d.totals.debitBase, credit: d.totals.creditBase },
    },
  ];
}

export async function partyOpenItemsTable(ctx: BuildCtx, q: { partyId: string; asOf: string; type?: 'receivable' | 'payable' }): Promise<ReportTable[]> {
  const d = await partyOpenItems(ctx.tx, q.partyId, q);
  const rows: Record<string, CellValue>[] = [];
  for (const type of ['receivable', 'payable'] as const) {
    const r = d[type];
    if (!r) continue;
    const label = type === 'receivable' ? 'Alacak' : 'Borç';
    for (const it of r.items) {
      rows.push({ type: label, due: it.dueDate, entryNo: it.entryNo, description: it.description, currency: it.currencyCode, amount: it.amount, remaining: it.remaining, remainingBase: it.remainingBase, days: it.daysOverdue });
    }
    if (Number(r.unapplied) !== 0) rows.push({ type: label, description: 'Avans / uygulanamayan tutar', remainingBase: r.unapplied });
  }
  const b = ctx.company.baseCurrency;
  return [
    {
      key: 'acik-kalemler',
      title: 'Cari açık kalemler',
      sheet: 'Açık kalemler',
      subtitle: sub(ctx, `${formatDateTR(q.asOf)} itibarıyla`),
      columns: [
        col('type', 'Tür', 'text', 10),
        col('due', 'Vade', 'date'),
        col('entryNo', 'Fiş no', 'text', 18),
        col('description', 'Açıklama', 'text', 44),
        col('currency', 'Para birimi', 'text', 8),
        col('amount', 'Tutar', 'money'),
        col('remaining', 'Kalan', 'money'),
        col('remainingBase', `Kalan (${b})`, 'money'),
        col('days', 'Gecikme (gün)', 'int'),
      ],
      rows,
    },
  ];
}

export async function stockStatusTable(
  ctx: BuildCtx,
  q: { asOf: string; warehouseId?: string; categoryId?: string; query?: string; lowOnly?: 'true' | 'false'; includeZero?: 'true' | 'false' },
): Promise<ReportTable[]> {
  const d = await stockStatus(ctx.tx, ctx.company, q);
  const b = ctx.company.baseCurrency;
  return [
    {
      key: 'stok-durumu',
      title: 'Stok durumu',
      sheet: 'Stok durumu',
      subtitle: sub(ctx, `${formatDateTR(q.asOf)} itibarıyla`, `${b} cinsinden`),
      columns: [
        col('code', 'Kod', 'text', 14),
        col('name', 'Stok kartı', 'text', 40),
        col('category', 'Kategori', 'text', 20),
        col('unit', 'Birim', 'text', 8),
        col('onHand', 'Eldeki', 'qty'),
        col('minLevel', 'Kritik seviye', 'qty'),
        col('avgCost', 'Ort. maliyet', 'money', undefined, b),
        col('value', `Değer (${b})`, 'money'),
      ],
      rows: d.rows.map((r) => ({ code: r.code, name: r.name, category: r.categoryName, unit: unit(r.unit), onHand: r.onHand, minLevel: r.minLevel, avgCost: r.avgCost, value: r.value })),
      totals: { value: d.totals.value },
    },
  ];
}

export async function itemCardTable(ctx: BuildCtx, q: { itemId: string; from: string; to: string; warehouseId?: string }): Promise<ReportTable[]> {
  const d = await itemStatement(ctx.tx, q.itemId, q);
  const b = ctx.company.baseCurrency;
  const rows: Record<string, CellValue>[] = [{ description: 'Açılış bakiyesi', balanceQty: d.openingQty, balanceValue: d.openingValue }];
  for (const l of d.lines) {
    rows.push({ date: l.date, docNo: l.docNo, type: STOCK_DOC_LABEL[l.type] ?? l.type, description: l.description, warehouse: l.warehouseName, qty: l.qty, value: l.value, balanceQty: l.balanceQty, balanceValue: l.balanceValue });
  }
  rows.push({ description: 'Kapanış bakiyesi', balanceQty: d.closingQty, balanceValue: d.closingValue });
  return [
    {
      key: 'stok-karti',
      title: 'Stok kartı ekstresi',
      sheet: 'Stok kartı',
      subtitle: sub(ctx, `${d.item.code} ${d.item.name}`, period(q.from, q.to)),
      columns: [
        col('date', 'Tarih', 'date'),
        col('docNo', 'Belge no', 'text', 18),
        col('type', 'Tür', 'text', 16),
        col('description', 'Açıklama', 'text', 36),
        col('warehouse', 'Depo', 'text', 18),
        col('qty', 'Miktar', 'qty'),
        col('value', `Değer (${b})`, 'money'),
        col('balanceQty', 'Bakiye miktar', 'qty'),
        col('balanceValue', `Bakiye değer (${b})`, 'money'),
      ],
      rows,
    },
  ];
}

export async function vatSummaryTable(ctx: BuildCtx, q: { from: string; to: string }): Promise<ReportTable[]> {
  const d = await vatSummary(ctx.tx, q);
  const b = ctx.company.baseCurrency;
  const pay = (s: string, p: string) => (Number(s) - Number(p)).toFixed(4);
  return [
    {
      key: 'kdv-ozeti',
      title: 'KDV özeti',
      subtitle: sub(ctx, period(q.from, q.to), `${b} cinsinden`, d.unverifiedCodes.length ? `Doğrulanmamış oran kodları: ${d.unverifiedCodes.join(', ')}` : 'Oranlar mali müşavirce doğrulanmalıdır'),
      columns: [
        col('code', 'KDV kodu', 'text', 14),
        col('rate', 'Oran (%)', 'rate'),
        col('salesNet', 'Satış net', 'money', undefined, b),
        col('salesVat', 'Hesaplanan KDV', 'money', undefined, b),
        col('purchaseNet', 'Alış net', 'money', undefined, b),
        col('purchaseVat', 'İndirilecek KDV', 'money', undefined, b),
        col('payable', 'Ödenecek KDV', 'money', undefined, b),
      ],
      rows: d.rows.map((r) => ({ code: r.code ?? 'KDV yok', rate: r.rate, salesNet: r.salesNet, salesVat: r.salesVat, purchaseNet: r.purchaseNet, purchaseVat: r.purchaseVat, payable: pay(r.salesVat, r.purchaseVat) })),
      totals: { salesNet: d.totals.salesNet, salesVat: d.totals.salesVat, purchaseNet: d.totals.purchaseNet, purchaseVat: d.totals.purchaseVat, payable: d.totals.payable },
    },
  ];
}

export async function treasuryStatementTable(ctx: BuildCtx, q: { accountId: string; from: string; to: string }): Promise<ReportTable[]> {
  const d = await treasuryStatement(ctx.tx, q.accountId, q);
  const b = ctx.company.baseCurrency;
  const foreign = d.account.currencyCode !== b;
  const rows: Record<string, CellValue>[] = [{ description: 'Açılış bakiyesi', balanceDoc: d.openingDoc, balanceBase: d.openingBase }];
  for (const l of d.lines) {
    rows.push({ date: l.entryDate, entryNo: l.entryNo, txnNo: l.txnNo, description: l.description, debit: Number(l.debit) === 0 ? null : l.debit, credit: Number(l.credit) === 0 ? null : l.credit, balanceDoc: l.balanceDoc, balanceBase: l.balanceBase });
  }
  const columns = [
    col('date', 'Tarih', 'date'),
    col('entryNo', 'Fiş no', 'text', 18),
    col('txnNo', 'Hareket no', 'text', 18),
    col('description', 'Açıklama', 'text', 44),
    col('debit', `Giriş (${d.account.currencyCode})`, 'money'),
    col('credit', `Çıkış (${d.account.currencyCode})`, 'money'),
    col('balanceDoc', `Bakiye (${d.account.currencyCode})`, 'money'),
    ...(foreign ? [col('balanceBase', `Bakiye (${b})`, 'money')] : []),
  ];
  return [
    {
      key: 'hesap-ekstresi',
      title: 'Kasa/banka hesap ekstresi',
      sheet: 'Hesap ekstresi',
      subtitle: sub(ctx, `${d.account.name} (${d.account.accountCode})`, period(q.from, q.to)),
      columns,
      rows,
      totals: { debit: d.totals.debit, credit: d.totals.credit },
    },
  ];
}

// --- Yeni raporlar ---------------------------------------------------------------

async function guardBookSize(tx: Tx, from: string, to: string) {
  const n = await countBookLines(tx, from, to);
  if (n > BOOK_EXPORT_MAX_LINES) {
    throw unprocessable(`Bu aralıkta ${n.toLocaleString('tr-TR')} satır var; dışa aktarma en çok ${BOOK_EXPORT_MAX_LINES.toLocaleString('tr-TR')} satır alır. Tarih aralığını daraltın.`, 'EXPORT_TOO_LARGE');
  }
}

export function journalBookColumns(base: string): TableColumn[] {
  return [
    col('date', 'Tarih', 'date'),
    col('entryNo', 'Fiş no', 'text', 18),
    col('line', 'Satır', 'int'),
    col('account', 'Hesap kodu', 'text', 12),
    col('accountName', 'Hesap adı', 'text', 36),
    col('party', 'Cari', 'text', 28),
    col('description', 'Açıklama', 'text', 44),
    col('currency', 'Para birimi', 'text', 8),
    col('fxRate', 'Kur', 'rate'),
    col('debit', 'Borç (döviz)', 'money'),
    col('credit', 'Alacak (döviz)', 'money'),
    col('debitBase', `Borç (${base})`, 'money'),
    col('creditBase', `Alacak (${base})`, 'money'),
  ];
}

export async function journalBookTable(ctx: BuildCtx, q: { from: string; to: string }): Promise<ReportTable[]> {
  await guardBookSize(ctx.tx, q.from, q.to);
  const d = await journalBook(ctx.tx, q);
  const b = ctx.company.baseCurrency;
  return [
    {
      key: 'yevmiye-defteri',
      title: 'Yevmiye defteri',
      sheet: 'Yevmiye defteri',
      subtitle: sub(ctx, period(q.from, q.to), `${d.total.toLocaleString('tr-TR')} satır`, 'İç belge: yasal onaylı defter yerine geçmez'),
      columns: journalBookColumns(b),
      rows: d.lines.map((l) => ({
        date: l.entryDate,
        entryNo: l.entryNo,
        line: l.lineNo,
        account: l.accountCode,
        accountName: l.accountName,
        party: l.partyName,
        description: l.description ?? l.entryDescription,
        currency: l.currencyCode,
        fxRate: l.currencyCode === b ? null : l.fxRate,
        debit: l.currencyCode === b ? null : l.debit,
        credit: l.currencyCode === b ? null : l.credit,
        debitBase: l.debitBase,
        creditBase: l.creditBase,
      })),
      totals: { debitBase: d.totals.debitBase, creditBase: d.totals.creditBase },
    },
  ];
}

export async function generalLedgerTable(ctx: BuildCtx, q: { from: string; to: string; codePrefix?: string }): Promise<ReportTable[]> {
  await guardBookSize(ctx.tx, q.from, q.to);
  const d = await generalLedger(ctx.tx, q);
  const b = ctx.company.baseCurrency;
  const rows: Record<string, CellValue>[] = [];
  let debit = 0;
  let credit = 0;
  for (const a of d.accounts) {
    rows.push({ account: a.code, accountName: a.name, description: 'Devir (dönem başı)', balance: a.opening });
    for (const l of a.lines) {
      rows.push({ account: a.code, accountName: a.name, date: l.entryDate, entryNo: l.entryNo, description: l.description, currency: l.currencyCode, debit: l.debitBase, credit: l.creditBase, balance: l.balance });
    }
    rows.push({ account: a.code, accountName: a.name, description: 'Hesap toplamı / kapanış', debit: a.debit, credit: a.credit, balance: a.closing });
    debit += Number(a.debit);
    credit += Number(a.credit);
  }
  return [
    {
      key: 'kebir',
      title: 'Kebir (büyük defter)',
      sheet: 'Kebir',
      subtitle: sub(ctx, period(q.from, q.to), q.codePrefix ? `Hesap kodu ${q.codePrefix}…` : 'Tüm hesaplar', `${b} cinsinden`, 'İç belge: yasal onaylı defter yerine geçmez'),
      columns: [
        col('account', 'Hesap', 'text', 12),
        col('accountName', 'Hesap adı', 'text', 32),
        col('date', 'Tarih', 'date'),
        col('entryNo', 'Fiş no', 'text', 18),
        col('description', 'Açıklama', 'text', 44),
        col('currency', 'Para birimi', 'text', 8),
        col('debit', `Borç (${b})`, 'money'),
        col('credit', `Alacak (${b})`, 'money'),
        col('balance', `Bakiye (${b})`, 'money'),
      ],
      rows,
      totals: { debit: debit.toFixed(4), credit: credit.toFixed(4) },
    },
  ];
}

const GROUP_LABEL = { party: 'Cari bazında', item: 'Stok kartı bazında', month: 'Ay bazında', invoice: 'Fatura bazında' } as const;

export async function salesReportTable(ctx: BuildCtx, side: 'sales' | 'purchases', q: { from: string; to: string; groupBy: 'party' | 'item' | 'month' | 'invoice' }): Promise<ReportTable[]> {
  const d = await salesReport(ctx.tx, side, q);
  const b = ctx.company.baseCurrency;
  const amounts = [col('net', `Net (${b})`, 'money'), col('vat', `KDV (${b})`, 'money'), col('gross', `Brüt (${b})`, 'money')];
  let columns: TableColumn[];
  let rows: Record<string, CellValue>[];
  if (q.groupBy === 'party') {
    columns = [col('label', side === 'sales' ? 'Müşteri' : 'Tedarikçi', 'text', 44), col('count', 'Belge adedi', 'int'), ...amounts];
    rows = d.rows.map((r) => ({ label: `${r.code ?? ''} ${r.label}`.trim(), count: r.docCount, net: r.net, vat: r.vat, gross: r.gross }));
  } else if (q.groupBy === 'item') {
    columns = [col('code', 'Kod', 'text', 14), col('label', 'Stok kartı', 'text', 40), col('qty', 'Miktar', 'qty'), ...amounts];
    rows = d.rows.map((r) => ({ code: r.code, label: r.label, qty: r.qty, net: r.net, vat: r.vat, gross: r.gross }));
  } else if (q.groupBy === 'month') {
    columns = [col('label', 'Ay', 'text', 12), col('count', 'Belge adedi', 'int'), ...amounts];
    rows = d.rows.map((r) => ({ label: r.label, count: r.docCount, net: r.net, vat: r.vat, gross: r.gross }));
  } else {
    columns = [col('date', 'Tarih', 'date'), col('code', 'Fatura no', 'text', 18), col('externalNo', side === 'sales' ? 'Dış no' : 'Tedarikçi fatura no', 'text', 18), col('label', side === 'sales' ? 'Müşteri' : 'Tedarikçi', 'text', 36), col('type', 'Tür', 'text', 16), ...amounts];
    rows = d.rows.map((r) => ({ date: r.date, code: r.code, externalNo: r.externalNo, label: r.label, type: r.type ? (INVOICE_TYPE_LABEL[r.type] ?? r.type) : null, net: r.net, vat: r.vat, gross: r.gross }));
  }
  return [
    {
      key: side === 'sales' ? 'satis-raporu' : 'alis-raporu',
      title: side === 'sales' ? 'Satış raporu' : 'Alış raporu',
      sheet: side === 'sales' ? 'Satış raporu' : 'Alış raporu',
      subtitle: sub(ctx, period(q.from, q.to), GROUP_LABEL[q.groupBy], 'İadeler düşülmüştür; iptal ve taslaklar hariç'),
      columns,
      rows,
      totals: { ...(d.totals.docCount === null ? {} : { count: d.totals.docCount }), net: d.totals.net, vat: d.totals.vat, gross: d.totals.gross },
    },
  ];
}

export async function itemProfitTable(ctx: BuildCtx, q: { from: string; to: string }): Promise<ReportTable[]> {
  const d = await itemProfitability(ctx.tx, q);
  const b = ctx.company.baseCurrency;
  return [
    {
      key: 'stok-karliligi',
      title: 'Stok kârlılığı',
      sheet: 'Stok kârlılığı',
      subtitle: sub(ctx, period(q.from, q.to), 'Satış faturaları eksi iadeler; maliyet fatura kaydındaki satılan mal maliyetidir'),
      columns: [
        col('code', 'Kod', 'text', 14),
        col('name', 'Stok kartı', 'text', 40),
        col('unit', 'Birim', 'text', 8),
        col('qty', 'Miktar', 'qty'),
        col('sales', `Satış net (${b})`, 'money'),
        col('cost', `Maliyet (${b})`, 'money'),
        col('profit', `Kâr (${b})`, 'money'),
        col('margin', 'Marj (%)', 'money'),
      ],
      rows: d.rows.map((r) => ({ code: r.code, name: r.name, unit: unit(r.unit), qty: r.qty, sales: r.sales, cost: r.cost, profit: r.profit, margin: r.marginPct })),
      totals: { sales: d.totals.sales, cost: d.totals.cost, profit: d.totals.profit, margin: d.totals.marginPct },
    },
  ];
}

export async function fxDifferencesTable(ctx: BuildCtx, q: { from: string; to: string }): Promise<ReportTable[]> {
  const d = await fxDifferences(ctx.tx, q);
  const b = ctx.company.baseCurrency;
  return [
    {
      key: 'kambiyo-raporu',
      title: 'Kambiyo (kur farkı) raporu',
      sheet: 'Kambiyo',
      subtitle: sub(ctx, period(q.from, q.to), `Gerçekleşen kur farkı, ${b} cinsinden; iptal edilen hareketler hariç`),
      columns: [
        col('date', 'Tarih', 'date'),
        col('txnNo', 'Hareket no', 'text', 18),
        col('type', 'Tür', 'text', 16),
        col('account', 'Kasa/banka', 'text', 24),
        col('party', 'Cari', 'text', 30),
        col('currency', 'Para birimi', 'text', 8),
        col('gain', `Kâr (${b})`, 'money'),
        col('loss', `Zarar (${b})`, 'money'),
        col('net', `Net (${b})`, 'money'),
      ],
      rows: d.rows.map((r) => ({ date: r.txnDate, txnNo: r.txnNo, type: TXN_LABEL[r.type as TreasuryTxnType] ?? r.type, account: r.accountName, party: r.partyName, currency: r.currencyCode, gain: r.gain, loss: r.loss, net: r.net })),
      totals: { gain: d.totals.gain, loss: d.totals.loss, net: d.totals.net },
    },
  ];
}

export { PARTY_KIND_LABEL, STOCK_DOC_LABEL, unit as unitLabel };

const BANK_STATUS_LABEL = { open: 'Açık', matched: 'Eşleşti', ignored: 'Yoksayıldı' } as const;

/** Banka mutabakatı: ekstre satırları (durumları ve eşleştikleri fişle) ve eşleşmemiş defter kayıtları. */
export async function bankReconciliationTable(ctx: BuildCtx, q: { accountId: string; from?: string; to?: string }): Promise<ReportTable[]> {
  const d = await reconciliation(ctx.tx, q.accountId, { from: q.from, to: q.to });
  const cur = d.account.currencyCode;
  const s = d.summary;
  const subtitle = sub(
    ctx,
    `${d.account.name} (${cur})`,
    period(d.from, d.to),
    s.statementClosing !== null ? `Ekstre kapanışı ${s.statementClosing} · defter ${s.ledgerBalance} · fark ${s.difference}` : `Defter bakiyesi ${s.ledgerBalance}`,
  );
  return [
    {
      key: 'ekstre-satirlari',
      title: 'Banka ekstresi satırları',
      sheet: 'Ekstre satırları',
      subtitle,
      columns: [
        col('date', 'Tarih', 'date'),
        col('description', 'Açıklama', 'text', 44),
        col('reference', 'Referans', 'text', 18),
        col('amount', `Tutar (${cur})`, 'money'),
        col('status', 'Durum', 'text', 14),
        col('entryNo', 'Fiş no', 'text', 18),
        col('txnNo', 'Hareket no', 'text', 18),
        col('note', 'Not', 'text', 30),
      ],
      rows: d.lines.map((l) => ({
        date: l.txnDate,
        description: l.description,
        reference: l.reference,
        amount: l.amount,
        status: BANK_STATUS_LABEL[l.status],
        entryNo: l.match?.entryNo ?? null,
        txnNo: l.match?.txnNo ?? null,
        note: l.ignoreReason,
      })),
      totals: { amount: sum(d.lines.map((l) => l.amount)).toFixed(4) },
    },
    {
      key: 'eslesmemis-defter',
      title: 'Eşleşmemiş defter kayıtları',
      sheet: 'Eşleşmemiş defter',
      subtitle,
      columns: [
        col('date', 'Tarih', 'date'),
        col('entryNo', 'Fiş no', 'text', 18),
        col('description', 'Açıklama', 'text', 44),
        col('txnNo', 'Hareket no', 'text', 18),
        col('party', 'Cari', 'text', 28),
        col('amount', `Tutar (${cur})`, 'money'),
      ],
      rows: d.unmatchedLedger.map((c) => ({ date: c.entryDate, entryNo: c.entryNo, description: c.description, txnNo: c.txnNo, party: c.partyName, amount: c.amount })),
      totals: { amount: sum(d.unmatchedLedger.map((c) => c.amount)).toFixed(4) },
    },
  ];
}

// --- Proje (inşaat) ------------------------------------------------------------

const PROJECT_KIND_LABEL: Record<string, string> = { own: 'Kendi projesi', contract: 'İşverene yapılan iş' };
const PROJECT_STATUS_LABEL: Record<string, string> = { planned: 'Planlanan', active: 'Aktif', on_hold: 'Beklemede', completed: 'Tamamlandı', cancelled: 'İptal' };

/** Proje maliyet raporu: iş kırılımı ağacı, yürürlükteki bütçe, gerçekleşen, tamamlanma, ETC/EAC ve sapma. */
export async function projectCostReportTable(ctx: BuildCtx, q: { projectId: string; asOf: string }): Promise<ReportTable[]> {
  const r = await projectCostReport(ctx.tx, q.projectId, q.asOf);
  const cur = ctx.company.baseCurrency;
  const rev = r.budget ? `Bütçe rev. ${r.budget.revisionNo}` : 'Onaylı bütçe yok';
  const row = (x: (typeof r.rows)[number]) => ({
    code: `${'  '.repeat(Math.max(0, x.depth - 1))}${x.code}`,
    name: x.name,
    budget: x.budget,
    actual: x.actual,
    committed: x.committed,
    actualPlusCommitted: x.actualPlusCommitted,
    remaining: x.remaining,
    spentPct: x.spentPct,
    percent: x.percent,
    earnedValue: x.hasProgress ? x.earnedValue : null,
    etc: x.etc,
    eac: x.eac,
    variance: x.variance,
    cpi: x.cpi,
  });
  return [
    {
      key: 'proje-maliyet',
      title: `Proje maliyet raporu — ${r.project.code} ${r.project.name}`,
      sheet: 'Proje maliyeti',
      subtitle: sub(ctx, formatDateTR(q.asOf), rev, `${cur} cinsinden`),
      columns: [
        col('code', 'İş kalemi', 'text', 16),
        col('name', 'Ad', 'text', 36),
        col('budget', 'Bütçe', 'money', undefined, cur),
        col('actual', 'Gerçekleşen', 'money', undefined, cur),
        col('committed', 'Kalan taahhüt', 'money', undefined, cur),
        col('actualPlusCommitted', 'Gerçekleşen + taahhüt', 'money', undefined, cur),
        col('remaining', 'Kalan bütçe', 'money', undefined, cur),
        col('spentPct', 'Harcama %', 'money'),
        col('percent', 'Tamamlanma %', 'money'),
        col('earnedValue', 'Kazanılmış değer', 'money', undefined, cur),
        col('etc', 'Tamamlanmaya kalan (ETC)', 'money', undefined, cur),
        col('eac', 'Tahmini toplam (EAC)', 'money', undefined, cur),
        col('variance', 'Sapma (bütçe − EAC)', 'money', undefined, cur),
        col('cpi', 'CPI', 'rate'),
      ],
      rows: r.rows.map(row),
      totals: { budget: r.totals.budget, actual: r.totals.actual, committed: r.totals.committed, actualPlusCommitted: r.totals.actualPlusCommitted, etc: r.totals.etc, eac: r.totals.eac, variance: r.totals.variance },
    },
  ];
}

/** Şirketin projeleri: bütçe, gerçekleşen, EAC ve sapma + defterle mutabakat satırları. */
export async function projectsSummaryTable(ctx: BuildCtx, q: { asOf: string }): Promise<ReportTable[]> {
  const d = await projectsSummary(ctx.tx, q.asOf);
  const cur = ctx.company.baseCurrency;
  return [
    {
      key: 'projeler',
      title: 'Proje özeti',
      sheet: 'Projeler',
      subtitle: sub(ctx, formatDateTR(q.asOf), `${cur} cinsinden`),
      columns: [
        col('code', 'Proje', 'text', 12),
        col('name', 'Ad', 'text', 36),
        col('kind', 'Tür', 'text', 20),
        col('status', 'Durum', 'text', 12),
        col('budget', 'Bütçe', 'money', undefined, cur),
        col('actual', 'Gerçekleşen', 'money', undefined, cur),
        col('percent', 'Tamamlanma %', 'money'),
        col('etc', 'ETC', 'money', undefined, cur),
        col('eac', 'EAC', 'money', undefined, cur),
        col('variance', 'Sapma', 'money', undefined, cur),
        col('cpi', 'CPI', 'rate'),
        col('revenue', 'Gelir (etiketli)', 'money', undefined, cur),
      ],
      rows: d.projects.map((p) => ({
        code: p.code,
        name: p.name,
        kind: PROJECT_KIND_LABEL[p.kind] ?? p.kind,
        status: PROJECT_STATUS_LABEL[p.status] ?? p.status,
        budget: p.budget,
        actual: p.actual,
        percent: p.percent,
        etc: p.etc,
        eac: p.eac,
        variance: p.variance,
        cpi: p.cpi,
        revenue: p.revenue,
      })),
      totals: { budget: d.totals.budget, actual: d.totals.actual, etc: d.totals.etc, eac: d.totals.eac, variance: d.totals.variance },
    },
    {
      key: 'proje-mutabakat',
      title: 'Defterle mutabakat (maliyet tarafı)',
      sheet: 'Mutabakat',
      subtitle: sub(ctx, formatDateTR(q.asOf)),
      columns: [col('label', 'Kalem', 'text', 44), col('amount', `Tutar (${cur})`, 'money')],
      rows: [
        { label: 'Projelere etiketli maliyet', amount: d.allocatedCost },
        { label: 'Projesiz maliyet', amount: d.unallocatedCost },
        { label: 'Defterdeki toplam maliyet tarafı', amount: d.ledgerCost },
      ],
    },
  ];
}


/** Maliyet koduna göre proje maliyeti (malzeme, işçilik, taşeron…). */
export async function projectCostByCodeTable(ctx: BuildCtx, q: { projectId: string; asOf: string }): Promise<ReportTable[]> {
  const r = await projectCostByCode(ctx.tx, q.projectId, q.asOf);
  const cur = ctx.company.baseCurrency;
  return [
    {
      key: 'maliyet-kodu',
      title: `Maliyet koduna göre maliyet — ${r.project.code} ${r.project.name}`,
      sheet: 'Maliyet kodu',
      subtitle: sub(ctx, formatDateTR(q.asOf), `${cur} cinsinden`),
      columns: [col('code', 'Kod', 'text', 12), col('name', 'Maliyet kodu', 'text', 28), col('actual', 'Gerçekleşen', 'money', undefined, cur), col('share', 'Pay %', 'money')],
      rows: r.rows.map((x) => ({ code: x.code ?? '—', name: x.name, actual: x.actual, share: x.share })),
      totals: { actual: r.total },
    },
  ];
}

const SUBCONTRACT_STATUS_LABEL: Record<string, string> = { draft: 'Taslak', active: 'Yürürlükte', completed: 'Tamamlandı', terminated: 'Feshedildi' };
const PROGRESS_STATUS_LABEL: Record<string, string> = { draft: 'Taslak', submitted: 'Onayda', posted: 'Kaydedildi', cancelled: 'İptal' };

/** Taşeron sözleşmeleri listesi. */
export async function subcontractRegisterTable(ctx: BuildCtx, q: { projectId?: string; direction?: string }): Promise<ReportTable[]> {
  const d = await listSubcontracts(ctx.tx, { projectId: q.projectId, direction: q.direction });
  return [
    {
      key: 'sozlesmeler',
      title: q.direction === 'receivable' ? 'İşveren sözleşmeleri' : 'Taşeron sözleşmeleri',
      sheet: 'Sözleşmeler',
      subtitle: sub(ctx, formatDateTR(todayIso())),
      columns: [
        col('code', 'Sözleşme', 'text', 12),
        col('title', 'İş', 'text', 32),
        col('project', 'Proje', 'text', 14),
        col('party', q.direction === 'receivable' ? 'İşveren' : 'Taşeron', 'text', 28),
        col('status', 'Durum', 'text', 14),
        col('currency', 'Para birimi', 'text', 8),
        col('amount', 'Sözleşme tutarı', 'money'),
        col('start', 'Başlangıç', 'date'),
        col('end', 'Bitiş', 'date'),
      ],
      rows: d.subcontracts.map((x) => ({
        code: String(x.code),
        title: String(x.title),
        project: String(x.projectCode),
        party: String(x.partyName),
        status: SUBCONTRACT_STATUS_LABEL[String(x.status)] ?? String(x.status),
        currency: String(x.currencyCode),
        amount: String(x.contractAmount),
        start: (x.startDate as string | null) ?? null,
        end: (x.endDate as string | null) ?? null,
      })),
    },
  ];
}

/** Taşeron hakedişleri listesi. */
export async function progressPaymentsTable(ctx: BuildCtx, q: { projectId?: string; subcontractId?: string; direction?: string }): Promise<ReportTable[]> {
  const d = await listProgress(ctx.tx, q);
  return [
    {
      key: 'hakedisler',
      title: q.direction === 'receivable' ? 'İşveren hakedişleri' : 'Taşeron hakedişleri',
      sheet: 'Hakedişler',
      subtitle: sub(ctx, formatDateTR(todayIso())),
      columns: [
        col('number', 'Hakediş no', 'text', 16),
        col('no', 'Sıra', 'int'),
        col('subcontract', 'Sözleşme', 'text', 12),
        col('party', q.direction === 'receivable' ? 'İşveren' : 'Taşeron', 'text', 28),
        col('project', 'Proje', 'text', 14),
        col('status', 'Durum', 'text', 12),
        col('periodEnd', 'Dönem sonu', 'date'),
        col('currency', 'Para birimi', 'text', 8),
        col('gross', 'Brüt', 'money'),
        col('net', 'Net ödenecek', 'money'),
      ],
      rows: d.payments.map((x) => ({
        number: (x.number as string | null) ?? '—',
        no: Number(x.paymentNo),
        subcontract: String(x.subcontractCode),
        party: String(x.partyName),
        project: String(x.projectCode),
        status: PROGRESS_STATUS_LABEL[String(x.status)] ?? String(x.status),
        periodEnd: String(x.periodEnd),
        currency: String(x.currencyCode),
        gross: String(x.gross),
        net: String(x.net),
      })),
    },
  ];
}

// --- Gayrimenkul satışı (B3) ---------------------------------------------------------------------------

const UNIT_STATUS_LABEL: Record<string, string> = { available: 'Satışa açık', reserved: 'Rezerve', sold: 'Satıldı', handed_over: 'Teslim edildi' };
const UNIT_TYPE_LABEL: Record<string, string> = { apartment: 'Daire', villa: 'Villa', shop: 'Dükkân', office: 'Ofis', land: 'Arsa', parking: 'Otopark', storage: 'Depo', other: 'Diğer' };
const CONTRACT_STATUS_LABEL: Record<string, string> = { draft: 'Taslak', active: 'Yürürlükte', handed_over: 'Teslim edildi', terminated: 'Feshedildi', cancelled: 'İptal' };
const KIND_LABEL: Record<string, string> = { down_payment: 'Peşinat', installment: 'Taksit', balloon: 'Balon ödeme' };

/** Birim envanteri. */
export async function realEstateUnitsTable(ctx: BuildCtx, q: { projectId?: string; status?: string }): Promise<ReportTable[]> {
  const d = await listUnits(ctx.tx, q);
  return [
    {
      key: 'birimler',
      title: 'Birim envanteri',
      sheet: 'Birimler',
      subtitle: sub(ctx, formatDateTR(todayIso())),
      columns: [
        col('project', 'Proje', 'text', 14),
        col('block', 'Blok', 'text', 8),
        col('unitNo', 'Birim no', 'text', 10),
        col('floor', 'Kat', 'int'),
        col('type', 'Tür', 'text', 12),
        col('rooms', 'Oda', 'text', 8),
        col('grossM2', 'Brüt m²', 'qty'),
        col('netM2', 'Net m²', 'qty'),
        col('currency', 'Para birimi', 'text', 8),
        col('listPrice', 'Liste fiyatı', 'money'),
        col('status', 'Durum', 'text', 14),
        col('buyer', 'Alıcı', 'text', 28),
        col('contract', 'Sözleşme', 'text', 16),
      ],
      rows: d.units.map((u) => ({
        project: String(u.projectCode),
        block: String(u.block ?? ''),
        unitNo: String(u.unitNo),
        floor: u.floor === null ? null : Number(u.floor),
        type: UNIT_TYPE_LABEL[String(u.unitType)] ?? String(u.unitType),
        rooms: (u.rooms as string | null) ?? null,
        grossM2: (u.grossM2 as string | null) ?? null,
        netM2: (u.netM2 as string | null) ?? null,
        currency: (u.listCurrency as string | null) ?? null,
        listPrice: (u.listPrice as string | null) ?? null,
        status: UNIT_STATUS_LABEL[String(u.status)] ?? String(u.status),
        buyer: (u.buyerName as string | null) ?? null,
        contract: (u.contractCode as string | null) ?? null,
      })),
    },
  ];
}

/** Satış sözleşmeleri listesi. */
export async function salesContractsTable(ctx: BuildCtx, q: { projectId?: string; status?: string }): Promise<ReportTable[]> {
  const d = await listContracts(ctx.tx, q);
  return [
    {
      key: 'satis-sozlesmeleri',
      title: 'Satış sözleşmeleri',
      sheet: 'Sözleşmeler',
      subtitle: sub(ctx, formatDateTR(todayIso())),
      columns: [
        col('code', 'Sözleşme', 'text', 16),
        col('date', 'Tarih', 'date'),
        col('project', 'Proje', 'text', 14),
        col('unit', 'Birim', 'text', 12),
        col('buyer', 'Alıcı', 'text', 28),
        col('status', 'Durum', 'text', 14),
        col('currency', 'Para birimi', 'text', 8),
        col('price', 'Bedel', 'money'),
        col('count', 'Taksit', 'int'),
      ],
      rows: d.contracts.map((c) => ({
        code: String(c.code),
        date: String(c.contractDate),
        project: String(c.projectCode),
        unit: `${c.block ? `${c.block}-` : ''}${c.unitNo}`,
        buyer: String(c.partyName),
        status: CONTRACT_STATUS_LABEL[String(c.status)] ?? String(c.status),
        currency: String(c.currencyCode),
        price: String(c.price),
        count: Number(c.installmentCount),
      })),
    },
  ];
}

/** Tek sözleşmenin ödeme planı (ödenen/kalan/gecikme ile). */
export async function salesScheduleTable(ctx: BuildCtx, q: { contractId: string }): Promise<ReportTable[]> {
  const d = await getContract(ctx.tx, q.contractId);
  const c = d.contract;
  const cur = String(c.currencyCode);
  return [
    {
      key: 'odeme-plani',
      title: `Ödeme planı · ${c.code}`,
      sheet: 'Ödeme planı',
      subtitle: sub(ctx, `${c.projectCode} ${c.block ? `${c.block}-` : ''}${c.unitNo}`, String(c.partyName), `${cur} cinsinden`),
      columns: [
        col('seq', 'No', 'int'),
        col('kind', 'Tür', 'text', 14),
        col('due', 'Vade', 'date'),
        col('amount', `Tutar (${cur})`, 'money', undefined, cur),
        col('paid', `Ödenen (${cur})`, 'money', undefined, cur),
        col('remaining', `Kalan (${cur})`, 'money', undefined, cur),
        col('days', 'Gecikme (gün)', 'int'),
      ],
      rows: d.installments.map((i) => ({ seq: i.seq, kind: KIND_LABEL[i.kind] ?? i.kind, due: i.dueDate, amount: i.amount, paid: i.paid, remaining: i.remaining, days: i.daysOverdue || null })),
      totals: { amount: d.installments.reduce((s, i) => s + Number(i.amount), 0).toFixed(2), paid: String(c.paid), remaining: String(c.remaining) },
    },
  ];
}

/** Tahsil edilecek / geciken taksitler. */
export async function overdueInstallmentsTable(ctx: BuildCtx, q: { projectId?: string; asOf?: string; overdue?: boolean }): Promise<ReportTable[]> {
  const d = await listInstallments(ctx.tx, { projectId: q.projectId, asOf: q.asOf, overdueOnly: q.overdue });
  return [
    {
      key: 'taksitler',
      title: q.overdue ? 'Geciken taksitler' : 'Tahsil edilecek taksitler',
      sheet: 'Taksitler',
      subtitle: sub(ctx, `${formatDateTR(d.asOf)} itibarıyla`),
      columns: [
        col('due', 'Vade', 'date'),
        col('buyer', 'Alıcı', 'text', 28),
        col('project', 'Proje', 'text', 14),
        col('unit', 'Birim', 'text', 12),
        col('contract', 'Sözleşme', 'text', 16),
        col('seq', 'No', 'int'),
        col('currency', 'Para birimi', 'text', 8),
        col('amount', 'Tutar', 'money'),
        col('remaining', 'Kalan', 'money'),
        col('days', 'Gecikme (gün)', 'int'),
      ],
      rows: d.installments.map((i) => ({
        due: i.dueDate,
        buyer: i.partyName,
        project: i.projectCode,
        unit: `${i.block ? `${i.block}-` : ''}${i.unitNo}`,
        contract: i.contractCode,
        seq: i.seq,
        currency: i.currencyCode,
        amount: i.amount,
        remaining: i.remaining,
        days: i.daysOverdue || null,
      })),
    },
  ];
}

/** Proje kârlılığı: sözleşmeli gelir, tanınmış gelir/maliyet, EAC ve tahmini kâr; defter ve yönetim para biriminde. */
export async function projectProfitabilityTable(ctx: BuildCtx, q: { asOf?: string }): Promise<ReportTable[]> {
  const asOf = q.asOf ?? todayIso();
  const d = await projectProfitability(ctx.tx, asOf, ctx.company.baseCurrency, ctx.company.reportingCurrency);
  const b = ctx.company.baseCurrency;
  const rc = ctx.company.reportingCurrency;
  const withRep = !!rc && rc !== b && d.rows.every((r) => r.reporting);
  const columns = [
    col('code', 'Proje', 'text', 12),
    col('name', 'Ad', 'text', 30),
    col('kind', 'Tür', 'text', 16),
    col('contracted', `Sözleşmeli gelir (${b})`, 'money'),
    col('revenue', `Tanınmış gelir (${b})`, 'money'),
    col('actual', `Gerçekleşen maliyet (${b})`, 'money'),
    col('eac', `Tahmini toplam maliyet (${b})`, 'money'),
    col('projected', `Tahmini kâr (${b})`, 'money'),
    col('margin', 'Marj %', 'money'),
    ...(withRep ? [col('rContracted', `Sözleşmeli gelir (${rc})`, 'money'), col('rActual', `Gerçekleşen maliyet (${rc})`, 'money'), col('rProjected', `Tahmini kâr (${rc})`, 'money')] : []),
  ];
  const toRow = (r: (typeof d.rows)[number]) => ({
    code: r.code,
    name: r.name,
    kind: r.kind === 'contract' ? 'İşverene yapılan iş' : 'Kendi projesi',
    contracted: r.contractedRevenue,
    revenue: r.revenue,
    actual: r.actual,
    eac: r.eac,
    projected: r.projectedProfit,
    margin: r.marginPct,
    ...(withRep && r.reporting ? { rContracted: r.reporting.contractedRevenue, rActual: r.reporting.actual, rProjected: r.reporting.projectedProfit } : {}),
  });
  return [
    {
      key: 'proje-karliligi',
      title: 'Proje kârlılığı',
      sheet: 'Kârlılık',
      subtitle: sub(ctx, `${formatDateTR(asOf)} itibarıyla`, withRep ? `${b} ve ${rc}` : `${b} cinsinden`),
      columns,
      rows: d.rows.map(toRow),
      totals: {
        contracted: d.totals.contractedRevenue,
        revenue: d.totals.revenue,
        actual: d.totals.actual,
        eac: d.totals.eac,
        projected: d.totals.projectedProfit,
        ...(withRep && d.totals.reporting ? { rContracted: d.totals.reporting.contractedRevenue, rActual: d.totals.reporting.actual, rProjected: d.totals.reporting.projectedProfit } : {}),
      },
    },
  ];
}
