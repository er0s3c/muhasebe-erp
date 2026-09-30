import { formatDateTR, ITEM_UNIT_LABELS, sum, type ItemUnit, type TreasuryTxnType } from '@erp/shared';
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
import { projectCostReport, projectsSummary } from '../projects/reports';
import { fxDifferences } from '../treasury/fx-report';
import { TXN_LABEL } from '../treasury/posting';
import { treasuryStatement } from '../treasury/reports';

/** Dışa aktarma bağlamı: işlem ve şirket bilgisi (başlık/alt başlıkta kullanılır). */
export interface BuildCtx {
  tx: Tx;
  company: { name: string; baseCurrency: string; reportingCurrency: string | null };
}

export const col = (key: string, label: string, kind: ColumnKind = 'text', width?: number): TableColumn => ({ key, label, kind, width });
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
      columns: [col('code', 'Kod', 'text', 12), col('name', 'Hesap', 'text', 44), col('opening', 'Açılış (B-A)', 'money'), col('debit', 'Dönem Borç', 'money'), col('credit', 'Dönem Alacak', 'money'), col('closing', 'Bakiye (B-A)', 'money')],
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
        col('notDue', 'Vadesi gelmemiş', 'money'),
        col('d1_30', '1–30 gün', 'money'),
        col('d31_60', '31–60 gün', 'money'),
        col('d61_90', '61–90 gün', 'money'),
        col('d90plus', '90+ gün', 'money'),
        col('unapplied', 'Avans / fazla ödeme', 'money'),
        col('total', 'Net bakiye', 'money'),
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
        col('avgCost', 'Ort. maliyet', 'money'),
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
        col('salesNet', 'Satış net', 'money'),
        col('salesVat', 'Hesaplanan KDV', 'money'),
        col('purchaseNet', 'Alış net', 'money'),
        col('purchaseVat', 'İndirilecek KDV', 'money'),
        col('payable', 'Ödenecek KDV', 'money'),
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
        col('budget', 'Bütçe', 'money'),
        col('actual', 'Gerçekleşen', 'money'),
        col('remaining', 'Kalan bütçe', 'money'),
        col('spentPct', 'Harcama %', 'money'),
        col('percent', 'Tamamlanma %', 'money'),
        col('earnedValue', 'Kazanılmış değer', 'money'),
        col('etc', 'Tamamlanmaya kalan (ETC)', 'money'),
        col('eac', 'Tahmini toplam (EAC)', 'money'),
        col('variance', 'Sapma (bütçe − EAC)', 'money'),
        col('cpi', 'CPI', 'rate'),
      ],
      rows: r.rows.map(row),
      totals: { budget: r.totals.budget, actual: r.totals.actual, etc: r.totals.etc, eac: r.totals.eac, variance: r.totals.variance },
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
        col('budget', 'Bütçe', 'money'),
        col('actual', 'Gerçekleşen', 'money'),
        col('percent', 'Tamamlanma %', 'money'),
        col('etc', 'ETC', 'money'),
        col('eac', 'EAC', 'money'),
        col('variance', 'Sapma', 'money'),
        col('cpi', 'CPI', 'rate'),
        col('revenue', 'Gelir (etiketli)', 'money'),
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
