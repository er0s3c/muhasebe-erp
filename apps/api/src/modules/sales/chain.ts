import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Permission } from '@erp/shared';
import type { TenantCtx } from '../../http/context';
import { notFound } from '../../http/errors';
import { isModuleDenied } from '../access/effective';

/** Satış belge zincirinin aşamaları (öneri 3): teklif → sipariş → irsaliye → fatura (ve iadesi) → tahsilat. */
export const CHAIN_KINDS = ['quote', 'order', 'delivery', 'invoice', 'payment'] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];
export const salesChainQuerySchema = z.object({ kind: z.enum(['quote', 'order', 'delivery', 'invoice']), id: z.string().uuid() });

export interface ChainNode {
  kind: ChainKind;
  id: string;
  /** Kullanıcının yetkisi dışındaki kayıt: varlığı ve aşaması görünür, numarası/tutarı/bağlantısı gizlenir. */
  restricted: boolean;
  no: string | null;
  date: string | null;
  status: string | null;
  /** Fatura türü (satış/iade) veya hareket türü. */
  type: string | null;
  amount: string | null;
  currency: string | null;
  path: string | null;
}
export interface ChainEdge { from: string; to: string }

const ACCESS: Record<ChainKind, { module: string; permission: Permission; path: (id: string) => string }> = {
  quote: { module: 'invoices.orders', permission: 'invoices.read', path: (id) => `/sales/docs/${id}` },
  order: { module: 'invoices.orders', permission: 'invoices.read', path: (id) => `/sales/docs/${id}` },
  delivery: { module: 'core.invoices', permission: 'deliveries.read', path: (id) => `/delivery-notes/${id}` },
  invoice: { module: 'core.invoices', permission: 'invoices.read', path: (id) => `/invoices/${id}` },
  payment: { module: 'core.treasury', permission: 'treasury.read', path: (id) => `/treasury/transactions?open=${id}` },
};
const visible = (c: TenantCtx, kind: ChainKind) =>
  c.enabledModules.has(ACCESS[kind].module) && !isModuleDenied(c.access, ACCESS[kind].module) && c.can(ACCESS[kind].permission);

