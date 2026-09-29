import { dec, roundMoney, type MoneyValue } from './money';

/**
 * Bir tutarın (kendi para biriminde `amount`) toplam içindeki payının defter para birimi karşılığı.
 * Toplamın tamamı çıkıyorsa kalan defter tutarının tamamı taşınır (kuruş artığı kalmaz), aksi halde orantılanır.
 * Açık kalemin kapanan payında ve yabancı para biriminden çıkan tutarın ortalama maliyetinde kullanılır.
 */
export function proportionalBase(amount: MoneyValue, totalDoc: MoneyValue, totalBase: MoneyValue): MoneyValue {
  return amount.eq(totalDoc) ? totalBase : roundMoney(totalBase.times(amount).div(totalDoc));
}

/**
 * Tahsilat/ödemede gerçekleşen kur farkı (defter para birimi): pozitif = kâr, negatif = zarar.
 * Tahsilatta aldığımız defter değeri taşınandan fazlaysa kâr; ödemede ödediğimiz fazlaysa zarardır.
 */
export function settlementFxDiff(kind: 'receipt' | 'payment', carriedBase: MoneyValue, settleBase: MoneyValue): MoneyValue {
  return dec(kind === 'receipt' ? settleBase.minus(carriedBase) : carriedBase.minus(settleBase));
}
