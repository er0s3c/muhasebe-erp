/** API yanıt tipleri (sunucu Drizzle satırlarının JSON hâli). Tutarlar her zaman string. */
import type {
  AttendanceDayType,
  BankGuaranteeStatus,
  ChequeAction,
  ChequeDirection,
  ChequeDocType,
  ChequeStatus,
  GuaranteeDirection,
  GuaranteeExpiryState,
  MaturityBucket,
} from '@erp/shared';

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

export type PartyKind = 'customer' | 'supplier' | 'both' | 'employee';

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
  tracksSerial: boolean;
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
  tracksSerial: boolean;
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
  /** Seri takipli kartta satıra girilen seri no'lar (X3). */
  serials?: string[];
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
  salesOrderLineId: string | null;
  salesOrderId: string | null;
  salesOrderNo: string | null;
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

export type DeliveryNoteType = 'sales' | 'purchase' | 'sales_return' | 'purchase_return';
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
  /** İade irsaliyesinde orijinal satır; orijinal irsaliyede iade edilen/edilebilir miktar (kaydedilmişse). */
  sourceLineId: string | null;
  returnedQty: string | null;
  returnableQty: string | null;
  salesOrderLineId: string | null;
  salesOrderId: string | null;
  salesOrderNo: string | null;
  /** Seri takipli kartta satıra girilen seri no'lar (X3). */
  serials: string[];
}

