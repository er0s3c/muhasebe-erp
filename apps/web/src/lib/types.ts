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
  mfaEnabled: boolean;
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
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  wbsId: string | null;
  wbsCode: string | null;
  wbsName: string | null;
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
    projectId?: string | null;
    projectCode?: string | null;
    wbsId?: string | null;
    wbsCode?: string | null;
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
  poLineId: string | null;
  orderCode: string | null;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  wbsId: string | null;
  wbsCode: string | null;
  wbsName: string | null;
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
    matchOverrideReason: string | null;
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

// --- Raporlar ---------------------------------------------------------------

export interface JournalBookLine {
  entryId: string;
  entryNo: string;
  entryDate: string;
  entryDescription: string;
  lineNo: number;
  accountCode: string;
  accountName: string;
  partyName: string | null;
  description: string | null;
  currencyCode: string;
  fxRate: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
}

export interface JournalBookData {
  from: string;
  to: string;
  total: number;
  lines: JournalBookLine[];
  totals: { debitBase: string; creditBase: string };
}

export interface GeneralLedgerAccount {
  accountId: string;
  code: string;
  name: string;
  opening: string;
  lines: {
    entryId: string;
    entryNo: string;
    entryDate: string;
    description: string;
    currencyCode: string;
    debit: string;
    credit: string;
    debitBase: string;
    creditBase: string;
    balance: string;
  }[];
  debit: string;
  credit: string;
  closing: string;
}

export interface GeneralLedgerData {
  from: string;
  to: string;
  total: number;
  accounts: GeneralLedgerAccount[];
}

export type SalesReportGroup = 'party' | 'item' | 'month' | 'invoice';

export interface SalesReportRow {
  key: string;
  label: string;
  code: string | null;
  docCount: number;
  qty: string | null;
  net: string;
  vat: string;
  gross: string;
  date: string | null;
  invoiceId: string | null;
  type: string | null;
  externalNo: string | null;
}

export interface SalesReportData {
  from: string;
  to: string;
  side: 'sales' | 'purchases';
  groupBy: SalesReportGroup;
  rows: SalesReportRow[];
  totals: { docCount: number | null; net: string; vat: string; gross: string };
}

export interface ItemProfitData {
  from: string;
  to: string;
  rows: {
    itemId: string | null;
    code: string | null;
    name: string;
    unit: string | null;
    qty: string | null;
    sales: string;
    cost: string;
    profit: string;
    marginPct: string | null;
  }[];
  totals: { sales: string; cost: string; profit: string; marginPct: string | null };
}

export interface FxDifferenceData {
  from: string;
  to: string;
  rows: {
    transactionId: string;
    txnNo: string;
    type: TreasuryTxnType;
    txnDate: string;
    accountName: string;
    partyName: string | null;
    currencyCode: string;
    gain: string;
    loss: string;
    net: string;
  }[];
  totals: { gain: string; loss: string; net: string };
}

// --- Şantiye / proje (Faz B1) ------------------------------------------------

export type { ProjectKind, ProjectStatus } from '@erp/shared';

export interface ProjectListRow {
  id: string;
  code: string;
  name: string;
  kind: 'own' | 'contract';
  status: 'planned' | 'active' | 'on_hold' | 'completed' | 'cancelled';
  clientPartyId: string | null;
  clientName: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  wbsCount: number;
}

export interface ProjectDetail extends Omit<ProjectListRow, 'wbsCount'> {
  description: string | null;
  clientCode: string | null;
  wbsCount: number;
  budgetCount: number;
  /** Projeye etiketli maliyet/gelir satırı var (silinemez/iptal edilemez). */
  hasPostings: boolean;
}

export interface ProjectWbsRow {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  depth: number;
  isLeaf: boolean;
  /** Maliyet, bütçe veya ilerleme kaydı var (alt iş eklenemez, silinemez). */
  hasPostings: boolean;
}

export interface ProjectMetrics {
  budget: string;
  actual: string;
  remaining: string;
  spentPct: string | null;
  percent: string | null;
  earnedValue: string;
  hasProgress: boolean;
  etc: string;
  eac: string;
  variance: string;
  cpi: string | null;
}