const ids = (list: readonly string[]) => sql`array[${sql.join(list.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
const MAX_NODES = 200;

/**
 * Bir satış belgesinden başlayarak bağlı bütün belgeleri bulur. Bağlar yalnız kayıtlı ilişkilerden gelir (teklif kimliği,
 * sipariş/irsaliye satırı, iade kaynağı, tahsilat eşleştirmesi); tahmin yapılmaz. Satırlar RLS (şirket/şube) altında okunur;
 * yetkisi olmayan aşamanın kaydı `restricted` döner. Zincir en çok 200 belgeyle sınırlıdır (`truncated`).
 */
export async function salesChain(c: TenantCtx, start: { kind: Exclude<ChainKind, 'payment'>; id: string }) {
  const { tx } = c;
  const found = new Map<string, { kind: ChainKind; id: string }>();
  const edges = new Map<string, ChainEdge>();
  const queue: { kind: ChainKind; id: string }[] = [];
  const add = (kind: ChainKind, id: string, from?: string, reverse = false) => {
    const key = `${kind}:${id}`;
    if (from && from !== key) {
      const edge = reverse ? { from: key, to: from } : { from, to: key };
      edges.set(`${edge.from}>${edge.to}`, edge);
    }
    if (found.has(key) || found.size >= MAX_NODES) return;
    found.set(key, { kind, id });
    queue.push({ kind, id });
  };
  const rows = async (query: SQL) => (await tx.execute<{ src: string; dst: string }>(query)).rows;

  // Teklif ve sipariş aynı tabloda: başlangıç türü kaydın kendisinden okunur
  if (start.kind === 'quote' || start.kind === 'order') {
    const kind = (await tx.execute<{ kind: 'quote' | 'order' }>(sql`select kind from sales_orders where id = ${start.id}::uuid`)).rows[0]?.kind;
    if (!kind) throw notFound('Belge');
    start = { ...start, kind };
  }
  add(start.kind, start.id);
  let truncated = false;
  while (queue.length) {
    // Aynı türden bekleyen kayıtlar tek sorguda genişletilir
    const kind = queue[0]!.kind;
    const batch = queue.filter((n) => n.kind === kind).map((n) => n.id);
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.kind === kind) queue.splice(i, 1);
    const from = (id: string) => `${kind}:${id}`;
    if (kind === 'quote') {
      for (const r of await rows(sql`select quote_id::text as src, id::text as dst from sales_orders where quote_id = any(${ids(batch)})`)) add('order', r.dst, from(r.src));
    } else if (kind === 'order') {
      for (const r of await rows(sql`select id::text as src, quote_id::text as dst from sales_orders where id = any(${ids(batch)}) and quote_id is not null`)) add('quote', r.dst, from(r.src), true);
      for (const r of await rows(sql`select distinct sol.order_id::text as src, dnl.note_id::text as dst from delivery_note_lines dnl join sales_order_lines sol on sol.id = dnl.sales_order_line_id where sol.order_id = any(${ids(batch)})`)) add('delivery', r.dst, from(r.src));
      for (const r of await rows(sql`select distinct sol.order_id::text as src, il.invoice_id::text as dst from invoice_lines il join sales_order_lines sol on sol.id = il.sales_order_line_id where sol.order_id = any(${ids(batch)})`)) add('invoice', r.dst, from(r.src));
    } else if (kind === 'delivery') {
      for (const r of await rows(sql`select distinct dnl.note_id::text as src, sol.order_id::text as dst from delivery_note_lines dnl join sales_order_lines sol on sol.id = dnl.sales_order_line_id where dnl.note_id = any(${ids(batch)})`)) add('order', r.dst, from(r.src), true);
      for (const r of await rows(sql`select distinct dnl.note_id::text as src, il.invoice_id::text as dst from invoice_lines il join delivery_note_lines dnl on dnl.id = il.delivery_line_id where dnl.note_id = any(${ids(batch)})`)) add('invoice', r.dst, from(r.src));
    } else if (kind === 'invoice') {
      for (const r of await rows(sql`select distinct il.invoice_id::text as src, sol.order_id::text as dst from invoice_lines il join sales_order_lines sol on sol.id = il.sales_order_line_id where il.invoice_id = any(${ids(batch)})`)) add('order', r.dst, from(r.src), true);
      for (const r of await rows(sql`select distinct il.invoice_id::text as src, dnl.note_id::text as dst from invoice_lines il join delivery_note_lines dnl on dnl.id = il.delivery_line_id where il.invoice_id = any(${ids(batch)})`)) add('delivery', r.dst, from(r.src), true);
      for (const r of await rows(sql`select return_of_id::text as src, id::text as dst from invoices where return_of_id = any(${ids(batch)})`)) add('invoice', r.dst, from(r.src));
      for (const r of await rows(sql`select id::text as src, return_of_id::text as dst from invoices where id = any(${ids(batch)}) and return_of_id is not null`)) add('invoice', r.dst, from(r.src), true);
      for (const r of await rows(sql`select distinct i.id::text as src, a.transaction_id::text as dst from party_allocations a join journal_lines l on l.id = a.charge_line_id join invoices i on i.journal_entry_id = l.entry_id where i.id = any(${ids(batch)})`)) add('payment', r.dst, from(r.src));
    } else {
      for (const r of await rows(sql`select distinct a.transaction_id::text as src, i.id::text as dst from party_allocations a join journal_lines l on l.id = a.charge_line_id join invoices i on i.journal_entry_id = l.entry_id where a.transaction_id = any(${ids(batch)})`)) add('invoice', r.dst, from(r.src), true);
    }
    if (found.size >= MAX_NODES) { truncated = true; break; }
  }

  const byKind = (kind: ChainKind) => [...found.values()].filter((n) => n.kind === kind).map((n) => n.id);
  type Detail = { id: string; no: string | null; date: string | null; status: string | null; type: string | null; amount: string | null; currency: string | null };
  const details = new Map<string, Detail>();
  const load = async (kind: ChainKind, query: (list: SQL) => SQL) => {
    const list = byKind(kind);
    if (!list.length) return;
    for (const d of (await tx.execute<Detail>(query(ids(list)))).rows) details.set(`${kind}:${d.id}`, d);
  };
  await load('quote', (l) => sql`select id::text, doc_no as no, doc_date::text as date, status, kind as type, gross_total::text as amount, currency_code as currency from sales_orders where id = any(${l})`);
  await load('order', (l) => sql`select id::text, doc_no as no, doc_date::text as date, status, kind as type, gross_total::text as amount, currency_code as currency from sales_orders where id = any(${l})`);
  await load('delivery', (l) => sql`select id::text, note_no as no, note_date::text as date, status, type, null::text as amount, null::text as currency from delivery_notes where id = any(${l})`);
  await load('invoice', (l) => sql`select id::text, invoice_no as no, invoice_date::text as date, status, type, gross_total::text as amount, currency_code as currency from invoices where id = any(${l})`);
  await load('payment', (l) => sql`select id::text, txn_no as no, txn_date::text as date, status, type, amount::text as amount, currency_code as currency from treasury_transactions where id = any(${l})`);

  const startKey = `${start.kind}:${start.id}`;
  if (!details.has(startKey)) throw notFound('Belge');
  const nodes: ChainNode[] = [];
  for (const [key, n] of found) {
    const d = details.get(key);
    // Şube kapsamı (RLS) dışındaki kayıt hiç okunamaz; zincirde de gösterilmez
    if (!d) continue;
    const open = visible(c, n.kind);
    nodes.push({
      kind: n.kind, id: n.id, restricted: !open,
      no: open ? d.no : null, date: open ? d.date : null, status: d.status, type: d.type,
      amount: open ? d.amount : null, currency: open ? d.currency : null, path: open ? ACCESS[n.kind].path(n.id) : null,
    });
  }
  const keys = new Set(nodes.map((n) => `${n.kind}:${n.id}`));
  const order = (k: ChainKind) => CHAIN_KINDS.indexOf(k);
  nodes.sort((a, b) => order(a.kind) - order(b.kind) || (a.date ?? '').localeCompare(b.date ?? '') || a.id.localeCompare(b.id));
  return {
    start: startKey,
    nodes,
    edges: [...edges.values()].filter((e) => keys.has(e.from) && keys.has(e.to)),
    truncated,
  };
}
