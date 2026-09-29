import { sql, type SQL } from 'drizzle-orm';
import { formatDateTR, type FullDataQuery } from '@erp/shared';
import { TR } from '../../db/search';
import { unprocessable } from '../../http/errors';
import type { CellValue, ReportTable, TableColumn } from '../../files/table';
import { BOOK_EXPORT_MAX_LINES, countBookLines, journalBook } from '../ledger/books';
import { TXN_LABEL } from '../treasury/posting';
import { INVOICE_TYPE_LABEL, col, journalBookColumns, unitLabel, PARTY_KIND_LABEL, STOCK_DOC_LABEL, type BuildCtx } from './builders';

/** Sayfa başına en çok satır: büyük şirketlerde tarih süzgeci kullanılmalıdır. */
export const FULL_DATA_SHEET_MAX_ROWS = 100_000;

const STATUS_LABEL: Record<string, string> = { draft: 'Taslak', posted: 'Kaydedildi', cancelled: 'İptal' };
const bool = (v: unknown) => (v ? 'Evet' : 'Hayır');

/** İsteğe bağlı tarih aralığı koşulu. */
function between(column: string, q: FullDataQuery): SQL {
  const parts: SQL[] = [];
  if (q.from) parts.push(sql`${sql.raw(column)} >= ${q.from}::date`);
  if (q.to) parts.push(sql`${sql.raw(column)} <= ${q.to}::date`);
  return parts.length ? sql`and ${sql.join(parts, sql` and `)}` : sql``;
}

/**
 * Müşterinin tüm verisi: tek çalışma kitabı, her tablo bir sayfa. Cari, stok kartı ve hesap planı tarih
 * süzgecinden etkilenmez; yevmiye, fatura, irsaliye, kasa/banka ve stok hareketleri `from/to` ile daralır.
 */