export interface ProjectCostRow extends ProjectMetrics {
  wbsId: string | null;
  parentId: string | null;
  code: string;
  name: string;
  depth: number;
  isLeaf: boolean;
  isActive: boolean;
  unassigned: boolean;
  progress: { percent: string; etcOverride: string | null; asOfDate: string; note: string | null } | null;
  revenue: string;
  /** Kalan taahhüt (yürürlükteki taşeron sözleşmeleri); EAC/CPI'ya girmez. */
  committed: string;
  actualPlusCommitted: string;
}

export interface ProjectCostReport {
  project: { id: string; code: string; name: string; kind: 'own' | 'contract'; status: string };
  asOf: string;
  budget: { id: string; revisionNo: number; approvedAt: string } | null;
  rows: ProjectCostRow[];
  totals: ProjectMetrics & { revenue: string; committed: string; actualPlusCommitted: string };
  commitments: { contracts: number; orders: number; missingRate: number };
  /** Bekleyen değişiklik emirleri: bilgi amaçlı, taahhüde/EAC'ye/gelire girmez. */
  pendingVariations: { cost: string; revenue: string; count: number; missingRate: number };
}

export interface ProjectBudgetRow {
  id: string;
  revisionNo: number;
  status: 'draft' | 'approved' | 'superseded';
  title: string | null;
  approvedAt: string | null;
  createdAt: string;
  lineCount: number;
  total: string;
  isCurrent: boolean;
}

export interface ProjectBudgetDetail {
  budget: { id: string; projectId: string; revisionNo: number; status: 'draft' | 'approved' | 'superseded'; title: string | null; approvedAt: string | null; total: string };
  lines: { id: string; wbsId: string; wbsCode: string; wbsName: string; amount: string }[];
}

export interface ProjectProgressOverview {
  asOf: string;
  latest: { wbsId: string; percent: string; etcOverride: string | null; asOfDate: string; note: string | null }[];
  history: { id: string; wbsId: string; wbsCode: string; wbsName: string; asOfDate: string; percent: string; etcOverride: string | null; note: string | null; createdAt: string }[];
}

export interface ProjectTransactionsData {
  transactions: {
    lineId: string;
    entryId: string;
    entryNo: string | null;
    date: string;
    description: string | null;
    accountCode: string;
    accountName: string;
    debitBase: string;
    creditBase: string;
    side: 'cost' | 'revenue';
    wbsId: string | null;
    wbsCode: string | null;
    wbsName: string | null;
    sourceType: string | null;
    reversalOfId: string | null;
  }[];
  total: number;
  costNet: string;
  revenueNet: string;
}

export interface ProjectsSummary {
  asOf: string;
  projects: (Pick<ProjectCostReport['project'], 'id' | 'code' | 'name' | 'kind' | 'status'> &
    Pick<ProjectMetrics, 'budget' | 'actual' | 'remaining' | 'percent' | 'etc' | 'eac' | 'variance' | 'cpi'> & { budgetRevision: number | null; revenue: string })[];
  totals: Pick<ProjectMetrics, 'budget' | 'actual' | 'remaining' | 'percent' | 'etc' | 'eac' | 'variance' | 'cpi'>;
  allocatedCost: string;
  unallocatedCost: string;
  ledgerCost: string;
}

export interface ProjectOption {
  id: string;
  code: string;
  name: string;
  kind: 'own' | 'contract';
  status: string;
  wbs: { id: string; code: string; name: string }[];
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
  'construction.subcontracts': 'modules.constructionSubcontracts',
  'construction.procurement': 'modules.constructionProcurement',
  'construction.realestate': 'modules.constructionRealestate',
  'retail.pos': 'modules.retailPos',
} as const;

// --- Taşeron ve hakediş (B2) ---------------------------------------------------------------

export interface CostCode {
  id: string;
  code: string;
  name: string;
  kind: 'material' | 'labor' | 'subcontract' | 'equipment' | 'transport' | 'overhead' | 'fee' | 'other';
  isActive: boolean;
}

