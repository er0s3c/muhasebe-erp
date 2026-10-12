import { z } from 'zod';

export const PORTAL_SCOPE_LABELS = { invoices: 'Satış faturaları ve iadeleri', quotes: 'Gönderilmiş teklifler', orders: 'Onaylanmış siparişler' } as const;
export const portalDocumentScopesSchema = z.object({ invoices: z.boolean().default(false), quotes: z.boolean().default(false), orders: z.boolean().default(false) }).strict();
export type PortalDocumentScopes = z.infer<typeof portalDocumentScopesSchema>;
export const EMPTY_PORTAL_SCOPES: PortalDocumentScopes = { invoices: false, quotes: false, orders: false };
export const PORTAL_DOCUMENT_KINDS = ['invoice', 'quote', 'order'] as const;
export type PortalDocumentKind = (typeof PORTAL_DOCUMENT_KINDS)[number];
export const portalScopeOf = (kind: PortalDocumentKind): keyof PortalDocumentScopes => ({ invoice: 'invoices', quote: 'quotes', order: 'orders' } as const)[kind];
export interface PortalDocumentSummary {
  id: string; kind: PortalDocumentKind; number: string; status: string; date: string; currency: string; grossTotal: string; type?: 'sales' | 'sales_return';
}
export interface PortalDocumentLine {
  lineNo: number; description: string; quantity: string; unit: string | null; unitPrice: string; discountPct: string; vatRate: string; net: string; vat: string; gross: string;
}
export interface PortalDocumentDetail extends PortalDocumentSummary {
  dueDate: string | null; validUntil: string | null; deliveryDate: string | null; vatIncluded: boolean; netTotal: string; vatTotal: string;
  vatWithheld: string; incomeWithheld: string; stamp: string; payableToSeller: string;
  lines: PortalDocumentLine[];
}
export interface PortalDocumentList { items: PortalDocumentSummary[]; total: number; offset: number; limit: number }