export async function fullDataTables(ctx: BuildCtx, q: FullDataQuery): Promise<ReportTable[]> {
  const { tx } = ctx;
  const b = ctx.company.baseCurrency;
  const scope = q.from || q.to ? `${q.from ? formatDateTR(q.from) : '…'} – ${q.to ? formatDateTR(q.to) : '…'}` : 'Tüm tarihler';

  async function query(name: string, body: SQL): Promise<Record<string, unknown>[]> {
    const r = await tx.execute<Record<string, unknown>>(sql`${body} limit ${FULL_DATA_SHEET_MAX_ROWS + 1}`);
    if (r.rows.length > FULL_DATA_SHEET_MAX_ROWS) {
      throw unprocessable(`“${name}” sayfası ${FULL_DATA_SHEET_MAX_ROWS.toLocaleString('tr-TR')} satırı aşıyor; başlangıç ve bitiş tarihiyle daraltın.`, 'EXPORT_TOO_LARGE');
    }
    return r.rows;
  }
  const table = (key: string, title: string, columns: TableColumn[], rows: Record<string, CellValue>[], subtitle?: string): ReportTable => ({
    key,
    sheet: title,
    title,
    subtitle: `${ctx.company.name} · ${subtitle ?? scope}`,
    columns,
    rows,
  });
  const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

  const tables: ReportTable[] = [];

  // Cariler (bakiye: borç − alacak, defter para birimi)
  const parties = await query(
    'Cariler',
    sql`select p.code, p.name, p.kind, p.tax_number, p.tax_office, p.phone, p.email, p.address, p.currency_code, p.payment_term_days,
               p.credit_limit, p.is_active, p.notes,
               coalesce((select sum(l.debit_base - l.credit_base) from journal_lines l
                         join journal_entries e on e.id = l.entry_id and e.status = 'posted' where l.party_id = p.id), 0) as balance
        from parties p order by p.name collate ${TR}`,
  );
  tables.push(
    table(
      'Cariler',
      'Cariler',
      [
        col('code', 'Kod', 'text', 14), col('name', 'Ünvan', 'text', 36), col('kind', 'Tür', 'text', 20), col('taxNumber', 'Vergi no', 'text', 14), col('taxOffice', 'Vergi dairesi', 'text', 16),
        col('phone', 'Telefon', 'text', 16), col('email', 'E-posta', 'text', 24), col('address', 'Adres', 'text', 32), col('currency', 'Para birimi', 'text', 8), col('term', 'Vade (gün)', 'int'),
        col('limit', 'Kredi limiti', 'money'), col('active', 'Aktif', 'text', 8), col('notes', 'Not', 'text', 24), col('balance', `Bakiye B−A (${b})`, 'money'),
      ],
      parties.map((r) => ({ code: s(r.code), name: s(r.name), kind: PARTY_KIND_LABEL[String(r.kind)] ?? s(r.kind), taxNumber: s(r.tax_number), taxOffice: s(r.tax_office), phone: s(r.phone), email: s(r.email), address: s(r.address), currency: s(r.currency_code), term: Number(r.payment_term_days), limit: s(r.credit_limit), active: bool(r.is_active), notes: s(r.notes), balance: s(r.balance) })),
      'Bakiye güncel durumdur',
    ),
  );

  // Stok kartları
  const items = await query(
    'Stok kartları',
    sql`select i.code, i.name, i.kind, i.unit, c.name as category, i.barcode, i.vat_code, i.purchase_price, i.purchase_currency,
               i.sale_price, i.sale_currency, i.min_level, i.is_active, i.notes,
               coalesce(m.qty, 0) as qty, coalesce(m.value, 0) as value
        from items i
        left join item_categories c on c.id = i.category_id
        left join (select item_id, sum(qty) as qty, sum(value) as value from stock_movements group by item_id) m on m.item_id = i.id
        order by i.name collate ${TR}`,
  );
  tables.push(
    table(
      'Stok kartları',
      'Stok kartları',
      [
        col('code', 'Kod', 'text', 14), col('name', 'Ad', 'text', 36), col('kind', 'Tür', 'text', 10), col('unit', 'Birim', 'text', 8), col('category', 'Kategori', 'text', 20), col('barcode', 'Barkod', 'text', 16),
        col('vat', 'KDV kodu', 'text', 10), col('purchasePrice', 'Alış fiyatı', 'money'), col('purchaseCur', 'Alış para birimi', 'text', 8), col('salePrice', 'Satış fiyatı', 'money'), col('saleCur', 'Satış para birimi', 'text', 8),
        col('min', 'Kritik seviye', 'qty'), col('active', 'Aktif', 'text', 8), col('qty', 'Eldeki miktar', 'qty'), col('value', `Stok değeri (${b})`, 'money'), col('notes', 'Not', 'text', 24),
      ],
      items.map((r) => ({ code: s(r.code), name: s(r.name), kind: r.kind === 'goods' ? 'Mal' : 'Hizmet', unit: unitLabel(s(r.unit)), category: s(r.category), barcode: s(r.barcode), vat: s(r.vat_code), purchasePrice: s(r.purchase_price), purchaseCur: s(r.purchase_currency), salePrice: s(r.sale_price), saleCur: s(r.sale_currency), min: s(r.min_level), active: bool(r.is_active), qty: s(r.qty), value: s(r.value), notes: s(r.notes) })),
      'Eldeki miktar ve değer güncel durumdur',
    ),
  );

  // Hesap planı
  const accounts = await query('Hesap planı', sql`select code, name, type, is_postable, currency_code, party_control, is_active from accounts order by code`);
  tables.push(
    table(
      'Hesap planı',
      'Hesap planı',
      [col('code', 'Kod', 'text', 14), col('name', 'Ad', 'text', 44), col('type', 'Tür', 'text', 12), col('postable', 'Kayıt atılabilir', 'text', 10), col('currency', 'Para birimi', 'text', 8), col('control', 'Cari kontrol', 'text', 12), col('active', 'Aktif', 'text', 8)],
      accounts.map((r) => ({ code: s(r.code), name: s(r.name), type: s(r.type), postable: bool(r.is_postable), currency: s(r.currency_code), control: r.party_control === 'receivable' ? 'Alıcılar' : r.party_control === 'payable' ? 'Satıcılar' : null, active: bool(r.is_active) })),
      'Hesap planı',
    ),
  );

  // Yevmiye satırları
  const from = q.from ?? '1900-01-01';
  const to = q.to ?? '2999-12-31';
  if ((await countBookLines(tx, from, to)) > BOOK_EXPORT_MAX_LINES) {
    throw unprocessable(`“Yevmiye satırları” ${BOOK_EXPORT_MAX_LINES.toLocaleString('tr-TR')} satırı aşıyor; başlangıç ve bitiş tarihiyle daraltın.`, 'EXPORT_TOO_LARGE');
  }
  const jb = await journalBook(tx, { from, to });
  tables.push(
    table(
      'Yevmiye satırları',
      'Yevmiye satırları',
      journalBookColumns(b),
      jb.lines.map((l) => ({ date: l.entryDate, entryNo: l.entryNo, line: l.lineNo, account: l.accountCode, accountName: l.accountName, party: l.partyName, description: l.description ?? l.entryDescription, currency: l.currencyCode, fxRate: l.currencyCode === b ? null : l.fxRate, debit: l.currencyCode === b ? null : l.debit, credit: l.currencyCode === b ? null : l.credit, debitBase: l.debitBase, creditBase: l.creditBase })),
    ),
  );

  // Faturalar ve satırları
  const invoices = await query(
    'Faturalar',
    sql`select v.invoice_date::text as date, v.invoice_no, v.external_no, v.type, v.status, p.name as party, v.currency_code, v.fx_rate,
               v.net_total, v.vat_total, v.gross_total, v.net_total_base, v.vat_total_base, v.gross_total_base, v.description
        from invoices v join parties p on p.id = v.party_id
        where true ${between('v.invoice_date', q)}
        order by v.invoice_date, v.invoice_no nulls last, v.created_at`,
  );
  tables.push(
    table(
      'Faturalar',
      'Faturalar',
      [
        col('date', 'Tarih', 'date'), col('no', 'Fatura no', 'text', 18), col('external', 'Tedarikçi fatura no', 'text', 18), col('type', 'Tür', 'text', 16), col('status', 'Durum', 'text', 12), col('party', 'Cari', 'text', 32),
        col('currency', 'Para birimi', 'text', 8), col('fx', 'Kur', 'rate'), col('net', 'Net', 'money'), col('vat', 'KDV', 'money'), col('gross', 'Brüt', 'money'),
        col('netBase', `Net (${b})`, 'money'), col('vatBase', `KDV (${b})`, 'money'), col('grossBase', `Brüt (${b})`, 'money'), col('description', 'Açıklama', 'text', 32),
      ],
      invoices.map((r) => ({ date: s(r.date), no: s(r.invoice_no), external: s(r.external_no), type: INVOICE_TYPE_LABEL[String(r.type)] ?? s(r.type), status: STATUS_LABEL[String(r.status)] ?? s(r.status), party: s(r.party), currency: s(r.currency_code), fx: r.currency_code === b ? null : s(r.fx_rate), net: s(r.net_total), vat: s(r.vat_total), gross: s(r.gross_total), netBase: s(r.net_total_base), vatBase: s(r.vat_total_base), grossBase: s(r.gross_total_base), description: s(r.description) })),
    ),
  );

  const lines = await query(
    'Fatura satırları',
    sql`select v.invoice_date::text as date, v.invoice_no, v.type, v.status, l.line_no, i.code as item_code, l.description, l.quantity, l.unit,
               l.unit_price, l.discount_pct, l.vat_code, l.vat_rate, l.net, l.vat, l.gross, l.net_base, l.vat_base, l.cost_value
        from invoice_lines l join invoices v on v.id = l.invoice_id left join items i on i.id = l.item_id
        where true ${between('v.invoice_date', q)}
        order by v.invoice_date, v.invoice_no nulls last, v.created_at, l.line_no`,
  );
  tables.push(
    table(
      'Fatura satırları',
      'Fatura satırları',
      [
        col('date', 'Tarih', 'date'), col('no', 'Fatura no', 'text', 18), col('type', 'Tür', 'text', 16), col('status', 'Durum', 'text', 12), col('line', 'Satır', 'int'), col('item', 'Stok kodu', 'text', 14),
        col('description', 'Açıklama', 'text', 36), col('qty', 'Miktar', 'qty'), col('unit', 'Birim', 'text', 8), col('price', 'Birim fiyat', 'money'), col('discount', 'İskonto %', 'money'),
        col('vatCode', 'KDV kodu', 'text', 10), col('vatRate', 'KDV %', 'money'), col('net', 'Net', 'money'), col('vat', 'KDV', 'money'), col('gross', 'Brüt', 'money'),
        col('netBase', `Net (${b})`, 'money'), col('vatBase', `KDV (${b})`, 'money'), col('cost', `Maliyet (${b})`, 'money'),
      ],
      lines.map((r) => ({ date: s(r.date), no: s(r.invoice_no), type: INVOICE_TYPE_LABEL[String(r.type)] ?? s(r.type), status: STATUS_LABEL[String(r.status)] ?? s(r.status), line: Number(r.line_no), item: s(r.item_code), description: s(r.description), qty: s(r.quantity), unit: unitLabel(s(r.unit)), price: s(r.unit_price), discount: s(r.discount_pct), vatCode: s(r.vat_code), vatRate: s(r.vat_rate), net: s(r.net), vat: s(r.vat), gross: s(r.gross), netBase: s(r.net_base), vatBase: s(r.vat_base), cost: s(r.cost_value) })),
    ),
  );

  // İrsaliyeler (başlık + satır tek sayfada)
  const notes = await query(
    'İrsaliyeler',
    sql`select n.note_date::text as date, n.note_no, n.external_no, n.type, n.status, p.name as party, w.name as warehouse, n.vehicle_plate,
               l.line_no, i.code as item_code, l.description, l.quantity, l.unit, l.unit_cost, l.currency_code, l.stock_value
        from delivery_notes n
        join parties p on p.id = n.party_id
        join warehouses w on w.id = n.warehouse_id
        join delivery_note_lines l on l.note_id = n.id
        left join items i on i.id = l.item_id
        where true ${between('n.note_date', q)}
        order by n.note_date, n.note_no nulls last, n.created_at, l.line_no`,
  );
  tables.push(
    table(
      'İrsaliyeler',
      'İrsaliyeler',
      [
        col('date', 'Tarih', 'date'), col('no', 'İrsaliye no', 'text', 18), col('external', 'Dış no', 'text', 18), col('type', 'Tür', 'text', 12), col('status', 'Durum', 'text', 12), col('party', 'Cari', 'text', 32),
        col('warehouse', 'Depo', 'text', 18), col('plate', 'Plaka', 'text', 12), col('line', 'Satır', 'int'), col('item', 'Stok kodu', 'text', 14), col('description', 'Açıklama', 'text', 32),
        col('qty', 'Miktar', 'qty'), col('unit', 'Birim', 'text', 8), col('unitCost', 'Birim maliyet', 'money'), col('currency', 'Para birimi', 'text', 8), col('value', `Stok değeri (${b})`, 'money'),
      ],
      notes.map((r) => ({ date: s(r.date), no: s(r.note_no), external: s(r.external_no), type: r.type === 'sales' ? 'Satış (sevk)' : 'Alış (mal kabul)', status: STATUS_LABEL[String(r.status)] ?? s(r.status), party: s(r.party), warehouse: s(r.warehouse), plate: s(r.vehicle_plate), line: Number(r.line_no), item: s(r.item_code), description: s(r.description), qty: s(r.quantity), unit: unitLabel(s(r.unit)), unitCost: s(r.unit_cost), currency: s(r.currency_code), value: s(r.stock_value) })),
    ),
  );

  // Kasa/banka hesapları (bakiye güncel) ve hareketleri
  const tAccounts = await query(
    'Kasa ve banka hesapları',
    sql`select ta.name, ta.kind, ta.currency_code, a.code as gl_code, ta.bank_name, ta.branch, ta.iban, ta.account_no, ta.is_active,
               coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' where l.account_id = ta.account_id), 0) as balance,
               coalesce((select sum(l.debit_base - l.credit_base) from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted' where l.account_id = ta.account_id), 0) as balance_base
        from treasury_accounts ta join accounts a on a.id = ta.account_id order by ta.kind, ta.name`,
  );
  tables.push(
    table(
      'Kasa ve banka hesapları',
      'Kasa ve banka hesapları',
      [
        col('name', 'Hesap', 'text', 28), col('kind', 'Tür', 'text', 8), col('currency', 'Para birimi', 'text', 8), col('gl', 'Muhasebe hesabı', 'text', 14), col('bank', 'Banka', 'text', 20), col('branch', 'Şube', 'text', 16),
        col('iban', 'IBAN', 'text', 30), col('accountNo', 'Hesap no', 'text', 16), col('active', 'Aktif', 'text', 8), col('balance', 'Bakiye (hesap para birimi)', 'money'), col('balanceBase', `Defter değeri (${b})`, 'money'),
      ],
      tAccounts.map((r) => ({ name: s(r.name), kind: r.kind === 'cash' ? 'Kasa' : 'Banka', currency: s(r.currency_code), gl: s(r.gl_code), bank: s(r.bank_name), branch: s(r.branch), iban: s(r.iban), accountNo: s(r.account_no), active: bool(r.is_active), balance: s(r.balance), balanceBase: s(r.balance_base) })),
      'Bakiye güncel durumdur',
    ),
  );

  const txns = await query(
    'Kasa ve banka hareketleri',
    sql`select t.txn_date::text as date, t.txn_no, t.type, t.status, ta.name as account, tb.name as to_account, p.name as party, g.code as gl_code,
               t.currency_code, t.amount, t.counter_amount, t.fx_rate, t.description, je.entry_no
        from treasury_transactions t
        join treasury_accounts ta on ta.id = t.account_id
        left join treasury_accounts tb on tb.id = t.to_account_id
        left join parties p on p.id = t.party_id
        left join accounts g on g.id = t.gl_account_id
        left join journal_entries je on je.id = t.journal_entry_id
        where true ${between('t.txn_date', q)}
        order by t.txn_date, t.txn_no`,
  );
  tables.push(
    table(
      'Kasa ve banka hareketleri',
      'Kasa ve banka hareketleri',
      [
        col('date', 'Tarih', 'date'), col('no', 'Hareket no', 'text', 18), col('type', 'Tür', 'text', 16), col('status', 'Durum', 'text', 12), col('account', 'Hesap', 'text', 24), col('toAccount', 'Hedef hesap', 'text', 24),
        col('party', 'Cari', 'text', 28), col('gl', 'Karşı hesap', 'text', 12), col('currency', 'Para birimi', 'text', 8), col('amount', 'Tutar', 'money'), col('counter', 'Hedef tutar', 'money'), col('fx', 'Kur', 'rate'),
        col('description', 'Açıklama', 'text', 32), col('entry', 'Yevmiye no', 'text', 18),
      ],
      txns.map((r) => ({ date: s(r.date), no: s(r.txn_no), type: TXN_LABEL[r.type as keyof typeof TXN_LABEL] ?? s(r.type), status: r.status === 'cancelled' ? 'İptal' : 'Kaydedildi', account: s(r.account), toAccount: s(r.to_account), party: s(r.party), gl: s(r.gl_code), currency: s(r.currency_code), amount: s(r.amount), counter: s(r.counter_amount), fx: s(r.fx_rate), description: s(r.description), entry: s(r.entry_no) })),
    ),
  );

  // Stok hareketleri
  const moves = await query(
    'Stok hareketleri',
    sql`select m.movement_date::text as date, d.doc_no, d.type, m.kind, i.code as item_code, i.name as item_name, w.name as warehouse, m.qty, m.value
        from stock_movements m
        join stock_documents d on d.id = m.document_id
        join items i on i.id = m.item_id
        join warehouses w on w.id = m.warehouse_id
        where true ${between('m.movement_date', q)}
        order by m.movement_date, m.seq`,
  );
  tables.push(
    table(
      'Stok hareketleri',
      'Stok hareketleri',
      [col('date', 'Tarih', 'date'), col('doc', 'Belge no', 'text', 18), col('type', 'Tür', 'text', 16), col('item', 'Stok kodu', 'text', 14), col('name', 'Stok kartı', 'text', 36), col('warehouse', 'Depo', 'text', 18), col('qty', 'Miktar', 'qty'), col('value', `Değer (${b})`, 'money')],
      moves.map((r) => ({ date: s(r.date), doc: s(r.doc_no), type: r.kind === 'cost_adjust' ? 'Maliyet düzeltmesi' : (STOCK_DOC_LABEL[String(r.type)] ?? s(r.type)), item: s(r.item_code), name: s(r.item_name), warehouse: s(r.warehouse), qty: s(r.qty), value: s(r.value) })),
    ),
  );

  return tables;
}