export interface ProjectCostByCode {
  project: { id: string; code: string; name: string };
  asOf: string;
  rows: { costCodeId: string | null; code: string | null; name: string; actual: string; share: string }[];
  total: string;
}

export type SubcontractStatus = 'draft' | 'active' | 'completed' | 'terminated';

export type ContractDirection = 'payable' | 'receivable';

export interface SubcontractRow {
  id: string;
  direction: ContractDirection;
  code: string;
  title: string;
  status: SubcontractStatus;
  currencyCode: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  partyId: string;
  partyName: string;
  startDate: string | null;
  endDate: string | null;
  contractAmount: string;
}

export interface SubcontractRevisionRow {
  id: string;
  revisionNo: number;
  status: 'draft' | 'approved' | 'superseded';
  title: string | null;
  approvedAt: string | null;
  createdAt: string;
  total: string;
  isCurrent: boolean;
  variationId: string | null;
  variationCode: string | null;
  variationStatus: VariationStatus | null;
}

export interface SubcontractDetail {
  subcontract: {
    id: string;
    direction: ContractDirection;
    code: string;
    projectId: string;
    partyId: string;
    title: string;
    currencyCode: string;
    startDate: string | null;
    endDate: string | null;
    paymentDays: number;
    retentionPct: string;
    advanceRecoupPct: string;
    withholdingPct: string;
    penaltyNote: string | null;
    status: SubcontractStatus;
    projectCode: string;
    projectName: string;
    partyCode: string;
    partyName: string;
    contractAmount: string;
    /** İlk onaylı revizyonun bedeli; uygulanan ve bekleyen değişiklik emri farkları; uygulanan süre uzatımı. */
    originalAmount: string;
    appliedVariations: string;
    pendingVariations: string;
    pendingCount: number;
    extensionDays: number;
  };
  revisions: SubcontractRevisionRow[];
}

export type VariationStatus = 'draft' | 'submitted' | 'awaiting_client' | 'applied' | 'rejected' | 'cancelled';
export type VariationReason = 'client_request' | 'design_change' | 'site_condition' | 'omission_error' | 'other';

export interface VariationRow {
  id: string;
  code: string;
  title: string;
  reason: VariationReason;
  status: VariationStatus;
  direction: ContractDirection;
  subcontractId: string;
  subcontractCode: string;
  currencyCode: string;
  partyName: string;
  projectId: string;
  projectCode: string;
  timeExtensionDays: number;
  amountDelta: string | null;
  createdAt: string;
  appliedAt: string | null;
  clientReference: string | null;
}

export interface VariationLine {
  lineKey: string;
  lineNo: number;
  itemNo: string | null;
  description: string;
  unit: string;
  oldQty: string | null;
  oldPrice: string | null;
  oldAmount: string | null;
  newQty: string | null;
  newPrice: string | null;
  newAmount: string | null;
  delta: string;
  change: 'added' | 'removed' | 'changed' | 'same';
}

export interface VariationDetail {
  variation: {
    id: string;
    code: string;
    title: string;
    reason: VariationReason;
    description: string | null;
    status: VariationStatus;
    direction: ContractDirection;
    subcontractId: string;
    projectId: string;
    revisionId: string | null;
    baseRevisionId: string;
    timeExtensionDays: number;
    previousEndDate: string | null;
    newEndDate: string | null;
    projectedEndDate: string | null;
    amountBefore: string;
    amountAfter: string;
    amountDelta: string;
    submittedAt: string | null;
    approvedAt: string | null;
    clientAcceptedAt: string | null;
    clientReference: string | null;
    appliedAt: string | null;
    rejectionNote: string | null;
    createdAt: string;
    subcontractCode: string;
    subcontractTitle: string;
    currencyCode: string;
    contractEndDate: string | null;
    subcontractStatus: SubcontractStatus;
    partyName: string;
    projectCode: string;
    projectName: string;
    revisionNo: number | null;
    baseRevisionNo: number;
  };
  lines: VariationLine[];
  approvals: ApprovalRequestRow[];
}

export interface BoqLineRow {
  id: string;
  lineKey: string;
  lineNo: number;
  itemNo: string | null;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  wbsId: string;
  wbsCode: string;
  wbsName: string;
  costCodeId: string | null;
  costCode: string | null;
}

