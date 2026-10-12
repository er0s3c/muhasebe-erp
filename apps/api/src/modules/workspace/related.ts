import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Permission } from '@erp/shared';
import type { TenantCtx } from '../../http/context';
import { forbidden, notFound } from '../../http/errors';
import { isModuleDenied } from '../access/effective';

/**
 * Cari, ürün ve proje için ortak "ilişkili kayıtlar" görünümü (öneri 4): modüllere dağılmış belgeler tek yerde, son kayıtlar
 * ve toplam sayılarıyla. Her bölüm kendi modül ve izniyle görünür (yetkisi olmayan bölüm hiç dönmez); satırlar RLS (şirket/şube)
 * altında okunur.
 */
export const relatedQuerySchema = z.object({ kind: z.enum(['party', 'item', 'project']), id: z.string().uuid() });
type AnchorKind = z.infer<typeof relatedQuerySchema>['kind'];

interface Section {
  key: string;
  label: string;
  modules: readonly string[];
  permission: Permission;
  /** `select id, no, date, status, amount, currency` döndüren kaynak (`$1` yerine bağlı kayıt kimliği). */
  source: (id: string) => SQL;
  path: (id: string) => string;
}

const ANCHOR: Record<AnchorKind, { table: string; modules: readonly string[]; permission: Permission }> = {
  party: { table: 'parties', modules: ['core.parties'], permission: 'parties.read' },
  item: { table: 'items', modules: ['core.inventory'], permission: 'inventory.read' },
  project: { table: 'projects', modules: ['construction.projects'], permission: 'projects.read' },
};

const salesDocs = (kind: 'quote' | 'order', where: SQL): SQL =>
  sql`select o.id, o.doc_no as no, o.doc_date::text as date, o.status, o.gross_total::text as amount, o.currency_code as currency from sales_orders o where o.kind = ${kind} and ${where}`;
const invoicesWhere = (where: SQL): SQL =>
  sql`select i.id, coalesce(i.invoice_no, i.external_no) as no, i.invoice_date::text as date, i.status, i.gross_total::text as amount, i.currency_code as currency from invoices i where ${where}`;
const deliveriesWhere = (where: SQL): SQL =>
  sql`select n.id, n.note_no as no, n.note_date::text as date, n.status, null::text as amount, null::text as currency from delivery_notes n where ${where}`;

