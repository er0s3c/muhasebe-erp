import { dec, roundMoney, type MoneyValue } from '@erp/shared';

/**
 * Hareketli ağırlıklı ortalama maliyet (ürün bazında, şirket geneli).
 * Fonksiyonlar saftır; veritabanı yoktur. Bakiye `stock_movements` toplamından türetilir.
 *
 * Durum: `qty` eldeki miktar (eksi olabilir), `value` şirket para biriminde envanter değeri
 * (miktarla aynı işaretli), `lastCost` son alış birim maliyeti (yedek referans).
 */
export interface ItemState {
  qty: MoneyValue;
  value: MoneyValue;
  lastCost: MoneyValue | null;
}

/** Referans birim maliyet: bakiye sıfırdan farklıysa değer/miktar; yoksa son alış maliyeti; yoksa 0. */
export function referenceUnitCost(s: ItemState): MoneyValue {
  if (!s.qty.isZero()) return s.value.div(s.qty);
  return s.lastCost ?? dec(0);
}

/**
 * Çıkış değeri (pozitif). Tamamı boşaltılıyorsa kalan değerin tamamı çıkar (kuruş artığı kalmaz);
 * aksi halde miktar × ortalama, 2 ondalığa yuvarlanmış. Bakiyeyi aşan çıkış (negatif stok izni)
 * ve sıfır bakiye de aynı referans maliyetle değerlenir.
 */
export function costIssue(s: ItemState, qty: MoneyValue): MoneyValue {
  if (qty.lte(0)) throw new Error('Çıkış miktarı pozitif olmalı');
  if (s.qty.gt(0) && qty.eq(s.qty)) return s.value;
  const value = roundMoney(qty.times(referenceUnitCost(s)));
  return value.isNegative() ? dec(0) : value;
}

export interface ReceiptResult {
  /** Girişin kendi değeri (pozitif). */
  value: MoneyValue;
  /**
   * İşaretli maliyet düzeltmesi; 0 ise satır yazılmaz. Yalnızca eksi bakiyeyi kapatan alışta oluşur:
   * önce eksi bakiyeyle çıkan mallar eski maliyetle değerlenmişti, alış maliyeti farklıysa envanter
   * değeri (miktar × yeni ortalama) tutacak şekilde fark ayrı satır olarak yazılır.
   * Negatif değer: envanter azalır, fark satılan mal maliyetine gider (M6'da 621).
   */
  adjustment: MoneyValue;
  after: ItemState;
}

/** Giriş: `valueIn` şirket para biriminde girişin toplam değeridir (birim maliyet × miktar, yuvarlanmış). */
export function costReceipt(s: ItemState, qtyIn: MoneyValue, valueIn: MoneyValue): ReceiptResult {
  if (qtyIn.lte(0)) throw new Error('Giriş miktarı pozitif olmalı');
  if (valueIn.isNegative()) throw new Error('Giriş değeri eksi olamaz');

  const lastCost = valueIn.isZero() ? s.lastCost : valueIn.div(qtyIn);
  const qtyAfter = s.qty.plus(qtyIn);

  if (s.qty.gte(0)) {
    return {
      value: valueIn,
      adjustment: dec(0),
      after: { qty: qtyAfter, value: s.value.plus(valueIn), lastCost },
    };
  }

  // Eksi bakiye kapanıyor: kalan miktarın hedef değeri
  let target: MoneyValue;
  if (qtyAfter.gt(0)) target = roundMoney(qtyAfter.times(valueIn.div(qtyIn)));
  else if (qtyAfter.isZero()) target = dec(0);
  else target = roundMoney(qtyAfter.times(s.value.div(s.qty)));

  const adjustment = target.minus(s.value.plus(valueIn));
  return { value: valueIn, adjustment, after: { qty: qtyAfter, value: target, lastCost } };
}

/** Çıkış sonrası durum. */
export function applyIssue(s: ItemState, qty: MoneyValue, value: MoneyValue): ItemState {
  return { qty: s.qty.minus(qty), value: s.value.minus(value), lastCost: s.lastCost };
}