export interface SubcontractRevisionDetail {
  revision: { id: string; subcontractId: string; revisionNo: number; status: 'draft' | 'approved' | 'superseded'; title: string | null; approvedAt: string | null; total: string };
  lines: BoqLineRow[];
}

export interface SubcontractBalances {
  advanceGiven: string;
  advanceRecouped: string;
  advanceBalance: string;
  retentionHeld: string;
  retentionReleased: string;
  retentionBalance: string;
  certifiedGross: string;
}

export type ProgressStatus = 'draft' | 'submitted' | 'posted' | 'cancelled';

export interface ProgressRow {
  id: string;
  direction: ContractDirection;
  number: string | null;
  paymentNo: number;
  status: ProgressStatus;
  periodEnd: string;
  subcontractId: string;
  subcontractCode: string;
  partyName: string;
  projectId: string;
  projectCode: string;
  currencyCode: string;
  gross: string;
  net: string;
}

export interface ApprovalStepRow {
  id: string;
  stepNo: number;
  approverRole: string | null;
  approverUserId: string | null;
  label: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface ApprovalRequestRow {
  id: string;
  docType: 'progress_payment' | 'employer_claim' | 'purchase_request' | 'variation_order';
  docId: string;
  amount: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedAt: string;
  completedAt: string | null;
  steps: ApprovalStepRow[];
}

export interface ProgressDetail {
  payment: {
    id: string;
    direction: ContractDirection;
    subcontractId: string;
    subcontractCode: string;
    subcontractTitle: string;
    projectId: string;
    projectCode: string;
    partyId: string;
    partyName: string;
    paymentNo: number;
    number: string | null;
    periodEnd: string;
    status: ProgressStatus;
    currencyCode: string;
    fxRate: string | null;
    vatCode: string | null;
    vatRate: string;
    retentionPct: string;
    advancePct: string;
    withholdingPct: string;
    gross: string;
    vat: string;
    retention: string;
    advance: string;
    withholding: string;
    otherDeductions: string;
    net: string;
    note: string | null;
    rejectionNote: string | null;
    entryId: string | null;
    cancelReason: string | null;
  };
  lines: { id: string; lineKey: string; lineNo: number; itemNo: string | null; description: string; unit: string; unitPrice: string; prevQty: string; cumQty: string; thisQty: string; amount: string; wbsCode: string; costCode: string | null }[];
  deductions: { id: string; description: string; amount: string }[];
  approvals: ApprovalRequestRow[];
}

export interface ConstructionParam {
  id: string;
  kind: 'retention_pct' | 'withholding_pct' | 'advance_recoup_pct';
  value: string;
  validFrom: string;
  validTo: string | null;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface ApprovalRuleRow {
  id: string;
  docType: 'progress_payment' | 'employer_claim' | 'purchase_request';
  projectId: string | null;
  minAmount: string;
  maxAmount: string | null;
  separateRequester: boolean;
  isActive: boolean;
  steps: { id: string; stepNo: number; approverRole: string | null; approverUserId: string | null; label: string | null }[];
}

export interface EmployerSummary {
  subcontractId: string;
  code: string;
  title: string;
  status: SubcontractStatus;
  currencyCode: string;
  contractAmount: string;
  claimCount: number;
  cumulativeGross: string;
  thisPeriodGross: string;
  previousGross: string;
  remainingContract: string;
  billedNet: string;
  collected: string;
  outstanding: string;
  retentionBalance: string;
  advanceBalance: string;
}

// --- Satın alma zinciri ---------------------------------------------------------------------------------

export type PurchaseRequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'ordered' | 'cancelled';
export type PurchaseOrderStatus = 'draft' | 'issued' | 'closed' | 'cancelled';
export type RfqStatus = 'open' | 'awarded' | 'cancelled';

export interface PurchaseRequestRow {
  id: string;
  code: string;
  title: string;
  status: PurchaseRequestStatus;
  needDate: string | null;
  projectId: string;
  projectCode: string;
  lineCount: number;
  estimatedTotal: string;
}

export interface PurchaseRequestLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemCode: string | null;
  description: string;
  unit: string;
  quantity: string;
  estUnitPrice: string | null;
  wbsId: string | null;
  wbsCode: string | null;
  wbsName: string | null;
}

export interface PurchaseRequestDetail {
  request: {
    id: string;
    code: string;
    title: string;
    status: PurchaseRequestStatus;
    needDate: string | null;
    note: string | null;
    rejectionNote: string | null;
    projectId: string;
    projectCode: string;
    projectName: string;
    estimatedTotal: string;
  };
  lines: PurchaseRequestLine[];
  approvals: ApprovalRequestRow[];
  rfq: { id: string; code: string; status: RfqStatus } | null;
  orders: { id: string; code: string; status: PurchaseOrderStatus }[];
}

export interface RfqListRow {
  id: string;
  code: string;
  status: RfqStatus;
  dueDate: string | null;
  requestId: string;
  requestCode: string;
  title: string;
  projectCode: string;
  offerCount: number;
}

export interface RfqOfferRow {
  id: string;
  partyId: string;
  partyName: string;
  currencyCode: string;
  deliveryDays: number | null;
  paymentDays: number;
  note: string | null;
  complete: boolean;
  pricedCount: number;
  total: string;
  totalBase: string | null;
  prices: Record<string, string | null>;
  awarded: boolean;
}

export interface RfqDetail {
  rfq: { id: string; code: string; status: RfqStatus; dueDate: string | null; note: string | null; requestId: string; requestCode: string; requestTitle: string; projectId: string; projectCode: string; awardedOfferId: string | null };
  lines: { id: string; lineNo: number; description: string; unit: string; quantity: string; estUnitPrice: string | null }[];
  offers: RfqOfferRow[];
  cheapestOfferId: string | null;
  fastestOfferId: string | null;
  baseCurrency: string;
}

export interface PurchaseOrderRow {
  id: string;
  code: string;
  status: PurchaseOrderStatus;
  projectId: string;
  projectCode: string;
  partyId: string;
  partyName: string;
  currencyCode: string;
  net: string;
  orderedQty: string;
  receivedQty: string;
}

export interface PurchaseOrderLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemCode: string | null;
  itemKind: string | null;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  wbsId: string | null;
  wbsCode: string | null;
  receivedQty: string;
  invoicedQty: string;
  remainingQty: string;
}