export interface DeliveryNoteDetail {
  note: {
    id: string;
    type: DeliveryNoteType;
    status: DeliveryNoteStatus;
    noteNo: string | null;
    externalNo: string | null;
    returnOfId: string | null;
    returnOfNo: string | null;
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
  /** Orijinal irsaliyede: bu irsaliyeye kesilmiş iade irsaliyeleri. */
  returns: { id: string; noteNo: string | null; status: DeliveryNoteStatus }[];
}

/** İade edilebilecek orijinal irsaliye satırı. */
export interface ReturnableLine {
  lineId: string;
  lineNo: number;
  noteId: string;
  noteNo: string;
  noteDate: string;
  itemId: string;
  itemCode: string;
  description: string;
  unit: string | null;
  quantity: string;
  returnedQty: string;
  returnableQty: string;
  invoicedQty: string;
}

// --- Satış teklifi ve siparişi (X2) ---------------------------------------

export type SalesDocKind = 'quote' | 'order';
export type SalesDocStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'converted' | 'confirmed' | 'closed' | 'cancelled';
export type FulfilmentState = 'none' | 'partial' | 'full';
export interface Fulfilment {
  delivery: FulfilmentState | null;
  invoicing: FulfilmentState;
}

export interface SalesDocListRow {
  id: string;
  kind: SalesDocKind;
  status: SalesDocStatus;
  docNo: string | null;
  docDate: string;
  validUntil: string | null;
  deliveryDate: string | null;
  partyId: string;
  partyCode: string;
  partyName: string;
  currencyCode: string;
  grossTotal: string;
  quoteId: string | null;
  expired: boolean;
  fulfilment: Fulfilment | null;
}

export interface SalesDocLine {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemCode: string | null;
  isGoods: boolean;
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
  /** Yalnızca siparişte. */
  delivered?: string;
  invoiced?: string;
  remainingDeliverable?: string;
  remainingInvoiceable?: string;
  deliveredNotInvoiced?: string;
}

export interface SalesDocDetail {
  doc: {
    id: string;
    kind: SalesDocKind;
    status: SalesDocStatus;
    docNo: string | null;
    partyId: string;
    partyCode: string;
    partyName: string;
    docDate: string;
    validUntil: string | null;
    deliveryDate: string | null;
    currencyCode: string;
    vatIncluded: boolean;
    warehouseId: string | null;
    warehouseName: string | null;
    notes: string | null;
    quoteId: string | null;
    quoteNo: string | null;
    orderId: string | null;
    orderNo: string | null;
    netTotal: string;
    vatTotal: string;
    grossTotal: string;
    expired: boolean;
    fulfilment: Fulfilment | null;
  };
  lines: SalesDocLine[];
  events: { fromStatus: string | null; toStatus: string; reason: string | null; createdAt: string; userName: string | null }[];
  notes: { id: string; noteNo: string | null; status: DeliveryNoteStatus; noteDate: string }[];
  invoices: { id: string; invoiceNo: string | null; status: InvoiceStatus; invoiceDate: string }[];
}

// --- Toplu faturalama (X2) -------------------------------------------------

export interface BatchPreviewNote {
  noteId: string;
  noteNo: string | null;
  noteDate: string;
  currency: string;
  blocked: boolean;
  issues: { code: string; message: string }[];
  net: string;
  vat: string;
  gross: string;
  lines: { lineId: string; itemCode: string; description: string; unit: string | null; quantity: string; unitPrice: string | null; discountPct: string; vatCode: string | null; priceSource: 'order' | 'item' | null }[];
}

export interface BatchPreview {
  grouping: 'party' | 'note';
  parties: { partyId: string; partyCode: string; partyName: string; notes: BatchPreviewNote[]; invoiceCount: number; pendingReturns: number }[];
  totals: { notes: number; invoiceable: number; invoices: number };
}

export interface BatchResult {
  batchId: string;
  created: { partyId: string; partyName: string; invoiceId: string; invoiceNo: string | null; status: string; noteIds: string[]; gross: string }[];
  failed: { partyId: string; partyName: string; noteIds: string[]; code: string; message: string }[];
  skipped: { noteId: string; reason: string }[];
}

export interface BatchHistoryRow {
  id: string;
  invoiceDate: string;
  grouping: 'party' | 'note';
  post: boolean;
  invoicesCreated: number;
  invoicesFailed: number;
  createdAt: string;
  userName: string | null;
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
  'hr.core': 'modules.hrCore',
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
    vatWithholdingPct: string;
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
  /** Taşerona verilen malzeme bedeli, hakedişlerde mahsup edilen ve kalan. */
  materialGiven: string;
  materialRecouped: string;
  materialBalance: string;
}

export interface MaterialIssueRow {
  id: string;
  issueDate: string;
  amount: string;
  amountBase: string;
  note: string | null;
  stockDocumentId: string;
  docNo: string;
  description: string | null;
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
    vatWithholdingPct: string;
    gross: string;
    vat: string;
    vatWithholding: string;
    retention: string;
    advance: string;
    withholding: string;
    material: string;
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

// --- İnsan kaynakları ve kişisel veri (Faz D1) ---

export type EmployeeStatus = 'active' | 'left';

export interface EmployeeRow {
  id: string;
  code: string;
  fullName: string;
  nationality: string | null;
  idKind: 'national_id' | 'passport' | null;
  hasId: boolean;
  idMasked: string | null;
  hasBirthDate: boolean;
  birthDateMasked: string | null;
  hasIban: boolean;
  ibanMasked: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  hireDate: string | null;
  leaveDate: string | null;
  status: EmployeeStatus;
  department: string | null;
  jobTitle: string | null;
  projectId: string | null;
  projectCode: string | null;
  /** Personel carisi (Faz X5); yalnızca bağlantı. */
  partyId: string | null;
  note: string | null;
  createdAt: string;
}

export type SensitiveField = 'id_number' | 'birth_date' | 'iban';

export interface InventoryRow {
  id: string;
  key: string;
  tableName: string;
  fieldName: string;
  category: 'identity' | 'contact' | 'financial' | 'employment' | 'other';
  purpose: string;
  legalBasis: string;
  retention: string | null;
  isSensitive: boolean;
  transferAbroad: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  note: string | null;
}

export interface DsrRow {
  id: string;
  kind: 'access' | 'export' | 'correction' | 'erasure';
  status: 'open' | 'completed' | 'rejected';
  requesterName: string;
  description: string | null;
  resolutionNote: string | null;
  openedAt: string;
  resolvedAt: string | null;
  employeeId: string | null;
  employeeCode: string | null;
  employeeName: string | null;
  contactId: string | null;
  contactName: string | null;
}

export interface AccessLogRow {
  id: string;
  field: SensitiveField | 'export' | 'directory_export' | 'directory_anonymize';
  reason: string;
  at: string;
  employeeId: string | null;
  employeeCode: string | null;
  employeeName: string | null;
  contactId: string | null;
  contactName: string | null;
  by: string;
}

// --- Puantaj (Faz D2) ---

export interface AttendanceEmployee {
  id: string;
  code: string;
  fullName: string;
  status: EmployeeStatus;
  department: string | null;
  jobTitle: string | null;
  hireDate: string | null;
  leaveDate: string | null;
  projectId: string | null;
}

export interface AttendanceEntryRow {
  id: string;
  employeeId: string;
  workDate: string;
  dayType: AttendanceDayType;
  normalHours: string;
  overtimeHours: string;
  projectId: string | null;
  projectCode: string | null;
  wbsId: string | null;
  wbsCode: string | null;
  costCodeId: string | null;
  costCode: string | null;
  note: string | null;
}

export interface AttendanceLock {
  month: string;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  reopenCount: number;
}

export interface AttendanceSheetData {
  month: string;
  start: string;
  end: string;
  lock: AttendanceLock;
  employees: AttendanceEmployee[];
  entries: AttendanceEntryRow[];
  missingHireDate: number;
}

export interface AttendanceSummaryRow {
  employeeId: string;
  code: string;
  fullName: string;
  department: string | null;
  status: EmployeeStatus;
  hireDate: string | null;
  leaveDate: string | null;
  days: Record<AttendanceDayType, number>;
  entryDays: number;
  missingDays: number;
  normalHours: string;
  overtimeHours: string;
}

export interface AttendanceSummary {
  month: string;
  lock: AttendanceLock;
  rows: AttendanceSummaryRow[];
  totals: { normalHours: string; overtimeHours: string; missingDays: number };
}

export interface AttendanceLaborRow {
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  costCode: string | null;
  costCodeName: string | null;
  personDays: number;
  employees: number;
  normalHours: string;
  overtimeHours: string;
}

export interface AttendanceLabor {
  from: string;
  to: string;
  rows: AttendanceLaborRow[];
  totals: { personDays: number; normalHours: string; overtimeHours: string };
}

// --- Bordro (Faz D3) ---

import type { PayrollParamKey, PayrollWarningCode } from '@erp/shared';

export type PayrollRunStatus = 'draft' | 'approved' | 'paid' | 'cancelled';
export type PayBasisKind = 'monthly' | 'daily' | 'hourly';

export interface PayrollParamRow {
  id: string;
  key: PayrollParamKey;
  value: string;
  effectiveFrom: string;
  enabled: boolean;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  supersedesId: string | null;
}

export interface PayrollItemRow {
  id: string;
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  affectsSocialBase: boolean;
  affectsTaxBase: boolean;
  liability: 'tax' | 'social' | 'other';
  isActive: boolean;
}

export interface PayTermRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  effectiveFrom: string;
  payBasis: PayBasisKind;
  amount: string;
  note: string | null;
}

export interface PayrollRunRow {
  id: string;
  number: string;
  month: string;
  description: string | null;
  status: PayrollRunStatus;
  employeeCount: number;
  grossTotal: string;
  deductionsTotal: string;
  netTotal: string;
  employerTotal: string;
  paramsSnapshot: { key: PayrollParamKey; value: string; verified: boolean; paramId: string }[];
  hasUnverifiedParams: boolean;
  calculatedAt: string | null;
  entryId: string | null;
  entryNo?: string | null;
  reversalEntryId: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  paidNote: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface PayrollWarningRow {
  code: PayrollWarningCode;
  keys?: PayrollParamKey[];
  count?: number;
}

export interface PayrollLineItemRow {
  kind: 'earning' | 'deduction' | 'employer';
  source: 'manual' | 'param';
  code: string;
  label: string;
  amount: string;
  liability: string | null;
  paramKey: PayrollParamKey | null;
  rate: string | null;
}

export interface PayrollLineRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  jobTitle: string | null;
  ibanMasked: string | null;
  payBasis: PayBasisKind;
  rate: string;
  normalHours: string;
  overtimeHours: string;
  hourDays: number;
  annualLeaveDays: number;
  sickLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  scheduledPay: string;
  absenceDeduction: string;
  basePay: string;
  overtimePay: string;
  earningsTotal: string;
  gross: string;
  socialBase: string;
  taxBase: string;
  employeeSocial: string;
  incomeTax: string;
  otherDeductions: string;
  deductionsTotal: string;
  net: string;
  employerSocial: string;
  employerOther: string;
  employerTotal: string;
  warnings: PayrollWarningRow[];
  items: PayrollLineItemRow[];
  allocations: { projectCode: string | null; wbsCode: string | null; costCode: string | null; hours: string; grossAmount: string; employerAmount: string }[];
}

export interface PayrollAdjustmentRow {
  id: string;
  employeeId: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  kind: 'earning' | 'deduction';
  amount: string;
  note: string | null;
}

export interface PayrollRunDetail {
  run: PayrollRunRow;
  lines: PayrollLineRow[];
  adjustments: PayrollAdjustmentRow[];
  missingTerms: { id: string; code: string; fullName: string }[];
  lock: AttendanceLock;
}

export interface PayrollSlip {
  run: PayrollRunRow;
  line: PayrollLineRow;
  lock: AttendanceLock;
  hireDate: string | null;
}

export interface PayrollCostRow {
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  costCode: string | null;
  costCodeName: string | null;
  employees: number;
  hours: string;
  gross: string;
  employer: string;
  total: string;
}

export interface PayrollCostReport {
  from: string;
  to: string;
  rows: PayrollCostRow[];
  months: { month: string; number: string; status: PayrollRunStatus; employeeCount: number; gross: string; deductions: string; net: string; employer: string; cost: string; hasUnverifiedParams: boolean }[];
  totals: { hours: string; gross: string; employer: string; total: string };
  unverified: boolean;
}

// --- Sosyal güvenlik çıktıları (Faz D4) ---

export type SocialDeclarationStatus = 'draft' | 'finalized';
export type SocialWarningCode = 'no_profile' | 'no_ssn' | 'no_payroll_type' | 'insurance_outside_month' | 'zero_base' | 'support_rule_off' | 'no_days';

export interface SocialProfileRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  effectiveFrom: string;
  payrollTypeCode: string | null;
  insuranceStart: string | null;
  insuranceEnd: string | null;
  hasSsn: boolean;
  ssnMasked: string | null;
  note: string | null;
}

