import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { INVOICE_TYPE_META, ITEM_UNIT_LABELS, formatTR, type ItemUnit } from '@erp/shared';
import type { Tx } from '../../db/client';
import { unprocessable } from '../../http/errors';
import { invoiceDocumentMail } from '../mail/templates';
import { enqueueEmail, sourceDeliveries } from '../outbox/service';
import { getInvoice } from './service';

export const sendInvoiceDocumentSchema = z.object({
  to: z.string().trim().toLowerCase().email('Geçerli bir e-posta adresi girin').max(254),
  note: z.string().trim().max(1000).optional().transform((v) => v || null),
});
export type SendInvoiceDocumentInput = z.infer<typeof sendInvoiceDocumentSchema>;

type InvoiceDetail = Awaited<ReturnType<typeof getInvoice>>;

/**
 * Belgenin müşteriye görünen içeriğinin sürümü: numara, durum, tarih, cari, para birimi, satırlar ve toplamlar değişince
 * değişir. Gönderim geçmişinde gönderilen sürüm ile güncel sürüm karşılaştırılır (ör. gönderimden sonra iptal).
 */
export function invoiceDocumentVersion({ invoice: i, lines }: InvoiceDetail): string {
  const canonical = JSON.stringify([
    i.invoiceNo, i.status, i.invoiceDate, i.dueDate, i.partyName, i.currencyCode, i.netTotal, i.vatTotal, i.grossTotal,
    lines.map((l) => [l.description, l.quantity, l.unit, l.unitPrice, l.discountPct, l.vatCode, l.net, l.vat]),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

const unitLabel = (unit: string | null) => (unit && unit in ITEM_UNIT_LABELS ? ITEM_UNIT_LABELS[unit as ItemUnit] : unit);
const qty = (v: string) => formatTR(v, 4).replace(/,?0+$/, '');

/**
 * Kayıtlı satış faturasını e-postayla gönderim kuyruğuna alır (öneri 7). İleti iş işlemiyle aynı işlemde kalıcı outbox'a
 * yazılır; gönderim ve denemeler zamanlayıcıdadır. `requestKey` aynı isteğin tekrarını tek iletiye indirger.
 */
export async function sendInvoiceDocument(tx: Tx, ctx: { companyId: string; userId: string }, id: string, input: SendInvoiceDocumentInput, requestKey: string | null) {
  const detail = await getInvoice(tx, id);
  const inv = detail.invoice;
  if (INVOICE_TYPE_META[inv.type as keyof typeof INVOICE_TYPE_META]?.side !== 'sales') throw unprocessable('Yalnız satış faturası ve satış iadesi müşteriye gönderilir', 'INVOICE_NOT_SENDABLE');
  if (inv.status !== 'posted') throw unprocessable('Yalnız kaydedilmiş fatura gönderilir', 'INVOICE_NOT_POSTED');
  const company = (await tx.execute<{ name: string }>(sql`select name from companies where id = ${ctx.companyId}::uuid`)).rows[0];
  const version = invoiceDocumentVersion(detail);
  const metadata = (inv.documentMetadata ?? {}) as { company?: { name?: string } };
  const taxTotals = inv.taxTotalsSnapshot as { payableToSeller?: string } | null;
  const mail = invoiceDocumentMail(input.to, {
    company: metadata.company?.name ?? company?.name ?? '',
    partyName: inv.partyName ?? '',
    invoiceNo: inv.invoiceNo ?? '',
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    currency: inv.currencyCode,
    lines: detail.lines.map((l) => ({ description: l.description, quantity: qty(l.quantity), unit: unitLabel(l.unit), unitPrice: l.unitPrice, net: l.net })),
    netTotal: inv.netTotal,
    vatTotal: inv.vatTotal,
    grossTotal: inv.grossTotal,
    payable: taxTotals?.payableToSeller ?? null,
    note: input.note,
    version,
  }, (v) => formatTR(v, 2));
  const { message, created } = await enqueueEmail(tx, {
    companyId: ctx.companyId,
    kind: 'invoice_document',
    dedupeKey: `invoice-document:${id}:${requestKey ?? randomUUID()}`,
    recipient: mail.to,
    subject: mail.subject,
    bodyText: mail.text,
    bodyHtml: mail.html ?? null,
    sourceType: 'invoice',
    sourceId: id,
    document: { type: 'invoice', id, no: inv.invoiceNo, version, status: inv.status },
    createdBy: ctx.userId,
  });
  return { delivery: { id: message.id, status: message.status, recipient: message.recipient, document: message.document }, created };
}

/** Faturanın gönderim geçmişi ve güncel belge sürümü (gönderilen sürüm farklıysa belge sonradan değişmiştir). */
export async function invoiceDeliveries(tx: Tx, id: string) {
  const detail = await getInvoice(tx, id);
  const rows = await sourceDeliveries(tx, 'invoice', id);
  const partyEmail = (await tx.execute<{ email: string | null }>(sql`select email from parties where id = ${detail.invoice.partyId}::uuid`)).rows[0]?.email ?? null;
  return { currentVersion: invoiceDocumentVersion(detail), partyEmail, deliveries: rows };
}