export interface PurchaseOrderDetail {
  order: {
    id: string;
    code: string;
    status: PurchaseOrderStatus;
    projectId: string;
    projectCode: string;
    projectName: string;
    partyId: string;
    partyName: string;
    requestId: string | null;
    requestCode: string | null;
    currencyCode: string;
    vatCode: string | null;
    vatRate: string;
    paymentDays: number;
    deliveryLocation: string | null;
    note: string | null;
    cancelReason: string | null;
    net: string;
    vat: string;
    gross: string;
    receiptState: 'none' | 'partial' | 'complete';
  };
  lines: PurchaseOrderLine[];
  receipts: { id: string; receiptNo: string; receiptDate: string; status: 'posted' | 'cancelled'; note: string | null; deliveryNoteId: string | null; cancelReason: string | null }[];
  invoices: { id: string; invoiceNo: string | null; externalNo: string | null; invoiceDate: string; status: string; grossTotal: string }[];
}

export type MatchFlag = 'over_received' | 'over_ordered' | 'price_variance';
export interface MatchRow {
  lineNo: number;
  poLineId: string;
  orderCode: string;
  orderLineNo: number;
  description: string;
  orderedQty: string;
  receivedQty: string;
  invoicedBeforeQty: string;
  invoiceQty: string;
  orderPrice: string;
  invoicePrice: string;
  priceDiffPct: string | null;
  flags: MatchFlag[];
}
export interface InvoiceableOrderLine {
  lineId: string;
  orderId: string;
  orderCode: string;
  orderDate: string;
  projectId: string;
  lineNo: number;
  itemId: string | null;
  description: string;
  unit: string;
  wbsId: string | null;
  vatCode: string | null;
  orderedQty: string;
  unitPrice: string;
  receivedQty: string;
  invoicedQty: string;
}
export interface OrderMatchRow {
  id: string;
  code: string;
  status: string;
  projectCode: string;
  partyName: string;
  currencyCode: string;
  orderedAmount: string;
  receivedAmount: string;
  invoicedAtOrderPrice: string;
  uninvoicedReceiptAmount: string;
  hasExcess: boolean;
}