export interface SupportRuleRow {
  id: string;
  code: string;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  target: 'employer' | 'employee';
  mode: 'percent_of_premium' | 'fixed_amount';
  value: string;
  enabled: boolean;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface SupportEligibilityRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  ruleCode: string;
  validFrom: string;
  validTo: string | null;
  note: string | null;
}

export interface SocialDeclarationRow {
  id: string;
  number: string;
  month: string;
  status: SocialDeclarationStatus;
  payrollRunId: string;
  payrollRunNumber: string;
  employeeCount: number;
  premiumBaseTotal: string;
  employeePremiumTotal: string;
  employerPremiumTotal: string;
  supportEmployeeTotal: string;
  supportEmployerTotal: string;
  supportSnapshot: { code: string; ruleId: string; name: string; target: string; mode: string; value: string; verified: boolean }[];
  hasUnverifiedParams: boolean;
  finalizedAt: string | null;
  finalizeNote: string | null;
  reopenReason: string | null;
  reopenCount: number;
  payrollRunStatus?: PayrollRunStatus | null;
}

export interface SocialDeclarationLine {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  payrollTypeCode: string | null;
  insuranceStart: string | null;
  insuranceEnd: string | null;
  ssnMasked: string | null;
  daysWorked: number;
  annualLeaveDays: number;
  sickLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  premiumBase: string;
  employeePremium: string;
  employerPremium: string;
  supportEmployee: string;
  supportEmployer: string;
  employeeDue: string;
  employerDue: string;
  supportCodes: string | null;
  warnings: SocialWarningCode[];
}

