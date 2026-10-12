import { dec, roundMoney, type MoneyValue } from './money';

/**
 * Fatura satırı tutar hesabı. API ve web aynı fonksiyonu kullanır; böylece ekranda görülen toplam
 * ile kaydedilen toplam birebir aynıdır. Tutarlar fatura para biriminde, 2 ondalığa yuvarlanır.
 *
 * KDV hariç (varsayılan): net = miktar × fiyat × (1 − iskonto), KDV = net × oran (satır başına yuvarlanır).
 * KDV dahil: brüt = miktar × fiyat × (1 − iskonto); net = brüt ÷ (1 + oran); KDV = brüt − net.
 * Fatura toplamı satır toplamlarının toplamıdır (başlıkta ayrıca yuvarlama yapılmaz).
 */
export interface CalcLineInput {
  quantity: string;
  unitPrice: string;
  /** Yüzde, 0–100 (örn. "12.5"). */
  discountPct?: string;
  /** Yüzde (örn. "16"). */
  vatRate: string;
}

export interface CalcLine {
  net: MoneyValue;
  vat: MoneyValue;
  gross: MoneyValue;
}

export interface VatGroup {
  rate: string;
  net: MoneyValue;
  vat: MoneyValue;
}

export interface InvoiceTotals {
  lines: CalcLine[];
  net: MoneyValue;
  vat: MoneyValue;
  gross: MoneyValue;
  /** KDV oranı bazında toplamlar (oran artan sırada). */
  byRate: VatGroup[];
}

export function calcLine(line: CalcLineInput, vatIncluded: boolean): CalcLine {
  const discount = dec(line.discountPct || 0);
  const amount = roundMoney(dec(line.quantity).times(line.unitPrice).times(dec(100).minus(discount)).div(100));
  const rate = dec(line.vatRate || 0);
  if (vatIncluded) {
    const net = roundMoney(amount.div(dec(1).plus(rate.div(100))));
    return { net, vat: amount.minus(net), gross: amount };
  }
  const vat = roundMoney(amount.times(rate).div(100));
  return { net: amount, vat, gross: amount.plus(vat) };
}

export function calcInvoice(lines: readonly CalcLineInput[], vatIncluded: boolean): InvoiceTotals {
  const calculated = lines.map((l) => calcLine(l, vatIncluded));
  const groups = new Map<string, VatGroup>();
  let net = dec(0);
  let vat = dec(0);
  lines.forEach((l, i) => {
    const c = calculated[i]!;
    net = net.plus(c.net);
    vat = vat.plus(c.vat);
    const key = dec(l.vatRate || 0).toFixed(4);
    const g = groups.get(key) ?? { rate: key, net: dec(0), vat: dec(0) };
    g.net = g.net.plus(c.net);
    g.vat = g.vat.plus(c.vat);
    groups.set(key, g);
  });
  return {
    lines: calculated,
    net,
    vat,
    gross: net.plus(vat),
    byRate: [...groups.values()].sort((a, b) => dec(a.rate).comparedTo(b.rate)),
  };
}

export interface CalcStep {
  label: string;
  /** Okunur işlem, ör. "4 × 100,00 × (1 − %10)". Sayılar nokta ondalıklı ham değerdir; biçimlendirme gösterende yapılır. */
  formula: string;
  value: string;
}

/**
 * Satır tutarının adım adım açıklaması (öneri 29). Değerler `calcLine` ile aynı yoldan üretilir; açıklama ile kaydedilen
 * tutar ayrışamaz. Yuvarlama (2 ondalık) yapılan adım ayrıca belirtilir.
 */
export function explainLine(line: CalcLineInput, vatIncluded: boolean): CalcStep[] {
  const c = calcLine(line, vatIncluded);
  const discount = dec(line.discountPct || 0);
  const rate = dec(line.vatRate || 0);
  const raw = dec(line.quantity).times(line.unitPrice).times(dec(100).minus(discount)).div(100);
  const base = `${dec(line.quantity).toString()} × ${dec(line.unitPrice).toString()}${discount.isZero() ? '' : ` × (1 − %${discount.toString()})`}`;
  const steps: CalcStep[] = [];
  const rounded = !raw.eq(roundMoney(raw));
  if (vatIncluded) {
    steps.push({ label: 'KDV dahil satır tutarı', formula: base + (rounded ? ' (2 ondalığa yuvarlandı)' : ''), value: c.gross.toFixed(2) });
    steps.push({ label: 'KDV hariç tutar', formula: `${c.gross.toFixed(2)} ÷ (1 + %${rate.toString()})`, value: c.net.toFixed(2) });
    steps.push({ label: 'KDV', formula: `${c.gross.toFixed(2)} − ${c.net.toFixed(2)}`, value: c.vat.toFixed(2) });
  } else {
    steps.push({ label: 'Satır tutarı (KDV hariç)', formula: base + (rounded ? ' (2 ondalığa yuvarlandı)' : ''), value: c.net.toFixed(2) });
    steps.push({ label: 'KDV', formula: `${c.net.toFixed(2)} × %${rate.toString()}`, value: c.vat.toFixed(2) });
    steps.push({ label: 'KDV dahil', formula: `${c.net.toFixed(2)} + ${c.vat.toFixed(2)}`, value: c.gross.toFixed(2) });
  }
  return steps;
}