// --- Gayrimenkul satışı (B3) ----------------------------------------------------------------------------

export type UnitStatus = 'available' | 'reserved' | 'sold' | 'handed_over';
export type SalesContractStatus = 'draft' | 'active' | 'handed_over' | 'terminated' | 'cancelled';
export type UnitType = 'apartment' | 'villa' | 'shop' | 'office' | 'land' | 'parking' | 'storage' | 'other';

export interface UnitRow {
  id: string;
  projectId: string;
  projectCode: string;
  block: string;
  floor: number | null;
  unitNo: string;
  unitType: UnitType;
  grossM2: string | null;
  netM2: string | null;
  rooms: string | null;
  listPrice: string | null;
  listCurrency: string | null;
  status: UnitStatus;
  note: string | null;
  contractId: string | null;
  contractCode: string | null;
  contractStatus: SalesContractStatus | null;
  buyerName: string | null;
}

export interface SalesContractRow {
  id: string;
  code: string;
  status: SalesContractStatus;
  contractDate: string;
  currencyCode: string;
  price: string;
  projectCode: string;
  block: string;
  unitNo: string;
  partyName: string;
  installmentCount: number;
}

export interface SalesInstallmentRow {
  id: string;
  seq: number;
  kind: 'down_payment' | 'installment' | 'balloon' | 'fee';
  label?: string | null;
  feeScheduleId?: string | null;
  dueDate: string;
  amount: string;
  journalLineId: string | null;
  paid: string;
  remaining: string;
  daysOverdue: number;
}

export interface SalesContractDetail {
  contract: {
    id: string;
    code: string;
    status: SalesContractStatus;
    contractDate: string;
    plannedHandover: string | null;
    currencyCode: string;
    price: string;
    downPayment: string;
    activatedOn: string | null;
    activationFx: string | null;
    handedOverOn: string | null;
    terminatedOn: string | null;
    cancelReason: string | null;
    penaltyNote: string | null;
    projectId: string;
    projectCode: string;
    projectName: string;
    unitId: string;
    block: string;
    floor: number | null;
    unitNo: string;
    unitType: UnitType;
    grossM2: string | null;
    partyId: string;
    partyName: string;
    paid: string;
    remaining: string;
    overdue: string;
    feesTotal: string;
    feesPaid: string;
    feesRemaining: string;
    activationEntryId: string | null;
    handoverEntryId: string | null;
  };
  installments: SalesInstallmentRow[];
  termination: { terminationDate: string; reason: string; collected: string; retained: string; refund: string; refundAccountId: string | null } | null;
}

export interface DueInstallmentRow {
  id: string;
  contractId: string;
  contractCode: string;
  partyName: string;
  projectCode: string;
  block: string;
  unitNo: string;
  currencyCode: string;
  seq: number;
  kind: string;
  dueDate: string;
  amount: string;
  remaining: string;
  daysOverdue: number;
}

export interface SalesSummary {
  units: Record<UnitStatus, { count: number; grossM2: string }>;
  byCurrency: { currencyCode: string; contracts: number; price: string; collected: string; remaining: string; overdue: string }[];
}

export interface FeeSchedule {
  id: string;
  code: string;
  name: string;
  side: 'buyer' | 'project';
  basis: 'per_unit' | 'per_m2' | 'pct_of_price' | 'fixed';
  amount: string;
  currencyCode: string | null;
  validFrom: string;
  validTo: string | null;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface FeeEstimate {
  asOf: string;
  baseCurrency: string;
  units: number;
  grossM2: string;
  rows: { id: string; code: string; name: string; basis: FeeSchedule['basis']; rate: string; currencyCode: string | null; basisValue: string; estimate: string; verified: boolean }[];
  estimate: string;
  actual: string;
  remaining: string;
  missingRate: number;
}
