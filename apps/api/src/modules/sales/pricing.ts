import { and, eq } from 'drizzle-orm';
import { resolvePriceFrom, type PriceKind, type PriceListCandidate, type PriceResolution } from '@erp/shared';
import type { Tx } from '../../db/client';
import { parties, partyPrices, priceListItems, priceLists } from '../../db/schema';

export interface PriceRequest {
  kind: PriceKind;
  item: {
    id: string;
    salePrice: string | null;
    saleCurrency: string;
    purchasePrice: string | null;
    purchaseCurrency: string;
  };
  partyId: string;
  /** İşlem tarihi (fiyat listeleri ve satırları tarihlidir). */
  date: string;
  /** İstenen belge para birimi (döviz çevirisi yapılmaz: uyuşmayan kaynak atlanır). */
  currency: string;
  /** Satır miktarı (miktar kademesi); boşsa 1. */
  quantity?: string;
}

async function loadList(tx: Tx, listId: string | null, itemId: string): Promise<PriceListCandidate | null> {
  if (!listId) return null;
  const [l] = await tx.select().from(priceLists).where(eq(priceLists.id, listId));
  if (!l) return null;
  const rows = await tx
    .select()
    .from(priceListItems)
    .where(and(eq(priceListItems.priceListId, listId), eq(priceListItems.itemId, itemId)));
  return {
    id: l.id,
    code: l.code,
    name: l.name,
    currency: l.currencyCode,
    isActive: l.isActive,
    validFrom: l.validFrom,
    validTo: l.validTo,
    rows: rows.map((r) => ({ minQty: r.minQty, price: r.price, validFrom: r.validFrom, validTo: r.validTo })),
  };
}

/**
 * Birim fiyat ve iskonto çözümleyicisi — TEK giriş noktası (teklif/sipariş, fatura satırı önerisi, toplu faturalama).
 * Sıra ve kurallar `packages/shared/src/price-resolution.ts` başında belgelidir:
 * fiyat: cariye özel kalem fiyatı > carinin listesi > şirket varsayılan listesi > stok kartı; iskonto fiyattan sonra, bağımsız çözülür.
 * Dönüş, fiyatın kaynağını (ve liste adını) içerir; arayüz bunu satırda gösterir, kullanıcı her zaman değiştirebilir.
 */
export async function resolvePrice(tx: Tx, req: PriceRequest): Promise<PriceResolution> {
  const [party] = await tx.select().from(parties).where(eq(parties.id, req.partyId));
  const partyListId = req.kind === 'sales' ? (party?.salesPriceListId ?? null) : (party?.purchasePriceListId ?? null);
  const partyDiscountPct = (req.kind === 'sales' ? party?.salesDiscountPct : party?.purchaseDiscountPct) ?? '0';

  const rows = await tx
    .select()
    .from(partyPrices)
    .where(and(eq(partyPrices.partyId, req.partyId), eq(partyPrices.itemId, req.item.id), eq(partyPrices.kind, req.kind)));
  const [def] = await tx
    .select({ id: priceLists.id })
    .from(priceLists)
    .where(and(eq(priceLists.kind, req.kind), eq(priceLists.isDefault, true)));

  const partyList = await loadList(tx, partyListId, req.item.id);
  const defaultList = def && def.id !== partyListId ? await loadList(tx, def.id, req.item.id) : def ? partyList : null;
  const card =
    req.kind === 'sales'
      ? { price: req.item.salePrice, currency: req.item.saleCurrency }
      : { price: req.item.purchasePrice, currency: req.item.purchaseCurrency };

  return resolvePriceFrom({
    date: req.date,
    quantity: req.quantity ?? '1',
    currency: req.currency,
    partyRows: rows.map((r) => ({
      minQty: r.minQty,
      validFrom: r.validFrom,
      validTo: r.validTo,
      price: r.price,
      currency: r.currencyCode,
      discountPct: r.discountPct,
    })),
    partyList,
    defaultList,
    itemCard: card,
    partyDiscountPct,
  });
}

/** Birden çok kalem için aynı çözümleme (toplu faturalama önizlemesi). */
export async function resolvePrices(tx: Tx, reqs: readonly PriceRequest[]): Promise<PriceResolution[]> {
  const out: PriceResolution[] = [];
  for (const r of reqs) out.push(await resolvePrice(tx, r));
  return out;
}