export interface SocialDeclarationDetail {
  declaration: SocialDeclarationRow;
  lines: SocialDeclarationLine[];
  totals: { count: number; premiumBase: string; employeePremium: string; employerPremium: string; supportEmployee: string; supportEmployer: string; supportTotal: string; employeeDue: string; employerDue: string };
  lock: { closed: boolean };
}

export interface PremiumSummaryReport {
  from: string;
  to: string;
  months: { id: string; number: string; month: string; status: SocialDeclarationStatus; employeeCount: number; premiumBase: string; employeePremium: string; employerPremium: string; supportEmployee: string; supportEmployer: string; employeeDue: string; employerDue: string; hasUnverifiedParams: boolean }[];
  projects: { projectId: string | null; projectCode: string | null; projectName: string | null; employees: number; employeePremium: string; employerPremium: string; supportEmployee: string; supportEmployer: string; employeeDue: string; employerDue: string }[];
  totals: { employeePremium: string; employerPremium: string; supportEmployee: string; supportEmployer: string; employeeDue: string; employerDue: string };
  unverified: boolean;
}

// --- Yabancı işçi belge ve teminat takibi (Faz D5) ---

export type ForeignDocStatus = 'valid' | 'expiring' | 'expired' | 'revoked';
export type GuaranteeStatus = 'held' | 'refunded' | 'forfeited';
export type ForeignParamKey = 'guarantee_amount' | 'expiry_warning_days';

export interface ForeignDocTypeRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface ForeignParamRow {
  id: string;
  key: ForeignParamKey;
  value: string;
  currency: string | null;
  effectiveFrom: string;
  enabled: boolean;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface ForeignDocRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  nationality: string | null;
  typeId: string;
  typeName: string;
  typeCode: string;
  hasNumber: boolean;
  numberMasked: string | null;
  issuingAuthority: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  referenceNote: string | null;
  note: string | null;
  renewalCount: number;
  revokedAt: string | null;
  revokeReason: string | null;
  status: ForeignDocStatus;
  daysToExpiry: number | null;
}