const SECTIONS: Record<AnchorKind, Section[]> = {
  party: [
    { key: 'quotes', label: 'Teklifler', modules: ['invoices.orders'], permission: 'invoices.read', source: (id) => salesDocs('quote', sql`o.party_id = ${id}::uuid`), path: (id) => `/sales/docs/${id}` },
    { key: 'orders', label: 'Satış siparişleri', modules: ['invoices.orders'], permission: 'invoices.read', source: (id) => salesDocs('order', sql`o.party_id = ${id}::uuid`), path: (id) => `/sales/docs/${id}` },
    { key: 'deliveries', label: 'İrsaliyeler', modules: ['core.invoices'], permission: 'deliveries.read', source: (id) => deliveriesWhere(sql`n.party_id = ${id}::uuid`), path: (id) => `/delivery-notes/${id}` },
    { key: 'invoices', label: 'Faturalar', modules: ['core.invoices'], permission: 'invoices.read', source: (id) => invoicesWhere(sql`i.party_id = ${id}::uuid`), path: (id) => `/invoices/${id}` },
    { key: 'payments', label: 'Tahsilat ve ödemeler', modules: ['core.treasury'], permission: 'treasury.read', source: (id) => sql`select t.id, t.txn_no as no, t.txn_date::text as date, t.status, t.amount::text as amount, t.currency_code as currency from treasury_transactions t where t.party_id = ${id}::uuid`, path: (id) => `/treasury/transactions?open=${id}` },
    { key: 'purchaseOrders', label: 'Satın alma siparişleri', modules: ['core.procurement', 'construction.procurement'], permission: 'procurement.read', source: (id) => sql`select p.id, p.code as no, p.created_at::date::text as date, p.status, null::text as amount, p.currency_code as currency from purchase_orders p where p.party_id = ${id}::uuid`, path: (id) => `/purchasing/orders/${id}` },
    { key: 'subcontracts', label: 'Taşeron sözleşmeleri', modules: ['construction.subcontracts'], permission: 'subcontracts.read', source: (id) => sql`select s.id, s.code as no, s.start_date::text as date, s.status, null::text as amount, s.currency_code as currency from subcontracts s where s.party_id = ${id}::uuid`, path: (id) => `/subcontracts/${id}` },
  ],
  item: [
    { key: 'orders', label: 'Satış siparişleri', modules: ['invoices.orders'], permission: 'invoices.read', source: (id) => salesDocs('order', sql`exists (select 1 from sales_order_lines l where l.order_id = o.id and l.item_id = ${id}::uuid)`), path: (id) => `/sales/docs/${id}` },
    { key: 'deliveries', label: 'İrsaliyeler', modules: ['core.invoices'], permission: 'deliveries.read', source: (id) => deliveriesWhere(sql`exists (select 1 from delivery_note_lines l where l.note_id = n.id and l.item_id = ${id}::uuid)`), path: (id) => `/delivery-notes/${id}` },
    { key: 'invoices', label: 'Faturalar', modules: ['core.invoices'], permission: 'invoices.read', source: (id) => invoicesWhere(sql`exists (select 1 from invoice_lines l where l.invoice_id = i.id and l.item_id = ${id}::uuid)`), path: (id) => `/invoices/${id}` },
  ],
  project: [
    { key: 'invoices', label: 'Faturalar', modules: ['core.invoices'], permission: 'invoices.read', source: (id) => invoicesWhere(sql`exists (select 1 from invoice_lines l where l.invoice_id = i.id and l.project_id = ${id}::uuid)`), path: (id) => `/invoices/${id}` },
    { key: 'purchaseOrders', label: 'Satın alma siparişleri', modules: ['core.procurement', 'construction.procurement'], permission: 'procurement.read', source: (id) => sql`select p.id, p.code as no, p.created_at::date::text as date, p.status, null::text as amount, p.currency_code as currency from purchase_orders p where p.project_id = ${id}::uuid`, path: (id) => `/purchasing/orders/${id}` },
    { key: 'subcontracts', label: 'Taşeron sözleşmeleri', modules: ['construction.subcontracts'], permission: 'subcontracts.read', source: (id) => sql`select s.id, s.code as no, s.start_date::text as date, s.status, null::text as amount, s.currency_code as currency from subcontracts s where s.project_id = ${id}::uuid`, path: (id) => `/subcontracts/${id}` },
  ],
};

const visible = (c: TenantCtx, modules: readonly string[], permission: Permission) =>
  modules.some((m) => c.enabledModules.has(m) && !isModuleDenied(c.access, m)) && c.can(permission);

export async function relatedRecords(c: TenantCtx, input: z.infer<typeof relatedQuerySchema>) {
  const anchor = ANCHOR[input.kind];
  if (!visible(c, anchor.modules, anchor.permission)) throw forbidden();
  const exists = await c.tx.execute(sql`select 1 from ${sql.identifier(anchor.table)} where id = ${input.id}::uuid`);
  if (!exists.rows.length) throw notFound('Kayıt');
  const sections = [];
  for (const s of SECTIONS[input.kind]) {
    if (!visible(c, s.modules, s.permission)) continue;
    const source = s.source(input.id);
    const [count] = (await c.tx.execute<{ n: number }>(sql`select count(*)::int as n from (${source}) x`)).rows;
    if (!count?.n) continue;
    const recent = (await c.tx.execute<{ id: string; no: string | null; date: string | null; status: string | null; amount: string | null; currency: string | null }>(
      sql`select * from (${source}) x order by x.date desc nulls last, x.id desc limit 5`,
    )).rows;
    sections.push({ key: s.key, label: s.label, total: count.n, recent: recent.map((r) => ({ ...r, path: s.path(r.id) })) });
  }
  return { kind: input.kind, id: input.id, sections };
}
