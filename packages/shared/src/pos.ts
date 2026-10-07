import { z } from 'zod';
import { dec, decCheck, roundMoney } from './money';
import { uuid, moneyString } from './schemas/common';
import { positiveQuantity } from './schemas/inventory';
import { positiveMoney } from './schemas/treasury';

const percent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).refine(decCheck(v => v.lte(100)), 'İskonto %100 sınırını aşamaz');
export const createPosTillSchema = z.object({
  name: z.string().trim().min(2).max(80), warehouseId: uuid, cashAccountId: uuid,
  cardAccountId: uuid.nullable().optional(), walkInPartyId: uuid.optional(),
  maxDiscountPct: percent.default('0'), assignedUserIds: z.array(uuid).min(1).max(100),
}).strict();
const cashAmount=moneyString.refine(decCheck(d=>d.decimalPlaces()<=2),'Nakit tutarı en çok iki ondalık basamak içerebilir');
export const openPosSessionSchema = z.object({ tillId: uuid, openingCash: cashAmount }).strict();
export const closePosSessionSchema = z.object({ countedCash: cashAmount, reason: z.string().trim().min(3).max(300).optional() }).strict();
const payment = z.object({ method: z.enum(['cash','card']), amount: positiveMoney.refine(decCheck(d=>d.decimalPlaces()<=2),'Ödeme tutarı en çok iki ondalık basamak içerebilir') }).strict();
export const posSaleSchema = z.object({
  requestId: uuid, customerId: uuid.optional(),
  lines: z.array(z.object({ itemId: uuid, quantity: positiveQuantity, discountPct: percent.optional(), serials: z.array(z.string().trim().min(1).max(60)).max(1000).optional() }).strict()).min(1).max(100),
  payments: z.array(payment).min(1).max(10),
}).strict();
export const posReturnSchema = z.object({
  requestId: uuid, sessionId: uuid, reason: z.string().trim().min(3).max(300),
  lines: z.array(z.object({ sourceLineId: uuid, quantity: positiveQuantity, serials: z.array(z.string().trim().min(1).max(60)).max(1000).optional() }).strict()).min(1).max(100),
  refunds: z.array(payment).min(1).max(10),
}).strict();
export type CreatePosTillInput = z.infer<typeof createPosTillSchema>;
export type PosSaleInput = z.infer<typeof posSaleSchema>;
export type PosReturnInput = z.infer<typeof posReturnSchema>;
export function posExpectedCash(opening: string, receipts: readonly { kind: string; payments: readonly { method: string; amount: string }[] }[]): string {
  return roundMoney(receipts.reduce((balance, sale) => sale.payments.reduce((b,p) => p.method === 'cash' ? sale.kind === 'return' ? b.minus(p.amount) : b.plus(p.amount) : b, balance), dec(opening))).toFixed(2);
}