export interface ForeignDocList {
  asOf: string;
  warning: { days: number | null; configured: boolean; verified: boolean };
  summary: Record<ForeignDocStatus, number>;
  docs: ForeignDocRow[];
}

export interface ForeignDocRenewalRow {
  id: string;
  prevIssueDate: string | null;
  prevExpiryDate: string | null;
  prevNumberMasked: string | null;
  newIssueDate: string | null;
  newExpiryDate: string | null;
  newNumberMasked: string | null;
  note: string | null;
  renewedAt: string;
}

export interface GuaranteeRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  docId: string | null;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  amount: string;
  currency: string;
  paramVerified: boolean;
  depositedDate: string;
  depositReference: string | null;
  status: GuaranteeStatus;
  resolvedDate: string | null;
  resolutionNote: string | null;
}

export interface GuaranteeReport {
  byEmployee: { employeeId: string; employeeCode: string; employeeName: string; projectCode: string | null; projectName: string | null; currency: string; count: number; amount: string; unverified: number }[];
  byProject: { projectId: string | null; projectCode: string | null; projectName: string | null; currency: string; employees: number; count: number; amount: string; unverified: number }[];
  totals: { currency: string; held: string; refunded: string; forfeited: string }[];
  unverified: boolean;
}

// --- Çek/senet portföyü ve banka teminat mektubu (Faz X1) -----------------------------------------------------

export interface ChequeRow {
  id: string;
  direction: ChequeDirection;
  docType: ChequeDocType;
  docNo: string;
  bankName: string;
  branch: string | null;
  partyId: string;
  partyCode: string;
  partyName: string;
  amount: string;
  currencyCode: string;
  issueDate: string;
  dueDate: string;
  status: ChequeStatus;
  holderPartyId: string | null;
  holderName: string | null;
  bankAccountId: string | null;
  bankAccountName: string | null;
  description: string | null;
  entryId: string;
  entryNo: string | null;
  lastEventDate: string | null;
}

export interface ChequeList {
  cheques: ChequeRow[];
  summary: { direction: ChequeDirection; status: ChequeStatus; count: number; amount: string }[];
  asOf: string;
}

export interface ChequeEventRow {
  id: string;
  fromStatus: ChequeStatus | null;
  toStatus: ChequeStatus;
  eventDate: string;
  note: string | null;
  batchNo: string | null;
  action: string | null;
  entryNo: string | null;
  entryId: string;
  partyName: string | null;
  bankAccountName: string | null;
}

export interface ChequeDetail {
  cheque: ChequeRow;
  events: ChequeEventRow[];
}

export interface ChequeBatchRow {
  id: string;
  batchNo: string;
  action: ChequeAction;
  eventDate: string;
  total: string;
  docCount: number;
  bankAccountName: string | null;
  partyName: string | null;
  entryNo: string | null;
  entryId: string;
  note: string | null;
}

export interface ChequeActionResult {
  batch: { id: string; batchNo: string; action: ChequeAction; eventDate: string; total: string; docCount: number; entryId: string };
  cheques: ChequeRow[];
}

export interface ChequeMaturityDirection {
  count: number;
  amount: string;
  buckets: { bucket: MaturityBucket; count: number; amount: string }[];
}
export interface ChequeMaturity {
  asOf: string;
  received: ChequeMaturityDirection;
  issued: ChequeMaturityDirection;
  byParty: { direction: ChequeDirection; partyId: string; partyName: string; count: number; amount: string; overdue: string; earliestDue: string }[];
}

export interface ChequeDueReport {
  from: string;
  to: string;
  days: number;
  rows: { id: string; direction: ChequeDirection; docType: ChequeDocType; docNo: string; bankName: string; status: ChequeStatus; partyName: string; dueDate: string; amount: string; overdue: boolean }[];
  totals: { received: string; issued: string };
}

export interface ChequeBouncedReport {
  asOf: string;
  rows: { id: string; direction: ChequeDirection; docType: ChequeDocType; docNo: string; bankName: string; partyName: string; amount: string; dueDate: string; bouncedDate: string | null; daysSince: number | null }[];
  totals: { received: string; issued: string };
}

