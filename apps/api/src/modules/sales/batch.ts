import { eq, sql, type SQL } from 'drizzle-orm';
import {
  calcInvoice,
  dec,
  groupBatchLines,
  todayIso,
  type BatchGrouping,
  type BatchPreviewQuery,
  type BatchRunInput,
  type CreateInvoiceInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { invoiceBatchItems, invoiceBatches, invoiceLines } from '../../db/schema';
import { describeError } from '../../http/errors';
import { uuidList } from '../inventory/balances';
import { lockItems } from '../inventory/balances';
import { lockDeliveryLines } from '../invoices/delivery-link';
import { postInvoice } from '../invoices/posting';
import { createInvoiceDraft, resolveVat, type InvoiceCtx } from '../invoices/service';
import { resolvePrice } from './pricing';
import { lockOrderLines } from './usage';

/**
 * Toplu faturalama (X2): kaydedilmiş, kalan miktarı olan satış irsaliyelerini cari başına faturalar. Fiyat/iskonto/KDV, irsaliye satırı
 * bir siparişe bağlıysa siparişten, değilse stok kartından (fiyat çözümleyici kancası, X3) gelir; fiyatı bulunamayan irsaliye faturalanmaz
 * ve nedeniyle raporlanır. Her fatura kendi kayıt noktasında (savepoint) işlenir: biri başarısız olursa yalnızca o geri alınır, diğerleri sürer.
 */

interface Row extends Record<string, unknown> {
  line_id: string;
  line_no: number;
  note_id: string;
  note_no: string | null;
  note_date: string;
  party_id: string;
  party_code: string;
  party_name: string;
  party_currency: string;
  item_id: string;
  item_code: string;
  item_sale_price: string | null;
  item_sale_currency: string;
  item_vat_code: string | null;
  item_purchase_price: string | null;
  item_purchase_currency: string;
  description: string;
  unit: string | null;
  remaining: string;
  so_line_id: string | null;
  so_unit_price: string | null;
  so_discount: string | null;
  so_vat_code: string | null;
  so_currency: string | null;
  so_vat_included: boolean | null;
  in_draft: boolean;
}

export interface BatchLine {
  lineId: string;
  noteId: string;
  noteNo: string | null;
  noteDate: string;
  partyId: string;
  itemId: string;
  itemCode: string;
  description: string;
  unit: string | null;
  quantity: string;
  salesOrderLineId: string | null;
  unitPrice: string | null;
  discountPct: string;
  vatCode: string | null;
  currency: string;
  vatIncluded: boolean;
  priceSource: 'order' | 'item' | 'party_item' | 'party_list' | 'default_list' | null;
  inDraft: boolean;
}

interface PartyInfo {
  id: string;
  code: string;
  name: string;
}

async function loadLines(tx: Tx, filter: { noteIds?: readonly string[]; from?: string; to?: string; partyId?: string }) {
  const conds: SQL[] = [sql`n.status = 'posted'`, sql`n.type = 'sales'`, sql`dl.quantity > coalesce(b.qty, 0)`];
  if (filter.noteIds) conds.push(sql`n.id in (${uuidList(filter.noteIds)})`);
  if (filter.from) conds.push(sql`n.note_date >= ${filter.from}::date`);
  if (filter.to) conds.push(sql`n.note_date <= ${filter.to}::date`);
  if (filter.partyId) conds.push(sql`n.party_id = ${filter.partyId}`);
  const rows = await tx.execute<Row>(sql`
    select dl.id as line_id, dl.line_no, n.id as note_id, n.note_no, n.note_date::text as note_date,
           p.id as party_id, p.code as party_code, p.name as party_name, p.currency_code as party_currency,
           it.id as item_id, it.code as item_code, it.sale_price as item_sale_price, it.sale_currency as item_sale_currency,
           it.vat_code as item_vat_code, it.purchase_price as item_purchase_price, it.purchase_currency as item_purchase_currency, dl.description, dl.unit, dl.quantity - coalesce(b.qty, 0) as remaining,
           ol.id as so_line_id, ol.unit_price as so_unit_price, ol.discount_pct as so_discount, ol.vat_code as so_vat_code,
           o.currency_code as so_currency, o.vat_included as so_vat_included,
           exists (select 1 from invoice_lines x join invoices xi on xi.id = x.invoice_id
                    where x.delivery_line_id = dl.id and xi.status = 'draft') as in_draft
    from delivery_note_lines dl
    join delivery_notes n on n.id = dl.note_id
    join parties p on p.id = n.party_id
    join items it on it.id = dl.item_id
    left join sales_order_lines ol on ol.id = dl.sales_order_line_id
    left join sales_orders o on o.id = ol.order_id
    left join (
      select il.delivery_line_id, sum(il.quantity) as qty
      from invoice_lines il join invoices i on i.id = il.invoice_id and i.status = 'posted'
      where il.delivery_line_id is not null group by il.delivery_line_id
    ) b on b.delivery_line_id = dl.id
    where ${sql.join(conds, sql` and `)}
    order by p.name, n.note_date, n.note_no, dl.line_no`);

  const parties = new Map<string, PartyInfo>();
  const out: BatchLine[] = [];
  const issues = new Map<string, { code: string; message: string }[]>();
  const addIssue = (noteId: string, code: string, message: string) => {
    const list = issues.get(noteId) ?? [];
    if (!list.some((i) => i.code === code && i.message === message)) list.push({ code, message });
    issues.set(noteId, list);
  };
  for (const r of rows.rows) {
    parties.set(r.party_id, { id: r.party_id, code: r.party_code, name: r.party_name });
    let unitPrice: string | null;
    let source: BatchLine['priceSource'] = null;
    let currency = r.party_currency;
    let vatIncluded = false;
    let discountPct: string;
    let vatCode = r.item_vat_code;
    if (r.so_line_id) {
      unitPrice = r.so_unit_price;
      discountPct = r.so_discount ?? '0';
      vatCode = r.so_vat_code;
      currency = r.so_currency ?? currency;
      vatIncluded = r.so_vat_included ?? false;
      source = 'order';
    } else {
      const res = await resolvePrice(tx, {
        kind: 'sales',
        item: {
          id: r.item_id,
          salePrice: r.item_sale_price,
          saleCurrency: r.item_sale_currency,
          purchasePrice: r.item_purchase_price,
          purchaseCurrency: r.item_purchase_currency,
        },
        partyId: r.party_id,
        date: r.note_date,
        currency,
        quantity: dec(r.remaining).toFixed(4),
      });
      unitPrice = res.unitPrice;
      discountPct = res.discountPct;
      if (res.priceSource !== 'none') source = res.priceSource === 'item_card' ? 'item' : res.priceSource;
    }
    if (unitPrice === null) {
      addIssue(
        r.note_id,
        'NO_PRICE',
        r.item_sale_price === null
          ? `${r.item_code}: stok kartında satış fiyatı yok ve irsaliye bir siparişe bağlı değil`
          : `${r.item_code}: kart fiyatı ${r.item_sale_currency} cinsinden, cari para birimi ${currency}`,
      );
    }
    if (r.in_draft) addIssue(r.note_id, 'IN_DRAFT_INVOICE', 'İrsaliye satırı zaten bir taslak faturada; önce taslağı kaydedin ya da silin');
    out.push({
      lineId: r.line_id,
      noteId: r.note_id,
      noteNo: r.note_no,
      noteDate: r.note_date,
      partyId: r.party_id,
      itemId: r.item_id,
      itemCode: r.item_code,
      description: r.description,
      unit: r.unit,
      quantity: dec(r.remaining).toFixed(4),
      salesOrderLineId: r.so_line_id,
      unitPrice,
      discountPct,
      vatCode,
      currency,
      vatIncluded,
      priceSource: source,
      inDraft: r.in_draft,
    });
  }
  // Bir irsaliyede para birimi/KDV biçimi karışıksa faturalanamaz (irsaliye bölünmez)
  const byNote = new Map<string, BatchLine[]>();
  for (const l of out) byNote.set(l.noteId, [...(byNote.get(l.noteId) ?? []), l]);
  for (const [noteId, ls] of byNote) {
    if (new Set(ls.map((l) => `${l.currency}|${l.vatIncluded}`)).size > 1) {
      addIssue(noteId, 'MIXED_CURRENCY', 'İrsaliye satırları farklı para birimi ya da KDV biçiminde (siparişlerine göre); elle faturalayın');
    }
  }
  return { lines: out, parties, issues };
}

const money = (n: { toFixed: (dp: number) => string }) => n.toFixed(2);

/** Önizleme: cari → irsaliye → satır, fiyat kaynağı, sorunlar ve tahmini tutarlar. Hiçbir şey yazmaz. */
export async function batchPreview(tx: Tx, q: BatchPreviewQuery) {
  const { lines, parties, issues } = await loadLines(tx, q);
  const date = q.to ?? todayIso();
  const rates = await resolveVat(tx, [...new Set(lines.flatMap((l) => (l.vatCode ? [l.vatCode] : [])))], date);

  const returns = await tx.execute<{ party_id: string; n: number }>(sql`
    select n.party_id, count(distinct n.id)::int as n
    from delivery_notes n join delivery_note_lines dl on dl.note_id = n.id
    left join (
      select il.delivery_line_id, sum(il.quantity) as qty
      from invoice_lines il join invoices i on i.id = il.invoice_id and i.status = 'posted'
      where il.delivery_line_id is not null group by il.delivery_line_id
    ) b on b.delivery_line_id = dl.id
    where n.status = 'posted' and n.type = 'sales_return' and dl.quantity > coalesce(b.qty, 0)
    group by n.party_id`);
  const pendingReturns = new Map(returns.rows.map((r) => [r.party_id, r.n]));

  const outParties = [...parties.values()].map((p) => {
    const mine = lines.filter((l) => l.partyId === p.id);
    const noteIds = [...new Set(mine.map((l) => l.noteId))];
    const notes = noteIds.map((noteId) => {
      const ls = mine.filter((l) => l.noteId === noteId);
      const priced = ls.filter((l) => l.unitPrice !== null);
      const noteIssues = issues.get(noteId) ?? [];
      const totals = calcInvoice(
        priced.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice!, discountPct: l.discountPct, vatRate: l.vatCode ? (rates.get(l.vatCode) ?? '0') : '0' })),
        ls[0]!.vatIncluded,
      );
      return {
        noteId,
        noteNo: ls[0]!.noteNo,
        noteDate: ls[0]!.noteDate,
        currency: ls[0]!.currency,
        blocked: noteIssues.length > 0,
        issues: noteIssues,
        net: money(totals.net),
        vat: money(totals.vat),
        gross: money(totals.gross),
        lines: ls.map((l) => ({
          lineId: l.lineId,
          itemCode: l.itemCode,
          description: l.description,
          unit: l.unit,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct,
          vatCode: l.vatCode,
          priceSource: l.priceSource,
        })),
      };
    });
    const ok = notes.filter((n) => !n.blocked);
    const groups = groupBatchLines(
      mine.filter((l) => ok.some((n) => n.noteId === l.noteId)).map((l) => ({ ...l, variant: `${l.currency}|${l.vatIncluded}` })),
      q.grouping,
    );
    return {
      partyId: p.id,
      partyCode: p.code,
      partyName: p.name,
      notes,
      invoiceCount: groups.length,
      pendingReturns: pendingReturns.get(p.id) ?? 0,
    };
  });
  return {
    grouping: q.grouping,
    parties: outParties,
    totals: {
      notes: outParties.reduce((s, p) => s + p.notes.length, 0),
      invoiceable: outParties.reduce((s, p) => s + p.notes.filter((n) => !n.blocked).length, 0),
      invoices: outParties.reduce((s, p) => s + p.invoiceCount, 0),
    },
  };
}

