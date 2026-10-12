import { z } from 'zod';
import { dec, roundMoney, type MoneyValue } from './money';

const amount = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/);
const pct = z.string().regex(/^\d{1,3}(\.\d{1,6})?$/).refine((v) => Number(v) <= 100);
export const withholdingFractionSchema = z.object({ numerator: z.number().int().min(0), denominator: z.number().int().min(1) }).refine((v) => v.numerator <= v.denominator, 'Tevkifat oranı 1’den büyük olamaz');
export const documentTaxInputSchema = z.object({
  jurisdiction: z.enum(['TR', 'KKTC']), rulePackVersion: z.string().min(1), sourceRefs: z.array(z.url()).min(1),
  netAmount: amount, vatRatePct: pct,
  /** KDV dahil belgenin brüt-net yuvarlamasını korur; oran hesabından en çok bir kuruş ayrılabilir. */
  vatAmount: amount.optional(),
  vatWithholding: withholdingFractionSchema.nullable().default(null),
  incomeWithholding: z.object({ ratePct: pct, basis: z.enum(['net', 'gross']) }).nullable().default(null),
  stamp: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('percentage'), ratePct: pct, basis: z.enum(['net', 'gross']), exemptAmount: amount, capAmount: amount.nullable() }),
    z.object({ kind: z.literal('fixed'), amount }),
  ]).nullable().default(null),
});
export type DocumentTaxInput = z.infer<typeof documentTaxInputSchema>;
export interface DocumentTaxCalculation {
  engineVersion: 'document-tax-v1';
  direction: 'normal' | 'reversal';
  input: DocumentTaxInput;
  netAmount: string; vat: string; grossAmount: string;
  vatWithheld: string; vatPayableToSeller: string; incomeWithheld: string; stamp: string; payableToSeller: string;
  stampAllocation?: { basis: 'document'; documentNet: string; documentGross: string; documentStamp: string };
}
const fmt = (value: MoneyValue) => roundMoney(value).toFixed(2);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const percent = (value: MoneyValue, rate: string) => roundMoney(value.times(rate).div(100));

export function calculateDocumentStamp(netAmount: string, grossAmount: string, rule: DocumentTaxInput['stamp']): string {
  let stamp = dec(0);
  if (rule?.kind === 'fixed') stamp = roundMoney(rule.amount);
  if (rule?.kind === 'percentage') {
    let base = dec(rule.basis === 'net' ? netAmount : grossAmount).minus(rule.exemptAmount);
    if (base.isNegative()) base = dec(0);
    stamp = percent(base, rule.ratePct);
    if (rule.capAmount !== null && stamp.gt(rule.capAmount)) stamp = dec(rule.capAmount);
  }
  return fmt(stamp);
}

/** Oran/rejim seçmez. Seçilmiş ve kaynaklandırılmış kurala göre türü belirli vergi aritmetiği yapar. */
export function calculateDocumentTaxes(raw: DocumentTaxInput): DocumentTaxCalculation {
  const input = documentTaxInputSchema.parse(raw);
  const net = dec(input.netAmount);
  const formulaVat = percent(net, input.vatRatePct);
  const vat = input.vatAmount === undefined ? formulaVat : dec(input.vatAmount);
  if (vat.minus(formulaVat).abs().gt('0.01')) throw new Error('Belge KDV tutarı oran hesabıyla uyuşmuyor');
  const gross = net.plus(vat);
  const withheld = input.vatWithholding ? roundMoney(vat.times(input.vatWithholding.numerator).div(input.vatWithholding.denominator)) : dec(0);
  const income = input.incomeWithholding ? percent(input.incomeWithholding.basis === 'net' ? net : gross, input.incomeWithholding.ratePct) : dec(0);
  const stamp = dec(calculateDocumentStamp(fmt(net), fmt(gross), input.stamp));
  const payable = gross.minus(withheld).minus(income);
  if (payable.isNegative()) throw new Error('Tevkifat ve stopaj toplamı belge tutarını aşamaz');
  return {
    engineVersion: 'document-tax-v1', direction: 'normal', input: clone(input),
    netAmount: fmt(net), vat: fmt(vat), grossAmount: fmt(gross), vatWithheld: fmt(withheld), vatPayableToSeller: fmt(vat.minus(withheld)),
    incomeWithheld: fmt(income), stamp: fmt(stamp), payableToSeller: fmt(payable),
  };
}

/** İade/ters kayıt, bugünün oranlarından bağımsız olarak kesinleşmiş hesap görüntüsünü ters çevirir. */
export function reverseDocumentTaxes(original: DocumentTaxCalculation): DocumentTaxCalculation {
  if (original.direction !== 'normal' || original.engineVersion !== 'document-tax-v1') throw new Error('Yalnız özgün vergi hesabı ters çevrilebilir');
  const reverse = (value: string) => fmt(dec(value).negated());
  return { ...clone(original), direction: 'reversal', netAmount: reverse(original.netAmount), vat: reverse(original.vat), grossAmount: reverse(original.grossAmount), vatWithheld: reverse(original.vatWithheld), vatPayableToSeller: reverse(original.vatPayableToSeller), incomeWithheld: reverse(original.incomeWithheld), stamp: reverse(original.stamp), payableToSeller: reverse(original.payableToSeller) };
}
