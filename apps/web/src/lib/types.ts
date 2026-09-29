/** API yanıt tipleri (sunucu Drizzle satırlarının JSON hâli). Tutarlar her zaman string. */

export interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'cost' | 'memo';
  parentId: string | null;
  isPostable: boolean;
  currencyCode: string | null;
  /** Cari kontrol hesabı: bu hesaba atılan satırlar bir cariye bağlanmalı */
  partyControl: 'receivable' | 'payable' | null;
  isActive: boolean;
}

export interface Period {
  id: string;
  year: number;
  month: number;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed';
}

export interface Rate {
  id: string;
  rateDate: string;
  currencyCode: string;
  quoteCode: string;
  buy: string;
  sell: string;
  source: string;
}

export interface TaxRate {
  id: string;
  code: string;
  name: string;
  rate: string;
  validFrom: string;
  validTo: string | null;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface CustomCode {
  id: string;
  scope: 'account' | 'transaction' | 'party' | 'item';
  code: string;
  name: string;
  isActive: boolean;
}

export interface Member {
  userId: string;
  email: string;
  fullName: string;
  isActive: boolean;
  role: string;
}

export interface JournalListItem {
  id: string;
  entryNo: string | null;
  entryDate: string;
  description: string;
  status: 'draft' | 'posted';
  reversalOfId: string | null;
  reversedById: string | null;
  /** Otomatik yevmiyeyi üreten belge: 'invoice' | 'stock_document' */
  sourceType: string | null;
  sourceId: string | null;
  totalBase: string;
}

export interface JournalLine {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  currencyCode: string;
  fxRate: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
  debitReporting: string | null;
  creditReporting: string | null;
  partyId: string | null;
  partyCode: string | null;
  partyName: string | null;
  dueDate: string | null;
}

export interface JournalEntry extends Omit<JournalListItem, 'totalBase'> {
  postedAt: string | null;
  createdAt: string;
  periodYear: number;
  periodMonth: number;
  lines: JournalLine[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  parentId: string | null;
  isPostable: boolean;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}

export interface TrialBalanceData {
  from: string;
  to: string;
  currency: string;
  rows: TrialBalanceRow[];
  totals: { debit: string; credit: string; difference: string };
  missingReportingLines: number;
}

export interface AccountLedgerData {
  account: { id: string; code: string; name: string };
  from: string;
  to: string;
  opening: string;
  lines: {
    entryId: string;
    entryNo: string;
    entryDate: string;
    accountCode: string;
    description: string;
    currencyCode: string;
    fxRate: string;
    debit: string;
    credit: string;
    debitBase: string;
    creditBase: string;
    balance: string;
  }[];
  totals: { debitBase: string; creditBase: string };
  closing: string;
}

export type PartyKind = 'customer' | 'supplier' | 'both';

export interface PartyListRow {
  id: string;
  code: string;
  name: string;
  kind: PartyKind;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  currencyCode: string;
  isActive: boolean;
  creditLimit: string | null;
  debit: string;
  credit: string;
  /** Borç − alacak (defter para birimi); pozitif: cari bize borçlu */
  balance: string;
  movements: number;
}

export interface Party {
  id: string;
  code: string;
  name: string;
  kind: PartyKind;
  taxNumber: string | null;
  taxOffice: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  currencyCode: string;
  creditLimit: string | null;
  paymentTermDays: number;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface PartyDetail {
  party: Party;
  summary: {
    debit: string;
    credit: string;
    balance: string;
    movements: number;
    byCurrency: { currency: string; balance: string }[];
  };
}

export interface PartyStatementData {
  party: { id: string; code: string; name: string };
  from: string;
  to: string;
  opening: string;
  lines: {
    entryId: string;
    entryNo: string;
    entryDate: string;
    dueDate: string | null;
    accountCode: string;
    control: 'receivable' | 'payable';
    description: string;
    currencyCode: string;
    fxRate: string;
    debit: string;
    credit: string;
    debitBase: string;
    creditBase: string;
    balance: string;
  }[];
  totals: { debitBase: string; creditBase: string };
  closing: string;
}

export interface OpenItem {
  lineId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  dueDate: string;
  description: string;
  currencyCode: string;
  amount: string;
  amountBase: string;
  remainingBase: string;
  remaining: string;
  daysOverdue: number;
  bucket: 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus';
}

export interface OpenItemsData {
  asOf: string;
  receivable?: { items: OpenItem[]; unapplied: string };
  payable?: { items: OpenItem[]; unapplied: string };
}

export interface AgingRow {
  partyId: string;
  partyCode: string;
  partyName: string;
  notDue: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90plus: string;
  unapplied: string;
  total: string;
}

export interface AgingReport {
  type: 'receivable' | 'payable';
  asOf: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, 'partyId' | 'partyCode' | 'partyName'>;
}

// --- Stok ---------------------------------------------------------------

export type ItemKind = 'goods' | 'service';
export type StockDocType = 'opening' | 'receipt' | 'issue' | 'waste' | 'transfer' | 'count';

export interface Item {
  id: string;
  code: string;
  name: string;
  kind: ItemKind;
  unit: string;
  categoryId: string | null;
  barcode: string | null;
  vatCode: string | null;
  purchasePrice: string | null;
  purchaseCurrency: string;
  salePrice: string | null;
  saleCurrency: string;
  minLevel: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface ItemListRow {
  id: string;
  code: string;
  name: string;
  kind: ItemKind;
  unit: string;
  barcode: string | null;
  vatCode: string | null;
  isActive: boolean;
  minLevel: string | null;
  categoryId: string | null;
  categoryName: string | null;
  purchasePrice: string | null;
  purchaseCurrency: string;
  salePrice: string | null;
  saleCurrency: string;
  /** Depo süzgeci varsa o depodaki, yoksa toplam miktar */
  onHand: string;
  value: string;
  avgCost: string | null;
  isLow: boolean;
}

export interface ItemDetail {
  item: Item & { categoryName: string | null };
  stock: {
    qty: string;
    value: string;
    avgCost: string | null;
    isLow: boolean;
    byWarehouse: { warehouseId: string; code: string; name: string; isActive: boolean; qty: string }[];
  };
}

export interface ItemStatementData {
  item: { id: string; code: string; name: string; unit: string };
  from: string;
  to: string;
  openingQty: string;
  openingValue: string | null;
  lines: {
    date: string;
    documentId: string;
    docNo: string;
    type: StockDocType;
    kind: 'qty' | 'cost_adjust';
    isReversal: boolean;
    description: string | null;
    warehouseName: string;
    qty: string;
    value: string;
    balanceQty: string;
    balanceValue: string | null;
  }[];
  closingQty: string;
  closingValue: string | null;
}

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  itemCount: number;
}

export interface CategoryRow {
  id: string;
  name: string;
  isActive: boolean;
  itemCount: number;
}

export interface StockDocListRow {
  id: string;
  docNo: string;
  docDate: string;
  type: StockDocType;
  description: string | null;
  warehouseName: string;
  toWarehouseName: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  lineCount: number;
  totalValue: string;
}

export interface StockDocDetail {
  document: {
    id: string;
    docNo: string;
    docDate: string;
    type: StockDocType;
    description: string | null;
    warehouseId: string;
    warehouseName: string;
    toWarehouseId: string | null;
    toWarehouseName: string | null;
    reversalOfId: string | null;
    reversalOfNo: string | null;
    reversedById: string | null;
    reversedByNo: string | null;
    countId: string | null;
    sourceType: string | null;
    sourceId: string | null;
  };
  lines: {
    lineNo: number;
    itemId: string;
    itemCode: string;
    itemName: string;
    unit: string;
    direction: 'in' | 'out' | 'transfer' | 'adjust';
    warehouseName: string;
    qty: string;
    value: string;
    unitCostBase: string | null;
    currencyCode: string | null;
    unitCost: string | null;
    fxRate: string | null;
    adjustment: string | null;
  }[];
  totalValue: string;
}

export interface StockCountListRow {
  id: string;
  countNo: string | null;
  countDate: string;
  status: 'draft' | 'posted';
  description: string | null;
  warehouseName: string;
  documentId: string | null;
  lineCount: number;
  countedCount: number;
}

export interface StockCountDetail {
  count: {
    id: string;
    countNo: string | null;
    countDate: string;
    status: 'draft' | 'posted';
    description: string | null;
    warehouseId: string;
    warehouseName: string;
    documentId: string | null;
    documentNo: string | null;
    documentReversedById: string | null;
  };
  lines: {
    itemId: string;
    itemCode: string;
    itemName: string;
    unit: string;
    countedQty: string | null;
    systemQty: string | null;
    diffQty: string | null;
  }[];
  summary: { lines: number; counted: number; uncounted: number; surplus: number; shortage: number };
  warnings?: { zeroCostItems: string[] };
}

export interface StockStatusReport {
  asOf: string;
  baseCurrency: string;
  rows: {
    id: string;
    code: string;
    name: string;
    unit: string;
    categoryName: string | null;
    isActive: boolean;
    minLevel: string | null;
    onHand: string;
    avgCost: string | null;
    value: string;
    isLow: boolean;
  }[];
  totals: { itemCount: number; lowCount: number; value: string; reportingValue: string | null; reportingCurrency: string | null };
  ledger: {
    accountsBalance: string;
    stockValue: string;
    difference: string;
    /** Faturası kesilmemiş irsaliyelerin stok defterine girmiş, yevmiyeye girmemiş değeri (satış eksi, alış artı). */
    pendingDeliveries: { sales: string; purchases: string; total: string };
    /** Fark − bekleyen irsaliyeler: sıfırdan farklıysa gerçek mutabakat sorunu. */
    unexplained: string;
  } | null;
}

export interface InventorySummary {
  itemCount: number;
  stockValue: string;
  lowCount: number;
}

// --- Fatura ---------------------------------------------------------------

export type InvoiceType = 'sales' | 'purchase' | 'expense' | 'sales_return' | 'purchase_return';
export type InvoiceStatus = 'draft' | 'posted' | 'cancelled';

export interface InvoiceListRow {
  id: string;
  type: InvoiceType;
  status: InvoiceStatus;
  invoiceNo: string | null;
  externalNo: string | null;
  invoiceDate: string;
  dueDate: string | null;
  partyId: string;
  partyCode: string;
  partyName: string;
  currencyCode: string;
  netTotal: string;
  vatTotal: string;
  grossTotal: string;
  grossTotalBase: string | null;
  returnOfId: string | null;
  description: string | null;
}

export interface InvoiceLineRow {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemCode: string | null;
  itemKind: ItemKind | null;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  discountPct: string;
  vatCode: string | null;
  vatRate: string;
  net: string;
  vat: string;
  gross: string;
  accountId: string | null;
  accountCode: string | null;
  sourceLineId: string | null;
  netBase: string | null;
  vatBase: string | null;
  costValue: string | null;
  returnedQty: string | null;
  returnableQty: string | null;
  deliveryLineId: string | null;
  deliveryNoteId: string | null;
  deliveryNoteNo: string | null;
  deliveryLineNo: number | null;
}

export interface InvoiceDetail {
  invoice: Omit<InvoiceListRow, 'returnOfId'> & {
    fxRate: string | null;
    vatIncluded: boolean;
    warehouseId: string | null;
    warehouseName: string | null;
    returnOfId: string | null;
    returnOfNo: string | null;
    netTotalBase: string | null;
    vatTotalBase: string | null;
    journalEntryId: string | null;
    journalEntryNo: string | null;
    stockDocumentId: string | null;
    stockDocumentNo: string | null;
    postedAt: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    cancelJournalEntryId: string | null;
    cancelJournalEntryNo: string | null;
    cancelStockDocumentId: string | null;
  };
  lines: InvoiceLineRow[];
  returns: { id: string; invoiceNo: string | null; status: InvoiceStatus; type: InvoiceType }[];
  warnings?: { creditLimit: { limit: string; balance: string } | null };
}

export interface AccountMapping {
  key: string;
  label: string;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
}

export interface VatSummary {
  from: string;
  to: string;
  rows: { code: string | null; rate: string; salesNet: string; salesVat: string; purchaseNet: string; purchaseVat: string }[];
  totals: { salesNet: string; salesVat: string; purchaseNet: string; purchaseVat: string; payable: string };
  unverifiedCodes: string[];
}

export interface InvoiceSummary {
  month: string;
  salesNet: string;
  purchasesNet: string;
  draftCount: number;
}

// --- İrsaliye -------------------------------------------------------------

export type DeliveryNoteType = 'sales' | 'purchase';
export type DeliveryNoteStatus = 'draft' | 'posted' | 'cancelled';
export type DeliveryInvoicing = 'open' | 'partial' | 'invoiced';

export interface DeliveryNoteListRow {
  id: string;
  type: DeliveryNoteType;
  status: DeliveryNoteStatus;
  noteNo: string | null;
  externalNo: string | null;
  noteDate: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  warehouseName: string;
  vehiclePlate: string | null;
  description: string | null;
  lineCount: number;
  totalQty: string;
  invoicedQty: string;
  invoicing: DeliveryInvoicing | null;
  /** Kayıtlı irsaliyede henüz faturalanmamış stok değeri (defter para birimi). */
  pendingValue: string | null;
}

export interface DeliveryNoteLineRow {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  description: string;
  quantity: string;
  unit: string | null;
  unitCost: string | null;
  currencyCode: string | null;
  fxRate: string | null;
  stockValue: string | null;
  adjustValue: string | null;
  invoicedQty: string;
  remainingQty: string;
}

export interface DeliveryNoteDetail {
  note: {
    id: string;
    type: DeliveryNoteType;
    status: DeliveryNoteStatus;
    noteNo: string | null;
    externalNo: string | null;
    noteDate: string;
    partyId: string;
    partyCode: string;
    partyName: string;
    warehouseId: string;
    warehouseName: string;
    vehiclePlate: string | null;
    driverName: string | null;
    description: string | null;
    stockDocumentId: string | null;
    stockDocumentNo: string | null;
    postedAt: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    cancelStockDocumentId: string | null;
    cancelStockDocumentNo: string | null;
    invoicing: DeliveryInvoicing | null;
  };
  lines: DeliveryNoteLineRow[];
  invoices: { id: string; invoiceNo: string | null; status: InvoiceStatus; type: InvoiceType }[];
}

/** Faturaya eklenebilecek, kalan miktarı olan irsaliye satırı. */
export interface OpenDeliveryLine {
  lineId: string;
  lineNo: number;
  noteId: string;
  noteNo: string;
  noteDate: string;
  externalNo: string | null;
  warehouseId: string;
  itemId: string;
  itemCode: string;
  description: string;
  unit: string | null;
  quantity: string;
  unitCost: string | null;
  currencyCode: string | null;
  invoicedQty: string;
  remainingQty: string;
}

export interface DeliverySummary {
  sales: { openCount: number; openValue: string };
  purchases: { openCount: number; openValue: string };
}

// --- Kasa ve banka --------------------------------------------------------

export type TreasuryAccountKind = 'cash' | 'bank';
export type TreasuryTxnType = 'receipt' | 'payment' | 'transfer' | 'exchange' | 'other_receipt' | 'other_payment';
export type TreasuryTxnStatus = 'posted' | 'cancelled';

export interface TreasuryAccount {
  id: string;
  kind: TreasuryAccountKind;
  name: string;
  currencyCode: string;
  accountId: string;
  accountCode: string;
  bankName: string | null;
  branch: string | null;
  iban: string | null;
  accountNo: string | null;
  isActive: boolean;
  /** Hesabın kendi para biriminde bakiye */
  balance: string;
  /** Defter para biriminde tarihsel maliyet */
  balanceBase: string;
  /** Güncel kurla defter para birimi karşılığı; kur yoksa null */
  equivalent: string | null;
  lastActivity: string | null;
}

export interface TreasurySummary {
  accountCount: number;
  equivalent: string;
  /** Bazı hesaplarda güncel kur yok: toplam tarihsel maliyetle tamamlandı */
  approximate: boolean;
  byCurrency: { currency: string; balance: string }[];
}

export interface TreasuryStatementLine {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
  fxRate: string;
  balanceDoc: string;
  balanceBase: string;
  txnId: string | null;
  txnNo: string | null;
  txnType: TreasuryTxnType | null;
  txnStatus: TreasuryTxnStatus | null;
}

export interface TreasuryStatementData {
  account: { id: string; name: string; kind: TreasuryAccountKind; currencyCode: string; accountCode: string };
  from: string;
  to: string;
  openingDoc: string;
  openingBase: string;
  lines: TreasuryStatementLine[];
  totals: { debit: string; credit: string };
  closingDoc: string;
  closingBase: string;
}

export interface TreasuryTxnListRow {
  id: string;
  type: TreasuryTxnType;
  status: TreasuryTxnStatus;
  txnNo: string;
  txnDate: string;
  accountName: string;
  currencyCode: string;
  amount: string;
  toAccountName: string | null;
  toCurrencyCode: string | null;
  counterAmount: string | null;
  partyName: string | null;
  glAccountCode: string | null;
  glAccountName: string | null;
  description: string | null;
}

export interface TreasuryTxnDetail {
  transaction: {
    id: string;
    type: TreasuryTxnType;
    status: TreasuryTxnStatus;
    txnNo: string;
    txnDate: string;
    accountId: string;
    accountName: string;
    accountKind: TreasuryAccountKind;
    currencyCode: string;
    amount: string;
    toAccountId: string | null;
    toAccountName: string | null;
    toCurrencyCode: string | null;
    counterAmount: string | null;
    fxRate: string | null;
    partyId: string | null;
    partyCode: string | null;
    partyName: string | null;
    glAccountId: string | null;
    glAccountCode: string | null;
    glAccountName: string | null;
    description: string | null;
    journalEntryId: string;
    journalEntryNo: string | null;
    postedAt: string;
    cancelledAt: string | null;
    cancelReason: string | null;
    cancelJournalEntryId: string | null;
    cancelJournalEntryNo: string | null;
  };
  allocations: {
    lineId: string;
    entryId: string;
    entryNo: string;
    entryDate: string;
    description: string;
    currencyCode: string;
    amount: string;
    amountBase: string;
    settleAmount: string;
  }[];
  /** Hareketin yevmiyesindeki net kambiyo farkı (+ kâr, − zarar; defter para birimi) */
  fxNet: string;
}

/** Modül anahtarı -> çeviri anahtarı */
export const MODULE_LABEL_KEYS = {
  'core.dashboard': 'modules.dashboard',
  'core.ledger': 'modules.ledger',
  'core.settings': 'modules.settings',
  'core.parties': 'modules.parties',
  'core.inventory': 'modules.inventory',
  'core.invoices': 'modules.invoices',
  'core.treasury': 'modules.treasury',
  'construction.projects': 'modules.constructionProjects',
  'retail.pos': 'modules.retailPos',
} as const;