export interface BatchResult {
  batchId: string;
  created: { partyId: string; partyName: string; invoiceId: string; invoiceNo: string | null; status: string; noteIds: string[]; gross: string }[];
  failed: { partyId: string; partyName: string; noteIds: string[]; code: string; message: string }[];
  /** Seçilip de faturalanacak kalanı olmayan (zaten faturalanmış, kaydedilmemiş ya da iptal) irsaliyeler. */
  skipped: { noteId: string; reason: string }[];
}

export async function runBatch(tx: Tx, ctx: InvoiceCtx, input: BatchRunInput): Promise<BatchResult> {
  const { lines, parties, issues } = await loadLines(tx, { noteIds: input.noteIds });
  const known = new Set(lines.map((l) => l.noteId));
  const skipped = input.noteIds.filter((id) => !known.has(id)).map((noteId) => ({ noteId, reason: 'Kaydedilmiş satış irsaliyesi değil ya da faturalanacak kalan miktar yok' }));

  const [batch] = await tx
    .insert(invoiceBatches)
    .values({ companyId: ctx.companyId, invoiceDate: input.invoiceDate, grouping: input.grouping, post: input.post, createdBy: ctx.userId })
    .returning({ id: invoiceBatches.id });
  const batchId = batch!.id;

  const result: BatchResult = { batchId, created: [], failed: [], skipped };
  const fail = async (partyId: string, noteIds: string[], code: string, message: string) => {
    await tx.insert(invoiceBatchItems).values({ companyId: ctx.companyId, batchId, partyId, status: 'failed', noteIds: noteIds.join(','), errorCode: code, errorMessage: message.slice(0, 500) });
    result.failed.push({ partyId, partyName: parties.get(partyId)?.name ?? '', noteIds, code, message });
  };

  // Sorunlu irsaliyeler (fiyat yok, taslakta, karışık para birimi) faturalanmaz; nedeniyle raporlanır, kalanlar sürer
  const blocked = new Set([...issues.keys()]);
  for (const noteId of blocked) {
    const first = lines.find((l) => l.noteId === noteId)!;
    const list = issues.get(noteId)!;
    await fail(first.partyId, [noteId], list[0]!.code, `${first.noteNo ?? 'İrsaliye'}: ${list.map((i) => i.message).join('; ')}`);
  }

  const ok = lines.filter((l) => !blocked.has(l.noteId)).map((l) => ({ ...l, variant: `${l.currency}|${l.vatIncluded}` }));
  const groups = groupBatchLines(ok, input.grouping as BatchGrouping);

  for (const g of groups) {
    const partyName = parties.get(g.partyId)?.name ?? '';
    try {
      const done = await tx.transaction(async (sp) => {
        const first = g.lines[0]!;
        await lockDeliveryLines(sp, g.lines.map((l) => l.lineId));
        await lockOrderLines(sp, g.lines.flatMap((l) => (l.salesOrderLineId ? [l.salesOrderLineId] : [])));
        await lockItems(sp, g.lines.map((l) => l.itemId));
        const noteNos = [...new Set(g.lines.map((l) => l.noteNo ?? ''))].filter(Boolean);
        const body: CreateInvoiceInput = {
          type: 'sales',
          partyId: g.partyId,
          invoiceDate: input.invoiceDate,
          currency: first.currency as CreateInvoiceInput['currency'],
          vatIncluded: first.vatIncluded,
          description: `Toplu faturalama: ${noteNos.join(', ')}`.slice(0, 300),
          lines: g.lines.map((l) => ({
            itemId: l.itemId,
            description: `${l.description} (${l.noteNo ?? 'irsaliye'})`.slice(0, 300),
            quantity: l.quantity,
            unit: l.unit as never,
            unitPrice: l.unitPrice!,
            discountPct: l.discountPct,
            vatCode: l.vatCode,
            deliveryLineId: l.lineId,
            salesOrderLineId: l.salesOrderLineId,
          })),
          post: false,
        };
        const invoiceId = await createInvoiceDraft(sp, ctx, body);
        const [item] = await sp
          .insert(invoiceBatchItems)
          .values({ companyId: ctx.companyId, batchId, partyId: g.partyId, status: 'created', invoiceId, noteIds: g.noteIds.join(',') })
          .returning({ id: invoiceBatchItems.id });
        // Çift toplu faturalama koruması (veritabanı): aynı irsaliye satırı başka bir toplu faturada olamaz
        await sp.update(invoiceLines).set({ batchItemId: item!.id }).where(eq(invoiceLines.invoiceId, invoiceId));
        if (input.post) {
          const posted = await postInvoice(sp, ctx, invoiceId);
          return { invoiceId, invoiceNo: posted.invoice.invoiceNo as string | null, status: posted.invoice.status as string, gross: String(posted.invoice.grossTotal) };
        }
        const head = await sp.execute<{ gross_total: string }>(sql`select gross_total from invoices where id = ${invoiceId}`);
        return { invoiceId, invoiceNo: null, status: 'draft', gross: String(head.rows[0]?.gross_total ?? '0') };
      });
      result.created.push({ partyId: g.partyId, partyName, noteIds: g.noteIds, ...done });
    } catch (e) {
      const d = describeError(e);
      await fail(g.partyId, g.noteIds, d.code, d.message);
    }
  }

  await tx.update(invoiceBatches).set({ invoicesCreated: result.created.length, invoicesFailed: result.failed.length }).where(eq(invoiceBatches.id, batchId));
  return result;
}
