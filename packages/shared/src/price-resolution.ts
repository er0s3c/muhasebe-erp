import { dec } from './money';

/**
 * Birim fiyat/iskonto çözümleme (X3) — saf hesap. Veritabanı okuması `apps/api/src/modules/sales/pricing.ts` içindedir;
 * bu fonksiyon yalnızca yüklenmiş adaylar arasından deterministik seçim yapar.
 *
 * FİYAT sırası (ilk bulunan kazanır):
 *   1. party_item   : cariye özel kalem fiyatı (fiyat dolu, para birimi belge para birimiyle aynı)
 *   2. party_list   : carinin atanmış fiyat listesi (aktif, tarih aralığında, liste para birimi = belge para birimi)
 *   3. default_list : şirket varsayılan listesi (aynı koşullar)
 *   4. item_card    : stok kartı fiyatı (kart para birimi = belge para birimi)
 *   5. none         : fiyat bulunamadı (kullanıcı girer)
 * Her kaynakta aday satırlar: geçerlilik tarihi işlem tarihini kapsar ve min_qty <= miktar; bunlar arasında EN BÜYÜK min_qty
 * (miktar kademesi), eşitse en yeni geçerlilik başlangıcı (tarihsiz satır en eski sayılır) kazanır.
 * Para birimi çevrilmez: uyuşmayan kaynak atlanır.
 *
 * İSKONTO (fiyattan bağımsız çözülür, fiyattan sonra uygulanır):
 *   1. party_item    : cariye özel kalem satırının iskonto yüzdesi (aynı kademe/tarih kuralı)
 *   2. party_default : carinin genel iskontosu — fiyat cariye özel fiyattan geldiyse UYGULANMAZ (özel fiyat zaten pazarlıklı fiyattır)
 *   3. none          : 0
 */
export type PriceKind = 'sales' | 'purchase';
export type PriceSource = 'party_item' | 'party_list' | 'default_list' | 'item_card' | 'none';
export type DiscountSource = 'party_item' | 'party_default' | 'none';

export interface Tiered {
  minQty: string;
  validFrom: string | null;
  validTo: string | null;
}
export interface PartyPriceRow extends Tiered {
  price: string | null;
  currency: string | null;
  discountPct: string | null;
}
export interface ListPriceRow extends Tiered {
  price: string;
}
export interface PriceListCandidate {
  id: string;
  code: string;
  name: string;
  currency: string;
  isActive: boolean;
  validFrom: string | null;
  validTo: string | null;
  /** Yalnızca istenen kalemin satırları. */
  rows: ListPriceRow[];
}

export interface PriceInputs {
  /** Belge tarihi (ISO). */
  date: string;
  /** Satır miktarı (miktar kademesi için). */
  quantity: string;
  /** Belge para birimi. */
  currency: string;
  partyRows: PartyPriceRow[];
  partyList: PriceListCandidate | null;
  defaultList: PriceListCandidate | null;
  itemCard: { price: string | null; currency: string } | null;
  /** Carinin genel iskontosu (yüzde). */
  partyDiscountPct: string;
}

export interface PriceResolution {
  unitPrice: string | null;
  priceSource: PriceSource;
  priceListId: string | null;
  priceListName: string | null;
  discountPct: string;
  discountSource: DiscountSource;
  /** Seçilen satırın miktar kademesi (kart/none için null). */
  minQty: string | null;
}

const validOn = (r: { validFrom: string | null; validTo: string | null }, date: string) =>
  (r.validFrom === null || r.validFrom <= date) && (r.validTo === null || r.validTo >= date);

/** Tarih ve miktara uyan adaylardan en büyük kademeyi (eşitse en yeni başlangıcı) seçer. */
export function pickTier<T extends Tiered>(rows: readonly T[], date: string, quantity: string): T | null {
  const qty = dec(quantity);
  let best: T | null = null;
  for (const r of rows) {
    if (!validOn(r, date) || dec(r.minQty).gt(qty)) continue;
    if (!best) {
      best = r;
      continue;
    }
    const cmp = dec(r.minQty).comparedTo(dec(best.minQty));
    if (cmp > 0 || (cmp === 0 && (r.validFrom ?? '') > (best.validFrom ?? ''))) best = r;
  }
  return best;
}

const listUsable = (l: PriceListCandidate | null, date: string, currency: string): l is PriceListCandidate =>
  !!l && l.isActive && l.currency === currency && validOn(l, date);

export function resolvePriceFrom(inp: PriceInputs): PriceResolution {
  const out: PriceResolution = {
    unitPrice: null,
    priceSource: 'none',
    priceListId: null,
    priceListName: null,
    discountPct: '0',
    discountSource: 'none',
    minQty: null,
  };

  const partyPriced = pickTier(
    inp.partyRows.filter((r) => r.price !== null && r.currency === inp.currency),
    inp.date,
    inp.quantity,
  );
  if (partyPriced) {
    out.unitPrice = partyPriced.price;
    out.priceSource = 'party_item';
    out.minQty = partyPriced.minQty;
  } else {
    for (const [list, source] of [
      [inp.partyList, 'party_list'],
      [inp.defaultList, 'default_list'],
    ] as const) {
      if (!listUsable(list, inp.date, inp.currency)) continue;
      const row = pickTier(list.rows, inp.date, inp.quantity);
      if (!row) continue;
      out.unitPrice = row.price;
      out.priceSource = source;
      out.priceListId = list.id;
      out.priceListName = list.name;
      out.minQty = row.minQty;
      break;
    }
    if (out.priceSource === 'none' && inp.itemCard && inp.itemCard.price !== null && inp.itemCard.currency === inp.currency) {
      out.unitPrice = inp.itemCard.price;
      out.priceSource = 'item_card';
    }
  }

  const partyDiscount = pickTier(
    inp.partyRows.filter((r) => r.discountPct !== null),
    inp.date,
    inp.quantity,
  );
  if (partyDiscount) {
    out.discountPct = dec(partyDiscount.discountPct!).toFixed(4);
    out.discountSource = 'party_item';
  } else if (out.priceSource !== 'party_item' && dec(inp.partyDiscountPct).gt(0)) {
    out.discountPct = dec(inp.partyDiscountPct).toFixed(4);
    out.discountSource = 'party_default';
  }
  return out;
}