export interface BankGuaranteeRow {
  id: string;
  direction: GuaranteeDirection;
  letterNo: string;
  bankName: string;
  branch: string | null;
  partyId: string | null;
  counterpartyName: string;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  subcontractId: string | null;
  subcontractCode: string | null;
  purpose: string | null;
  amount: string;
  currencyCode: string;
  issueDate: string;
  expiryDate: string | null;
  commissionRate: string | null;
  commissionAmount: string | null;
  commissionNote: string | null;
  note: string | null;
  status: BankGuaranteeStatus;
  resolvedDate: string | null;
  resolutionNote: string | null;
  expiryState: GuaranteeExpiryState | 'closed';
  daysToExpiry: number | null;
}

export interface BankGuaranteeList {
  guarantees: BankGuaranteeRow[];
  asOf: string;
  warningDays: number | null;
  activeTotals: { direction: GuaranteeDirection; currency: string; count: number; amount: string }[];
  expiring: number;
  lapsed: number;
}

export interface BankGuaranteeReport {
  byBank: { direction: GuaranteeDirection; bankName: string; currency: string; count: number; amount: string; commission: string }[];
  byProject: { direction: GuaranteeDirection; projectId: string | null; projectCode: string | null; projectName: string | null; currency: string; count: number; amount: string }[];
  closed: { direction: GuaranteeDirection; status: BankGuaranteeStatus; currency: string; count: number; amount: string }[];
}


// --- Fiyat listeleri ve seri no (X3) -------------------------------------------

export type PriceKind = 'sales' | 'purchase';
export type PriceSource = 'party_item' | 'party_list' | 'default_list' | 'item_card' | 'none';

export interface PriceListRow {
  id: string;
  code: string;
  name: string;
  kind: PriceKind;
  currencyCode: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  isDefault: boolean;
  notes: string | null;
  itemCount: number;
  partyCount: number;
}

