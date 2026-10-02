import type { ImportKind } from '@erp/shared';
import type { ImportHandler } from './handlers/common';
import { bankStatementHandler } from './handlers/bank-statement';
import { directoryContactsHandler } from './handlers/directory-contacts';
import { itemsHandler } from './handlers/items';
import { purchaseInvoicesHandler, salesInvoicesHandler } from './handlers/invoices';
import { ledgerOpeningsHandler } from './handlers/ledger-openings';
import { partiesHandler } from './handlers/parties';
import { partyOpeningsHandler } from './handlers/party-openings';
import { stockOpeningsHandler } from './handlers/stock-openings';

export const IMPORT_HANDLERS: Record<ImportKind, ImportHandler> = {
  parties: partiesHandler,
  items: itemsHandler,
  party_openings: partyOpeningsHandler,
  stock_openings: stockOpeningsHandler,
  ledger_openings: ledgerOpeningsHandler,
  bank_statement: bankStatementHandler,
  sales_invoices: salesInvoicesHandler,
  purchase_invoices: purchaseInvoicesHandler,
  directory_contacts: directoryContactsHandler,
};
