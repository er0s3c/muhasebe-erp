import { z } from 'zod';
import { dec, tryDec } from './money';
import { isoDate, uuid } from './schemas/common';
import { positiveMoney, treasuryItemSchema } from './schemas/treasury';

/**
 * Toplu ödeme (öneri 54): vadesi gelen tedarikçi borçlarından ödeme listesi hazırlanır, yalnız doğrulanmış cari IBAN'ları
 * kullanılır, hazırlayandan farklı bir kullanıcı onaylar (tek kullanıcılı şirket hariç), banka dosyası alınır ve kayıtta
 * her satır açık kalemleri kapatan ayrı bir ödeme hareketi olur.
 */
export const PAYMENT_BATCH_STATUSES = ['draft', 'approved', 'posted', 'cancelled'] as const;
export type PaymentBatchStatus = (typeof PAYMENT_BATCH_STATUSES)[number];
export const paymentBatchLineSchema = z
  .object({
    partyId: uuid,
    bankAccountId: uuid,
    amount: positiveMoney,
    items: z.array(treasuryItemSchema).max(100).default([]),
    description: z.string().trim().max(140).default(''),
  })
  .refine(
    (l) => {
      const used = l.items.reduce<ReturnType<typeof dec> | null>((s, i) => (s && tryDec(i.settleAmount) ? s.plus(i.settleAmount) : null), dec(0));
      return !!used && !!tryDec(l.amount) && used.lte(l.amount);
    },
    { message: 'Kalemlere ayrılan tutar ödeme tutarını aşıyor', path: ['items'] },
  );
export const createPaymentBatchSchema = z
  .object({
    accountId: uuid,
    paymentDate: isoDate,
    note: z.string().trim().max(300).default(''),
    lines: z.array(paymentBatchLineSchema).min(1).max(200),
  })
  .refine((b) => new Set(b.lines.map((l) => l.partyId)).size === b.lines.length, { message: 'Her cari listede bir kez yer alır', path: ['lines'] });
export type CreatePaymentBatchInput = z.infer<typeof createPaymentBatchSchema>;
export const paymentBatchSuggestQuerySchema = z.object({ accountId: uuid, dueUntil: isoDate });
export const paymentBatchCancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });

const csvCell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Genel EFT/havale listesi (noktalı virgül ayrımlı, ondalık nokta): IBAN;Alıcı;Tutar;Para birimi;Açıklama. */
export function paymentBankFileCsv(rows: readonly { iban: string; holderName: string; amount: string; currency: string; description: string }[]) {
  const lines = ['IBAN;Alıcı;Tutar;Para birimi;Açıklama'];
  for (const r of rows) lines.push([r.iban, r.holderName, dec(r.amount).toFixed(2), r.currency, r.description].map((v) => csvCell(String(v))).join(';'));
  return lines.join('\r\n') + '\r\n';
}
