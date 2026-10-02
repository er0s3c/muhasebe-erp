import type { Tx } from '../../db/client';

export interface PriceRequest {
  item: { id: string; salePrice: string | null; saleCurrency: string };
  partyId: string;
  /** İşlem tarihi (fiyat listeleri tarihli olacaktır). */
  date: string;
  /** İstenen belge para birimi. */
  currency: string;
}

/**
 * Birim satış fiyatı çözümleyicisi. Şimdilik yalnızca stok kartının satış fiyatı (kart para birimi belge para birimiyle aynıysa)
 * kullanılır; cari özel fiyat/iskonto ve fiyat listeleri (X3) bu fonksiyona bağlanacaktır — çağıranlar değişmez.
 * Döviz çevirisi yapılmaz: para birimi uyuşmazsa fiyat bulunamamış sayılır (kullanıcı fiyatı kendisi girer).
 */
export async function resolveSalePrice(_tx: Tx, req: PriceRequest): Promise<string | null> {
  if (req.item.salePrice === null) return null;
  return req.item.saleCurrency === req.currency ? req.item.salePrice : null;
}