export interface PriceListItemRow {
  id: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  minQty: string;
  price: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface PartyPriceRow {
  id: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  kind: PriceKind;
  currencyCode: string | null;
  price: string | null;
  discountPct: string | null;
  minQty: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface PartyPricing {
  partyId: string;
  salesPriceListId: string | null;
  purchasePriceListId: string | null;
  salesDiscountPct: string;
  purchaseDiscountPct: string;
}

export interface PriceResolution {
  unitPrice: string | null;
  priceSource: PriceSource;
  priceListId: string | null;
  priceListName: string | null;
  discountPct: string;
  discountSource: 'party_item' | 'party_default' | 'none';
  minQty: string | null;
}

export type SerialStatus = 'in_stock' | 'issued' | 'returned' | 'scrapped' | 'void';

export interface SerialRow {
  id: string;
  serialNo: string;
  status: SerialStatus;
  itemId: string;
  itemCode: string;
  itemName: string;
  warehouseId: string | null;
  warehouseName: string | null;
}

export interface SerialHistoryRow {
  id: string;
  event: string;
  fromStatus: string;
  toStatus: string;
  docDate: string;
  stockDocumentId: string;
  stockDocumentNo: string;
  fromWarehouse: string | null;
  toWarehouse: string | null;
  partyName: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceNo: string | null;
}

export interface SerialLookup {
  serials: (SerialRow & { supplier: string | null; customer: string | null; history: SerialHistoryRow[] })[];
}

// --- İthalat maliyet dağıtımı ve gider kartları (Faz X4) -----------------------------------------------------------------

export type ImportFileStatus = 'draft' | 'allocated' | 'posted' | 'cancelled';
export type ImportMethod = 'value' | 'quantity' | 'weight' | 'manual';
export type ImportCostKind = 'freight' | 'insurance' | 'customs_duty' | 'other_tax' | 'brokerage' | 'other';

export interface ImportFileRow {
  id: string;
  code: string;
  name: string;
  reference: string | null;
  status: ImportFileStatus;
  fileDate: string;
  postDate: string | null;
  lineCount: number;
  goodsValue: string;
  costTotal: string;
}

export interface ImportSource {
  kind: 'invoice' | 'delivery';
  sourceLineId: string;
  docNo: string;
  docDate: string;
  partyId: string;
  partyName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  quantity: string;
  value: string;
  usedIn: string | null;
}

export interface ImportFileLine {
  id: string;
  lineNo: number;
  sourceKind: 'invoice' | 'delivery';
  sourceLineId: string;
  sourceDocNo: string;
  sourceDate: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  warehouseName: string;
  quantity: string;
  valueBase: string;
  weight: string | null;
  allocated: string;
  stockedAmount: string | null;
  cogsAmount: string | null;
}

export interface ImportCostLine {
  id: string;
  lineNo: number;
  kind: ImportCostKind;
  kindLabel: string;
  description: string;
  partyId: string | null;
  partyName: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  currencyCode: string;
  amount: string;
  fxRate: string | null;
  amountBase: string;
  method: ImportMethod;
  creditAccountId: string | null;
  creditAccountCode: string | null;
  reference: string | null;
}

export interface ImportFileDetail {
  file: {
    id: string;
    code: string;
    name: string;
    reference: string | null;
    description: string | null;
    method: ImportMethod;
    fileDate: string;
    status: ImportFileStatus;
    postDate: string | null;
    journalEntryId: string | null;
    journalEntryNo: string | null;
    cancelJournalEntryNo: string | null;
    stockDocumentNo: string | null;
    cancelReason: string | null;
  };
  lines: ImportFileLine[];
  costLines: ImportCostLine[];
  allocations: { costLineId: string; fileLineId: string; amount: string }[];
  events: { action: string; fromStatus: string | null; toStatus: string; note: string | null; createdAt: string; userName: string | null }[];
  totals: { goodsValue: string; costTotal: string; landedValue: string };
}

export interface ImportReport {
  file: { id: string; code: string; name: string; reference: string | null; status: ImportFileStatus; statusLabel: string; fileDate: string; postDate: string | null };
  byLine: { lineNo: number; sourceDocNo: string; itemId: string; itemCode: string; itemName: string; unit: string; quantity: string; weight: string | null; goodsValue: string; allocated: string; landedValue: string; unitBefore: string | null; unitAfter: string | null; uplift: string | null; stockedAmount: string | null; cogsAmount: string | null }[];
  byItem: { itemId: string; itemCode: string; itemName: string; unit: string; quantity: string; goodsValue: string; allocated: string; landedValue: string; unitBefore: string | null; unitAfter: string | null }[];
  byCost: { kind: ImportCostKind; kindLabel: string; amount: string }[];
  totals: { goodsValue: string; costTotal: string; landedValue: string; allocated: string };
}

export interface ExpenseCard {
  id: string;
  code: string;
  name: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  taxCode: string | null;
  withholdingRate: string | null;
  projectId: string | null;
  projectCode: string | null;
  wbsId: string | null;
  costCodeId: string | null;
  costCodeCode: string | null;
  notes: string | null;
  isActive: boolean;
  entryCount: number;
}

export interface ExpenseEntry {
  id: string;
  entryNo: string;
  entryDate: string;
  status: 'posted' | 'cancelled';
  description: string;
  cardId: string;
  cardCode: string;
  cardName: string;
  accountCode: string;
  partyId: string | null;
  partyName: string | null;
  paymentKind: 'treasury' | 'party';
  treasuryAccountId: string | null;
  treasuryAccountName: string | null;
  dueDate: string | null;
  net: string;
  vatCode: string | null;
  vatRate: string;
  vat: string;
  withholdingRate: string;
  withholding: string;
  gross: string;
  payable: string;
  documentRef: string | null;
  projectId: string | null;
  projectCode: string | null;
  journalEntryId: string;
  journalEntryNo: string | null;
  cancelReason: string | null;
}

export interface ExpenseGroup {
  count: number;
  net: string;
  vat: string;
  withholding: string;
  gross: string;
}

export interface ExpenseReport {
  from: string;
  to: string;
  totals: ExpenseGroup;
  byCard: (ExpenseGroup & { cardId: string; cardCode: string; cardName: string; accountCode: string })[];
  byMonth: (ExpenseGroup & { month: string })[];
  byProject: (ExpenseGroup & { projectId: string | null; projectCode: string | null; projectName: string | null })[];
  byParty: (ExpenseGroup & { partyId: string | null; partyName: string | null })[];
  top: { id: string; entryNo: string; entryDate: string; description: string; cardName: string; partyName: string | null; net: string; gross: string }[];
}

// --- Personel cari ve avans (Faz X5) ------------------------------------------------------------------------------------

export type AdvanceStatus = 'open' | 'partial' | 'settled' | 'cancelled';

export interface EmployeeBalanceRow {
  employeeId: string;
  code: string;
  fullName: string;
  department: string | null;
  partyId: string | null;
  salaryNet: string;
  salaryPaid: string;
  advanceGiven: string;
  advanceDeducted: string;
  advanceRepaid: string;
  /** Alacak − borç: pozitif ise şirket personele borçlu, negatif ise personel şirkete borçlu. */
  net: string;
  openAdvance: string;
  unpaidSalary: string;
}

export interface EmployeeBalances {
  asOf: string | null;
  rows: EmployeeBalanceRow[];
  totals: { owedToEmployees: string; owedByEmployees: string };
}

export interface AdvanceRegisterRow {
  id: string;
  number: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  advanceDate: string;
  amount: string;
  settled: string;
  open: string;
  purpose: string;
  projectCode: string | null;
  status: AdvanceStatus;
  ageDays: number;
  bucket: 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus';
}

export interface AdvanceRegister {
  asOf: string;
  rows: AdvanceRegisterRow[];
  totals: { open: string; buckets: Record<'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus', string> };
}

export interface AdvanceDetail {
  advance: {
    id: string;
    number: string;
    employeeId: string;
    employeeCode: string;
    employeeName: string;
    advanceDate: string;
    amount: string;
    settledAmount: string;
    openAmount: string;
    purpose: string;
    status: AdvanceStatus;
    projectCode: string | null;
    txnNo: string;
    cancelReason: string | null;
  };
  settlements: { id: string; kind: 'payroll' | 'repayment'; amount: string; settledDate: string; note: string | null; reversedAt: string | null; reverseReason: string | null; runNumber: string | null; txnNo: string | null }[];
  events: { fromStatus: AdvanceStatus | null; toStatus: AdvanceStatus; settledAmount: string; at: string; by: string | null }[];
}

export interface LedgerSettings {
  deductionCapPct: string | null;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface OutstandingAdvance {
  id: string;
  number: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  advanceDate: string;
  amount: string;
  settledAmount: string;
  remaining: string;
  purpose: string;
  status: AdvanceStatus;
}

export interface RunDeductionRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  advanceId: string;
  advanceNumber: string;
  amount: string;
  advanceRemaining: string;
}

export interface EmployeeStatement {
  employee: { id: string; code: string; fullName: string; partyId: string | null; partyCode: string | null };
  from: string;
  to: string;
  opening: string;
  lines: { date: string; kind: 'salary_net' | 'salary_payment' | 'advance' | 'advance_deduction' | 'advance_repayment'; ref: string; description: string; debit: string; credit: string; balance: string }[];
  totals: { debit: string; credit: string };
  closing: string;
  openAdvances: AdvanceRegisterRow[];
}

export interface SalaryPaymentRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  payDate: string;
  amount: string;
  note: string | null;
  txnNo: string;
  txnId: string;
  txnStatus: 'posted' | 'cancelled';
  runNumber: string | null;
}

// --- Rehber, ajanda ve görüşme notları (Faz X6) ---

export interface DirContact {
  id: string;
  fullName: string;
  title: string | null;
  organizationId: string | null;
  organizationName: string | null;
  phone: string | null;
  phone2: string | null;
  email: string | null;
  email2: string | null;
  address: string | null;
  partyId: string | null;
  partyCode: string | null;
  partyName: string | null;
  employeeId: string | null;
  projectId: string | null;
  projectCode: string | null;
  tags: string[];
  note: string | null;
  isArchived: boolean;
  mergedIntoId: string | null;
  anonymizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirDuplicate {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  isArchived: boolean;
  matchedOn: 'phone' | 'email';
}

export interface DirOrg {
  id: string;
  name: string;
  category: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  web: string | null;
  partyId: string | null;
  partyName: string | null;
  note: string | null;
  isArchived: boolean;
  contactCount: number;
  createdAt: string;
}

export type DirNoteKind = 'call' | 'meeting' | 'email' | 'other';

export interface DirNote {
  id: string;
  contactId: string | null;
  contactName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  kind: DirNoteKind;
  noteDate: string;
  summary: string;
  visibility: 'private' | 'shared';
  projectId: string | null;
  projectCode: string | null;
  authorId: string;
  authorName: string;
  clearedAt: string | null;
  editedAt: string | null;
  createdAt: string;
  mine: boolean;
}

export type AgendaBucketKey = 'overdue' | 'today' | 'upcoming' | 'later' | 'closed';

export interface AgendaItem {
  id: string;
  kind: 'task' | 'appointment';
  title: string;
  description: string | null;
  dueDate: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  remindBeforeMinutes: number | null;
  status: 'open' | 'done' | 'cancelled';
  completedAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  contactId: string | null;
  contactName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  partyId: string | null;
  partyName: string | null;
  projectId: string | null;
  projectCode: string | null;
  sourceNoteId: string | null;
  createdBy: string | null;
  bucket?: AgendaBucketKey;
}

export interface AgendaSummary {
  asOf: string;
  counts: { overdue: number; today: number; upcoming: number };
  overdue: AgendaItem[];
  today: AgendaItem[];
  upcoming: AgendaItem[];
}
